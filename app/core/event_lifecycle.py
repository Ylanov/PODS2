# app/core/event_lifecycle.py
"""
Автоматическая деактивация прошедших списков.

Бизнес-правило:
    Список (Event, is_template=False) с датой ДО сегодня и статусом 'active'
    — это смысловая ошибка. В активном состоянии списка ожидается что
    управления его заполняют. Но заполнять прошлый день уже не нужно.

Поэтому раз в некоторое время (на старте + при чтении списков + по таймеру)
мы переводим такие записи в 'draft' — это скрывает их из выдачи для
департаментов (фильтр в slots.py:get_all_events требует status='active')
и убирает статус «активен» в админке.

Реализация:
    Один UPDATE с индекс-лукапом по (is_template, date, status).
    Идемпотентен — повторный вызов без актуальных данных ничего не
    обновляет (zero rows affected), стоит ~доли миллисекунд.

Почему не удаляем и не отдельный статус 'archived':
    - В текущей модели Event.status — простое текстовое поле без enum.
      Добавлять новые значения требует фронтовых правок во многих местах.
    - 'draft' достаточно чтобы скрыть список из активной выдачи, при этом
      он остаётся виден в истории и в редакторе шаблонов.
    - Если позже понадобится отдельный визуал для «прошло автоматически»
      — легко добавить флаг auto_deactivated_at.
"""

import logging
from datetime import date as date_type

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.models.event import Event

logger = logging.getLogger(__name__)


def expire_past_active_events(db: Session) -> int:
    """
    Переводит все не-шаблонные active-списки с датой < сегодня в draft.
    Возвращает количество затронутых строк.

    Идемпотентен. Безопасно вызывать при каждом чтении списков —
    при актуальных данных ничего не меняет.
    """
    today = date_type.today()

    stmt = (
        update(Event)
        .where(
            Event.is_template == False,   # noqa: E712
            Event.status      == "active",
            Event.date        < today,
            Event.date.isnot(None),
        )
        .values(status="draft")
        .execution_options(synchronize_session=False)
    )

    result = db.execute(stmt)
    affected = result.rowcount or 0
    if affected > 0:
        db.commit()
        logger.info(
            "Auto-deactivated %d past active event(s) (date < %s)",
            affected, today.isoformat(),
        )
    return affected
