# app/api/v1/routers/dashboard.py
"""
Дашборд готовности — главный экран администратора.

GET /admin/dashboard/today    — сводка на сегодня (или указанную дату)
GET /admin/dashboard/calendar — события за диапазон дат (для мини-календаря)

ИСПРАВЛЕНИЕ N+1:
  Был: selectinload(Group.slots) без загрузки Position.
       В build_event_summary каждый slot.position.name вызывал отдельный SELECT.
       При 100 пустых слотах = 100 лишних запросов.
  Стал: selectinload(Group.slots).joinedload(Slot.position)
        Position загружается одним JOIN в том же запросе — 0 дополнительных SELECT.
"""

from datetime import date as date_type
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload, joinedload

from app.db.database import get_db
from app.models.user import User
from app.models.event import Event, Group, Slot
from app.api.dependencies import get_current_active_admin

router = APIRouter()


# ─── Эндпоинт 1: Сводка за дату ──────────────────────────────────────────────

@router.get("/dashboard/today")
def get_dashboard(
    target_date: Optional[date_type] = Query(default=None, alias="date"),
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_active_admin),
):
    """
    Возвращает сводку готовности всех списков за указанную дату.
    Если дата не передана — берёт сегодня.

    Ответ:
    {
      "date": "2026-04-04",
      "events": [
        {
          "id": 1,
          "title": "...",
          "status": "active",
          "total_slots": 10,
          "filled_slots": 7,
          "empty_slots": 3,
          "fill_pct": 70,
          "departments": [
            {
              "name": "upr_1",
              "total": 4,
              "filled": 3,
              "empty": 1,
              "fill_pct": 75,
              "empty_positions": ["— звание ФИО (должность)", ...]
            }
          ]
        }
      ],
      "total_slots": 30,
      "filled_slots": 22,
      "fill_pct": 73,
      "events_without_date": [ ... ]
    }
    """
    if target_date is None:
        target_date = date_type.today()

    # ── Опции загрузки: Position джойним чтобы не делать N+1 ─────────────────
    load_options = (
        selectinload(Event.groups)
        .selectinload(Group.slots)
        .joinedload(Slot.position)   # ← ИСПРАВЛЕНИЕ: убирает N+1 при slot.position.name
    )

    # Все активные НЕ-шаблонные списки за дату
    events_on_date = (
        db.query(Event)
        .filter(
            Event.date        == target_date,
            Event.is_template == False,
        )
        .options(load_options)
        .order_by(Event.id)
        .all()
    )

    # Активные списки без даты (всегда показываем)
    events_no_date = (
        db.query(Event)
        .filter(
            Event.date        == None,
            Event.is_template == False,
            Event.status      == "active",
        )
        .options(load_options)
        .order_by(Event.id)
        .all()
    )

    def build_event_summary(event: Event) -> dict:
        all_slots = []
        for group in event.groups:
            all_slots.extend(group.slots)

        total  = len(all_slots)
        filled = sum(1 for s in all_slots if s.full_name and s.full_name.strip())
        empty  = total - filled

        # Группировка по управлению
        dept_map: dict = {}
        for slot in all_slots:
            dept = slot.department or "—"
            if dept not in dept_map:
                dept_map[dept] = {"total": 0, "filled": 0, "empty_slots_info": []}
            dept_map[dept]["total"] += 1
            if slot.full_name and slot.full_name.strip():
                dept_map[dept]["filled"] += 1
            else:
                # slot.position уже загружен joinedload — дополнительного SELECT нет
                pos_name = slot.position.name if slot.position else "?"
                dept_map[dept]["empty_slots_info"].append(pos_name)

        departments = []
        for dept_name, data in sorted(dept_map.items()):
            dept_total  = data["total"]
            dept_filled = data["filled"]
            dept_empty  = dept_total - dept_filled
            departments.append({
                "name":            dept_name,
                "total":           dept_total,
                "filled":          dept_filled,
                "empty":           dept_empty,
                "fill_pct":        round(dept_filled / dept_total * 100) if dept_total else 0,
                "empty_positions": data["empty_slots_info"][:5],  # максимум 5 для UI
            })

        return {
            "id":           event.id,
            "title":        event.title,
            "status":       event.status,
            "date":         event.date.isoformat() if event.date else None,
            "total_slots":  total,
            "filled_slots": filled,
            "empty_slots":  empty,
            "fill_pct":     round(filled / total * 100) if total else 0,
            "departments":  departments,
        }

    events_summary    = [build_event_summary(e) for e in events_on_date]
    no_date_summary   = [build_event_summary(e) for e in events_no_date]

    all_for_total = events_summary
    total_slots   = sum(e["total_slots"]  for e in all_for_total)
    filled_slots  = sum(e["filled_slots"] for e in all_for_total)

    return {
        "date":                target_date.isoformat(),
        "events":              events_summary,
        "events_without_date": no_date_summary,
        "total_slots":         total_slots,
        "filled_slots":        filled_slots,
        "empty_slots":         total_slots - filled_slots,
        "fill_pct":            round(filled_slots / total_slots * 100) if total_slots else 0,
    }


# ─── Эндпоинт 2: Календарь (точки активности) ────────────────────────────────

@router.get("/dashboard/calendar")
def get_calendar_dots(
    year:  int = Query(...),
    month: int = Query(..., ge=1, le=12),
    db:    Session = Depends(get_db),
    admin: User    = Depends(get_current_active_admin),
):
    """
    Возвращает список дат в месяце у которых есть активные списки.
    Используется для рисования точек на мини-календаре.

    Оптимально: делает один агрегирующий GROUP BY запрос,
    не загружает сами события в память.
    """
    from calendar import monthrange
    _, days  = monthrange(year, month)
    date_from = date_type(year, month, 1)
    date_to   = date_type(year, month, days)

    rows = (
        db.query(Event.date, func.count(Event.id).label("cnt"))
        .filter(
            Event.date        >= date_from,
            Event.date        <= date_to,
            Event.is_template == False,
        )
        .group_by(Event.date)
        .all()
    )

    return {
        "dates": [
            {
                "date":  row.date.isoformat(),
                "count": row.cnt,
            }
            for row in rows
        ]
    }