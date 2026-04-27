# app/core/duty_approvals.py
"""
Общая логика утверждения графиков наряда.

Используется и dept_duty роутером, и admin-duty роутером — чтобы snapshot
создавался одинаково (денормализованные копии состава и отметок за месяц).

Правила, которые тут зафиксированы:
  • Один snapshot на пару (schedule_id, year, month) — без версий.
  • При повторном approve старый snapshot удаляется, создаётся новый.
  • Snapshot копирует full_name / rank / doc_number каждого человека на
    момент утверждения — чтобы последующие увольнения и переименования
    не ломали историю.
  • Отметки snapshot'а берутся строго за месяц (start ≤ duty_date < next_month).
"""

from calendar import monthrange
from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

from app.models.duty import (
    DutySchedule,
    DutySchedulePerson,
    DutyMark,
    DutyScheduleApproval,
    DutyScheduleApprovalPerson,
    DutyScheduleApprovalMark,
)


def get_approval(
        db:          Session,
        schedule_id: int,
        year:        int,
        month:       int,
) -> DutyScheduleApproval | None:
    """Возвращает snapshot за месяц (или None, если draft)."""
    return (
        db.query(DutyScheduleApproval)
          .filter(
              DutyScheduleApproval.schedule_id == schedule_id,
              DutyScheduleApproval.year        == year,
              DutyScheduleApproval.month       == month,
          )
          .first()
    )


def approve_month(
        db:             Session,
        schedule_id:    int,
        year:           int,
        month:          int,
        approved_by_id: int | None,
) -> DutyScheduleApproval:
    """
    Утверждает график за месяц.

    Логика:
      1. Если snapshot за этот месяц уже существует — удаляем его
         (cascade уберёт *_persons и *_marks). Это эквивалент
         «повторно утвердить после правок» — версий не храним.
      2. Создаём новую запись DutyScheduleApproval.
      3. Копируем текущий состав (duty_schedule_persons) → approval_persons.
      4. Копируем все отметки за этот месяц (duty_marks) → approval_marks.

    Все three вставки идут в одной транзакции — если что-то упадёт,
    состояние остаётся как было (db.rollback на уровне endpoint'а).

    Возвращает свежесозданную запись со всеми relationship'ами загружены.
    """
    # Удаляем предыдущий snapshot если был
    existing = get_approval(db, schedule_id, year, month)
    if existing is not None:
        db.delete(existing)
        db.flush()

    approval = DutyScheduleApproval(
        schedule_id         = schedule_id,
        year                = year,
        month               = month,
        approved_at         = datetime.now(timezone.utc),
        approved_by_user_id = approved_by_id,
    )
    db.add(approval)
    db.flush()  # нужен id

    # Копируем состав. joinedload избыточен — обращаемся только к полям Person.
    persons = (
        db.query(DutySchedulePerson)
          .filter(DutySchedulePerson.schedule_id == schedule_id)
          .order_by(DutySchedulePerson.order_num, DutySchedulePerson.id)
          .all()
    )
    for dsp in persons:
        p = dsp.person
        snap = DutyScheduleApprovalPerson(
            approval_id = approval.id,
            person_id   = dsp.person_id,
            full_name   = p.full_name if p else "—",
            rank        = p.rank       if p else None,
            doc_number  = p.doc_number if p else None,
            order_num   = dsp.order_num,
        )
        db.add(snap)

    # Копируем отметки за месяц
    last_day = monthrange(year, month)[1]
    month_start = date(year, month, 1)
    month_end   = date(year, month, last_day)
    marks = (
        db.query(DutyMark)
          .filter(
              DutyMark.schedule_id == schedule_id,
              DutyMark.duty_date   >= month_start,
              DutyMark.duty_date   <= month_end,
          )
          .all()
    )
    for m in marks:
        p = m.person
        snap_mark = DutyScheduleApprovalMark(
            approval_id       = approval.id,
            person_id         = m.person_id,
            full_name_at_time = p.full_name if p else "—",
            duty_date         = m.duty_date,
            mark_type         = m.mark_type,
        )
        db.add(snap_mark)

    db.flush()
    return approval


def unapprove_month(
        db:          Session,
        schedule_id: int,
        year:        int,
        month:       int,
) -> bool:
    """
    Снимает утверждение за месяц: удаляет snapshot (cascade уносит persons и marks).
    Возвращает True если что-то удалено, False если snapshot'а не было.
    """
    existing = get_approval(db, schedule_id, year, month)
    if existing is None:
        return False
    db.delete(existing)
    db.flush()
    return True
