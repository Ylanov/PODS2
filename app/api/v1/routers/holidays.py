# app/api/v1/routers/holidays.py
"""
Справочник праздников / каникулярных дней.

Доступ:
  GET  /api/v1/holidays           — все авторизованные пользователи
  POST /api/v1/admin/holidays     — только admin
  PUT  /api/v1/admin/holidays/...
  DELETE /api/v1/admin/holidays/...

Клиенты (админ и dept) загружают список единым запросом GET /holidays
и вычисляют подсветку + переработку на клиенте. Это убирает нагрузку
с бэка для высокочастотных запросов графиков.
"""
from datetime import date as date_type
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, ConfigDict

from app.db.database import get_db
from app.api.dependencies import get_current_user, get_current_active_admin
from app.models.user import User
from app.models.duty import Holiday


public_router = APIRouter()   # /api/v1/holidays — чтение всем
admin_router  = APIRouter()   # /api/v1/admin/holidays — CRUD для admin


class HolidayIn(BaseModel):
    date:        date_type
    title:       str
    is_last_day: bool = False


class HolidayOut(BaseModel):
    date:        date_type
    title:       str
    is_last_day: bool

    model_config = ConfigDict(from_attributes=True)


@public_router.get(
    "",
    response_model=List[HolidayOut],
    summary="Список праздников",
)
def list_holidays(
        year: Optional[int] = Query(None, description="Фильтр по году; если не задан — все"),
        db:   Session = Depends(get_db),
        _:    User = Depends(get_current_user),
):
    q = db.query(Holiday)
    if year is not None:
        q = q.filter(
            Holiday.date >= date_type(year, 1, 1),
            Holiday.date <= date_type(year, 12, 31),
        )
    return q.order_by(Holiday.date).all()


@admin_router.post(
    "/holidays",
    response_model=HolidayOut,
    status_code=status.HTTP_201_CREATED,
    summary="Добавить праздник (админ)",
)
def create_holiday(
        payload: HolidayIn,
        db:      Session = Depends(get_db),
        _:       User    = Depends(get_current_active_admin),
):
    if db.query(Holiday).filter(Holiday.date == payload.date).first():
        raise HTTPException(status_code=409, detail="На эту дату уже есть запись")
    h = Holiday(date=payload.date, title=payload.title, is_last_day=payload.is_last_day)
    db.add(h)
    db.commit()
    db.refresh(h)
    return h


@admin_router.put(
    "/holidays/{day}",
    response_model=HolidayOut,
    summary="Изменить праздник (админ)",
)
def update_holiday(
        day:     date_type,
        payload: HolidayIn,
        db:      Session = Depends(get_db),
        _:       User    = Depends(get_current_active_admin),
):
    h = db.query(Holiday).filter(Holiday.date == day).first()
    if not h:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    # Смена даты в payload допустима: если новая дата ≠ day, проверяем что
    # на новую дату нет другой записи, иначе 409.
    if payload.date != day:
        if db.query(Holiday).filter(Holiday.date == payload.date).first():
            raise HTTPException(status_code=409, detail="На целевую дату уже есть запись")
        # Перемещаем — проще удалить старую и добавить новую, т.к. date это PK
        db.delete(h)
        db.flush()
        h = Holiday(date=payload.date, title=payload.title, is_last_day=payload.is_last_day)
        db.add(h)
    else:
        h.title       = payload.title
        h.is_last_day = payload.is_last_day
    db.commit()
    db.refresh(h)
    return h


@admin_router.delete(
    "/holidays/{day}",
    summary="Удалить праздник (админ)",
)
def delete_holiday(
        day: date_type,
        db:  Session = Depends(get_db),
        _:   User    = Depends(get_current_active_admin),
):
    h = db.query(Holiday).filter(Holiday.date == day).first()
    if not h:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    db.delete(h)
    db.commit()
    return {"ok": True}
