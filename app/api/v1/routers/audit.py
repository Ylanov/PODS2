# app/api/v1/routers/audit.py
"""
Эндпоинты аудита и уведомлений.

Пути:
  GET  /api/v1/admin/audit-log               — общий журнал (только admin)
  GET  /api/v1/slots/{slot_id}/history       — история конкретного слота
  POST /api/v1/slots/{slot_id}/revert/{aid}  — откат слота к состоянию до audit-записи

  GET    /api/v1/notifications                — свои уведомления (is_read=0 по умолч.)
  POST   /api/v1/notifications/{id}/read      — отметить прочитанным
  POST   /api/v1/notifications/read-all       — отметить все прочитанными
  DELETE /api/v1/notifications/{id}           — удалить одно

Кто что видит:
  admin        — все записи audit_log; все свои notifications.
  department   — audit по своим слотам (через entity_type='slot' + slot.department
                 == username) + notifications себе.
"""
from datetime import date as date_type, datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import desc, func
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel, ConfigDict

from app.db.database import get_db
from app.api.dependencies import get_current_user, get_current_active_admin
from app.models.user import User
from app.models.audit import (
    AuditLog, Notification,
    ACTION_REVERT, ACTION_UPDATE,
)
from app.models.event import Slot
from app.core.audit import log_change, snapshot, compute_diff
from app.core.websockets import manager

# Админский суб-роутер: /admin/audit-log и /admin/audit-log/day-counts.
# Монтируется в main.py под prefix /api/v1/admin.
audit_admin_router = APIRouter()

# Общий суб-роутер для slot-history и revert — и admin, и department (свои).
# Монтируется под /api/v1 без /admin-префикса, т.к. department-пользователи
# тоже обращаются (смотрят историю своих слотов).
slot_history_router = APIRouter()

# Backward-compat алиас: в main.py раньше был audit_router.
# Оставим для плавного переключения.
audit_router         = audit_admin_router
notifications_router = APIRouter()


# ─── Schemas ─────────────────────────────────────────────────────────────────

class AuditLogEntry(BaseModel):
    id:          int
    timestamp:   datetime
    user_id:     Optional[int]
    username:    Optional[str]
    action:      str
    entity_type: str
    entity_id:   Optional[int]
    old_values:  Optional[dict] = None
    new_values:  Optional[dict] = None
    ip_address:  Optional[str]  = None
    extra:       Optional[dict] = None

    model_config = ConfigDict(from_attributes=True)


class AuditLogPage(BaseModel):
    items: List[AuditLogEntry]
    total: int
    page:  int
    pages: int
    limit: int


class NotificationEntry(BaseModel):
    id:         int
    kind:       str
    title:      str
    body:       Optional[str] = None
    link:       Optional[str] = None
    is_read:    bool
    created_at: datetime
    read_at:    Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class NotificationPage(BaseModel):
    items:  List[NotificationEntry]
    total:  int
    unread: int


# ─── Audit log ───────────────────────────────────────────────────────────────

@audit_admin_router.get(
    "/audit-log",
    response_model=AuditLogPage,
    summary="Общий журнал изменений (админ)",
)
def get_audit_log(
        entity_type: Optional[str] = Query(None, description="slot|person|user|user_permissions"),
        entity_id:   Optional[int] = Query(None),
        user_id:     Optional[int] = Query(None),
        action:      Optional[str] = Query(None),
        date_from:   Optional[date_type] = Query(None, description="Фильтр с даты (включительно)"),
        date_to:     Optional[date_type] = Query(None, description="Фильтр по дату (включительно)"),
        page:  int = Query(1,  ge=1),
        limit: int = Query(50, ge=1, le=200),
        db:    Session = Depends(get_db),
        _:     User    = Depends(get_current_active_admin),
):
    q = db.query(AuditLog)
    if entity_type: q = q.filter(AuditLog.entity_type == entity_type)
    if entity_id:   q = q.filter(AuditLog.entity_id   == entity_id)
    if user_id:     q = q.filter(AuditLog.user_id     == user_id)
    if action:      q = q.filter(AuditLog.action      == action)
    if date_from:   q = q.filter(AuditLog.timestamp >= date_from)
    if date_to:
        # timestamp <= end of day (exclusive next day). Работает для любой TZ
        # потому что timestamp хранится с TZ.
        q = q.filter(AuditLog.timestamp < (date_to + timedelta(days=1)))

    total = q.count()
    pages = max(1, (total + limit - 1) // limit)
    items = (q.order_by(desc(AuditLog.timestamp))
              .offset((page - 1) * limit)
              .limit(limit)
              .all())

    return AuditLogPage(
        items=[_ae(e) for e in items],
        total=total, page=page, pages=pages, limit=limit,
    )


@audit_admin_router.get(
    "/audit-log/day-counts",
    summary="Счётчики audit-записей по дням в диапазоне (для календарного вида)",
)
def get_audit_day_counts(
        date_from: date_type = Query(..., description="Начало диапазона (включит.)"),
        date_to:   date_type = Query(..., description="Конец диапазона (включит.)"),
        db:        Session   = Depends(get_db),
        _:         User      = Depends(get_current_active_admin),
):
    """
    Возвращает {"2026-04-15": 23, "2026-04-16": 7, ...}
    — сколько audit-записей в каждый день диапазона.

    Используется календарной вкладкой истории: под каждой клеткой
    показываем сколько было изменений — при клике на день грузится
    подробный лог за этот день одним запросом.

    Диапазон ограничен 90 днями — защита от тяжёлых запросов.
    """
    if date_to < date_from:
        raise HTTPException(status_code=400, detail="date_to < date_from")
    span_days = (date_to - date_from).days
    if span_days > 90:
        raise HTTPException(
            status_code=400,
            detail=f"Диапазон слишком большой ({span_days} дней). Максимум 90.",
        )

    # GROUP BY DATE(timestamp) — PostgreSQL cast к дате с учётом сессионной TZ.
    # Для простоты передаём сервер-локальное время; при необходимости
    # в будущем можно добавить tz-параметр.
    rows = (
        db.query(
            func.date(AuditLog.timestamp).label("day"),
            func.count(AuditLog.id).label("cnt"),
        )
        .filter(
            AuditLog.timestamp >= date_from,
            AuditLog.timestamp <  date_to + timedelta(days=1),
        )
        .group_by(func.date(AuditLog.timestamp))
        .all()
    )
    return {r.day.isoformat(): int(r.cnt) for r in rows}


def _ae(e: AuditLog) -> AuditLogEntry:
    """AuditLog → схема ответа, с приведением IP к строке (INET ⇒ str)."""
    return AuditLogEntry(
        id         = e.id,
        timestamp  = e.timestamp,
        user_id    = e.user_id,
        username   = e.username,
        action     = e.action,
        entity_type= e.entity_type,
        entity_id  = e.entity_id,
        old_values = e.old_values,
        new_values = e.new_values,
        ip_address = str(e.ip_address) if e.ip_address else None,
        extra      = e.extra,
    )


# Поля слота которые реально интересны пользователю в истории.
# Внутренние (id, group_id) не показываем.
_SLOT_AUDIT_FIELDS = (
    "full_name", "rank", "doc_number", "position_id",
    "department", "callsign", "note",
)


# ─── История конкретного слота ───────────────────────────────────────────────

@slot_history_router.get(
    "/slots/{slot_id}/history",
    response_model=List[AuditLogEntry],
    summary="История изменений одного слота",
)
def get_slot_history(
        slot_id: int,
        limit:   int = Query(50, ge=1, le=200),
        db:      Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Возвращает записи audit_log где entity_type='slot' AND entity_id=slot_id.
    Department видит историю только своих слотов (slot.department == username).
    Admin — любую.
    """
    slot = db.query(Slot).filter(Slot.id == slot_id).first()
    if not slot:
        raise HTTPException(status_code=404, detail="Слот не найден")

    if current_user.role != "admin" and slot.department != current_user.username:
        raise HTTPException(status_code=403, detail="Это не ваша строка")

    entries = (
        db.query(AuditLog)
        .filter(AuditLog.entity_type == "slot", AuditLog.entity_id == slot_id)
        .order_by(desc(AuditLog.timestamp))
        .limit(limit)
        .all()
    )
    return [_ae(e) for e in entries]


# ─── Откат слота ─────────────────────────────────────────────────────────────

@slot_history_router.post(
    "/slots/{slot_id}/revert/{audit_id}",
    summary="Откатить слот к состоянию ДО указанной audit-записи",
)
async def revert_slot(
        slot_id:  int,
        audit_id: int,
        request:  Request,
        db:       Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Откат: берём old_values из audit-записи и применяем их к слоту.
    Пишем новую audit-запись с action=revert (origin=audit_id).

    Правила доступа:
      admin — всегда может откатить.
      department — только свои слоты (как и fill_slot).
    """
    slot = (
        db.query(Slot)
        .options(joinedload(Slot.group))
        .filter(Slot.id == slot_id)
        .first()
    )
    if not slot:
        raise HTTPException(status_code=404, detail="Слот не найден")

    if current_user.role != "admin" and slot.department != current_user.username:
        raise HTTPException(status_code=403, detail="Это не ваша строка")

    audit = (
        db.query(AuditLog)
        .filter(
            AuditLog.id == audit_id,
            AuditLog.entity_type == "slot",
            AuditLog.entity_id   == slot_id,
        )
        .first()
    )
    if not audit:
        raise HTTPException(status_code=404, detail="Запись истории не найдена")
    if audit.action != ACTION_UPDATE or not audit.old_values:
        raise HTTPException(
            status_code=400,
            detail="К этой записи нельзя откатиться (не update или нет old_values)",
        )

    # Snapshot до отката — чтобы сохранить diff в новой записи аудита
    before = snapshot(slot, _SLOT_AUDIT_FIELDS)

    # Применяем old_values (только разрешённые поля для безопасности)
    for field, value in audit.old_values.items():
        if field in _SLOT_AUDIT_FIELDS:
            setattr(slot, field, value)
    slot.version += 1

    after = snapshot(slot, _SLOT_AUDIT_FIELDS)
    diff  = compute_diff(before, after) or {"old": {}, "new": {}}

    log_change(
        db, request, current_user,
        action      = ACTION_REVERT,
        entity_type = "slot",
        entity_id   = slot.id,
        old_values  = diff["old"],
        new_values  = diff["new"],
        extra       = {"reverted_audit_id": audit_id, "event_id": slot.group.event_id},
    )

    db.commit()
    db.refresh(slot)

    await manager.broadcast({"event_id": slot.group.event_id, "action": "update"})
    return {"message": "Слот откатан к предыдущему состоянию", "version": slot.version}


# ─── Notifications ──────────────────────────────────────────────────────────

@notifications_router.get(
    "",
    response_model=NotificationPage,
    summary="Мои уведомления",
)
def get_notifications(
        unread_only: bool = Query(False, description="Только непрочитанные"),
        limit: int = Query(50, ge=1, le=200),
        db:    Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    q = db.query(Notification).filter(Notification.user_id == current_user.id)
    total  = q.count()
    unread = (db.query(Notification)
                .filter(Notification.user_id == current_user.id,
                        Notification.is_read == 0)
                .count())

    if unread_only:
        q = q.filter(Notification.is_read == 0)

    items = q.order_by(desc(Notification.created_at)).limit(limit).all()

    return NotificationPage(
        items=[NotificationEntry(
            id=n.id, kind=n.kind, title=n.title, body=n.body, link=n.link,
            is_read=bool(n.is_read), created_at=n.created_at, read_at=n.read_at,
        ) for n in items],
        total=total,
        unread=unread,
    )


@notifications_router.post(
    "/{notification_id}/read",
    summary="Отметить уведомление прочитанным",
)
def mark_notification_read(
        notification_id: int,
        db:    Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    n = (db.query(Notification)
           .filter(Notification.id == notification_id,
                   Notification.user_id == current_user.id)
           .first())
    if not n:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    if not n.is_read:
        n.is_read = 1
        n.read_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True}


@notifications_router.post(
    "/read-all",
    summary="Отметить все мои уведомления прочитанными",
)
def mark_all_read(
        db:    Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    updated = (db.query(Notification)
                 .filter(Notification.user_id == current_user.id,
                         Notification.is_read == 0)
                 .update({"is_read": 1, "read_at": now},
                         synchronize_session=False))
    db.commit()
    return {"updated": updated}


@notifications_router.delete(
    "/{notification_id}",
    summary="Удалить уведомление",
)
def delete_notification(
        notification_id: int,
        db:    Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    n = (db.query(Notification)
           .filter(Notification.id == notification_id,
                   Notification.user_id == current_user.id)
           .first())
    if not n:
        raise HTTPException(status_code=404, detail="Уведомление не найдено")
    db.delete(n)
    db.commit()
    return {"ok": True}
