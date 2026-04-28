# app/schemas/event.py
from pydantic import BaseModel, ConfigDict
from typing import Optional, List
from datetime import date


# =========================
# СХЕМЫ ДЛЯ ГРУПП (Group)
# =========================

class GroupBase(BaseModel):
    """Базовая схема для группы с общими полями."""
    name: str
    order_num: int = 0
    # is_supplementary=True — группа выводится отдельной таблицей под
    # основным списком (например, водители в ГРОЗА-555). Дефолт False.
    is_supplementary: bool = False


class GroupCreate(GroupBase):
    """Схема для создания новой группы. Наследует все от GroupBase."""
    pass


class GroupUpdate(BaseModel):
    """PATCH-схема — все поля опциональные, обновляем только переданные."""
    name:             Optional[str]  = None
    order_num:        Optional[int]  = None
    is_supplementary: Optional[bool] = None


class GroupResponse(GroupBase):
    """
    Схема для ответа API после создания группы.
    Включает в себя ID, которые присваивает база данных.
    """
    id: int
    event_id: int

    # Эта конфигурация позволяет Pydantic создавать схему из модели SQLAlchemy
    model_config = ConfigDict(from_attributes=True)


# =========================
# СХЕМЫ ДЛЯ СПИСКОВ (Event)
# =========================

class EventBase(BaseModel):
    """Базовая схема для списка."""
    title: str
    date: Optional[date] = None
    is_template: bool = False # 🔥 Добавили поле


class EventCreate(EventBase):
    """Схема для создания нового списка."""
    pass


class EventResponse(EventBase):
    """Схема для ответа API, включающая ID и статус."""
    id: int
    status: str

    model_config = ConfigDict(from_attributes=True)

class EventInstantiate(BaseModel):
    """Схема для разворачивания шаблона на конкретные даты."""
    dates: List[date]

class EventUpdateTemplate(BaseModel):
    """Схема для включения/выключения статуса шаблона у существующего списка"""
    is_template: bool

