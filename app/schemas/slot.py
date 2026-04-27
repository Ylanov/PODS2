# app/schemas/slot.py
from pydantic import BaseModel, ConfigDict
from typing import Optional


class SlotUpdate(BaseModel):
    version: int # <-- УБЕДИТЕСЬ, ЧТО ЭТА СТРОКА ЕСТЬ
    rank: Optional[str] = None
    full_name: Optional[str] = None
    doc_number: Optional[str] = None
    callsign: Optional[str] = None
    note: Optional[str] = None


class GroupInfo(BaseModel):
    id: int
    name: str
    model_config = ConfigDict(from_attributes=True)


# 🔥 НОВАЯ СХЕМА: Для вывода названия должности
class PositionInfo(BaseModel):
    id: int
    name: str
    model_config = ConfigDict(from_attributes=True)


class SlotResponse(BaseModel):
    id: int
    group_id: int
    department: str

    position_id: Optional[int] = None
    position: Optional[PositionInfo] = None

    rank: Optional[str] = None
    full_name: Optional[str] = None
    doc_number: Optional[str] = None
    callsign: Optional[str] = None
    note: Optional[str] = None

    group: GroupInfo

    version: int  # <-- ДОБАВЛЕНО ЭТО ПОЛЕ

    model_config = ConfigDict(from_attributes=True)