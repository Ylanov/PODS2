# app/api/v1/routers/alert_lists.py
"""
Списки оповещения (вкладка под permission='alert_lists').

Контракт UI:
  • два списка (id=1, id=2) — сидируются миграцией, не создаются и не удаляются
  • в каждом — N слотов (позиций); admin/permitted может править их состав
  • на каждый слот — отметки на дни месяца (N/O/V); при V обязательно
    указан substitute_person_id (выбор зама делает пользователь вручную)

Эндпоинты:
  GET    /api/v1/alert-lists/                                — два списка
  GET    /api/v1/alert-lists/{list_id}/slots                 — слоты списка
  POST   /api/v1/alert-lists/{list_id}/slots                 — добавить слот
  PATCH  /api/v1/alert-lists/slots/{slot_id}                 — править слот
  DELETE /api/v1/alert-lists/slots/{slot_id}                 — удалить слот
  GET    /api/v1/alert-lists/{list_id}/marks?year=&month=    — все отметки за месяц
  PUT    /api/v1/alert-lists/slots/{slot_id}/marks/{date}    — поставить/обновить отметку
  DELETE /api/v1/alert-lists/slots/{slot_id}:marks/{date}    — снять отметку
"""

import logging
from datetime import date as date_type
from calendar import monthrange
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import require_permission
from app.db.database import get_db
from app.models.alert_list import (
    AlertList, AlertSlot, AlertMark,
    ALL_ALERT_MARK_TYPES, ALERT_MARK_VACATION,
    ALL_ALERT_ROLES,
)
from app.models.person import Person


logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(require_permission("alert_lists"))])


# ─── Pydantic ────────────────────────────────────────────────────────────────

class _PersonRef(BaseModel):
    id:        int
    full_name: str
    rank:      Optional[str] = None
    position_title: Optional[str] = None


class ListOut(BaseModel):
    id:   int
    name: str


class SlotOut(BaseModel):
    id:         int
    list_id:    int
    title:      str
    role_kind:  str
    sort_order: int
    primary_person: Optional[_PersonRef] = None


class SlotIn(BaseModel):
    title:             str = Field(..., min_length=1, max_length=200)
    role_kind:         str = Field(default="upr")
    sort_order:        int = 0
    primary_person_id: Optional[int] = None


class SlotPatch(BaseModel):
    title:             Optional[str] = Field(default=None, min_length=1, max_length=200)
    role_kind:         Optional[str] = None
    sort_order:        Optional[int] = None
    primary_person_id: Optional[int] = None   # None = разорвать привязку
    primary_person_id_set: bool = False       # маркер «поле передано» — иначе не трогаем


class MarkOut(BaseModel):
    slot_id:   int
    mark_date: date_type
    mark_type: str
    substitute_person: Optional[_PersonRef] = None


class MarkIn(BaseModel):
    mark_type:           str
    substitute_person_id: Optional[int] = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _person_ref(p: Optional[Person]) -> Optional[_PersonRef]:
    if not p:
        return None
    return _PersonRef(
        id=p.id,
        full_name=p.full_name,
        rank=p.rank,
        position_title=p.position_title,
    )


def _slot_out(s: AlertSlot) -> SlotOut:
    return SlotOut(
        id=s.id,
        list_id=s.list_id,
        title=s.title,
        role_kind=s.role_kind,
        sort_order=s.sort_order,
        primary_person=_person_ref(s.primary_person),
    )


def _mark_out(m: AlertMark) -> MarkOut:
    return MarkOut(
        slot_id=m.slot_id,
        mark_date=m.mark_date,
        mark_type=m.mark_type,
        substitute_person=_person_ref(m.substitute_person),
    )


# ─── Lists ───────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[ListOut], summary="Два списка оповещения")
def list_lists(db: Session = Depends(get_db)):
    rows = db.query(AlertList).order_by(AlertList.id.asc()).all()
    return [ListOut(id=r.id, name=r.name) for r in rows]


# ─── Slots CRUD ──────────────────────────────────────────────────────────────

@router.get("/{list_id}/slots", response_model=List[SlotOut],
            summary="Слоты выбранного списка")
def list_slots(list_id: int, db: Session = Depends(get_db)):
    if not db.query(AlertList).filter(AlertList.id == list_id).first():
        raise HTTPException(status_code=404, detail="Список не найден")
    rows = (
        db.query(AlertSlot)
        .filter(AlertSlot.list_id == list_id)
        .order_by(AlertSlot.sort_order.asc(), AlertSlot.id.asc())
        .all()
    )
    return [_slot_out(s) for s in rows]


@router.post("/{list_id}/slots", response_model=SlotOut, status_code=201,
             summary="Добавить слот в список")
def create_slot(list_id: int, payload: SlotIn, db: Session = Depends(get_db)):
    if not db.query(AlertList).filter(AlertList.id == list_id).first():
        raise HTTPException(status_code=404, detail="Список не найден")
    if payload.role_kind not in ALL_ALERT_ROLES:
        raise HTTPException(status_code=400, detail=f"role_kind должен быть один из {ALL_ALERT_ROLES}")
    if payload.primary_person_id is not None:
        if not db.query(Person).filter(Person.id == payload.primary_person_id).first():
            raise HTTPException(status_code=400, detail="primary_person_id не найден в Базе людей")

    slot = AlertSlot(
        list_id=list_id,
        title=payload.title.strip(),
        role_kind=payload.role_kind,
        sort_order=payload.sort_order or 0,
        primary_person_id=payload.primary_person_id,
    )
    db.add(slot)
    db.commit()
    db.refresh(slot)
    return _slot_out(slot)


@router.patch("/slots/{slot_id}", response_model=SlotOut, summary="Изменить слот")
def patch_slot(slot_id: int, payload: SlotPatch, db: Session = Depends(get_db)):
    s = db.query(AlertSlot).filter(AlertSlot.id == slot_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Слот не найден")
    if payload.title is not None:
        s.title = payload.title.strip()
    if payload.role_kind is not None:
        if payload.role_kind not in ALL_ALERT_ROLES:
            raise HTTPException(status_code=400, detail=f"role_kind должен быть один из {ALL_ALERT_ROLES}")
        s.role_kind = payload.role_kind
    if payload.sort_order is not None:
        s.sort_order = payload.sort_order
    if payload.primary_person_id_set:
        if payload.primary_person_id is not None:
            if not db.query(Person).filter(Person.id == payload.primary_person_id).first():
                raise HTTPException(status_code=400, detail="primary_person_id не найден")
        s.primary_person_id = payload.primary_person_id
    db.commit()
    db.refresh(s)
    return _slot_out(s)


@router.delete("/slots/{slot_id}", status_code=204, summary="Удалить слот")
def delete_slot(slot_id: int, db: Session = Depends(get_db)):
    s = db.query(AlertSlot).filter(AlertSlot.id == slot_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Слот не найден")
    db.delete(s)
    db.commit()


# ─── Marks ───────────────────────────────────────────────────────────────────

@router.get("/{list_id}/marks", response_model=List[MarkOut],
            summary="Все отметки списка за месяц")
def list_marks(
    list_id: int,
    year:    int = Query(..., ge=2000, le=2100),
    month:   int = Query(..., ge=1, le=12),
    db:      Session = Depends(get_db),
):
    if not db.query(AlertList).filter(AlertList.id == list_id).first():
        raise HTTPException(status_code=404, detail="Список не найден")
    last = monthrange(year, month)[1]
    rows = (
        db.query(AlertMark)
        .join(AlertSlot, AlertMark.slot_id == AlertSlot.id)
        .filter(
            AlertSlot.list_id == list_id,
            AlertMark.mark_date >= date_type(year, month, 1),
            AlertMark.mark_date <= date_type(year, month, last),
        )
        .all()
    )
    return [_mark_out(m) for m in rows]


@router.put("/slots/{slot_id}/marks/{mark_date}", response_model=MarkOut,
            summary="Поставить/обновить отметку (N/O/V) на день")
def upsert_mark(
    slot_id:   int,
    mark_date: date_type,
    payload:   MarkIn,
    db:        Session = Depends(get_db),
):
    slot = db.query(AlertSlot).filter(AlertSlot.id == slot_id).first()
    if not slot:
        raise HTTPException(status_code=404, detail="Слот не найден")
    if payload.mark_type not in ALL_ALERT_MARK_TYPES:
        raise HTTPException(status_code=400, detail=f"mark_type должен быть один из {ALL_ALERT_MARK_TYPES}")

    # Для V — substitute_person_id обязателен (UI спрашивает зама прежде
    # чем дать поставить отпуск).
    if payload.mark_type == ALERT_MARK_VACATION:
        if not payload.substitute_person_id:
            raise HTTPException(
                status_code=400,
                detail="Для отпуска (V) обязательно указать заместителя — substitute_person_id",
            )
        if not db.query(Person).filter(Person.id == payload.substitute_person_id).first():
            raise HTTPException(status_code=400, detail="substitute_person_id не найден")
        sub_id = payload.substitute_person_id
    else:
        # N/O — substitute_person_id не нужен, обнуляем если был.
        sub_id = None

    existing = (
        db.query(AlertMark)
        .filter(AlertMark.slot_id == slot_id, AlertMark.mark_date == mark_date)
        .first()
    )
    if existing:
        existing.mark_type = payload.mark_type
        existing.substitute_person_id = sub_id
        mark = existing
    else:
        mark = AlertMark(
            slot_id=slot_id,
            mark_date=mark_date,
            mark_type=payload.mark_type,
            substitute_person_id=sub_id,
        )
        db.add(mark)
    db.commit()
    db.refresh(mark)
    return _mark_out(mark)


@router.delete("/slots/{slot_id}/marks/{mark_date}", status_code=204,
               summary="Снять отметку")
def delete_mark(
    slot_id:   int,
    mark_date: date_type,
    db:        Session = Depends(get_db),
):
    mark = (
        db.query(AlertMark)
        .filter(AlertMark.slot_id == slot_id, AlertMark.mark_date == mark_date)
        .first()
    )
    if not mark:
        return
    db.delete(mark)
    db.commit()


# ─── Поиск кандидатов на зама ────────────────────────────────────────────────

@router.get("/persons/search", response_model=List[_PersonRef],
            summary="Поиск Person для модалки выбора зама")
def search_persons(
    q:    str = Query("", max_length=200),
    role: Optional[str] = Query(default=None, description="upr/otd/cnc — фильтр по корню должности"),
    root: Optional[str] = Query(default=None, max_length=200,
                                description="корень должности для фильтра role=upr/otd"),
    db:   Session = Depends(get_db),
):
    """
    Возвращает кандидатов на роль зама. Логика фильтра:
      role=cnc          — без ограничения, ищем по q среди всех активных
      role=upr / otd    — Person.position_title ICONTAINS root (например root='5 упр'
                          → подберёт «Зам. начальника 5 упр»). q дополняет фильтр.

    Не учитываем уволенных (fired_at IS NULL).
    """
    qry = db.query(Person).filter(Person.fired_at.is_(None))
    if role in ("upr", "otd") and root:
        qry = qry.filter(Person.position_title.ilike(f"%{root}%"))
    if q:
        qry = qry.filter(Person.full_name.ilike(f"%{q}%"))
    rows = qry.order_by(Person.full_name.asc()).limit(40).all()
    return [_person_ref(p) for p in rows if p]
