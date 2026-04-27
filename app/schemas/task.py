# app/schemas/task.py

from datetime import date as date_type, datetime
from typing import Optional, Literal
from pydantic import BaseModel, Field, ConfigDict, field_validator


Priority = Literal["low", "normal", "high", "urgent"]
Status   = Literal["pending", "in_progress", "done"]


_TIME_RE_MSG = "Время должно быть в формате HH:MM (например 09:30)"


def _validate_time(v: Optional[str]) -> Optional[str]:
    if v is None or v == "":
        return None
    v = v.strip()
    if len(v) != 5 or v[2] != ":":
        raise ValueError(_TIME_RE_MSG)
    try:
        h = int(v[:2])
        m = int(v[3:])
    except ValueError:
        raise ValueError(_TIME_RE_MSG)
    if not (0 <= h < 24 and 0 <= m < 60):
        raise ValueError(_TIME_RE_MSG)
    return v


class TaskBase(BaseModel):
    title:       str            = Field(..., min_length=1, max_length=300, strip_whitespace=True)
    description: Optional[str]  = Field(None, max_length=5000)
    due_date:    date_type
    time_from:   Optional[str]  = None
    time_to:     Optional[str]  = None
    priority:    Priority       = "normal"
    status:      Status         = "pending"
    category:    Optional[str]  = Field(None, max_length=100, strip_whitespace=True)
    color:       Optional[str]  = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("time_from", "time_to", mode="before")
    @classmethod
    def _check_time(cls, v):
        return _validate_time(v)


class TaskCreate(TaskBase):
    pass


class TaskUpdate(BaseModel):
    title:       Optional[str]            = Field(None, min_length=1, max_length=300, strip_whitespace=True)
    description: Optional[str]             = Field(None, max_length=5000)
    due_date:    Optional[date_type]      = None
    time_from:   Optional[str]            = None
    time_to:     Optional[str]            = None
    priority:    Optional[Priority]        = None
    status:      Optional[Status]          = None
    category:    Optional[str]            = Field(None, max_length=100, strip_whitespace=True)
    color:       Optional[str]            = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")

    @field_validator("time_from", "time_to", mode="before")
    @classmethod
    def _check_time(cls, v):
        return _validate_time(v)


class TaskResponse(TaskBase):
    id:         int
    owner_id:   int
    created_at: datetime
    updated_at: datetime
    # Имя владельца — заполняется в роутере для админа
    owner_username: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)
