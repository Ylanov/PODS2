# app/core/limiter.py
"""
Общий инстанс SlowAPI Limiter.

Вынесен в отдельный модуль, чтобы:
  - main.py мог зарегистрировать его в app.state
  - роутеры (auth.py и др.) могли импортировать и декорировать эндпоинты
  - не было циклических импортов между main.py и роутерами

Ключ — IP клиента (get_remote_address). За nginx fastapi получает
реальный IP если nginx передаёт X-Forwarded-For; SlowAPI по умолчанию
читает его. Если nginx у вас не передаёт заголовок — все клиенты будут
учтены как один, и глобальный лимит подавит всех. Проверьте nginx.conf:
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Real-IP $remote_addr;
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.core.config import settings


def _default_limits() -> list[str]:
    """Глобальный лимит применяется ко всем эндпоинтам если не пуст."""
    val = (settings.GLOBAL_RATE_LIMIT or "").strip()
    return [val] if val else []


limiter = Limiter(
    key_func=get_remote_address,
    default_limits=_default_limits(),
)
