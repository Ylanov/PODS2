# app/api/v1/routers/admin.py

import json
import re
from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session, joinedload, selectinload
from pydantic import BaseModel, Field, ConfigDict, field_validator
from typing import Literal, List, Optional, Any, Dict

from app.db.database import get_db
from app.models.user import User
from app.models.event import Event, Group, Slot, Position, DEFAULT_COLUMNS
from app.models.duty import DutyMark, DutySchedule
from app.models.person import Person
from app.schemas.event import (
    EventCreate, EventResponse, GroupCreate, GroupResponse,
    EventInstantiate, EventUpdateTemplate,
)
from app.api.dependencies import get_current_active_admin
from app.core.security import get_password_hash
from app.core.websockets import manager
from app.core.cache import positions_cache, get_or_set, invalidate
from app.core.audit import (
    log_change, snapshot, compute_diff, notify_user,
    ACTION_CREATE, ACTION_UPDATE, ACTION_DELETE,
)
from app.api.v1.routers.persons import upsert_person_from_slot
from app.data.template_presets import (
    PRESETS, get_preset, list_presets_meta,
)


# Те же поля что трассирует slots.py — для консистентности diff и revert
_SLOT_AUDIT_FIELDS = (
    "full_name", "rank", "doc_number", "position_id",
    "department", "callsign", "note",
)

router = APIRouter()


# ─── Схемы роутера ───────────────────────────────────────────────────────────

class PositionCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200, strip_whitespace=True)


class PositionResponse(BaseModel):
    id: int
    name: str
    model_config = ConfigDict(from_attributes=True)


class ColumnConfig(BaseModel):
    key:     str
    label:   str  = Field(..., min_length=1, max_length=100, strip_whitespace=True)
    type:    str  = Field(default="text")
    order:   int  = Field(default=0)
    width:   int  = Field(default=120, ge=40, le=600)
    visible: bool = True
    custom:  bool = False


class ColumnsUpdatePayload(BaseModel):
    columns: List[ColumnConfig]


class SlotAdminUpdate(BaseModel):
    version:     int
    position_id: Optional[int]  = None
    # Квота: пустая строка допустима — admin может снять привязку к управлению
    # ("— без квоты —" в UI). Раньше была min_length=1, которая ломала
    # inline-сохранение с дашборда когда admin выбирал пустую квоту.
    department:  str            = Field(default="", max_length=100)
    callsign:    Optional[str]  = Field(default=None, max_length=50)
    note:        Optional[str]  = Field(default=None, max_length=500)
    full_name:   Optional[str]  = Field(default=None, max_length=300)
    rank:        Optional[str]  = Field(default=None, max_length=100)
    doc_number:  Optional[str]  = Field(default=None, max_length=100)
    extra_data:  Optional[Dict[str, Any]] = None


class SlotAdminResponse(BaseModel):
    id:          int
    group_id:    int
    department:  str
    position_id: Optional[int]  = None
    callsign:    Optional[str]  = None
    note:        Optional[str]  = None
    rank:        Optional[str]  = None
    full_name:   Optional[str]  = None
    doc_number:  Optional[str]  = None
    version:     int
    extra_data:  Optional[Dict[str, Any]] = None
    model_config = ConfigDict(from_attributes=True)


class SlotQuickCreate(BaseModel):
    department:  str            = Field(..., min_length=1, max_length=100)
    position_id: Optional[int] = None


class SlotsBulkPatch(BaseModel):
    """
    Массовое переназначение строк в списке/шаблоне.

    Сценарий «экстренная замена людей»: в шаблоне на слотах 12, 14, 17
    стоит квота upr_3 с уже заполненными ФИО. Админ хочет «передать»
    эти строки управлению upr_5, чтобы именно они начали заполнять.
    Ставит чекбоксы → выбирает действия:
        department = "upr_5"   — сменить квоту
        clear_name = True      — очистить ФИО, звание, № документа
        clear_note / callsign  — очистить позывной/примечание
    """
    slot_ids:       List[int]       = Field(..., min_length=1, max_length=500)
    department:     Optional[str]   = Field(default=None, max_length=100)
    position_id:    Optional[int]   = None
    clear_name:     bool = False
    clear_callsign: bool = False
    clear_note:     bool = False


from app.models.user import AVAILABLE_PERMISSIONS, DEFAULT_PERMISSIONS


class UserCreate(BaseModel):
    username: str = Field(..., min_length=2, max_length=50, strip_whitespace=True)
    # Минимум 10 символов. Требуется буква и цифра.
    # Это разумная политика для служебной системы: сильнее NIST 800-63B минимума
    # (8 символов) без требования спецсимволов — те часто провоцируют 1 вариант
    # ("Password1!") и снижают реальную энтропию.
    password: str = Field(..., min_length=10, max_length=128)
    # Роли — три категории:
    #   admin       — полный доступ ко всему.
    #   department  — управление (логины upr_1, upr_2, …). Видит свои данные.
    #   unit        — отдел (логины произвольные: gsm, comms, и т.д.).
    #                 Видимость как у department (по slot.department == username).
    # Конкретный отдел/управление определяется username'ом, а набор его вкладок —
    # полем permissions. Это позволяет админу централизованно управлять всем.
    role:     Literal["admin", "department", "unit"] = "department"
    # Список вкладок доступных этому пользователю. None → дефолт (все).
    # Для role='admin' игнорируется — админ всегда видит всё.
    permissions: Optional[List[str]] = None

    @field_validator("password")
    @classmethod
    def _password_strength(cls, v: str) -> str:
        if not re.search(r"[A-Za-zА-Яа-яЁё]", v):
            raise ValueError("Пароль должен содержать хотя бы одну букву")
        if not re.search(r"\d", v):
            raise ValueError("Пароль должен содержать хотя бы одну цифру")
        # Защита от очевидных "password1234" / "12345qwerty"
        weak = {"password", "qwerty", "admin123", "12345678", "1234567890"}
        if v.lower() in weak:
            raise ValueError("Пароль слишком простой")
        return v

    @field_validator("permissions")
    @classmethod
    def _validate_permissions(cls, v):
        if v is None:
            return None
        # Убираем дубликаты, сохраняя порядок, и валидируем по whitelist
        seen = set()
        clean = []
        for item in v:
            if not isinstance(item, str):
                raise ValueError("permissions должен быть списком строк")
            if item not in AVAILABLE_PERMISSIONS:
                raise ValueError(
                    f"Неизвестная вкладка '{item}'. "
                    f"Разрешены: {', '.join(AVAILABLE_PERMISSIONS)}"
                )
            if item not in seen:
                seen.add(item)
                clean.append(item)
        return clean


class UserPermissionsUpdate(BaseModel):
    """Изменение списка разрешений существующего пользователя."""
    permissions: List[str] = Field(default_factory=list)

    @field_validator("permissions")
    @classmethod
    def _validate(cls, v):
        # Переиспользуем логику через UserCreate.permissions validator
        return UserCreate._validate_permissions.__func__(cls, v) or []


class UserPasswordReset(BaseModel):
    """
    Сброс пароля админом для произвольного юзера.
    Старый пароль не проверяется — это admin override (нужно когда юзер
    забыл пароль или нужно его принудительно сменить).
    Свой пароль юзер меняет через /auth/me/password (там проверяется старый).
    """
    new_password: str = Field(..., min_length=10, max_length=128)

    @field_validator("new_password")
    @classmethod
    def _check(cls, v):
        return UserCreate._password_strength.__func__(cls, v)


class UserModulesUpdate(BaseModel):
    """Изменение списка модулей-операций (только для unit-юзеров)."""
    modules: List[str] = Field(default_factory=list)

    @field_validator("modules")
    @classmethod
    def _validate(cls, v):
        from app.models.user import AVAILABLE_MODULES
        if v is None:
            return []
        seen = set()
        clean = []
        for item in v:
            if not isinstance(item, str):
                raise ValueError("modules должен быть списком строк")
            if item not in AVAILABLE_MODULES:
                raise ValueError(
                    f"Неизвестный модуль '{item}'. "
                    f"Разрешены: {', '.join(AVAILABLE_MODULES)}"
                )
            if item not in seen:
                seen.add(item); clean.append(item)
        return clean


class UserResponse(BaseModel):
    id:          int
    username:    str
    role:        str
    is_active:   bool
    permissions: List[str] = Field(default_factory=lambda: list(DEFAULT_PERMISSIONS))
    modules:     List[str] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)

    # SQLAlchemy возвращает modules как None для NULL в БД, но Pydantic
    # ожидает list. Нормализуем через before-validator, чтобы старые юзеры
    # с modules=NULL отдавались как [].
    @field_validator("modules", mode="before")
    @classmethod
    def _normalize_modules(cls, v):
        return v if isinstance(v, list) else []


class EventUpdatePayload(BaseModel):
    title: Optional[str]       = Field(None, min_length=1, max_length=300, strip_whitespace=True)
    date:  Optional[date_type] = None


# ─── Вспомогательная функция: наряд для даты ─────────────────────────────────

def _get_duty_map_for_date(db: Session, target_date) -> dict:
    """
    Возвращает {position_id: Person} для заданной даты.

    Берёт все DutyMark за эту дату у которых в графике задана должность.
    Если на одну должность несколько человек — берётся последний (по id).
    """
    rows = (
        db.query(DutyMark, DutySchedule, Person)
        .join(DutySchedule, DutyMark.schedule_id == DutySchedule.id)
        .join(Person,       DutyMark.person_id   == Person.id)
        .filter(
            DutyMark.duty_date       == target_date,
            DutySchedule.position_id != None,       # noqa: E711
        )
        .order_by(DutyMark.id.asc())
        .all()
    )

    duty_map: dict = {}
    for mark, schedule, person in rows:
        duty_map[schedule.position_id] = person

    return duty_map


# ─── Столбцы ─────────────────────────────────────────────────────────────────

@router.get(
    "/events/{event_id}/columns",
    response_model=List[ColumnConfig],
    summary="Получить конфигурацию столбцов для списка",
)
def get_event_columns(
        event_id:      int,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Список не найден")
    return event.get_columns()


@router.put(
    "/events/{event_id}/columns",
    response_model=List[ColumnConfig],
    summary="Сохранить конфигурацию столбцов",
)
async def update_event_columns(
        event_id:      int,
        payload:       ColumnsUpdatePayload,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    columns = payload.columns

    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Список не найден")

    if not any(c.visible for c in columns):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Должен остаться хотя бы один видимый столбец",
        )

    keys = [c.key for c in columns]
    if len(keys) != len(set(keys)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Обнаружены дублирующиеся ключи столбцов",
        )

    event.set_columns([c.model_dump() for c in columns])
    db.commit()

    await manager.broadcast({"event_id": event_id, "action": "update"})
    return event.get_columns()


# ─── Должности ───────────────────────────────────────────────────────────────

@router.get("/positions", response_model=List[PositionResponse])
def get_all_positions(
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    # Справочник редко меняется, запрашивается на каждый refresh UI.
    # TTLCache 60с полностью снимает нагрузку при 2к пользователях.
    # Инвалидируется при POST/DELETE ниже.
    def _load():
        rows = db.query(Position).order_by(Position.name).all()
        # Материализуем в словари — иначе после коммита сессии объекты
        # станут detached и доступ к .name выбросит DetachedInstanceError.
        return [{"id": p.id, "name": p.name} for p in rows]

    return get_or_set(positions_cache, "all", _load)


@router.post("/positions", response_model=PositionResponse, status_code=201)
async def create_position(
        position_in:   PositionCreate,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    existing = db.query(Position).filter(Position.name == position_in.name).first()
    if existing:
        raise HTTPException(status_code=409, detail="Должность с таким названием уже существует")

    new_position = Position(name=position_in.name)
    db.add(new_position)
    db.commit()
    db.refresh(new_position)
    invalidate(positions_cache)  # сбрасываем кеш справочника
    await manager.broadcast({"action": "positions_update"})
    return new_position


@router.delete("/positions/{position_id}")
async def delete_position(
        position_id:   int,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    pos = db.query(Position).filter(Position.id == position_id).first()
    if not pos:
        raise HTTPException(status_code=404, detail="Должность не найдена")
    db.delete(pos)
    db.commit()
    invalidate(positions_cache)  # сбрасываем кеш справочника
    await manager.broadcast({"action": "positions_update"})
    return {"message": "Должность удалена"}


# ─── Списки (Events) ─────────────────────────────────────────────────────────

@router.get("/events")
def get_all_events_admin(
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    events = db.query(Event).order_by(Event.date.asc().nullslast(), Event.id.desc()).all()
    return [
        {
            "id":                 e.id,
            "title":              e.title,
            "date":               e.date.isoformat() if e.date else None,
            "status":             e.status,
            "is_template":        e.is_template,
            # Нужен фронту чтобы в расписании подсветить «уже сгенерирован»
            # и отключить повторный выбор того же шаблона на эту дату.
            "source_template_id": e.source_template_id,
        }
        for e in events
    ]


@router.patch("/events/{event_id}/status")
async def set_event_status(
        event_id:      int,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Список не найден")
    if event.is_template:
        raise HTTPException(status_code=400, detail="Шаблон нельзя активировать")
    event.status = "draft" if event.status == "active" else "active"
    db.commit()
    await manager.broadcast({"action": "update"})
    return {"message": "Статус обновлён", "status": event.status}


@router.post("/events", response_model=EventResponse)
def create_event(
        event_in:      EventCreate,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    new_event = Event(
        title=event_in.title,
        date=event_in.date,
        status="draft",
        is_template=event_in.is_template,
    )
    db.add(new_event)
    db.commit()
    db.refresh(new_event)
    return new_event


# ─── Пресеты шаблонов ────────────────────────────────────────────────────────
# Каталог заготовок (АМГ эшелон, АМГ Паводки, Аэрозоль, ГРОЗА, …) живёт
# в app/data/template_presets.py — там же описаны архетипы, взятые из
# реальных docx-документов. Эндпоинты ниже позволяют:
#   1) получить список доступных пресетов (GET);
#   2) создать шаблон по пресету — группы + слоты с типовыми должностями
#      создаются автоматически, админ в редакторе только проставляет
#      ФИО/документы/квоты (POST).

class PresetInstantiate(BaseModel):
    """Тело запроса при создании шаблона из пресета."""
    title: str = Field(..., min_length=1, max_length=300)


@router.get("/template-presets")
def list_template_presets(
        current_admin: User = Depends(get_current_active_admin),
):
    """Лёгкий список пресетов для UI — без полных структур групп/слотов."""
    return list_presets_meta()


@router.post("/template-presets/{preset_id}/instantiate",
             response_model=EventResponse, status_code=201)
async def create_template_from_preset(
        preset_id:     str,
        payload:       PresetInstantiate,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    """
    Создаёт новый шаблон (is_template=True) по выбранному пресету.
    Раскатывает columns_config + группы + слоты с типовыми должностями.
    Должности upsert-ятся в справочник positions: если такой уже есть —
    переиспользуем id, если нет — создаём.
    """
    preset = get_preset(preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Пресет не найден")

    # 1. Сам шаблон-событие
    new_event = Event(
        title=payload.title.strip(),
        date=None,
        status="draft",
        is_template=True,
    )
    new_event.set_columns(preset["columns"])
    db.add(new_event)
    db.flush()

    # 2. Кеш позиций по имени — чтобы не делать SELECT на каждый слот
    position_cache: Dict[str, int] = {}

    def _get_position_id(name: str) -> int:
        if name in position_cache:
            return position_cache[name]
        pos = db.query(Position).filter(Position.name == name).first()
        if not pos:
            pos = Position(name=name)
            db.add(pos)
            db.flush()
        position_cache[name] = pos.id
        return pos.id

    # 3. Группы и слоты в порядке из пресета (order_num идёт инкрементом)
    for order_num, preset_group in enumerate(preset["groups"]):
        group = Group(
            event_id=new_event.id,
            name=preset_group["name"],
            order_num=order_num,
        )
        db.add(group)
        db.flush()

        for preset_slot in preset_group["slots"]:
            position_name = preset_slot.get("position", "").strip()
            slot = Slot(
                group_id=group.id,
                position_id=_get_position_id(position_name) if position_name else None,
                department="",          # квоту админ проставит сам
                rank=None,
                full_name=None,
                doc_number=None,
                callsign=None,
                note=preset_slot.get("note"),
            )
            db.add(slot)

    db.commit()
    db.refresh(new_event)

    # Сбрасываем кеш справочника — могли добавиться новые должности
    invalidate(positions_cache)
    await manager.broadcast({"action": "update"})
    await manager.broadcast({"action": "positions_update"})

    return new_event


@router.patch("/events/{event_id}", response_model=EventResponse)
async def update_event(
        event_id:      int,
        payload:       EventUpdatePayload,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Список не найден")
    if payload.title is not None:
        event.title = payload.title
    if payload.date is not None:
        event.date = payload.date
    db.commit()
    db.refresh(event)
    await manager.broadcast({"event_id": event_id, "action": "update"})
    return event


@router.delete("/events/{event_id}")
async def delete_event(
        event_id:      int,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Список не найден")
    db.delete(event)
    db.commit()
    await manager.broadcast({"action": "update"})
    return {"message": "Список удалён"}


@router.patch("/events/{event_id}/template")
async def toggle_event_template(
        event_id:      int,
        payload:       EventUpdateTemplate,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Список не найден")
    event.is_template = payload.is_template
    db.commit()
    await manager.broadcast({"event_id": event_id, "action": "update"})
    return {"message": "Статус изменён", "is_template": event.is_template}


@router.post("/events/{template_id}/instantiate")
async def instantiate_template(
        template_id:   int,
        payload:       EventInstantiate,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    template = db.query(Event).filter(Event.id == template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    if not template.is_template:
        raise HTTPException(
            status_code=400,
            detail="Это не шаблон. Пометьте список как шаблон перед генерацией.",
        )

    groups = (
        db.query(Group)
        .options(selectinload(Group.slots))
        .filter(Group.event_id == template.id)
        .all()
    )

    # ── Дедупликация: какие даты УЖЕ сгенерированы из этого шаблона ──────────
    # Забираем одной выборкой, чтобы не делать SELECT в цикле.
    already_gen_dates = {
        d for (d,) in db.query(Event.date)
                        .filter(
                            Event.source_template_id == template.id,
                            Event.date.in_(payload.dates),
                        )
                        .all()
    }

    created_ids: list[int] = []
    skipped_dates: list[str] = []
    WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]

    for target_date in payload.dates:
        if target_date in already_gen_dates:
            skipped_dates.append(target_date.isoformat())
            continue

        weekday_str = WEEKDAYS[target_date.weekday()]

        # Ищем кто в наряде на эту дату — заполняем слоты сразу при создании
        duty_map = _get_duty_map_for_date(db, target_date)

        new_event = Event(
            title=f"{template.title} ({target_date.strftime('%d.%m.%Y')}, {weekday_str})",
            date=target_date,
            status="active",
            is_template=False,
            source_template_id=template.id,    # ← связь с шаблоном для защиты от дублей
            columns_config=template.columns_config,
        )
        db.add(new_event)
        db.flush()

        for group in groups:
            new_group = Group(
                event_id=new_event.id,
                name=group.name,
                order_num=group.order_num,
            )
            db.add(new_group)
            db.flush()

            for slot in group.slots:
                person_on_duty = duty_map.get(slot.position_id) if slot.position_id else None

                new_slot = Slot(
                    group_id=new_group.id,
                    position_id=slot.position_id,
                    department=slot.department,
                    callsign=slot.callsign,
                    note=slot.note,
                    full_name  = person_on_duty.full_name if person_on_duty else None,
                    rank       = person_on_duty.rank      if person_on_duty else None,
                    doc_number = None,
                    extra_data = None,
                )
                db.add(new_slot)

        created_ids.append(new_event.id)

    db.commit()
    await manager.broadcast({"action": "update"})

    # Статус 200: даже если всё пропущено — это НЕ ошибка, просто
    # админу стоит сообщить что дубли отброшены.
    if skipped_dates and not created_ids:
        msg = f"Все даты уже сгенерированы из этого шаблона ({len(skipped_dates)})."
    elif skipped_dates:
        msg = (f"Создано: {len(created_ids)}. "
               f"Пропущено (уже есть): {len(skipped_dates)}.")
    else:
        msg = f"Создано: {len(created_ids)}."

    return {
        "message":       msg,
        "created_ids":   created_ids,
        "skipped_dates": skipped_dates,
    }


# ─── Группы ──────────────────────────────────────────────────────────────────

@router.post("/events/{event_id}/groups", response_model=GroupResponse, status_code=201)
async def create_group_in_event(
        event_id:      int,
        group_in:      GroupCreate,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Список не найден")
    new_group = Group(
        event_id=event.id,
        name=group_in.name,
        order_num=group_in.order_num,
    )
    db.add(new_group)
    db.commit()
    db.refresh(new_group)
    await manager.broadcast({"event_id": event_id, "action": "update"})
    return new_group


@router.delete("/groups/{group_id}")
async def delete_group(
        group_id:      int,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Группа не найдена")
    event_id = group.event_id
    db.delete(group)
    db.commit()
    await manager.broadcast({"event_id": event_id, "action": "update"})
    return {"message": "Группа удалена"}


@router.get("/events/{event_id}/full")
def get_full_event_table(
        event_id:      int,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Список не найден")

    groups = (
        db.query(Group)
        .filter(Group.event_id == event_id)
        .options(selectinload(Group.slots).joinedload(Slot.position))
        .order_by(Group.order_num)
        .all()
    )

    result = []
    for g in groups:
        slots_data = [
            {
                "id":            s.id,
                "group_id":      s.group_id,
                "department":    s.department,
                "rank":          s.rank,
                "full_name":     s.full_name,
                "doc_number":    s.doc_number,
                "callsign":      s.callsign,
                "note":          s.note,
                "position_id":   s.position_id,
                "position_name": s.position.name if s.position else None,
                "version":       s.version,
                "extra_data":    s.get_extra(),
            }
            for s in sorted(g.slots, key=lambda s: s.id)
        ]
        result.append({"id": g.id, "name": g.name, "order_num": g.order_num, "slots": slots_data})

    return {
        "event": {
            "id":          event.id,
            "title":       event.title,
            "date":        event.date,
            "status":      event.status,
            "is_template": event.is_template,
        },
        "columns": event.get_columns(),
        "groups":  result,
    }


# ─── Строки (слоты) ───────────────────────────────────────────────────────────

@router.post("/groups/{group_id}/slots", response_model=SlotAdminResponse, status_code=201)
async def add_slot_to_group(
        group_id:      int,
        slot_in:       SlotQuickCreate,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    group = db.query(Group).filter(Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Группа не найдена")

    # При добавлении новой строки — проверяем наряд на дату списка
    person_on_duty = None
    if slot_in.position_id:
        event = db.query(Event).filter(Event.id == group.event_id).first()
        if event and event.date:
            duty_map = _get_duty_map_for_date(db, event.date)
            person_on_duty = duty_map.get(slot_in.position_id)

    new_slot = Slot(
        group_id=group_id,
        department=slot_in.department,
        position_id=slot_in.position_id,
        full_name  = person_on_duty.full_name if person_on_duty else None,
        rank       = person_on_duty.rank      if person_on_duty else None,
    )
    db.add(new_slot)
    db.commit()
    db.refresh(new_slot)
    await manager.broadcast({"event_id": group.event_id, "action": "update"})

    return {
        "id":          new_slot.id,
        "group_id":    new_slot.group_id,
        "department":  new_slot.department,
        "position_id": new_slot.position_id,
        "callsign":    new_slot.callsign,
        "note":        new_slot.note,
        "rank":        new_slot.rank,
        "full_name":   new_slot.full_name,
        "doc_number":  new_slot.doc_number,
        "version":     new_slot.version,
        "extra_data":  new_slot.get_extra(),
    }


@router.delete("/slots/{slot_id}")
async def delete_slot(
        slot_id:       int,
        request:       Request,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    slot = (
        db.query(Slot)
        .options(joinedload(Slot.group))
        .filter(Slot.id == slot_id)
        .first()
    )
    if not slot:
        raise HTTPException(status_code=404, detail="Строка не найдена")
    event_id = slot.group.event_id

    # Audit: фиксируем snapshot удалённого слота в old_values
    log_change(
        db, request, current_admin,
        action      = ACTION_DELETE,
        entity_type = "slot",
        entity_id   = slot.id,
        old_values  = snapshot(slot, _SLOT_AUDIT_FIELDS),
        new_values  = {},
        extra       = {"event_id": event_id},
    )

    db.delete(slot)
    db.commit()
    await manager.broadcast({"event_id": event_id, "action": "update"})
    return {"message": "Строка удалена"}


@router.post("/slots/bulk-patch", summary="Массовое изменение слотов (переназначение квоты, очистка ФИО)")
async def bulk_patch_slots(
        payload:       SlotsBulkPatch,
        request:       Request,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    """
    «Экстренная замена» — переназначить несколько строк сразу, не трогая
    другие.

    Приёмы:
      • Сменить квоту: передать `department="upr_5"` — все выбранные
        строки уйдут управлению upr_5. Управление, бывшее раньше,
        получит уведомление «ваш слот был изменён».
      • Очистить ФИО: `clear_name=true` — обнуляет full_name, rank,
        doc_number. Другое управление начнёт заполнять с чистого листа.
      • Очистить позывной / примечание — аналогично.
      • Сменить должность — через position_id.

    Версия каждого слота инкрементируется, каждое изменение попадает
    в audit_log (отдельная запись на слот). WS-broadcast по каждому
    затронутому event_id — клиенты перечитывают таблицы.
    """
    slots = (
        db.query(Slot)
        .options(joinedload(Slot.group).joinedload(Group.event))
        .filter(Slot.id.in_(payload.slot_ids))
        .all()
    )
    if not slots:
        raise HTTPException(status_code=404, detail="Слоты не найдены")

    # Группируем по event_id для broadcast и уведомлений
    touched_events: set[int] = set()
    notified_users: dict[int, int] = {}   # user_id → count

    for slot in slots:
        before = snapshot(slot, _SLOT_AUDIT_FIELDS)
        old_dept = slot.department

        if payload.department is not None:
            slot.department = payload.department
        if payload.position_id is not None:
            slot.position_id = payload.position_id
        if payload.clear_name:
            slot.full_name  = None
            slot.rank       = None
            slot.doc_number = None
        if payload.clear_callsign:
            slot.callsign = None
        if payload.clear_note:
            slot.note = None

        slot.version += 1

        after = snapshot(slot, _SLOT_AUDIT_FIELDS)
        diff  = compute_diff(before, after)
        if not diff:
            continue

        ev = slot.group.event
        touched_events.add(ev.id if ev else None)

        audit_entry = log_change(
            db, request, current_admin,
            action      = ACTION_UPDATE,
            entity_type = "slot",
            entity_id   = slot.id,
            old_values  = diff["old"],
            new_values  = diff["new"],
            extra       = {
                "event_id":    ev.id if ev else None,
                "event_title": ev.title if ev else None,
                "bulk":        True,
            },
        )

        # Нотификации старому и новому department'у
        for uname in filter(None, {old_dept, slot.department}):
            if uname == current_admin.username:
                continue
            target = db.query(User).filter(User.username == uname).first()
            if target:
                notify_user(
                    db, target.id,
                    kind  = "slot_changed",
                    title = ("Слот передан вам администратором"
                             if uname == slot.department and uname != old_dept
                             else "Ваш слот был изменён администратором"),
                    body  = (f"Список «{ev.title}» — группа «{slot.group.name}». "
                             "Зайдите в «Списки» чтобы увидеть изменения.")
                             if ev else "Данные слота изменены.",
                    link  = f"/static/index.html#event/{ev.id}" if ev else None,
                    audit = audit_entry,
                )
                notified_users[target.id] = notified_users.get(target.id, 0) + 1

    db.commit()

    # Realtime: по одному broadcast на event + per-user push
    for eid in touched_events:
        if eid is not None:
            await manager.broadcast({"event_id": eid, "action": "update"})
    for uid in notified_users:
        await manager.push_to_user(uid, {"action": "notification_new", "kind": "slot_changed"})

    return {
        "updated":      len(slots),
        "events":       list(filter(None, touched_events)),
        "notified":     list(notified_users.keys()),
    }


@router.put("/slots/{slot_id}", response_model=SlotAdminResponse)
async def update_slot(
        slot_id:       int,
        slot_in:       SlotAdminUpdate,
        request:       Request,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    slot = (
        db.query(Slot)
        .options(joinedload(Slot.group).joinedload(Group.event))
        .filter(Slot.id == slot_id)
        .first()
    )
    if not slot:
        raise HTTPException(status_code=404, detail="Строка не найдена")

    if slot.version != slot_in.version:
        raise HTTPException(
            status_code=409,
            detail="Данные были изменены другим пользователем. "
                   "Таблица обновится автоматически.",
        )

    # Snapshot до админского редактирования — фиксируем diff для audit,
    # а заодно старый department чтобы уведомить сразу оба управления
    # если квота перенесена.
    before = snapshot(slot, _SLOT_AUDIT_FIELDS)
    old_dept = slot.department

    old_position_id = slot.position_id
    new_position_id = slot_in.position_id

    slot.position_id = new_position_id
    slot.department  = slot_in.department
    slot.callsign    = slot_in.callsign   or None
    slot.note        = slot_in.note       or None
    slot.full_name   = slot_in.full_name  or None
    slot.rank        = slot_in.rank       or None
    slot.doc_number  = slot_in.doc_number or None

    if slot_in.extra_data is not None:
        existing_extra = slot.get_extra()
        existing_extra.update(slot_in.extra_data)
        slot.set_extra(existing_extra)

    # ── Автозаполнение из наряда при смене должности ──────────────────────────
    #
    # Срабатывает когда:
    #   1. Должность изменилась на новую (не просто сохранение той же)
    #   2. Пользователь не вводит ФИО вручную (поле пустое в запросе)
    #   3. Слот сейчас не заполнен (нет имени)
    #   4. У события есть дата
    #   5. На эту дату есть отметка наряда с нужной должностью
    #
    if (
        new_position_id                         # новая должность задана
        and new_position_id != old_position_id  # должность изменилась
        and not slot_in.full_name               # ФИО не вводится вручную
        and not slot.full_name                  # слот сейчас пустой
    ):
        event = slot.group.event
        if event and event.date:
            duty_map = _get_duty_map_for_date(db, event.date)
            person_on_duty = duty_map.get(new_position_id)
            if person_on_duty:
                slot.full_name = person_on_duty.full_name
                slot.rank      = person_on_duty.rank or slot.rank
                print(f"[duty→update_slot] slot_id={slot_id} "
                      f"pos {old_position_id}→{new_position_id} "
                      f"→ '{person_on_duty.full_name}'")

    slot.version += 1

    # Обновляем базу людей если ФИО заполнено
    if slot.full_name and slot.full_name.strip():
        upsert_person_from_slot(
            db=db,
            full_name=slot.full_name,
            rank=slot.rank,
            doc_number=slot.doc_number,
            department=slot.department,
        )

    # ── Audit + уведомления ──────────────────────────────────────────────────
    after = snapshot(slot, _SLOT_AUDIT_FIELDS)
    diff  = compute_diff(before, after)
    target_user_ids: list[int] = []   # кого уведомлять realtime после commit

    if diff:
        audit_entry = log_change(
            db, request, current_admin,
            action      = ACTION_UPDATE,
            entity_type = "slot",
            entity_id   = slot.id,
            old_values  = diff["old"],
            new_values  = diff["new"],
            extra       = {
                "event_id":    slot.group.event_id,
                "event_title": slot.group.event.title if slot.group.event else None,
                "by_admin":    True,
            },
        )

        # Нотификации затронутым department-юзерам:
        # - текущему (slot.department) если админ отредактировал их строку;
        # - старому (если квота переносилась на другое управление).
        target_unames: set[str] = set()
        if slot.department and slot.department != current_admin.username:
            target_unames.add(slot.department)
        if old_dept and old_dept != slot.department and old_dept != current_admin.username:
            target_unames.add(old_dept)

        for uname in target_unames:
            target_user = db.query(User).filter(User.username == uname).first()
            if target_user:
                notify_user(
                    db, target_user.id,
                    kind  = "slot_changed",
                    title = "Ваш слот был изменён администратором",
                    body  = (f"Список «{slot.group.event.title}» — "
                             f"группа «{slot.group.name}». "
                             "Откройте вкладку «Списки» чтобы увидеть детали."),
                    link  = f"/static/index.html#event/{slot.group.event_id}",
                    audit = audit_entry,
                )
                target_user_ids.append(target_user.id)

    db.commit()
    db.refresh(slot)
    await manager.broadcast({"event_id": slot.group.event_id, "action": "update"})

    # Realtime push: уведомляем вкладки затронутых юзеров подтянуть /notifications.
    # Делаем после commit — иначе notification ещё может не быть в БД.
    for uid in target_user_ids:
        await manager.push_to_user(uid, {
            "action": "notification_new",
            "kind":   "slot_changed",
        })

    return {
        "id":          slot.id,
        "group_id":    slot.group_id,
        "department":  slot.department,
        "position_id": slot.position_id,
        "callsign":    slot.callsign,
        "note":        slot.note,
        "rank":        slot.rank,
        "full_name":   slot.full_name,
        "doc_number":  slot.doc_number,
        "version":     slot.version,
        "extra_data":  slot.get_extra(),
    }


# ─── Пользователи ────────────────────────────────────────────────────────────

@router.get("/users", response_model=List[UserResponse])
def get_all_users(
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    return db.query(User).order_by(User.id).all()


@router.post("/users", response_model=UserResponse, status_code=201)
def create_user(
        user_in:       UserCreate,
        request:       Request,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    if db.query(User).filter(User.username == user_in.username).first():
        raise HTTPException(
            status_code=409,
            detail="Пользователь с таким логином уже существует",
        )

    # Если permissions не заданы — используем дефолт (все вкладки).
    perms = user_in.permissions if user_in.permissions is not None else list(DEFAULT_PERMISSIONS)

    new_user = User(
        username=user_in.username,
        hashed_password=get_password_hash(user_in.password),
        role=user_in.role,
        permissions=perms,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    log_change(
        db, request, current_admin,
        action      = ACTION_CREATE,
        entity_type = "user",
        entity_id   = new_user.id,
        old_values  = {},
        new_values  = {
            "username":    new_user.username,
            "role":        new_user.role,
            "permissions": perms,
        },
    )
    db.commit()
    return new_user


@router.put("/users/{user_id}/permissions", response_model=UserResponse,
            summary="Изменить список разрешённых вкладок пользователя")
def update_user_permissions(
        user_id:       int,
        payload:       UserPermissionsUpdate,
        request:       Request,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    """
    Меняет список вкладок (permissions) у department-пользователя.

    Admin: изменения permissions у admin'а бессмысленны — он всегда видит всё.
    Но разрешаем (сохраняет консистентность в БД, например если управление
    сделали админом и потом обратно).

    UI: в админской странице "Пользователи" рядом с каждой строкой будет
    кнопка шестерёнки / "Настроить доступ".
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    if user.username == "admin":
        # Защита от случайной блокировки главного админа
        raise HTTPException(
            status_code=400,
            detail="Главному администратору нельзя ограничивать доступ",
        )

    old_perms = list(user.permissions or [])
    user.permissions = payload.permissions
    db.commit()
    db.refresh(user)

    if sorted(old_perms) != sorted(payload.permissions):
        log_change(
            db, request, current_admin,
            action      = ACTION_UPDATE,
            entity_type = "user_permissions",
            entity_id   = user.id,
            old_values  = {"permissions": old_perms},
            new_values  = {"permissions": payload.permissions},
            extra       = {"username": user.username},
        )
        notify_user(
            db, user.id,
            kind  = "permissions_changed",
            title = "Администратор изменил ваш доступ",
            body  = "Ваш набор доступных вкладок был обновлён. "
                    "Перезайдите чтобы увидеть актуальный список.",
            link  = None,
        )
        db.commit()

    return user


@router.put("/users/{user_id}/modules", response_model=UserResponse,
            summary="Изменить набор модулей-операций (для unit-роли)")
def update_user_modules(
        user_id:       int,
        payload:       UserModulesUpdate,
        request:       Request,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    """
    Назначает unit-юзеру список модулей-операций (карточки в «Операциях»):
    'comms', 'media', 'procurement', 'training'. Для других ролей — поле
    игнорируется при чтении.

    После сохранения уведомляем юзера через WS, чтобы он перезашёл и увидел
    актуальный набор карточек.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if user.username == "admin":
        raise HTTPException(
            status_code=400,
            detail="Главному администратору модули не настраиваются — "
                   "ему доступно всё",
        )

    old_modules = list(user.modules or [])
    user.modules = payload.modules
    db.commit()
    db.refresh(user)

    if sorted(old_modules) != sorted(payload.modules):
        log_change(
            db, request, current_admin,
            action      = ACTION_UPDATE,
            entity_type = "user_modules",
            entity_id   = user.id,
            old_values  = {"modules": old_modules},
            new_values  = {"modules": payload.modules},
            extra       = {"username": user.username},
        )
        notify_user(
            db, user.id,
            kind  = "modules_changed",
            title = "Администратор изменил ваши модули",
            body  = "Набор доступных модулей операций обновлён. "
                    "Перезайдите чтобы увидеть актуальные карточки.",
            link  = None,
        )
        db.commit()

    return user


@router.put("/users/{user_id}/password", response_model=UserResponse,
            summary="Сбросить пароль пользователя (админ)")
def reset_user_password(
        user_id:       int,
        payload:       UserPasswordReset,
        request:       Request,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    """
    Принудительная установка нового пароля админом. Старый пароль не нужен —
    это override-операция для случаев когда пользователь забыл пароль или
    его нужно сменить по требованию безопасности.

    Свой собственный пароль юзеры меняют через /auth/me/password там
    обязательна проверка текущего пароля.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    user.hashed_password = get_password_hash(payload.new_password)
    db.commit()
    db.refresh(user)

    log_change(
        db, request, current_admin,
        action      = ACTION_UPDATE,
        entity_type = "user_password",
        entity_id   = user.id,
        old_values  = {},                                # пароли в логе не храним
        new_values  = {"reset_by_admin": True},
        extra       = {"username": user.username},
    )
    notify_user(
        db, user.id,
        kind  = "password_changed",
        title = "Пароль был сброшен администратором",
        body  = "Ваш пароль был изменён администратором. "
                "Если это сделали не вы — обратитесь к администратору.",
        link  = None,
    )
    db.commit()
    return user


@router.delete("/users/{user_id}")
def delete_user(
        user_id:       int,
        request:       Request,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if user.username == "admin":
        raise HTTPException(status_code=403, detail="Нельзя удалить главного администратора")

    log_change(
        db, request, current_admin,
        action      = ACTION_DELETE,
        entity_type = "user",
        entity_id   = user.id,
        old_values  = {"username": user.username, "role": user.role,
                       "permissions": user.permissions or []},
        new_values  = {},
    )
    db.delete(user)
    db.commit()
    return {"message": "Пользователь удалён"}