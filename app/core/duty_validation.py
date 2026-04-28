# app/core/duty_validation.py
"""
Валидация расстановки нарядов: запрет «слишком близких» дежурств у одного
человека.

Правила (по требованию штаба):
  • Дельта 1 день  (соседние дни, например 9 и 10) → запрет, обойти нельзя.
  • Дельта 2 дня   (через сутки, например 9 и 11)  → предупреждение.
                   Можно поставить, если клиент пришёл с force=True.
  • Дельта ≥ 3 дня → молча пропускается.

Игнорируется:
  • существующая отметка на ту же дату (дельта=0) — её обрабатывает
    основная toggle-логика в роутере (snimaet/переключает тип);
  • отметки других типов (U/V/R) — проверка только между нарядами 'N'.
"""

from datetime import date as date_type, timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.duty import DutyMark, MARK_DUTY


def validate_duty_interval(
    db:          Session,
    schedule_id: int,
    person_id:   int,
    duty_date:   date_type,
    *,
    force:       bool = False,
) -> None:
    """
    При нарушении бросает HTTPException 409 с machine-readable detail:
        {
            "code":          "duty_too_close_strict" | "duty_too_close_warn",
            "message":       "...",
            "previous_date": "YYYY-MM-DD",
        }

    Фронт смотрит на code: для 'warn' — показать confirm и повторить запрос
    с force=True, для 'strict' — просто показать сообщение.
    """
    # Окно ±2 дня — больше нам не интересно (дельта ≥3 = ОК).
    nearby_dates = (
        db.query(DutyMark.duty_date)
        .filter(
            DutyMark.schedule_id == schedule_id,
            DutyMark.person_id   == person_id,
            DutyMark.mark_type   == MARK_DUTY,
            DutyMark.duty_date   >= duty_date - timedelta(days=2),
            DutyMark.duty_date   <= duty_date + timedelta(days=2),
            DutyMark.duty_date   != duty_date,         # сам же день не считаем
        )
        .all()
    )

    for (other,) in nearby_dates:
        delta = abs((duty_date - other).days)
        if delta == 1:
            raise HTTPException(status_code=409, detail={
                "code":          "duty_too_close_strict",
                "message":       (
                    f"Нельзя ставить наряды в соседние дни. "
                    f"У человека уже наряд {other.strftime('%d.%m.%Y')}."
                ),
                "previous_date": other.isoformat(),
            })
        if delta == 2 and not force:
            raise HTTPException(status_code=409, detail={
                "code":          "duty_too_close_warn",
                "message":       (
                    f"У этого человека наряд {other.strftime('%d.%m.%Y')} "
                    f"(через сутки от выбранной даты). Поставить всё равно?"
                ),
                "previous_date": other.isoformat(),
            })
