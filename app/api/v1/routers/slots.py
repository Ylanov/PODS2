# app/api/v1/routers/slots.py

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session, joinedload
from typing import List
from datetime import date as date_today
from sqlalchemy import or_
from pydantic import BaseModel

from app.db.database import get_db
from app.models.user import User
from app.models.event import Slot, Event
from app.models.person import Person
from app.schemas.slot import SlotUpdate, SlotResponse
from app.api.dependencies import get_current_user
from app.core.websockets import manager
from app.core.audit import (
    log_change, snapshot, compute_diff, notify_user, notify_all_admins,
    ACTION_UPDATE,
)
from app.api.v1.routers.persons import upsert_person_from_slot


# Поля которые трассируем в audit для слота.
# Список строго согласован с app/api/v1/routers/audit.py:_SLOT_AUDIT_FIELDS,
# потому что endpoint revert применяет только эти же поля.
SLOT_AUDIT_FIELDS = (
    "full_name", "rank", "doc_number", "position_id",
    "department", "callsign", "note",
)

router = APIRouter()


class ApplyPersonPayload(BaseModel):
    """Применить человека из общей базы к слоту."""
    person_id: int
    version:   int    # optimistic lock — тот же механизм что и в fill_slot


@router.get("/events", summary="Получить все рабочие списки для выпадающих меню")
def get_all_events(
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Возвращает списки для заполнения выпадающих меню.

    - Обычные пользователи (department): только НЕ-шаблоны, только активные, и не в прошлом.
    - Администратор: все списки включая шаблоны (нужны для настройки редактора).
    """
    query = db.query(Event)

    if current_user.role != "admin":
        today = date_today.today()
        # Department видит только активированные рабочие списки, начиная с сегодняшнего дня.
        query = query.filter(
            Event.is_template == False,
            Event.status == "active",
            or_(Event.date == None, Event.date >= today),  # ← скрывает прошлые
        )

    events = query.order_by(Event.date.asc().nullslast(), Event.id.desc()).all()

    return [
        {
            "id":          e.id,
            "title":       e.title,
            "date":        e.date.isoformat() if e.date else None,
            "status":      e.status,
            "is_template": e.is_template,
        }
        for e in events
    ]


@router.get(
    "/events/{event_id}/my-slots",
    response_model=List[SlotResponse],
    summary="Получить свои строки по списку",
)
def get_my_slots(
        event_id: int,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Возвращает строки (слоты), назначенные текущему пользователю в данном списке.
    Администратор видит ВСЕ слоты списка (удобно для проверки).
    """
    query = (
        db.query(Slot)
        .join(Slot.group)
        .filter(Slot.group.has(event_id=event_id))
        .options(joinedload(Slot.group), joinedload(Slot.position))
    )

    if current_user.role != "admin":
        query = query.filter(Slot.department == current_user.username)

    return query.all()


@router.patch(
    "/{slot_id}",
    response_model=SlotResponse,
    summary="Заполнить / обновить свою строку",
)
async def fill_slot(
        slot_id: int,
        slot_in: SlotUpdate,
        request: Request,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    slot = (
        db.query(Slot)
        .options(joinedload(Slot.group), joinedload(Slot.position))
        .filter(Slot.id == slot_id)
        .first()
    )

    if not slot:
        raise HTTPException(status_code=404, detail="Строка не найдена")

    # ПРОВЕРКА ПРАВ:
    # Администратор может редактировать всё.
    # Управление (department) может редактировать только слоты, явно назначенные ему.
    if current_user.role != "admin":
        if not slot.department or slot.department != current_user.username:
            raise HTTPException(
                status_code=403,
                detail="Доступ запрещён. Это не ваша строка.",
            )

    # ПРОВЕРКА ВЕРСИИ
    if slot.version != slot_in.version:
        raise HTTPException(
            status_code=409,
            detail="Данные были изменены другим пользователем. Таблица обновится автоматически, проверьте данные."
        )

    # Snapshot до изменений — для diff в audit-логе
    before = snapshot(slot, SLOT_AUDIT_FIELDS)

    update_data = slot_in.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        if key != 'version':  # Поле version не обновляем напрямую
            setattr(slot, key, value)

    slot.version += 1  # Увеличиваем версию

    # Audit: пишем diff. Если пусто (юзер нажал «Сохранить» без реальных
    # изменений) — не засоряем лог.
    after = snapshot(slot, SLOT_AUDIT_FIELDS)
    diff = compute_diff(before, after)
    admin_recipients: list[int] = []
    if diff:
        audit_entry = log_change(
            db, request, current_user,
            action      = ACTION_UPDATE,
            entity_type = "slot",
            entity_id   = slot.id,
            old_values  = diff["old"],
            new_values  = diff["new"],
            extra       = {"event_id": slot.group.event_id},
        )

        # Уведомляем админов что department что-то заполнил / изменил
        # в своём слоте. Раньше админ не получал уведомлений вообще —
        # его лента всегда была пустой. Теперь ключевые действия
        # департаментов ему видны в реальном времени.
        # exclude=current_user.id покрывает случай когда админ сам
        # использует «режим заполнения» и редактирует как department.
        ev_title = (slot.group.event.title
                    if slot.group and slot.group.event else None)
        admin_recipients = notify_all_admins(
            db,
            kind  = "slot_filled",
            title = f"«{current_user.username}» заполнил(а) слот",
            body  = (f"Список «{ev_title}» — группа «{slot.group.name}». "
                     f"ФИО: {slot.full_name or '—'}"),
            link  = f"/static/index.html#event/{slot.group.event_id}",
            audit = audit_entry,
            exclude_user_id = current_user.id,
        )

    if slot.full_name and slot.full_name.strip():
        # Передаём department из слота — чтобы запись в базе людей
        # попала к нужному управлению, и оно смогло её потом найти
        # через автодополнение (/persons/search).
        upsert_person_from_slot(
            db=db,
            full_name=slot.full_name,
            rank=slot.rank,
            doc_number=slot.doc_number,
            department=slot.department,
        )

    db.commit()
    db.refresh(slot)

    await manager.broadcast({"event_id": slot.group.event_id, "action": "update"})

    # Realtime push каждому админу — пусть колокольчик сразу засветится
    for uid in admin_recipients:
        await manager.push_to_user(uid, {
            "action": "notification_new", "kind": "slot_filled",
        })

    return slot


@router.post(
    "/{slot_id}/apply-person",
    response_model=SlotResponse,
    summary="Применить человека из общей базы к своей строке",
)
async def apply_person_to_slot(
        slot_id: int,
        payload: ApplyPersonPayload,
        request: Request,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Применить найденного (через /persons/suggest) человека к своему слоту.

    Сценарий из ТЗ:
      1. Пользователь управления upr_5 заполняет строку в таблице.
      2. Вводит ФИО → фронт дёргает /persons/suggest → нашёл "Иванова"
         которого ранее добавил upr_3.
      3. Пользователь подтверждает выбор → фронт шлёт этот endpoint.
      4. В слот копируются full_name/rank/doc_number из Person.
      5. Стандартный upsert_person_from_slot (как и в fill_slot) обновляет
         Person.department на upr_5 — "управление применяется к человеку"
         как того требует бизнес-логика. Это та же функция что вызывается
         при обычном заполнении через PATCH /slots/{id}, так что ЛОГИКА
         СОХРАНЕНА: мы просто подставляем поля вместо ручного ввода.

    Если человек новый (не нашёлся в общей базе) — фронт просто пользуется
    обычным PATCH /slots/{id}, где upsert_person_from_slot создаст запись
    в общей базе. Это тоже соответствует ТЗ ("добавляет человека в общую
    базу и в базу пользователя").
    """
    slot = (
        db.query(Slot)
        .options(joinedload(Slot.group), joinedload(Slot.position))
        .filter(Slot.id == slot_id)
        .first()
    )
    if not slot:
        raise HTTPException(status_code=404, detail="Строка не найдена")

    # Тот же check что в fill_slot — только свои слоты, админ может всё
    if current_user.role != "admin":
        if not slot.department or slot.department != current_user.username:
            raise HTTPException(
                status_code=403,
                detail="Доступ запрещён. Это не ваша строка.",
            )

    if slot.version != payload.version:
        raise HTTPException(
            status_code=409,
            detail="Данные были изменены другим пользователем. "
                   "Таблица обновится автоматически, проверьте данные.",
        )

    person = db.query(Person).filter(Person.id == payload.person_id).first()
    if not person:
        raise HTTPException(status_code=404, detail="Человек не найден в общей базе")

    before = snapshot(slot, SLOT_AUDIT_FIELDS)

    # Копируем ключевые поля из Person в Slot.
    # Позиционные поля слота (position_id, department, callsign, note,
    # extra_data) НЕ трогаем — они задаются админом при создании строки.
    slot.full_name  = person.full_name
    slot.rank       = person.rank       or slot.rank
    slot.doc_number = person.doc_number or slot.doc_number
    slot.version   += 1

    # Обновляем общую базу — department становится текущим управлением.
    upsert_person_from_slot(
        db=db,
        full_name=slot.full_name,
        rank=slot.rank,
        doc_number=slot.doc_number,
        department=slot.department,
    )

    # Audit: фиксируем диф с указанием что применение было из общей базы
    after = snapshot(slot, SLOT_AUDIT_FIELDS)
    diff  = compute_diff(before, after)
    admin_recipients: list[int] = []
    if diff:
        audit_entry = log_change(
            db, request, current_user,
            action      = ACTION_UPDATE,
            entity_type = "slot",
            entity_id   = slot.id,
            old_values  = diff["old"],
            new_values  = diff["new"],
            extra       = {
                "event_id":      slot.group.event_id,
                "applied_from":  "persons_base",
                "person_id":     person.id,
            },
        )
        ev_title = (slot.group.event.title
                    if slot.group and slot.group.event else None)
        admin_recipients = notify_all_admins(
            db,
            kind  = "slot_filled",
            title = f"«{current_user.username}» применил(а) человека из общей базы",
            body  = (f"Список «{ev_title}» — группа «{slot.group.name}». "
                     f"ФИО: {slot.full_name}"),
            link  = f"/static/index.html#event/{slot.group.event_id}",
            audit = audit_entry,
            exclude_user_id = current_user.id,
        )

    db.commit()
    db.refresh(slot)
    await manager.broadcast({"event_id": slot.group.event_id, "action": "update"})
    for uid in admin_recipients:
        await manager.push_to_user(uid, {
            "action": "notification_new", "kind": "slot_filled",
        })
    return slot