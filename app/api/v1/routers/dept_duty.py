# app/api/v1/routers/dept_duty.py
"""
Роутер графиков наряда для управлений (department).

Каждое управление видит только свои графики (owner == current_user.username).
Автозаполнение при постановке отметки ограничено слотами своего управления.

Маршруты (префикс /api/v1/dept):
  GET    /schedules                              – список своих графиков
  POST   /schedules                              – создать свой график
  DELETE /schedules/{id}                         – удалить свой график
  GET    /schedules/{id}/persons                 – люди в графике
  POST   /schedules/{id}/persons                 – добавить человека
  DELETE /schedules/{id}/persons/{person_id}     – убрать человека
  GET    /schedules/{id}/marks?year=&month=      – метки за месяц
  POST   /schedules/{id}/marks                   – поставить/снять + автозаполнение
"""

from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel, Field
from typing import Optional, List

from app.db.database import get_db
from app.models.user import User
from app.models.event import Event, Group, Slot
from app.models.person import Person
from app.models.duty import DutySchedule, DutySchedulePerson, DutyMark
from app.api.dependencies import get_current_user, require_permission
from app.core.websockets import manager
from app.core.audit import notify_all_admins
from app.core.duty_approvals import (
    approve_month   as _approve_month,
    unapprove_month as _unapprove_month,
    get_approval    as _get_approval,
)

# Весь роутер графиков наряда управлений требует permission "duty".
# Admin пропускается автоматически (см. require_permission).
router = APIRouter(dependencies=[Depends(require_permission("duty"))])


# ─── Dependency: роли с scope-видимостью (управление + отделы + admin) ───────
DEPT_SCOPE_ROLES = ("department", "admin", "unit")

def get_current_department_user(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in DEPT_SCOPE_ROLES:
        raise HTTPException(status_code=403, detail="Доступ запрещён")
    return current_user


# ─── Schemas ──────────────────────────────────────────────────────────────────

class DeptScheduleCreate(BaseModel):
    title:         str           = Field(..., min_length=1, max_length=300, strip_whitespace=True)
    position_id:   Optional[int] = None
    position_name: Optional[str] = None


class DeptScheduleResponse(BaseModel):
    id:            int
    title:         str
    position_id:   Optional[int]
    position_name: Optional[str]
    owner:         Optional[str]

    class Config:
        from_attributes = True


class DeptPersonInScheduleResponse(BaseModel):
    schedule_person_id: int
    person_id:   int
    full_name:   str
    rank:        Optional[str]
    order_num:   int

    class Config:
        from_attributes = True


class DeptAddPersonPayload(BaseModel):
    person_id: int


class DeptMarkPayload(BaseModel):
    person_id: int
    duty_date: date_type
    mark_type: str = "N"   # 'N' / 'U' / 'V' / 'R'
    # force=True — обойти предупреждение «через сутки» (дельта=2). Запрет
    # для соседних дней (дельта=1) обойти нельзя.
    force: bool = False

@router.get("/positions", summary="Получить список должностей для выпадающего меню")
def get_dept_positions(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_department_user),
):
    """Отдает список должностей управлениям (только чтение)"""
    from app.models.event import Position
    positions = db.query(Position).order_by(Position.id).all()
    return [{"id": p.id, "name": p.name} for p in positions]


# ─── Schedules CRUD ───────────────────────────────────────────────────────────

@router.get("/schedules", response_model=List[DeptScheduleResponse])
def list_my_schedules(
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """Возвращает только графики текущего управления (owner == username)."""
    rows = (
        db.query(DutySchedule)
        .filter(DutySchedule.owner == user.username)
        .order_by(DutySchedule.id.desc())
        .all()
    )
    result = []
    for s in rows:
        pos_name = s.position_name
        if not pos_name and s.position:
            pos_name = s.position.name
        result.append(DeptScheduleResponse(
            id=s.id, title=s.title,
            position_id=s.position_id,
            position_name=pos_name,
            owner=s.owner,
        ))
    return result


@router.post("/schedules", response_model=DeptScheduleResponse, status_code=201)
async def create_my_schedule(
    payload: DeptScheduleCreate,
    db:      Session = Depends(get_db),
    user:    User    = Depends(get_current_department_user),
):
    """Создать график. owner автоматически = текущий пользователь."""
    from app.models.event import Position
    pos_name = payload.position_name
    if not pos_name and payload.position_id:
        pos = db.query(Position).filter(Position.id == payload.position_id).first()
        pos_name = pos.name if pos else None

    s = DutySchedule(
        title=payload.title,
        position_id=payload.position_id,
        position_name=pos_name,
        owner=user.username,           # ← изоляция по управлению
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return DeptScheduleResponse(
        id=s.id, title=s.title,
        position_id=s.position_id,
        position_name=s.position_name,
        owner=s.owner,
    )


@router.delete("/schedules/{schedule_id}", status_code=204)
async def delete_my_schedule(
    schedule_id: int,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    s = db.query(DutySchedule).filter(
        DutySchedule.id    == schedule_id,
        DutySchedule.owner == user.username,
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="График не найден")
    db.delete(s)
    db.commit()


# ─── Persons in schedule ──────────────────────────────────────────────────────

@router.get("/schedules/{schedule_id}/persons",
            response_model=List[DeptPersonInScheduleResponse])
def list_schedule_persons(
    schedule_id: int,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    _check_owner(db, schedule_id, user.username)
    rows = (
        db.query(DutySchedulePerson)
        .options(joinedload(DutySchedulePerson.person))
        .filter(DutySchedulePerson.schedule_id == schedule_id)
        .order_by(DutySchedulePerson.order_num, DutySchedulePerson.id)
        .all()
    )
    return [
        DeptPersonInScheduleResponse(
            schedule_person_id=r.id,
            person_id=r.person_id,
            full_name=r.person.full_name,
            rank=r.person.rank,
            order_num=r.order_num,
        )
        for r in rows
    ]


@router.post("/schedules/{schedule_id}/persons", status_code=201)
async def add_person_to_my_schedule(
    schedule_id: int,
    payload: DeptAddPersonPayload,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    _check_owner(db, schedule_id, user.username)

    # Управление может добавлять только своих людей
    person = db.query(Person).filter(
        Person.id == payload.person_id,
        Person.department == user.username,
    ).first()
    if not person:
        raise HTTPException(status_code=404, detail="Человек не найден или не принадлежит вашему управлению")

    existing = db.query(DutySchedulePerson).filter(
        DutySchedulePerson.schedule_id == schedule_id,
        DutySchedulePerson.person_id   == payload.person_id,
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="Человек уже в графике")

    max_order = db.query(DutySchedulePerson).filter(
        DutySchedulePerson.schedule_id == schedule_id
    ).count()

    sp = DutySchedulePerson(
        schedule_id=schedule_id,
        person_id=payload.person_id,
        order_num=max_order,
    )
    db.add(sp)
    db.commit()
    return {"ok": True}


@router.delete("/schedules/{schedule_id}/persons/{person_id}", status_code=204)
async def remove_person_from_my_schedule(
    schedule_id: int,
    person_id:   int,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    _check_owner(db, schedule_id, user.username)
    sp = db.query(DutySchedulePerson).filter(
        DutySchedulePerson.schedule_id == schedule_id,
        DutySchedulePerson.person_id   == person_id,
    ).first()
    if not sp:
        raise HTTPException(status_code=404, detail="Не найдено")
    db.delete(sp)
    db.commit()


# ─── Marks ────────────────────────────────────────────────────────────────────

@router.get("/schedules/{schedule_id}/marks")
def get_my_marks(
    schedule_id: int,
    year:  int = Query(...),
    month: int = Query(..., ge=1, le=12),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    _check_owner(db, schedule_id, user.username)
    from calendar import monthrange
    _, days_in_month = monthrange(year, month)
    date_from = date_type(year, month, 1)
    date_to   = date_type(year, month, days_in_month)

    marks = (
        db.query(DutyMark)
        .filter(
            DutyMark.schedule_id == schedule_id,
            DutyMark.duty_date   >= date_from,
            DutyMark.duty_date   <= date_to,
        )
        .all()
    )
    return [
        {
            "id":        m.id,
            "person_id": m.person_id,
            "duty_date": m.duty_date.isoformat(),
            "mark_type": m.mark_type or "N",
        }
        for m in marks
    ]


@router.post("/schedules/{schedule_id}/marks")
async def toggle_my_mark(
    schedule_id: int,
    payload:     DeptMarkPayload,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """
    Поставить или снять отметку наряда.
    При постановке — автозаполняет ТОЛЬКО слоты своего управления
    (slot.department == user.username) с совпадающей должностью.
    """
    schedule = _check_owner(db, schedule_id, user.username)

    person = db.query(Person).filter(
        Person.id         == payload.person_id,
        Person.department == user.username,    # только свои люди
    ).first()
    if not person:
        raise HTTPException(status_code=404, detail="Человек не найден")

    from app.models.duty import ALL_MARK_TYPES, MARK_DUTY, MARK_VACATION
    mark_type = (payload.mark_type or MARK_DUTY).upper()
    if mark_type not in ALL_MARK_TYPES:
        raise HTTPException(status_code=400, detail=f"Недопустимый тип отметки: {mark_type}")

    # Toggle: same type → снимаем; different type → переключаем
    existing = db.query(DutyMark).filter(
        DutyMark.schedule_id == schedule_id,
        DutyMark.person_id   == payload.person_id,
        DutyMark.duty_date   == payload.duty_date,
    ).first()

    # Защита: нельзя ставить наряд на день, где уже стоит отпуск.
    # Смена V→N невозможна без явного снятия отпуска (клик по той же
    # клетке в режиме O снимет V, после чего можно будет ставить N).
    if (
        mark_type == MARK_DUTY
        and existing is not None
        and existing.mark_type == MARK_VACATION
    ):
        raise HTTPException(
            status_code=409,
            detail="На день отпуска нельзя ставить наряд. Сначала снимите отпуск.",
        )

    # Валидация интервала: запрет соседних дней (delta=1), предупреждение
    # «через сутки» (delta=2). Только для новых N-нарядов.
    if mark_type == MARK_DUTY and (existing is None or existing.mark_type != MARK_DUTY):
        from app.core.duty_validation import validate_duty_interval
        validate_duty_interval(
            db, schedule_id, payload.person_id, payload.duty_date,
            force=payload.force,
        )

    if existing:
        if existing.mark_type == mark_type:
            db.delete(existing)
            db.commit()
            return {"action": "removed", "filled_slots_count": 0}
        existing.mark_type = mark_type
        db.commit()
        if mark_type != MARK_DUTY:
            return {"action": "changed", "mark_type": mark_type, "filled_slots_count": 0}
        mark = existing
    else:
        mark = DutyMark(
            schedule_id=schedule_id,
            person_id=payload.person_id,
            duty_date=payload.duty_date,
            mark_type=mark_type,
        )
        db.add(mark)

    # Для не-MARK_DUTY (отпуск/увольнение) не заполняем слоты автоматически
    if mark_type != MARK_DUTY:
        db.commit()
        return {"action": "created", "mark_type": mark_type, "filled_slots_count": 0}

    # ── Автозаполнение — только слоты СВОЕГО управления ──────────────────────
    fill_count = 0
    affected_event_ids = set()

    if schedule.position_id:
        events_on_date = (
            db.query(Event)
            .filter(
                Event.date        == payload.duty_date,
                Event.is_template == False,
                Event.status      == "active",
            )
            .all()
        )

        for event in events_on_date:
            groups = db.query(Group).filter(Group.event_id == event.id).all()
            for group in groups:
                slots = (
                    db.query(Slot)
                    .filter(
                        Slot.group_id    == group.id,
                        Slot.position_id == schedule.position_id,
                        Slot.department  == user.username,   # ← ИЗОЛЯЦИЯ
                    )
                    .all()
                )
                for slot in slots:
                    slot.full_name = person.full_name
                    if person.rank:
                        slot.rank = person.rank
                    slot.version += 1
                    fill_count += 1
                    affected_event_ids.add(event.id)

    # Уведомляем админов о действии департамента в графике наряда.
    # type: 'duty_assigned' когда поставили, 'slot_changed' для снятия
    # (снятие попадает в другую ветку выше; здесь только постановка).
    admin_recipients: list[int] = []
    if user.role != "admin":
        kind_title = {
            "N": "в наряд",
            "U": "в увольнение",
            "V": "в отпуск",
        }.get(mark_type, "в график")
        admin_recipients = notify_all_admins(
            db,
            kind  = "duty_assigned",
            title = f"«{user.username}» поставил(а) {person.full_name} {kind_title}",
            body  = f"Дата: {payload.duty_date.isoformat()}",
            link  = None,
            exclude_user_id = user.id,
        )

    db.commit()

    # Уведомить всех подключённых о изменении (как у админа)
    for eid in affected_event_ids:
        await manager.broadcast({"event_id": eid, "action": "update"})

    for uid in admin_recipients:
        await manager.push_to_user(uid, {
            "action": "notification_new", "kind": "duty_assigned",
        })

    return {
        "action":            "marked",
        "filled_slots_count": fill_count,
        "affected_events":   list(affected_event_ids),
    }


@router.delete("/schedules/{schedule_id}/marks", status_code=204)
def clear_my_marks_by_type(
    schedule_id: int,
    mark_type:   str = Query(..., min_length=1, max_length=2),
    year:        int = Query(..., ge=2000, le=2100),
    month:       int = Query(..., ge=1, le=12),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """
    Массовое снятие отметок одного типа за месяц у графика управления.
    Используется кнопкой «Очистить отпуска» в UI.
    """
    from app.models.duty import ALL_MARK_TYPES
    from calendar import monthrange

    _check_owner(db, schedule_id, user.username)

    mt = mark_type.upper()
    if mt not in ALL_MARK_TYPES:
        raise HTTPException(status_code=400, detail=f"Недопустимый тип отметки: {mt}")

    last = monthrange(year, month)[1]
    db.query(DutyMark).filter(
        DutyMark.schedule_id == schedule_id,
        DutyMark.mark_type   == mt,
        DutyMark.duty_date   >= date_type(year, month, 1),
        DutyMark.duty_date   <= date_type(year, month, last),
    ).delete(synchronize_session=False)
    db.commit()


# ─── Экспорт графика в .docx ──────────────────────────────────────────────────

@router.get("/schedules/{schedule_id}/export-docx")
def export_my_schedule_docx(
    schedule_id: int,
    year:        int = Query(..., ge=2000, le=2100),
    month:       int = Query(..., ge=1, le=12),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """Скачать свой график наряда за месяц в формате Word (.docx)."""
    from urllib.parse import quote
    from fastapi.responses import StreamingResponse
    from app.api.v1.routers.duty_export import build_duty_schedule_docx

    schedule = _check_owner(db, schedule_id, user.username)

    buf = build_duty_schedule_docx(db, schedule, year, month)
    safe_title = (schedule.title or "schedule").replace(" ", "_")[:60]
    filename = f"Naryad_{safe_title}_{month:02d}_{year}.docx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition":
                f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}",
        },
    )


# ─── Вспомогательная функция ──────────────────────────────────────────────────

def _check_owner(db: Session, schedule_id: int, username: str) -> DutySchedule:
    """Проверяет что график существует и принадлежит этому управлению."""
    s = db.query(DutySchedule).filter(
        DutySchedule.id    == schedule_id,
        DutySchedule.owner == username,
    ).first()
    if not s:
        raise HTTPException(status_code=404, detail="График не найден")
    return s


# ─── Утверждение графика за месяц ────────────────────────────────────────────

def _validate_month(year: int, month: int) -> None:
    if month < 1 or month > 12:
        raise HTTPException(status_code=400, detail="month должен быть в диапазоне 1..12")
    if year < 2000 or year > 2100:
        raise HTTPException(status_code=400, detail="year вне допустимого диапазона")


@router.get("/schedules/{schedule_id}/approval")
def get_approval_status(
    schedule_id: int,
    year:  int = Query(...),
    month: int = Query(...),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """
    Статус утверждения за месяц.
    Возвращает {status: 'draft'|'approved', approved_at, approved_by} — клиенту
    этого достаточно, чтобы нарисовать badge и переключить UI между
    «режим редактирования» и «утверждён».
    """
    _check_owner(db, schedule_id, user.username)
    _validate_month(year, month)

    a = _get_approval(db, schedule_id, year, month)
    if a is None:
        return {"status": "draft", "approved_at": None, "approved_by": None}
    approver = None
    if a.approved_by_user_id:
        u = db.query(User).filter(User.id == a.approved_by_user_id).first()
        approver = u.username if u else None
    return {
        "status":      "approved",
        "approved_at": a.approved_at.isoformat(),
        "approved_by": approver,
    }


@router.post("/schedules/{schedule_id}/approval", status_code=201)
async def approve_schedule_month(
    schedule_id: int,
    year:  int = Query(...),
    month: int = Query(...),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """
    Утвердить месяц — снимает «режим редактирования».
    Создаёт snapshot текущего состава и отметок за этот месяц; если snapshot
    за этот месяц уже существовал (редкий случай: повторное утверждение
    после разблокировки) — старый заменяется новым.
    Админам отправляется уведомление: «<управление> утвердил <график> за <месяц/год>».
    """
    schedule = _check_owner(db, schedule_id, user.username)
    _validate_month(year, month)

    try:
        approval = _approve_month(db, schedule_id, year, month, user.id)
    except Exception:
        db.rollback()
        raise HTTPException(status_code=500, detail="Не удалось утвердить график")

    # Уведомляем админов
    admin_recipients: list[int] = []
    if user.role != "admin":
        admin_recipients = notify_all_admins(
            db,
            kind  = "duty_schedule_approved",
            title = f"«{user.username}» утвердил(а) график наряда",
            body  = f"«{schedule.title}» · {month:02d}.{year}",
            link  = None,
            exclude_user_id = user.id,
        )

    db.commit()
    db.refresh(approval)

    for uid in admin_recipients:
        await manager.push_to_user(uid, {
            "action": "notification_new", "kind": "duty_schedule_approved",
        })

    return {
        "status":      "approved",
        "approved_at": approval.approved_at.isoformat(),
        "approved_by": user.username,
    }


@router.delete("/schedules/{schedule_id}/approval", status_code=204)
def unapprove_schedule_month(
    schedule_id: int,
    year:  int = Query(...),
    month: int = Query(...),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """
    Вернуть месяц в режим редактирования. Удаляет snapshot (cascade
    уносит *_persons и *_marks). Если snapshot'а не было — 404.
    """
    _check_owner(db, schedule_id, user.username)
    _validate_month(year, month)

    removed = _unapprove_month(db, schedule_id, year, month)
    if not removed:
        raise HTTPException(status_code=404, detail="График ещё не был утверждён")
    db.commit()