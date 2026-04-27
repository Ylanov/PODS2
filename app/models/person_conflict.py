# app/models/person_conflict.py
"""
Расхождения данных в общей базе людей.

Когда участник тестирования заполняет анкету, мы пытаемся синхронизировать
его данные (управление, телефон) с Person в общей базе:
  • если у Person это поле пустое — записываем новое значение
  • если значение совпадает — ничего не делаем
  • если значения разные — создаём запись в person_data_conflicts,
    чтобы админ выбрал какое из двух правильное

Решение принимает только admin: 'old' оставляет старое, 'new' применяет новое.
"""

from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, ForeignKey, Index,
)
from sqlalchemy.orm import relationship
from app.db.database import Base


CONFLICT_FIELDS = ("department", "phone", "position_title")
CONFLICT_SOURCES = ("training",)
CONFLICT_CHOICES = ("old", "new")


class PersonDataConflict(Base):
    __tablename__ = "person_data_conflicts"

    id           = Column(Integer, primary_key=True, index=True)

    person_id    = Column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    person       = relationship("Person", lazy="joined")

    # Контекст: ссылка на попытку тестирования (если конфликт пришёл оттуда).
    # Может быть NULL — если в будущем будут другие источники.
    attempt_id   = Column(
        Integer,
        ForeignKey("training_attempts.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )

    field_name   = Column(String(50),  nullable=False)
    old_value    = Column(Text,        nullable=True)
    new_value    = Column(Text,        nullable=True)
    source       = Column(String(50),  nullable=False, default="training")

    created_at   = Column(DateTime(timezone=True),
                          default=lambda: datetime.now(timezone.utc), nullable=False)
    resolved_at  = Column(DateTime(timezone=True), nullable=True)
    resolved_by  = Column(String(100), nullable=True)
    resolved_choice = Column(String(20), nullable=True)

    __table_args__ = (
        Index("ix_person_data_conflicts_pending",
              "resolved_at", postgresql_where=None),
    )
