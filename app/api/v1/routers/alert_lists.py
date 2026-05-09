# app/api/v1/routers/alert_lists.py
"""
Списки оповещения (вкладка под permission='alert_lists').

Структура:
  AlertList     — два списка (id=1, id=2). Сидируются миграцией.
  AlertPosition — словарь должностей с одним ФИО на каждую (общее для
                  всех списков). Title уникален.
  AlertSlot     — привязка должности к списку. Один слот = одна должность
                  в одном списке. UNIQUE (list_id, position_id).
  AlertMark     — отметка на день для должности. Видна в любом списке
                  где должность есть. UNIQUE (position_id, mark_date).

Что значит «общее ФИО»:
  В списке 1 и в списке 2 есть «Начальник 5 управления». Это одна и
  та же AlertPosition. Меняешь у неё primary_person_id — отображается
  в обоих списках. Ставишь V (отпуск) — то же самое.

Что свободно у каждого списка:
  Какие должности входят (можно держать в списке 1 — управления, в
  списке 2 — отделы). Порядок (sort_order у AlertSlot). Полный
  состав AlertSlot редактируется через UI («+ позиция», «📋 Шаблон»,
  drag-n-drop, «Удалить позицию»).

Эндпоинты:
  GET    /alert-lists/                                      — два списка
  GET    /alert-lists/{list_id}/slots                       — слоты списка с join'ом на position
  POST   /alert-lists/{list_id}/slots                       — добавить позицию в список
                                                              (создаёт AlertPosition если нет, AlertSlot)
  PATCH  /alert-lists/slots/{slot_id}                       — править (title/role/primary → AlertPosition;
                                                              sort_order → AlertSlot)
  DELETE /alert-lists/slots/{slot_id}                       — удалить только slot из списка
                                                              (AlertPosition останется)
  PUT    /alert-lists/{list_id}/slots/reorder               — drag-n-drop
  POST   /alert-lists/{list_id}/slots/seed                  — заполнить шаблоном
  GET    /alert-lists/{list_id}/marks?year=&month=          — отметки за месяц
  PUT    /alert-lists/slots/{slot_id}/marks/{date}          — поставить отметку
                                                              (на position, видна везде)
  DELETE /alert-lists/slots/{slot_id}/marks/{date}          — снять отметку
  GET    /alert-lists/{list_id}/export-docx?on_date=        — Word на день
  GET    /alert-lists/persons/search                        — для модалки выбора зама
"""

import logging
from datetime import date as date_type
from calendar import monthrange
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import require_permission
from app.core.websockets import manager
from app.db.database import get_db
from app.models.alert_list import (
    AlertList, AlertPosition, AlertSlot, AlertMark,
    ALL_ALERT_MARK_TYPES, ALERT_MARK_VACATION,
    ALL_ALERT_ROLES,
)
from app.models.person import Person


logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(require_permission("alert_lists"))])


# ─── Шаблон позиций по умолчанию ─────────────────────────────────────────────
DEFAULT_SLOT_TEMPLATES: list[dict] = [
    # Руководство центра
    {"title": "Первый зам. НЦ",                                "role_kind": "cnc"},
    {"title": "НШ–заместит. НЦ",                               "role_kind": "cnc"},
    {"title": "Заместитель НЦ",                                "role_kind": "cnc"},
    {"title": "Заместитель НЦ по оперативному реагированию",   "role_kind": "cnc"},
    {"title": "Заместитель НЦ по воспитательной работе",       "role_kind": "cnc"},
    {"title": "Зам. НЦ по тылу",                               "role_kind": "cnc"},
    {"title": "Зам. НЦ по вооружению",                         "role_kind": "cnc"},
    {"title": "Зам. НШ",                                       "role_kind": "cnc"},
    {"title": "Зам. НШ (по орг.-моб. раб.)",                   "role_kind": "cnc"},
    {"title": "зам. НШ по оперативной работе",                 "role_kind": "cnc"},
    # Управления
    {"title": "1 Управление",                                  "role_kind": "upr"},
    {"title": "2 Управление",                                  "role_kind": "upr"},
    {"title": "3 Управление",                                  "role_kind": "upr"},
    {"title": "4 Управление",                                  "role_kind": "upr"},
    {"title": "5 Управление",                                  "role_kind": "upr"},
    {"title": "6 Управление",                                  "role_kind": "upr"},
    {"title": "7 Управление",                                  "role_kind": "upr"},
    {"title": "8 Управление",                                  "role_kind": "upr"},
    # Отделы и группы
    {"title": "Отдел кадров",                                  "role_kind": "otd"},
    {"title": "Отдел воспитательной работы",                   "role_kind": "otd"},
    {"title": "Отдел организационный и комплектования",        "role_kind": "otd"},
    {"title": "Отдел эксплуатации зданий",                     "role_kind": "otd"},
    {"title": "Отдел (профессиональной подготовки)",           "role_kind": "otd"},
    {"title": "Отдел (организации контрактной работы)",        "role_kind": "otd"},
    {"title": "Нач. отд. – гл. бухгалтер",                     "role_kind": "otd"},
    {"title": "Начальник отдела-нач. связи",                   "role_kind": "otd"},
    {"title": "Начальник клуба",                               "role_kind": "otd"},
    {"title": "Начальник группы-комендант",                    "role_kind": "otd"},
    # Службы
    {"title": "Юридическая служба",                            "role_kind": "otd"},
    {"title": "Психологическая служба",                        "role_kind": "otd"},
    {"title": "Вещевая служба",                                "role_kind": "otd"},
    {"title": "Продовольственная служба",                      "role_kind": "otd"},
    {"title": "Автомобильная служба",                          "role_kind": "otd"},
    {"title": "Инженерная служба",                             "role_kind": "otd"},
    {"title": "Воздушно-десантная служба",                     "role_kind": "otd"},
    {"title": "Служба горючего и смазочных материалов",        "role_kind": "otd"},
    {"title": "Служба артиллерийского вооружения",             "role_kind": "otd"},
    {"title": "Служба защиты государственной тайны",           "role_kind": "otd"},
    {"title": "Служба ППЗ и СР",                               "role_kind": "otd"},
    {"title": "Служба РХБЗ",                                   "role_kind": "otd"},
    # Прочее
    {"title": "ВАИ",                                           "role_kind": "otd"},
    {"title": "БАЗА (ОБЕСПЕЧЕНИЯ)",                            "role_kind": "otd"},
    {"title": "Оркестр - Военный дирижер",                     "role_kind": "otd"},
]


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
    """
    Slot отдаётся фронту с разворотом полей AlertPosition в плоскую
    структуру — UI как был, ничего менять не нужно. position_id отдаём
    отдельно, потому что фронт может пригодиться (для marks-логики).
    """
    id:          int
    list_id:     int
    position_id: int
    title:       str
    role_kind:   str
    sort_order:  int
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
    primary_person_id: Optional[int] = None
    primary_person_id_set: bool = False


class MarkOut(BaseModel):
    """
    slot_id оставлен в выдаче для бэк-совместимости фронта (он строит
    Map по этому ключу). Бэкенд по slot_id → position_id и работает.
    """
    slot_id:   int
    mark_date: date_type
    mark_type: str
    substitute_person: Optional[_PersonRef] = None


class MarkIn(BaseModel):
    mark_type:           str
    substitute_person_id: Optional[int] = None


class ReorderPayload(BaseModel):
    slot_ids: List[int]


class SeedPayload(BaseModel):
    pass


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _person_ref(p: Optional[Person]) -> Optional[_PersonRef]:
    if not p:
        return None
    return _PersonRef(
        id=p.id, full_name=p.full_name, rank=p.rank, position_title=p.position_title,
    )


def _slot_out(s: AlertSlot) -> SlotOut:
    pos = s.position
    return SlotOut(
        id=s.id,
        list_id=s.list_id,
        position_id=pos.id,
        title=pos.title,
        role_kind=pos.role_kind,
        sort_order=s.sort_order,
        primary_person=_person_ref(pos.primary_person),
    )


def _mark_out(slot_id: int, m: AlertMark) -> MarkOut:
    return MarkOut(
        slot_id=slot_id,
        mark_date=m.mark_date,
        mark_type=m.mark_type,
        substitute_person=_person_ref(m.substitute_person),
    )


def _get_or_create_position(db: Session, title: str, role_kind: str,
                            primary_person_id: Optional[int]) -> AlertPosition:
    """
    Найти AlertPosition по title или создать новую. role_kind /
    primary_person_id применяются только при создании; при существующей —
    не перезаписываем (если нужно изменить — через PATCH /slots/{id}).
    """
    title = title.strip()
    pos = db.query(AlertPosition).filter(AlertPosition.title == title).first()
    if pos:
        return pos
    pos = AlertPosition(
        title=title,
        role_kind=role_kind,
        primary_person_id=primary_person_id,
    )
    db.add(pos)
    db.flush()
    return pos


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
             summary="Добавить позицию в список")
async def create_slot(list_id: int, payload: SlotIn, db: Session = Depends(get_db)):
    if not db.query(AlertList).filter(AlertList.id == list_id).first():
        raise HTTPException(status_code=404, detail="Список не найден")
    if payload.role_kind not in ALL_ALERT_ROLES:
        raise HTTPException(status_code=400, detail=f"role_kind должен быть один из {ALL_ALERT_ROLES}")
    if payload.primary_person_id is not None:
        if not db.query(Person).filter(Person.id == payload.primary_person_id).first():
            raise HTTPException(status_code=400, detail="primary_person_id не найден")

    pos = _get_or_create_position(db, payload.title, payload.role_kind, payload.primary_person_id)
    # Если такая позиция уже есть в этом списке — отказ.
    exists = (
        db.query(AlertSlot)
        .filter(AlertSlot.list_id == list_id, AlertSlot.position_id == pos.id)
        .first()
    )
    if exists:
        raise HTTPException(status_code=409, detail="Эта должность уже есть в списке")

    slot = AlertSlot(list_id=list_id, position_id=pos.id, sort_order=payload.sort_order or 0)
    db.add(slot)
    db.commit()
    db.refresh(slot)
    await manager.broadcast({"action": "alert_lists_update"})
    return _slot_out(slot)


@router.patch("/slots/{slot_id}", response_model=SlotOut,
              summary="Изменить позицию (title/role/primary — общее; sort_order — у слота)")
async def patch_slot(slot_id: int, payload: SlotPatch, db: Session = Depends(get_db)):
    s = db.query(AlertSlot).filter(AlertSlot.id == slot_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Слот не найден")
    pos = s.position

    # title/role_kind/primary_person_id — это поля AlertPosition. Изменения
    # отразятся во всех списках где эта позиция присутствует.
    if payload.title is not None:
        new_title = payload.title.strip()
        if new_title != pos.title:
            # Если такой title уже есть у другой позиции — нельзя
            # (нарушит UNIQUE). UI должен валидировать заранее.
            other = db.query(AlertPosition).filter(
                AlertPosition.title == new_title,
                AlertPosition.id    != pos.id,
            ).first()
            if other:
                raise HTTPException(
                    status_code=409,
                    detail="Должность с таким названием уже существует. "
                           "Используйте её или придумайте другое имя.",
                )
            pos.title = new_title
    if payload.role_kind is not None:
        if payload.role_kind not in ALL_ALERT_ROLES:
            raise HTTPException(status_code=400, detail=f"role_kind должен быть один из {ALL_ALERT_ROLES}")
        pos.role_kind = payload.role_kind
    if payload.primary_person_id_set:
        if payload.primary_person_id is not None:
            if not db.query(Person).filter(Person.id == payload.primary_person_id).first():
                raise HTTPException(status_code=400, detail="primary_person_id не найден")
        pos.primary_person_id = payload.primary_person_id

    # sort_order — у самого AlertSlot, локально для списка.
    if payload.sort_order is not None:
        s.sort_order = payload.sort_order

    db.commit()
    db.refresh(s)
    await manager.broadcast({"action": "alert_lists_update"})
    return _slot_out(s)


@router.delete("/slots/{slot_id}", status_code=204,
               summary="Удалить позицию из списка (AlertPosition не трогается)")
async def delete_slot(slot_id: int, db: Session = Depends(get_db)):
    s = db.query(AlertSlot).filter(AlertSlot.id == slot_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Слот не найден")
    db.delete(s)
    db.commit()
    await manager.broadcast({"action": "alert_lists_update"})


@router.put("/{list_id}/slots/reorder", summary="Переупорядочить слоты списка (drag-n-drop)")
async def reorder_slots(list_id: int, payload: ReorderPayload, db: Session = Depends(get_db)):
    if not db.query(AlertList).filter(AlertList.id == list_id).first():
        raise HTTPException(status_code=404, detail="Список не найден")
    rows = (
        db.query(AlertSlot)
        .filter(AlertSlot.list_id == list_id, AlertSlot.id.in_(payload.slot_ids))
        .all()
    )
    by_id = {s.id: s for s in rows}
    for idx, sid in enumerate(payload.slot_ids):
        s = by_id.get(sid)
        if s:
            s.sort_order = idx
    db.commit()
    await manager.broadcast({"action": "alert_lists_update", "list_id": list_id})
    return {"updated": len(by_id)}


# ─── Шаблон ──────────────────────────────────────────────────────────────────

@router.get("/template/preview", summary="Шаблон стандартных позиций")
def template_preview():
    return DEFAULT_SLOT_TEMPLATES


@router.post("/{list_id}/slots/seed",
             summary="Заполнить список стандартными позициями (idempotent)")
async def seed_slots(list_id: int, payload: SeedPayload, db: Session = Depends(get_db)):
    """
    Для каждой записи шаблона:
      • если AlertPosition с таким title нет — создаём
      • если в этом списке этой position_id ещё нет — добавляем AlertSlot
      • иначе — пропускаем

    sort_order у новых слотов продолжается от текущего max.
    """
    if not db.query(AlertList).filter(AlertList.id == list_id).first():
        raise HTTPException(status_code=404, detail="Список не найден")

    existing_position_ids = {
        row[0] for row in
        db.query(AlertSlot.position_id).filter(AlertSlot.list_id == list_id).all()
    }
    max_order = (
        db.query(AlertSlot.sort_order)
        .filter(AlertSlot.list_id == list_id)
        .order_by(AlertSlot.sort_order.desc())
        .first()
    )
    next_order = (max_order[0] + 1) if max_order else 0

    created = 0
    skipped = 0
    for tpl in DEFAULT_SLOT_TEMPLATES:
        pos = _get_or_create_position(db, tpl["title"], tpl["role_kind"], None)
        if pos.id in existing_position_ids:
            skipped += 1
            continue
        slot = AlertSlot(list_id=list_id, position_id=pos.id, sort_order=next_order)
        db.add(slot)
        existing_position_ids.add(pos.id)
        next_order += 1
        created += 1

    db.commit()
    await manager.broadcast({"action": "alert_lists_update", "list_id": list_id})
    return {"created": created, "skipped": skipped, "total": created + skipped}


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
    # Отметки общие на position. Нам нужно отдать их «по слотам этого
    # списка» — фронт работает с slot_id. Делаем join.
    rows = (
        db.query(AlertSlot.id, AlertMark)
        .join(AlertMark, AlertMark.position_id == AlertSlot.position_id)
        .filter(
            AlertSlot.list_id == list_id,
            AlertMark.mark_date >= date_type(year, month, 1),
            AlertMark.mark_date <= date_type(year, month, last),
        )
        .all()
    )
    return [_mark_out(slot_id, m) for slot_id, m in rows]


@router.put("/slots/{slot_id}/marks/{mark_date}", response_model=MarkOut,
            summary="Поставить/обновить отметку (на ДОЛЖНОСТЬ — видна в обоих списках)")
async def upsert_mark(
    slot_id:   int,
    mark_date: date_type,
    payload:   MarkIn,
    db:        Session = Depends(get_db),
):
    slot = db.query(AlertSlot).filter(AlertSlot.id == slot_id).first()
    if not slot:
        raise HTTPException(status_code=404, detail="Слот не найден")
    position_id = slot.position_id

    if payload.mark_type not in ALL_ALERT_MARK_TYPES:
        raise HTTPException(status_code=400, detail=f"mark_type должен быть один из {ALL_ALERT_MARK_TYPES}")

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
        sub_id = None

    existing = (
        db.query(AlertMark)
        .filter(AlertMark.position_id == position_id, AlertMark.mark_date == mark_date)
        .first()
    )
    if existing:
        existing.mark_type = payload.mark_type
        existing.substitute_person_id = sub_id
        mark = existing
    else:
        mark = AlertMark(
            position_id=position_id,
            mark_date=mark_date,
            mark_type=payload.mark_type,
            substitute_person_id=sub_id,
        )
        db.add(mark)
    db.commit()
    db.refresh(mark)
    await manager.broadcast({"action": "alert_lists_update"})
    return _mark_out(slot_id, mark)


@router.delete("/slots/{slot_id}/marks/{mark_date}", status_code=204,
               summary="Снять отметку")
async def delete_mark(
    slot_id:   int,
    mark_date: date_type,
    db:        Session = Depends(get_db),
):
    slot = db.query(AlertSlot).filter(AlertSlot.id == slot_id).first()
    if not slot:
        return
    mark = (
        db.query(AlertMark)
        .filter(AlertMark.position_id == slot.position_id,
                AlertMark.mark_date  == mark_date)
        .first()
    )
    if not mark:
        return
    db.delete(mark)
    db.commit()
    await manager.broadcast({"action": "alert_lists_update"})


# ─── Экспорт в Word на конкретный день ───────────────────────────────────────

@router.get("/{list_id}/export-docx", summary="Экспорт списка на конкретный день в .docx")
def export_alert_list_docx(
    list_id: int,
    on_date: date_type = Query(..., description="День, на который формируется список"),
    db:      Session = Depends(get_db),
):
    from io import BytesIO
    from urllib.parse import quote
    from fastapi.responses import StreamingResponse
    from docx import Document
    from docx.shared import Pt, Cm
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    alert_list = db.query(AlertList).filter(AlertList.id == list_id).first()
    if not alert_list:
        raise HTTPException(status_code=404, detail="Список не найден")

    slots = (
        db.query(AlertSlot)
        .filter(AlertSlot.list_id == list_id)
        .order_by(AlertSlot.sort_order.asc(), AlertSlot.id.asc())
        .all()
    )

    position_ids = [s.position_id for s in slots]
    marks = []
    if position_ids:
        marks = (
            db.query(AlertMark)
            .filter(
                AlertMark.position_id.in_(position_ids),
                AlertMark.mark_date == on_date,
            )
            .all()
        )
    marks_by_position = {m.position_id: m for m in marks}

    MARK_TITLES = {"N": "Наряд", "O": "Ответственный", "V": "Отпуск"}

    doc = Document()
    section = doc.sections[0]
    section.left_margin   = Cm(1.5)
    section.right_margin  = Cm(1.5)
    section.top_margin    = Cm(1.0)
    section.bottom_margin = Cm(1.0)

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run(f"{alert_list.name}\nна {on_date.strftime('%d.%m.%Y')}")
    run.bold = True
    run.font.size = Pt(14)

    table = doc.add_table(rows=1, cols=4)
    table.style = "Light Grid Accent 1"
    hdr = table.rows[0].cells
    hdr[0].text = "№"
    hdr[1].text = "Должность"
    hdr[2].text = "ФИО"
    hdr[3].text = "Отметка"
    for c in hdr:
        for para in c.paragraphs:
            for run in para.runs:
                run.bold = True

    for idx, slot in enumerate(slots, start=1):
        pos = slot.position
        mark = marks_by_position.get(pos.id)
        who = None
        suffix = ""
        if mark and mark.mark_type == "V" and mark.substitute_person:
            who = mark.substitute_person
            suffix = " (замещает)"
        elif pos.primary_person:
            who = pos.primary_person
        full_name = who.full_name if who else "—"
        rank      = (who.rank + " ") if who and who.rank else ""

        mark_label = MARK_TITLES.get(mark.mark_type, "") if mark else ""

        row = table.add_row().cells
        row[0].text = str(idx)
        row[1].text = pos.title
        row[2].text = f"{rank}{full_name}{suffix}"
        row[3].text = mark_label

    buf = BytesIO()
    doc.save(buf)
    buf.seek(0)

    filename = f"{alert_list.name.replace(' ', '_')}_{on_date.strftime('%Y-%m-%d')}.docx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition":
                f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}",
        },
    )


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
    qry = db.query(Person).filter(Person.fired_at.is_(None))
    if role in ("upr", "otd") and root:
        qry = qry.filter(Person.position_title.ilike(f"%{root}%"))
    if q:
        qry = qry.filter(Person.full_name.ilike(f"%{q}%"))
    rows = qry.order_by(Person.full_name.asc()).limit(40).all()
    return [_person_ref(p) for p in rows if p]
