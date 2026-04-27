# app/core/cache.py
"""
Простой in-process TTL-кеш для часто запрашиваемых справочников.

Зачем не Redis:
  - Redis — отдельный сервис, лишняя точка отказа.
  - Справочники (positions, schedules) редко меняются, но запрашиваются
    на каждый refresh UI у 2к пользователей → это десятки тысяч SELECT'ов.
  - In-process cachetools покрывает 95% пользы Redis без инфра-усложнения.
  - При нескольких воркерах gunicorn каждый держит свою копию — это ОК,
    TTL 60 секунд ограничивает лаг после инвалидации до 1 минуты.

Когда обязательно сбрасывать кеш:
  POST/PUT/DELETE к соответствующему ресурсу — вызвать invalidate(key).
  Иначе до истечения TTL пользователи будут видеть устаревший список.
"""
from typing import Any, Callable
from cachetools import TTLCache
from threading import RLock


# Отдельные кеши на каждый тип данных, чтобы:
#  - можно было инвалидировать прицельно
#  - размеры и TTL выбирать индивидуально
_positions_cache = TTLCache(maxsize=4,  ttl=60)   # всего ОДИН ключ "all"
_schedules_cache = TTLCache(maxsize=16, ttl=60)

# RLock — защищаем от гонки между запросами в одном воркере
# (FastAPI sync-роутеры могут идти в thread pool параллельно).
_lock = RLock()


def get_or_set(cache: TTLCache, key: str, loader: Callable[[], Any]) -> Any:
    """Атомарно: вернуть из кеша или загрузить, записать, вернуть."""
    with _lock:
        if key in cache:
            return cache[key]
        value = loader()
        cache[key] = value
        return value


def invalidate(cache: TTLCache, key: str | None = None) -> None:
    """Сбросить один ключ или весь кеш."""
    with _lock:
        if key is None:
            cache.clear()
        else:
            cache.pop(key, None)


# Публичные хендлы — роутеры импортируют их и работают с нужным кешем
positions_cache = _positions_cache
schedules_cache = _schedules_cache
