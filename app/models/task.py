# app/models/task.py

from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, String, Text, Date, DateTime, ForeignKey, Index,
)
from sqlalchemy.orm import relationship

from app.db.database import Base


class Task(Base):
    """
    Личные задачи/планы пользователя.

    Каждый пользователь ведёт свой календарь (день / неделя / месяц).
    Админ видит задачи всех пользователей в сводном виде.

    Задача привязана к дате (`due_date`). Время хранится опционально
    как строка 'HH:MM' чтобы не плодить часовые пояса.
    """
    __tablename__ = "tasks"

    id          = Column(Integer, primary_key=True, index=True)

    # ── Владелец ─────────────────────────────────────────────────────────────
    owner_id    = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                         nullable=False, index=True)
    owner       = relationship("User")

    # ── Содержание ───────────────────────────────────────────────────────────
    title       = Column(String(300), nullable=False)
    description = Column(Text,         nullable=True)

    # ── Планирование ─────────────────────────────────────────────────────────
    # Главная дата — когда задача актуальна / дедлайн по умолчанию.
    # due_date дополнительная — если дедлайн отличается от плановой даты.
    due_date    = Column(Date,         nullable=False, index=True)
    time_from   = Column(String(5),    nullable=True)   # 'HH:MM'
    time_to     = Column(String(5),    nullable=True)   # 'HH:MM'

    # ── Классификация ────────────────────────────────────────────────────────
    # Значения: 'low' | 'normal' | 'high' | 'urgent'
    priority    = Column(String(20),   nullable=False, default="normal")
    # Значения: 'pending' | 'in_progress' | 'done'
    status      = Column(String(20),   nullable=False, default="pending", index=True)
    # Произвольная метка/категория («Работа», «Тренировка», …)
    category    = Column(String(100),  nullable=True)
    # Цвет для визуализации в календаре (#RRGGBB)
    color       = Column(String(7),    nullable=True)

    # ── Служебные ────────────────────────────────────────────────────────────
    created_at  = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at  = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    __table_args__ = (
        # Самый частый запрос — «задачи пользователя в диапазоне дат»
        Index("ix_tasks_owner_due", "owner_id", "due_date"),
    )
