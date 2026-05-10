# app/api/v1/routers/analytics.py
"""
Аналитика по спискам, должностям, людям, нарядам.

Endpoint /admin/analytics/overview возвращает все агрегаты одним запросом —
фронт строит дашборд без N+1 GET'ов. Все запросы идут через GROUP BY/COUNT
на индексированных полях, поэтому работают быстро даже на 10k+ слотов.
"""
from collections import defaultdict
from datetime import date as date_type, timedelta

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, case, distinct
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_active_admin
from app.core.config import settings
from app.core.limiter import limiter
from app.db.database import get_db
from app.models.duty import DutyMark, DutySchedule, DutySchedulePerson, MARK_DUTY, DUTY_KIND_DUTY
from app.models.event import Event, Group, Slot, Position
from app.models.person import Person
from app.models.user import User


router = APIRouter()


@router.get("/overview", summary="Сводная аналитика для админ-дашборда")
@limiter.limit(lambda: settings.ANALYTICS_RATE_LIMIT)
def analytics_overview(
        request:       Request,
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

    # ── Перегруз/недогруз в нарядах за 90 дней ──────────────────────────────
    # avg считаем по тем у кого хоть один N-наряд за период; иначе среднее
    # размывается «бездельниками» и пороги получаются нереалистично низкими.
    duty_count_rows = (
        db.query(
            DutyMark.person_id,
            func.count(DutyMark.id).label("cnt"),
        )
        .filter(DutyMark.mark_type == MARK_DUTY)
        .filter(DutyMark.duty_date >= cutoff)
        .group_by(DutyMark.person_id)
        .all()
    )
    counts_map = {r.person_id: int(r.cnt or 0) for r in duty_count_rows}
    avg_per_person = (
        round(sum(counts_map.values()) / len(counts_map), 2)
        if counts_map else 0.0
    )
    threshold_high = round(avg_per_person * 1.5, 1) if avg_per_person else 0
    threshold_low  = round(avg_per_person * 0.4, 1) if avg_per_person else 0

    # Тянем Person'ов одним запросом для всех cnt>0
    load_pids = list(counts_map.keys())
    load_persons = (
        db.query(Person).filter(Person.id.in_(load_pids)).all()
        if load_pids else []
    )
    load_persons_map = {p.id: p for p in load_persons}

    overloaded = []
    underloaded = []
    if avg_per_person > 0:
        for pid, cnt in counts_map.items():
            p = load_persons_map.get(pid)
            if not p or p.fired_at is not None:
                continue
            entry = {
                "person_id":    pid,
                "full_name":    p.full_name,
                "rank":         p.rank,
                "department":   p.department,
                "count":        cnt,
                "pct_of_avg":   round(100 * cnt / avg_per_person, 0) if avg_per_person else 0,
            }
            if cnt >= threshold_high:
                overloaded.append(entry)
            elif cnt <= threshold_low:
                underloaded.append(entry)
        overloaded.sort(key=lambda e: e["count"], reverse=True)
        underloaded.sort(key=lambda e: e["count"])

    duty_load = {
        "period_days":      90,
        "active_with_duty": len(counts_map),
        "avg_per_person":   avg_per_person,
        "threshold_high":   threshold_high,
        "threshold_low":    threshold_low,
        "overloaded":       overloaded[:15],   # топ-15 чтобы не переполнять UI
        "underloaded":      underloaded[:15],
    }

    # ── Здоровье Базы людей ─────────────────────────────────────────────────
    active_persons = persons_all   # уже загрузили выше
    no_position = sum(1 for p in active_persons if not (p.position_title or "").strip())
    no_phone    = sum(1 for p in active_persons if not (p.phone or "").strip())
    no_department = sum(1 for p in active_persons if not (p.department or "").strip())

    # Дубликаты по нормализованному телефону / номеру документа.
    from collections import defaultdict as _dd
    by_phone = _dd(list)
    by_doc   = _dd(list)
    for p in active_persons:
        ph = (p.phone or "").strip()
        if ph:
            # Нормализуем для группировки: только цифры, последние 10
            digits = "".join(ch for ch in ph if ch.isdigit())
            if len(digits) >= 10:
                key = digits[-10:]
                by_phone[key].append(p)
        dn = (p.doc_number or "").strip()
        if dn:
            by_doc[dn].append(p)

    dup_phones = [
        {
            "key":     k,
            "persons": [{"id": p.id, "full_name": p.full_name, "phone": p.phone} for p in ps],
        }
        for k, ps in by_phone.items() if len(ps) > 1
    ]
    dup_docs = [
        {
            "key":     k,
            "persons": [{"id": p.id, "full_name": p.full_name, "doc_number": p.doc_number} for p in ps],
        }
        for k, ps in by_doc.items() if len(ps) > 1
    ]

    data_health = {
        "total_active":  len(active_persons),
        "no_position":   no_position,
        "no_phone":      no_phone,
        "no_department": no_department,
        "dup_phones":    dup_phones[:30],
        "dup_phones_total": len(dup_phones),
        "dup_docs":      dup_docs[:30],
        "dup_docs_total": len(dup_docs),
    }

    # ── Дни без покрытия в графиках нарядов (текущий месяц) ─────────────────
    # Для каждого активного DutySchedule (kind=duty) с привязанными людьми —
    # дни текущего месяца без N-отметки. Это «забытые» дни в графике.
    today = date_type.today()
    month_start = today.replace(day=1)
    if month_start.month == 12:
        next_month = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month = month_start.replace(month=month_start.month + 1)
    month_end = next_month - timedelta(days=1)

    schedules_with_persons = (
        db.query(
            DutySchedule.id,
            DutySchedule.title,
            DutySchedule.position_name,
            func.count(distinct(DutySchedulePerson.person_id)).label("persons_cnt"),
        )
        .outerjoin(DutySchedulePerson, DutySchedulePerson.schedule_id == DutySchedule.id)
        .filter(DutySchedule.kind == DUTY_KIND_DUTY)
        .group_by(DutySchedule.id, DutySchedule.title, DutySchedule.position_name)
        .having(func.count(distinct(DutySchedulePerson.person_id)) > 0)
        .all()
    )
    sched_ids = [r.id for r in schedules_with_persons]

    # Все N-отметки за месяц по этим графикам — одним запросом
    marks_by_sched: dict[int, set] = defaultdict(set)
    if sched_ids:
        mark_rows = (
            db.query(DutyMark.schedule_id, DutyMark.duty_date)
            .filter(DutyMark.schedule_id.in_(sched_ids))
            .filter(DutyMark.mark_type == MARK_DUTY)
            .filter(DutyMark.duty_date >= month_start)
            .filter(DutyMark.duty_date <= month_end)
            .all()
        )
        for sid, d in mark_rows:
            marks_by_sched[sid].add(d)

    uncovered = []
    days_in_month = (month_end - month_start).days + 1
    all_days = [month_start + timedelta(days=i) for i in range(days_in_month)]
    for r in schedules_with_persons:
        existing_days = marks_by_sched.get(r.id, set())
        missing = [d.isoformat() for d in all_days if d not in existing_days]
        if not missing:
            continue
        uncovered.append({
            "schedule_id":   r.id,
            "schedule_title": r.title,
            "position_name":  r.position_name,
            "persons_cnt":    int(r.persons_cnt or 0),
            "missing_dates":  missing,
            "missing_count":  len(missing),
        })
    # Сортируем — больше пропусков сверху.
    uncovered.sort(key=lambda x: x["missing_count"], reverse=True)

    # ── Тренды за последние 12 ISO-недель ───────────────────────────────────
    # Считаем weekly-агрегаты: % заполнения списков (по событиям с date в
    # неделе), число N-нарядов за неделю, среднее N на активного человека
    # с нарядами в эту неделю.
    weeks_count = 12
    today_d = date_type.today()
    # Понедельник текущей недели: weekday() — 0=пн, 6=вс.
    cur_monday = today_d - timedelta(days=today_d.weekday())
    week_starts = [cur_monday - timedelta(weeks=(weeks_count - 1 - i)) for i in range(weeks_count)]
    week_labels = [d.strftime("%d.%m") for d in week_starts]

    # Fill rate по неделям — берём слоты в реальных списках, чья event.date
    # попадает в эту неделю. Если событий нет — null (не 0!), чтобы линия
    # не «ныряла» к нулю в пустых неделях.
    fill_rate_weekly: list = []
    for ws in week_starts:
        we = ws + timedelta(days=6)
        row = (
            db.query(
                func.count(Slot.id).label("total"),
                func.sum(is_filled).label("filled"),
            )
            .join(Group, Group.id == Slot.group_id)
            .join(Event, Event.id == Group.event_id)
            .filter(Event.is_template == False)
            .filter(Event.date >= ws, Event.date <= we)
            .first()
        )
        total  = int(row.total or 0) if row else 0
        filled = int(row.filled or 0) if row else 0
        fill_rate_weekly.append(
            round(100 * filled / total, 1) if total else None
        )

    # N-наряды по неделям + среднее на человека с нарядами.
    duty_count_weekly: list = []
    avg_duty_weekly:  list = []
    for ws in week_starts:
        we = ws + timedelta(days=6)
        rows = (
            db.query(
                DutyMark.person_id,
                func.count(DutyMark.id).label("cnt"),
            )
            .filter(DutyMark.mark_type == MARK_DUTY)
            .filter(DutyMark.duty_date >= ws, DutyMark.duty_date <= we)
            .group_by(DutyMark.person_id)
            .all()
        )
        total_n   = sum(int(r.cnt or 0) for r in rows)
        unique_p  = len(rows)
        duty_count_weekly.append(total_n)
        avg_duty_weekly.append(round(total_n / unique_p, 2) if unique_p else None)

    trends = {
        "weeks":       week_labels,
        "week_starts": [d.isoformat() for d in week_starts],
        "fill_rate":   fill_rate_weekly,
        "duty_count":  duty_count_weekly,
        "duty_avg":    avg_duty_weekly,
    }

    return {
        "totals":       totals,
        "users":        users,
        "positions":    positions,
        "duty_top":     duty_top,
        "ghosts":       ghosts,
        "ghosts_total": ghosts_total,
        "duty_load":    duty_load,
        "data_health":  data_health,
        "uncovered":    uncovered,
        "uncovered_month": {"year": month_start.year, "month": month_start.month},
        "trends":       trends,
    }
