# app/api/v1/routers/analytics.py
"""
Аналитика по спискам, должностям, людям, нарядам.

Endpoint /admin/analytics/overview возвращает все агрегаты одним запросом —
фронт строит дашборд без N+1 GET'ов. Все запросы идут через GROUP BY/COUNT
на индексированных полях, поэтому работают быстро даже на 10k+ слотов.
"""
from collections import defaultdict
from datetime import date as date_type, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, case, distinct
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.user import User
from app.models.event import Event, Group, Slot, Position
from app.models.person import Person
from app.models.duty import DutyMark, MARK_DUTY
from app.api.dependencies import get_current_active_admin


router = APIRouter()


@router.get("/overview", summary="Сводная аналитика для админ-дашборда")
def analytics_overview(
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    # ── Глобальные цифры ──────────────────────────────────────────────────────
    totals = {
        "templates":       db.query(Event).filter(Event.is_template == True).count(),
        "events":          db.query(Event).filter(Event.is_template == False).count(),
        "persons_active":  db.query(Person).filter(Person.fired_at.is_(None)).count(),
        "persons_fired":   db.query(Person).filter(Person.fired_at.isnot(None)).count(),
        "total_slots":     db.query(Slot).count(),
        # filled = full_name есть и не пустая строка
        "filled_slots":    db.query(Slot)
                             .filter(Slot.full_name.isnot(None))
                             .filter(func.length(func.trim(Slot.full_name)) > 0)
                             .count(),
    }
    totals["fill_rate"] = (
        round(100 * totals["filled_slots"] / totals["total_slots"], 1)
        if totals["total_slots"] else 0
    )

    # ── По управлениям (department) ───────────────────────────────────────────
    # Считаем только слоты в реальных списках, не в шаблонах — статистика
    # по «работе» управлений, а не по проектам.
    is_filled = case(
        (func.length(func.coalesce(func.trim(Slot.full_name), "")) > 0, 1),
        else_=0,
    )
    user_rows = (
        db.query(
            Slot.department.label("department"),
            func.count(Slot.id).label("total"),
            func.sum(is_filled).label("filled"),
            func.count(distinct(Group.event_id)).label("events_count"),
        )
        .join(Group, Group.id == Slot.group_id)
        .join(Event, Event.id == Group.event_id)
        .filter(Event.is_template == False)
        .group_by(Slot.department)
        .order_by(func.count(Slot.id).desc())
        .all()
    )
    users = [
        {
            "department":   r.department or "—",
            "total":        int(r.total or 0),
            "filled":       int(r.filled or 0),
            "fill_rate":    round(100 * (r.filled or 0) / r.total, 1) if r.total else 0,
            "events_count": int(r.events_count or 0),
        }
        for r in user_rows
    ]

    # ── По должностям ─────────────────────────────────────────────────────────
    # LEFT JOIN от Position — тогда видны и «мёртвые» должности
    # (slot_count=0).
    pos_rows = (
        db.query(
            Position.id.label("id"),
            Position.name.label("name"),
            func.count(Slot.id).label("slot_count"),
            func.sum(is_filled).label("filled_count"),
        )
        .outerjoin(Slot, Slot.position_id == Position.id)
        .group_by(Position.id, Position.name)
        .order_by(func.count(Slot.id).desc(), Position.name.asc())
        .all()
    )
    positions = [
        {
            "id":           int(r.id),
            "name":         r.name,
            "slot_count":   int(r.slot_count or 0),
            "filled_count": int(r.filled_count or 0),
        }
        for r in pos_rows
    ]

    # ── Топ нарядов (по графикам наряда) ──────────────────────────────────────
    # За последние 90 дней — чаще всего в нарядах.
    cutoff = date_type.today() - timedelta(days=90)
    duty_rows = (
        db.query(
            DutyMark.person_id,
            func.count(DutyMark.id).label("cnt"),
        )
        .filter(DutyMark.mark_type == MARK_DUTY)
        .filter(DutyMark.duty_date >= cutoff)
        .group_by(DutyMark.person_id)
        .order_by(func.count(DutyMark.id).desc())
        .limit(10)
        .all()
    )
    person_ids = [r.person_id for r in duty_rows]
    persons_map = {
        p.id: p for p in
        db.query(Person).filter(Person.id.in_(person_ids)).all()
    } if person_ids else {}
    duty_top = [
        {
            "person_id": r.person_id,
            "full_name": persons_map.get(r.person_id).full_name if persons_map.get(r.person_id) else f"#{r.person_id}",
            "rank":      persons_map.get(r.person_id).rank if persons_map.get(r.person_id) else None,
            "count":     int(r.cnt or 0),
        }
        for r in duty_rows
    ]

    # ── Люди-«призраки»: ни разу не назначены и не в нарядах ────────────────
    # Сначала — id всех, кто хоть раз появлялся в slots или duty_marks
    used_in_slots = {row[0] for row in
                     db.query(distinct(Slot.full_name)).filter(Slot.full_name.isnot(None)).all()
                     if row[0]}
    used_in_duty  = {row[0] for row in db.query(distinct(DutyMark.person_id)).all()}

    persons_all = (
        db.query(Person)
        .filter(Person.fired_at.is_(None))
        .all()
    )
    ghosts = []
    for p in persons_all:
        # Имя в слотах хранится текстом (Slot.full_name == person.full_name).
        # Этого достаточно для «призрак» — человек не упоминался нигде.
        if p.full_name in used_in_slots: continue
        if p.id          in used_in_duty:  continue
        ghosts.append({
            "id":         p.id,
            "full_name":  p.full_name,
            "rank":       p.rank,
            "department": p.department,
        })
    # Топ-30 хватает админу, чтобы не перегружать ответ.
    ghosts = ghosts[:30]
    ghosts_total = len([
        p for p in persons_all
        if p.full_name not in used_in_slots and p.id not in used_in_duty
    ])

    return {
        "totals":       totals,
        "users":        users,
        "positions":    positions,
        "duty_top":     duty_top,
        "ghosts":       ghosts,
        "ghosts_total": ghosts_total,
    }
