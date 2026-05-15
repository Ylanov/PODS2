# app/api/v1/routers/global_search.py
"""
Глобальный поиск + массовая замена человека в слотах.

Сценарий: админу позвонили — «Иванов заболел, замени его сегодня везде
на Петрова». Без этого модуля админ должен открывать каждый список,
искать слот, менять руками. Здесь — одна модалка:
  1. Найти человека по ФИО (автокомплит из общей базы).
  2. Указать период (сегодня / неделя / диапазон).
  3. Видим все слоты — выбрать какие заменить.
  4. Указать кого подставить.
  5. Apply.

Использует существующий audit-механизм (log_change + ACTION_UPDATE) —
история ревёрта работает как с обычным редактированием.
"""

from datetime import date as date_type, datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.api.dependencies import get_current_active_admin
from app.api.v1.routers.slots import SLOT_AUDIT_FIELDS
from app.core.audit import log_change, snapshot, compute_diff, ACTION_UPDATE
from app.core.websockets import manager
from app.db.database import get_db
from app.models.event import Event, Group, Slot
from app.models.person import Person
from app.models.user import User


router = APIRouter(
    dependencies=[Depends(get_current_active_admin)],
    tags=["Глобальный поиск (admin)"],
)


# ─── Schemas ──────────────────────────────────────────────────────────────────

class SlotMatchOut(BaseModel):
    """Одно вхождение человека в слот — для отображения в модалке."""
    slot_id:         int
    event_id:        int
    event_title:     str
    event_date:      Optional[date_type]
    group_name:      str
    position_name:   Optional[str]
    department:      str
    full_name:       Optional[str]
    rank:            Optional[str]
    doc_number:      Optional[str]
    passport_number: Optional[str]


class GlobalReplaceIn(BaseModel):
    """Массовая замена: список slot_id + ID новой персоны."""
    slot_ids:        List[int]    = Field(..., min_length=1, max_length=500)
    new_person_id:   int


class GlobalReplaceOut(BaseModel):
    replaced_count: int
    affected_event_ids: List[int]


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get(
    "/admin/global-search/slots",
    response_model=List[SlotMatchOut],
    summary="Найти все слоты где встречается человек (по ФИО), в диапазоне дат",
)
def search_slots_by_person(
    full_name: Optional[str] = None,
    person_id: Optional[int] = None,
    date_from: Optional[date_type] = None,
    date_to:   Optional[date_type] = None,
    db: Session = Depends(get_db),
):
    """
    Параметры:
      • person_id — если задан, full_name берётся из таблицы persons
        (точное совпадение, без риска опечатки).
      • full_name — fallback / если ищем по строке (case-insensitive).
      • date_from / date_to — фильтр по дате Event'а (включительно).
        Если оба пусты — возвращаем за сегодня + 30 дней вперёд.

    Возвращает list of SlotMatchOut, отсортированных по дате + группе.
    Только активные не-шаблонные списки.
    """
    # Resolve full_name из person_id если есть
    if person_id:
        person = db.query(Person).filter(Person.id == person_id).first()
        if person:
            full_name = person.full_name

    if not full_name or not full_name.strip():
        return []

    # Дефолтные границы: сегодня + 30 дней вперёд, чтобы не сканировать всю историю.
    if date_from is None and date_to is None:
        date_from = date_type.today()
        date_to   = date_type(date_from.year, date_from.month, date_from.day)
        # +30 дней через timedelta — но проще через replace тут не выходит,
        # делаем простым импортом.
        from datetime import timedelta
        date_to = date_from + timedelta(days=30)

    q = (
        db.query(Slot)
        .options(
            joinedload(Slot.group).joinedload(Group.event),
            joinedload(Slot.position),
        )
        .join(Group, Slot.group_id == Group.id)
        .join(Event, Group.event_id == Event.id)
        .filter(
            func.lower(Slot.full_name) == full_name.strip().lower(),
            Event.status == "active",
            Event.is_template == False,                       # noqa: E712
        )
    )
    if date_from is not None:
        q = q.filter(Event.date >= date_from)
    if date_to is not None:
        q = q.filter(Event.date <= date_to)

    rows = q.order_by(Event.date.asc(), Group.order_num.asc(), Slot.id.asc()).all()

    return [
        SlotMatchOut(
            slot_id         = s.id,
            event_id        = s.group.event_id,
            event_title     = s.group.event.title if s.group and s.group.event else "",
            event_date      = s.group.event.date if s.group and s.group.event else None,
            group_name      = s.group.name if s.group else "",
            position_name   = s.position.name if s.position else None,
            department      = s.department,
            full_name       = s.full_name,
            rank            = s.rank,
            doc_number      = s.doc_number,
            passport_number = s.passport_number,
        )
        for s in rows
    ]


@router.post(
    "/admin/global-search/replace",
    response_model=GlobalReplaceOut,
    summary="Заменить человека в группе слотов на другого (массово)",
)
async def replace_person_in_slots(
    payload:      GlobalReplaceIn,
    request:      Request,
    db:           Session = Depends(get_db),
    current:      User    = Depends(get_current_active_admin),
):
    """
    Меняет ФИО+звание+номера документов в каждом слоте на данные из
    указанной персоны. Каждое изменение проходит через audit-механизм
    (log_change ACTION_UPDATE) — потом можно откатить как обычное
    редактирование. version++ во избежание optimistic-locking конфликтов
    с открытыми у юзеров формами.

    Триггерит WS broadcast {event_id, action: "update"} для каждого
    затронутого Event — у всех онлайн юзеры таблицы автоматически
    обновятся.
    """
    new_person = db.query(Person).filter(Person.id == payload.new_person_id).first()
    if not new_person:
        raise HTTPException(status_code=404, detail="Новая персона не найдена.")
    if new_person.fired_at is not None:
        raise HTTPException(status_code=400, detail="Нельзя подставить уволенного.")

    slots = (
        db.query(Slot)
        .options(joinedload(Slot.group))
        .filter(Slot.id.in_(payload.slot_ids))
        .all()
    )
    if not slots:
        raise HTTPException(status_code=404, detail="Ни один из слотов не найден.")

    affected_event_ids: set[int] = set()
    replaced = 0

    for slot in slots:
        before = snapshot(slot, SLOT_AUDIT_FIELDS)

        slot.full_name       = new_person.full_name
        slot.rank            = new_person.rank
        slot.doc_number      = new_person.doc_number
        slot.passport_number = new_person.passport_number
        slot.version += 1

        after = snapshot(slot, SLOT_AUDIT_FIELDS)
        diff = compute_diff(before, after)
        if diff:
            event_id = slot.group.event_id if slot.group else None
            log_change(
                db, request, current,
                action      = ACTION_UPDATE,
                entity_type = "slot",
                entity_id   = slot.id,
                old_values  = diff["old"],
                new_values  = diff["new"],
                extra       = {
                    "event_id": event_id,
                    "source":   "global_search_replace",
                },
            )
            if event_id is not None:
                affected_event_ids.add(event_id)
            replaced += 1

    db.commit()

    # WS broadcast — каждому Event'у, не группе, потому что фронт слушает по event_id.
    for eid in affected_event_ids:
        await manager.broadcast({"event_id": eid, "action": "update"})

    return GlobalReplaceOut(
        replaced_count     = replaced,
        affected_event_ids = sorted(affected_event_ids),
    )
