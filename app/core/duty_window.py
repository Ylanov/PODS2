# app/core/duty_window.py
"""
Окно подачи/редактирования графиков нарядов для управлений.

Каждый день с 09:00 до 16:00 (МСК, UTC+3) управления могут:
  - редактировать составы и отметки в своих графиках,
  - утверждать/отзывать утверждение за месяц.

Вне окна — все «пишущие» операции возвращают 403. Админ не ограничен.

Часовой пояс: фиксированный UTC+3 (Россия не использует переход на летнее
время с 2014), чтобы не тащить tzdata-зависимость на Windows.
"""

from datetime import datetime, timedelta, time, timezone

from fastapi import Depends, HTTPException, status

from app.api.dependencies import get_current_user
from app.models.user import User


MSK = timezone(timedelta(hours=3))
WINDOW_START = time(9, 0)
WINDOW_END   = time(16, 0)


def _now_msk() -> datetime:
    return datetime.now(MSK)


def is_window_open(now: datetime | None = None) -> bool:
    now = now or _now_msk()
    t = now.timetz().replace(tzinfo=None)
    return WINDOW_START <= t < WINDOW_END


def get_window_status() -> dict:
    """
    Текущий статус окна для фронта.

    Возвращает:
      is_open      — открыто ли сейчас
      server_time  — текущее серверное время (МСК, ISO)
      opens_at     — ближайший момент открытия (МСК, ISO)
      closes_at    — ближайший момент закрытия (МСК, ISO)
      window       — границы как 'HH:MM' для отображения
    """
    now = _now_msk()
    today = now.date()

    open_today  = datetime.combine(today, WINDOW_START, tzinfo=MSK)
    close_today = datetime.combine(today, WINDOW_END,   tzinfo=MSK)

    if now < open_today:
        opens_at  = open_today
        closes_at = close_today
        is_open   = False
    elif now < close_today:
        opens_at  = open_today
        closes_at = close_today
        is_open   = True
    else:
        opens_at  = open_today + timedelta(days=1)
        closes_at = close_today + timedelta(days=1)
        is_open   = False

    return {
        "is_open":     is_open,
        "server_time": now.isoformat(),
        "opens_at":    opens_at.isoformat(),
        "closes_at":   closes_at.isoformat(),
        "window":      {"start": WINDOW_START.strftime("%H:%M"),
                        "end":   WINDOW_END.strftime("%H:%M")},
    }


def require_duty_window_or_admin(
    current_user: User = Depends(get_current_user),
) -> User:
    """
    FastAPI dependency: пропускает админа всегда; остальных — только в окне
    09:00–16:00 МСК. Иначе 403.
    """
    if current_user.role == "admin":
        return current_user
    if is_window_open():
        return current_user
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            f"Окно подачи закрыто. Редактирование доступно с "
            f"{WINDOW_START.strftime('%H:%M')} до "
            f"{WINDOW_END.strftime('%H:%M')} (МСК)."
        ),
    )
