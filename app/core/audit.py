# app/core/audit.py
"""
Хелперы для записи audit-log и уведомлений.

Usage:
    from app.core.audit import log_change, compute_diff, ACTION_UPDATE

    @router.patch("/slots/{id}")
    def fill_slot(request: Request, ...):
        old_snapshot = _snapshot(slot)           # dict до изменений
        ...                                      # меняем slot
        new_snapshot = _snapshot(slot)           # dict после
        diff = compute_diff(old_snapshot, new_snapshot)
        if diff:
            log_change(
                db, request, user,
                action=ACTION_UPDATE,
                entity_type="slot",
                entity_id=slot.id,
                old_values=diff["old"],
                new_values=diff["new"],
                extra={"event_id": slot.group.event_id},
            )

Почему явные вызовы, а не SQLAlchemy events:
    * event-хуки срабатывают внутри flush — риск рекурсивного коммита;
    * из event нет доступа к Request → не получить ip, user_agent;
    * diff всё равно удобнее считать в handler где известен старый snapshot;
    * events не видят cascade-deletes словами "удалён потому что удалили
      родителя" — пришлось бы писать руками специальную логику.

Производительность:
    log_change делает один INSERT, никаких SELECT. Коммит откладывается
    до следующего db.commit() handler'а — работает в той же транзакции
    что и основное изменение, атомарно.
"""
from __future__ import annotations

import json
from datetime import date as date_type, datetime, timezone
from typing import Any, Iterable, Optional

from fastapi import Request
from sqlalchemy.orm import Session

from app.models.audit import (
    AuditLog, Notification,
    ACTION_CREATE, ACTION_UPDATE, ACTION_DELETE, ACTION_REVERT,
)
from app.models.user import User


# ─── Утилиты ──────────────────────────────────────────────────────────────────

def _json_safe(v: Any) -> Any:
    """Привести значение к JSON-сериализуемому виду для хранения в JSONB."""
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, (datetime, date_type)):
        return v.isoformat()
    if isinstance(v, (list, tuple)):
        return [_json_safe(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _json_safe(val) for k, val in v.items()}
    # Для неизвестных типов — строковое представление (SA relationships,
    # Decimal, UUID, ...). Это лучше чем падать с ошибкой сериализации.
    return str(v)


def snapshot(obj: Any, fields: Iterable[str]) -> dict:
    """
    Снять dict-snapshot атрибутов объекта для diff.
    Поля которых нет на объекте — игнорируются (не KeyError).
    """
    out: dict = {}
    for f in fields:
        if hasattr(obj, f):
            out[f] = _json_safe(getattr(obj, f))
    return out


def compute_diff(old: dict, new: dict) -> Optional[dict]:
    """
    Вернуть {"old": {...}, "new": {...}} только для полей которые изменились.
    None если изменений нет (тогда не надо логировать).
    """
    changed_old: dict = {}
    changed_new: dict = {}
    keys = set(old.keys()) | set(new.keys())
    for k in keys:
        o = old.get(k)
        n = new.get(k)
        if o != n:
            changed_old[k] = o
            changed_new[k] = n
    if not changed_new and not changed_old:
        return None
    return {"old": changed_old, "new": changed_new}


def _client_ip(request: Optional[Request]) -> Optional[str]:
    """
    Получить IP клиента с учётом nginx X-Forwarded-For.
    Возвращает строку — PG сам приведёт к типу INET.
    """
    if request is None:
        return None
    # SlowAPI аналогично читает этот заголовок — поведение единое.
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # Первый IP в списке — оригинальный клиент
        return xff.split(",")[0].strip() or None
    client = request.client
    return client.host if client else None


def _user_agent(request: Optional[Request]) -> Optional[str]:
    if request is None:
        return None
    ua = request.headers.get("user-agent")
    return ua[:400] if ua else None   # колонка 400 символов, обрезаем


# ─── Главный helper ──────────────────────────────────────────────────────────

def log_change(
    db:          Session,
    request:     Optional[Request],
    user:        Optional[User],
    *,
    action:      str,
    entity_type: str,
    entity_id:   Optional[int] = None,
    old_values:  Optional[dict] = None,
    new_values:  Optional[dict] = None,
    extra:       Optional[dict] = None,
) -> AuditLog:
    """
    Записать audit-запись в сессию. Коммит делает вызывающий код —
    audit-лог атомарно попадает в ту же транзакцию что и бизнес-изменение,
    что правильно: если INSERT slot rollback'нулся, лог тоже rollback.

    Для UPDATE: old_values/new_values должны содержать ТОЛЬКО изменённые поля
    (используй compute_diff для получения этого автоматически).
    """
    entry = AuditLog(
        user_id     = user.id       if user else None,
        username    = user.username if user else None,
        action      = action,
        entity_type = entity_type,
        entity_id   = entity_id,
        old_values  = _json_safe(old_values)  if old_values  is not None else None,
        new_values  = _json_safe(new_values)  if new_values  is not None else None,
        extra       = _json_safe(extra)       if extra       is not None else None,
        ip_address  = _client_ip(request),
        user_agent  = _user_agent(request),
    )
    db.add(entry)
    db.flush()   # чтобы entry.id стал доступен (нужен для notification.audit_id)
    return entry


# ─── Notifications ────────────────────────────────────────────────────────────

def notify_user(
    db:        Session,
    user_id:   int,
    *,
    kind:      str,
    title:     str,
    body:      Optional[str] = None,
    link:      Optional[str] = None,
    audit:     Optional[AuditLog] = None,
) -> Notification:
    """
    Создать уведомление для одного пользователя.

    Не коммитит — это делает вызывающий код, чтобы уведомление атомарно
    проходило вместе с основным изменением.

    Realtime-доставка (через WebSocket) — отдельным вызовом после commit
    в app.core.websockets.push_notification_to_user (см. модуль websockets).
    """
    n = Notification(
        user_id  = user_id,
        kind     = kind,
        title    = title[:200],
        body     = body,
        link     = link[:500] if link else None,
        audit_id = audit.id if audit else None,
    )
    db.add(n)
    return n


def notify_all_admins(
    db:        Session,
    *,
    kind:      str,
    title:     str,
    body:      Optional[str] = None,
    link:      Optional[str] = None,
    audit:     Optional[AuditLog] = None,
    exclude_user_id: Optional[int] = None,
) -> list[int]:
    """
    Создать уведомление каждому активному админу (кроме exclude_user_id —
    чтобы админ-инициатор действия не получал уведомление о самом себе).

    Возвращает список user_id всех получателей — используется вызывающим
    кодом для push_to_user() после commit.

    Типичный use-case: department-юзер что-то сделал (заполнил слот,
    поставил наряд, добавил человека в общую базу) — всем админам
    приходит уведомление в реальном времени.
    """
    from app.models.user import User
    admins = (
        db.query(User)
        .filter(User.role == "admin", User.is_active == True)
        .all()
    )
    recipient_ids: list[int] = []
    for a in admins:
        if exclude_user_id is not None and a.id == exclude_user_id:
            continue
        notify_user(
            db, a.id,
            kind=kind, title=title, body=body, link=link, audit=audit,
        )
        recipient_ids.append(a.id)
    return recipient_ids
