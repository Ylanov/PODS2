# app/core/duty_window.py
"""
Окно подачи/редактирования графиков нарядов для управлений.

Время открытия/закрытия теперь конфигурируется через админку: ключи
`duty_window_start` и `duty_window_end` в таблице `settings`. Формат
"HH:MM" по МСК. Дефолты — 09:00–16:00 (см. settings.DEFAULTS).

Вне окна — все «пишущие» операции возвращают 403. Админ не ограничен.

Часовой пояс: фиксированный UTC+3 (Россия не использует переход на летнее
время с 2014), чтобы не тащить tzdata-зависимость на Windows.
"""

from datetime import datetime, timedelta, time, timezone

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.db.database import get_db
from app.models.user import User


MSK = timezone(timedelta(hours=3))


def _parse_hhmm(s: str, fallback: time) -> time:
    """Парсит 'HH:MM' в datetime.time; при ошибке возвращает fallback."""
    if not s:
        return fallback
    try:
        h, m = s.split(":")
        return time(int(h), int(m))
    except (ValueError, AttributeError):
        return fallback


def _read_window_bounds(db: Session) -> tuple[time, time]:
    """
    Читает duty_window_start/end из таблицы settings, парсит в datetime.time.
    Если что-то невалидное — возвращает дефолты 09:00–16:00.
    """
    # Локальный импорт чтобы избежать циклов (settings импортирует Setting → Base).
    from app.api.v1.routers.settings import get_setting
    start = _parse_hhmm(get_setting(db, "duty_window_start"), time(9, 0))
    end   = _parse_hhmm(get_setting(db, "duty_window_end"),   time(16, 0))
    # Защита от бредовой конфигурации (end <= start) — fallback.
    if end <= start:
        return time(9, 0), time(16, 0)
    return start, end


def _now_msk() -> datetime:
    return datetime.now(MSK)


def is_window_open(db: Session, now: datetime | None = None) -> bool:
    start, end = _read_window_bounds(db)
    now = now or _now_msk()
    t = now.timetz().replace(tzinfo=None)
    return start <= t < end


def get_window_status(db: Session) -> dict:
    """
    Текущий статус окна для фронта.

    Возвращает:
      is_open      — открыто ли сейчас
      server_time  — текущее серверное время (МСК, ISO)
      opens_at     — ближайший момент открытия (МСК, ISO)
      closes_at    — ближайший момент закрытия (МСК, ISO)
      window       — границы как 'HH:MM' для отображения
    """
    start, end = _read_window_bounds(db)
    now   = _now_msk()
    today = now.date()

    open_today  = datetime.combine(today, start, tzinfo=MSK)
    close_today = datetime.combine(today, end,   tzinfo=MSK)

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
        "window":      {"start": start.strftime("%H:%M"),
                        "end":   end.strftime("%H:%M")},
    }


def require_duty_window_or_admin(
    current_user: User    = Depends(get_current_user),
    db:           Session = Depends(get_db),
) -> User:
    """
    FastAPI dependency: пропускает админа всегда; остальных — только когда
    окно подачи открыто (границы берутся из таблицы settings).
    """
    if current_user.role == "admin":
        return current_user
    if is_window_open(db):
        return current_user
    start, end = _read_window_bounds(db)
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            f"Окно подачи закрыто. Редактирование доступно с "
            f"{start.strftime('%H:%M')} до {end.strftime('%H:%M')} (МСК)."
        ),
    )
