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

from datetime import date as date_type, timedelta

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
from app.core.duty_window import is_window_open, WINDOW_START, WINDOW_END

# Весь роутер графиков наряда управлений требует permission "duty".
# Admin пропускается автоматически (см. require_permission).
router = APIRouter(dependencies=[Depends(require_permission("duty"))])


# ─── Dependency: роли с scope-видимостью (управление + отделы + admin) ───────
DEPT_SCOPE_ROLES = ("department", "admin", "unit")

def get_current_department_user(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in DEPT_SCOPE_ROLES:
        raise HTTPException(status_code=403, detail="Доступ запрещён")
    return current_user


def get_current_department_user_in_window(
    user: User = Depends(get_current_department_user),
) -> User:
    """
    Как get_current_department_user, но дополнительно проверяет окно подачи
    09:00–16:00 МСК. Админ — без ограничений (звонки после 16:00 «замените ФИО»).
    """
    if user.role == "admin":
        return user
    if is_window_open():
        return user
    raise HTTPException(
        status_code=403,
        detail=(
            f"Окно подачи закрыто. Редактирование доступно с "
            f"{WINDOW_START.strftime('%H:%M')} до "
            f"{WINDOW_END.strftime('%H:%M')} (МСК)."
        ),
    )


# ─── Schemas ──────────────────────────────────────────────────────────────────

class DeptScheduleCreate(BaseModel):
    title:         str           = Field(..., min_length=1, max_length=300, strip_whitespace=True)
    position_id:   Optional[int] = None
    position_name: Optional[str] = None
    # 'duty' (default) или 'amg_duty' — см. константы DUTY_KIND_* в models/duty.py
    kind:          str           = "duty"


class DeptScheduleResponse(BaseModel):
    id:            int
    title:         str
    position_id:   Optional[int]
    position_name: Optional[str]
    owner:         Optional[str]
    # Если пусто — график применяется ко всем спискам с такой position
    # (бэк-совместимое поведение). Если задан список template-id —
    # автозаполнение работает только для событий из этих шаблонов.
    applicable_template_ids: List[int] = []
    # Тип графика: 'duty' (наряд, default) или 'amg_duty' (дежурство АМГ).
    # У 'amg_duty' автозаполнение слотов в списках выключено.
    kind:          str           = "duty"

    class Config:
        from_attributes = True


class DeptScheduleTemplatesPayload(BaseModel):
    """PATCH /schedules/{id}/applicable-templates — массив template-id."""
    template_ids: List[int] = []


class DeptScheduleKindPayload(BaseModel):
    """PATCH /schedules/{id}/kind — переключить тип графика."""
    kind: str = Field(..., description="'duty' или 'amg_duty'")


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

@router.get("/templates",
            summary="Список шаблонов-событий для привязки графика наряда")
def list_templates_for_filter(
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """
    Возвращает плоский список template-event'ов (id + title) — нужен
    модалке «Применять только к шаблонам» в UI графиков нарядов.
    """
    rows = (
        db.query(Event.id, Event.title)
        .filter(Event.is_template == True)   # noqa: E712
        .order_by(Event.title.asc())
        .all()
    )
    return [{"id": r.id, "title": r.title} for r in rows]


@router.get("/templates/{template_id}/groups",
            summary="Группы конкретного шаблона — для wizard замещений")
def list_template_groups(
    template_id: int,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """
    Группы (id + name + position_name) шаблона. Wizard замещений показывает
    их как варианты, куда направить замещающий наряд.
    """
    tmpl = db.query(Event).filter(
        Event.id == template_id,
        Event.is_template == True,    # noqa: E712
    ).first()
    if not tmpl:
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    rows = (
        db.query(Group)
        .filter(Group.event_id == template_id)
        .order_by(Group.order_num, Group.id)
        .all()
    )
    return [
        {
            "id":         g.id,
            "name":       g.name,
            "time_offset": getattr(g, "time_offset", "") or "",
        }
        for g in rows
    ]


@router.get("/departments",
            summary="Список управлений/отделов для выбора квоты в wizard")
def list_departments(
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    """
    Список username'ов активных управлений и отделов. Используется для
    выбора квоты в wizard замещений. admin сверху, далее по алфавиту.
    """
    users = (
        db.query(User)
        .filter(User.is_active == True)   # noqa: E712
        .all()
    )

    def _rank(u):
        if u.role == "admin":      return 0
        if u.role == "department": return 1
        if u.role == "unit":       return 2
        return 3

    sorted_users = sorted(users, key=lambda u: (_rank(u), u.username or ""))
    return [u.username for u in sorted_users]


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
            applicable_template_ids=s.get_applicable_template_ids(),
            kind=getattr(s, "kind", "duty") or "duty",
        ))
    return result


@router.post("/schedules", response_model=DeptScheduleResponse, status_code=201)
async def create_my_schedule(
    payload: DeptScheduleCreate,
    db:      Session = Depends(get_db),
    user:    User    = Depends(get_current_department_user_in_window),
):
    """Создать график. owner автоматически = текущий пользователь."""
    from app.models.event import Position
    from app.models.duty  import ALL_DUTY_KINDS, DUTY_KIND_DUTY
    pos_name = payload.position_name
    if not pos_name and payload.position_id:
        pos = db.query(Position).filter(Position.id == payload.position_id).first()
        pos_name = pos.name if pos else None

    kind = (payload.kind or DUTY_KIND_DUTY).strip()
    if kind not in ALL_DUTY_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Недопустимый kind: {kind}. Допустимо: {', '.join(ALL_DUTY_KINDS)}",
        )

    s = DutySchedule(
        title=payload.title,
        position_id=payload.position_id,
        position_name=pos_name,
        owner=user.username,           # ← изоляция по управлению
        kind=kind,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return DeptScheduleResponse(
        id=s.id, title=s.title,
        position_id=s.position_id,
        position_name=s.position_name,
        owner=s.owner,
        applicable_template_ids=s.get_applicable_template_ids(),
        kind=getattr(s, "kind", DUTY_KIND_DUTY) or DUTY_KIND_DUTY,
    )


@router.patch("/schedules/{schedule_id}/kind",
              response_model=DeptScheduleResponse,
              summary="Переключить тип графика (наряд / дежурство АМГ)")
async def update_schedule_kind(
    schedule_id: int,
    payload:     DeptScheduleKindPayload,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user_in_window),
):
    from app.models.duty import ALL_DUTY_KINDS

    s = _check_owner(db, schedule_id, user.username)

    kind = (payload.kind or "").strip()
    if kind not in ALL_DUTY_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Недопустимый kind: {kind}. Допустимо: {', '.join(ALL_DUTY_KINDS)}",
        )

    s.kind = kind
    db.commit()
    db.refresh(s)

    pos_name = s.position_name or (s.position.name if s.position else None)
    return DeptScheduleResponse(
        id=s.id, title=s.title,
        position_id=s.position_id,
        position_name=pos_name,
        owner=s.owner,
        applicable_template_ids=s.get_applicable_template_ids(),
        kind=s.kind,
    )


@router.patch("/schedules/{schedule_id}/applicable-templates",
              response_model=DeptScheduleResponse,
              summary="Привязать график к конкретным шаблонам списков (или снять привязку)")
async def update_schedule_applicable_templates(
    schedule_id: int,
    payload:     DeptScheduleTemplatesPayload,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user_in_window),
):
    """
    Управление перечнем шаблонов, к которым применяется автозаполнение
    этого графика наряда. Пустой список → применяется ко всем (default).
    """
    s = _check_owner(db, schedule_id, user.username)

    # Валидируем переданные id: каждый должен быть существующим Event
    # с is_template=True. Несуществующие — отбрасываем.
    if payload.template_ids:
        valid_ids = {
            row.id for row in
            db.query(Event.id).filter(
                Event.id.in_(payload.template_ids),
                Event.is_template == True,   # noqa: E712
            ).all()
        }
        cleaned = [tid for tid in payload.template_ids if tid in valid_ids]
    else:
        cleaned = []

    s.set_applicable_template_ids(cleaned)
    db.commit()
    db.refresh(s)

    pos_name = s.position_name or (s.position.name if s.position else None)
    return DeptScheduleResponse(
        id=s.id, title=s.title,
        position_id=s.position_id,
        position_name=pos_name,
        owner=s.owner,
        applicable_template_ids=s.get_applicable_template_ids(),
        kind=getattr(s, "kind", "duty") or "duty",
    )


@router.delete("/schedules/{schedule_id}", status_code=204)
async def delete_my_schedule(
    schedule_id: int,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user_in_window),
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
    user: User    = Depends(get_current_department_user_in_window),
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
    user: User    = Depends(get_current_department_user_in_window),
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
    user: User    = Depends(get_current_department_user_in_window),
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

    from app.models.duty import ALL_MARK_TYPES, MARK_DUTY, ABSENT_MARK_TYPES
    mark_type = (payload.mark_type or MARK_DUTY).upper()
    if mark_type not in ALL_MARK_TYPES:
        raise HTTPException(status_code=400, detail=f"Недопустимый тип отметки: {mark_type}")

    # Toggle: same type → снимаем; different type → переключаем
    existing = db.query(DutyMark).filter(
        DutyMark.schedule_id == schedule_id,
        DutyMark.person_id   == payload.person_id,
        DutyMark.duty_date   == payload.duty_date,
    ).first()

    # Защита: нельзя ставить наряд на день отсутствия (отпуск/командировка/
    # госпиталь). Смена возможна только через явное снятие отметки.
    if (
        mark_type == MARK_DUTY
        and existing is not None
        and existing.mark_type in ABSENT_MARK_TYPES
    ):
        absent_label = {
            "V": "отпуска", "T": "командировки", "H": "госпиталя",
        }.get(existing.mark_type, "отсутствия")
        raise HTTPException(
            status_code=409,
            detail=f"На день {absent_label} нельзя ставить наряд. Сначала снимите отметку.",
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
        # При смене типа сбрасываем замещения — они актуальны только для
        # текущей роли наряда, при V/U/R substitute-поля бессмысленны и
        # при возврате в N не должны всплывать stale-данные.
        existing.is_primary = True
        existing.substitute_department = None
        existing.substitute_template_group_id = None
        existing.substitutes_json = None
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

    # Графики типа «Дежурство в АМГ» — учётные. Отметку наряда мы записали,
    # но слоты в списках НИКОГДА не подставляем. Это разделение real-нарядов
    # и дежурств — по требованию ИБ.
    from app.models.duty import DUTY_KIND_DUTY
    if schedule.kind != DUTY_KIND_DUTY:
        db.commit()
        return {"action": "marked", "filled_slots_count": 0, "affected_events": []}

    # ── Автозаполнение — только слоты СВОЕГО управления ──────────────────────
    fill_count = 0
    affected_event_ids = set()

    if schedule.position_id:
        # Группа с duty_day_offset=N берёт наряд на event.date + N. Чтобы
        # отметка наряда на дату D попала в правильные слоты, ищем события
        # как на дату D (offset=0), так и на дату D-1 (offset=1).
        candidate_event_dates = [
            payload.duty_date,
            payload.duty_date - timedelta(days=1),
        ]
        events_in_window = (
            db.query(Event)
            .filter(
                Event.date.in_(candidate_event_dates),
                Event.is_template == False,
                Event.status      == "active",
            )
            .all()
        )

        for event in events_in_window:
            # Если у графика стоит фильтр applicable_template_ids — событие
            # должно быть инстансом из подходящего шаблона. Без фильтра
            # применяется ко всем (старая семантика).
            if not schedule.applies_to_event(event):
                continue

            groups = db.query(Group).filter(Group.event_id == event.id).all()
            for group in groups:
                offset = int(getattr(group, "duty_day_offset", 0) or 0)
                # Подставляем только в группы, чей сдвиг указывает на эту дату наряда.
                if event.date + timedelta(days=offset) != payload.duty_date:
                    continue

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
    person_id:   Optional[int] = Query(None),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user_in_window),
):
    """
    Снятие отметок одного типа за месяц у графика управления.
    Если задан person_id — только для этого человека (точечная очистка).
    Иначе — массово, у всех людей графика.
    """
    from app.models.duty import ALL_MARK_TYPES
    from calendar import monthrange

    _check_owner(db, schedule_id, user.username)

    mt = mark_type.upper()
    if mt not in ALL_MARK_TYPES:
        raise HTTPException(status_code=400, detail=f"Недопустимый тип отметки: {mt}")

    last = monthrange(year, month)[1]
    q = db.query(DutyMark).filter(
        DutyMark.schedule_id == schedule_id,
        DutyMark.mark_type   == mt,
        DutyMark.duty_date   >= date_type(year, month, 1),
        DutyMark.duty_date   <= date_type(year, month, last),
    )
    if person_id is not None:
        q = q.filter(DutyMark.person_id == person_id)
    q.delete(synchronize_session=False)
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


# ─── Замещения (substitution): wizard перед утверждением ────────────────────

def _conflicts_for_month(db: Session, schedule_id: int, year: int, month: int):
    """
    Возвращает список дней, в которых у графика >1 отметки 'N', с полной
    информацией о каждой отметке (id, person, is_primary, substitute_*).

    Используется и в GET /conflicts (для wizard), и в pre-check approval.
    """
    from calendar import monthrange
    last = monthrange(year, month)[1]

    rows = (
        db.query(DutyMark, Person)
        .join(Person, DutyMark.person_id == Person.id)
        .filter(
            DutyMark.schedule_id == schedule_id,
            DutyMark.mark_type   == "N",
            DutyMark.duty_date   >= date_type(year, month, 1),
            DutyMark.duty_date   <= date_type(year, month, last),
        )
        .order_by(DutyMark.duty_date.asc(), DutyMark.id.asc())
        .all()
    )

    # Группируем по дате
    by_date: dict = {}
    for mark, person in rows:
        targets = mark.get_substitutes()
        by_date.setdefault(mark.duty_date.isoformat(), []).append({
            "mark_id":   mark.id,
            "person_id": person.id,
            "person":    person.full_name,
            "rank":      person.rank,
            "is_primary":                    bool(mark.is_primary),
            # legacy поля (для бэк-совместимости фронта; новый код смотрит substitutes)
            "substitute_department":         mark.substitute_department,
            "substitute_template_group_id":  mark.substitute_template_group_id,
            # массив целей замещения — основной формат теперь
            "substitutes":                   targets,
        })

    # Возвращаем только дни с >1 наряда
    result = []
    for d, marks in sorted(by_date.items()):
        if len(marks) > 1:
            primary_count = sum(1 for m in marks if m["is_primary"])
            unresolved = (
                primary_count != 1
                or any(
                    not m["is_primary"] and not m["substitutes"]
                    for m in marks
                )
            )
            result.append({
                "date":       d,
                "marks":      marks,
                "unresolved": unresolved,
            })
    return result


@router.get("/schedules/{schedule_id}/conflicts",
            summary="Дни с >1 нарядов в графике (для wizard замещений)")
def get_schedule_conflicts(
    schedule_id: int,
    year:  int = Query(..., ge=2000, le=2100),
    month: int = Query(..., ge=1, le=12),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user),
):
    _check_owner(db, schedule_id, user.username)
    return {
        "conflicts":  _conflicts_for_month(db, schedule_id, year, month),
        "year":       year,
        "month":      month,
    }


class DeptSubstituteTarget(BaseModel):
    department:        str
    template_group_id: int


class DeptMarkDecision(BaseModel):
    mark_id:    int
    is_primary: bool
    # legacy одиночные поля (если фронт ещё не обновлён) — используются
    # как fallback, когда substitutes не передан
    substitute_department:        Optional[str] = None
    substitute_template_group_id: Optional[int] = None
    # новый формат: массив целей замещения; одна отметка может покрывать
    # несколько мест в разных шаблонах/группах
    substitutes: Optional[List[DeptSubstituteTarget]] = None


class DeptConflictsResolvePayload(BaseModel):
    decisions: List[DeptMarkDecision]


@router.patch("/schedules/{schedule_id}/conflicts",
              summary="Сохранить решения wizard'а: кто primary, кто замещает")
def resolve_schedule_conflicts(
    schedule_id: int,
    payload:     DeptConflictsResolvePayload,
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user_in_window),
):
    _check_owner(db, schedule_id, user.username)

    if not payload.decisions:
        return {"updated": 0}

    mark_ids = [d.mark_id for d in payload.decisions]
    marks = (
        db.query(DutyMark)
        .filter(
            DutyMark.id.in_(mark_ids),
            DutyMark.schedule_id == schedule_id,
        )
        .all()
    )
    by_id = {m.id: m for m in marks}

    updated = 0
    for d in payload.decisions:
        mark = by_id.get(d.mark_id)
        if not mark:
            continue   # mark не наш или удалён — пропускаем
        if d.is_primary:
            mark.is_primary = True
            mark.set_substitutes([])
        else:
            mark.is_primary = False
            if d.substitutes:
                mark.set_substitutes([
                    {
                        "department":        t.department,
                        "template_group_id": t.template_group_id,
                    }
                    for t in d.substitutes
                ])
            elif d.substitute_department and d.substitute_template_group_id:
                # legacy одиночная цель
                mark.set_substitutes([{
                    "department":        d.substitute_department,
                    "template_group_id": d.substitute_template_group_id,
                }])
            else:
                mark.set_substitutes([])
        updated += 1

    db.commit()
    return {"updated": updated}


@router.post("/schedules/{schedule_id}/approval", status_code=201)
async def approve_schedule_month(
    schedule_id: int,
    year:  int = Query(...),
    month: int = Query(...),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_department_user_in_window),
):
    """
    Утвердить месяц — снимает «режим редактирования».
    Создаёт snapshot текущего состава и отметок за этот месяц; если snapshot
    за этот месяц уже существовал (редкий случай: повторное утверждение
    после разблокировки) — старый заменяется новым.
    Админам отправляется уведомление: «<управление> утвердил <график> за <месяц/год>».

    Pre-check: если в месяце есть дни с >1 нарядом, все они должны быть
    разрешены через wizard (один is_primary, остальные с заполненными
    substitute_*). Иначе — 409 с сообщением и списком конфликтов.
    """
    schedule = _check_owner(db, schedule_id, user.username)
    _validate_month(year, month)

    # Pre-check: блокируем утверждение если есть нерешённые конфликты
    conflicts = _conflicts_for_month(db, schedule_id, year, month)
    unresolved = [c for c in conflicts if c["unresolved"]]
    if unresolved:
        raise HTTPException(
            status_code=409,
            detail={
                "code":      "duty_conflicts_unresolved",
                "message":   "В графике есть дни с несколькими нарядами — нужно "
                             "указать, кто из них основной, а кто замещает кого-то.",
                "conflicts": unresolved,
            },
        )

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
    user: User    = Depends(get_current_department_user_in_window),
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