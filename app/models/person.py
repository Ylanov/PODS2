# app/models/person.py

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Date, Text
from app.db.database import Base


class Person(Base):
    """
    Центральный справочник людей.

    Записи создаются/обновляются автоматически когда пользователи
    из управлений заполняют слоты (ФИО + звание + номер документа).
    Администратор может просматривать и редактировать базу вручную
    или загружать через Excel.

    Обязательные поля при импорте: full_name, rank, doc_number.
    Остальные — опциональные.
    """
    __tablename__ = "persons"

    id             = Column(Integer, primary_key=True, index=True)

    # ── Обязательные ─────────────────────────────────────────────────────────
    full_name      = Column(String(300), nullable=False, index=True, unique=True)
    rank           = Column(String(100), nullable=True)   # воинское звание
    doc_number     = Column(String(100), nullable=True)   # номер документа (уд. личности / паспорт)

    # ── Организационные ──────────────────────────────────────────────────────
    department     = Column(String(100), nullable=True)   # username управления-владельца
    position_title = Column(String(200), nullable=True)   # должность (текстовая, не FK)

    # ── Персональные (необязательные) ────────────────────────────────────────
    birth_date     = Column(Date,        nullable=True)   # дата рождения  ДД.ММ.ГГГГ
    phone          = Column(String(50),  nullable=True)   # номер телефона
    notes          = Column(Text,        nullable=True)   # произвольная заметка

    # ── Статус увольнения ────────────────────────────────────────────────────
    # NULL  → активный сотрудник (по умолчанию).
    # NOT NULL → дата увольнения; запись сохраняется ради истории
    #           (duty_marks и slots сохраняют ссылки / денормализованные ФИО).
    # Меняется только через админский endpoint /persons/{id}/fire|unfire.
    fired_at = Column(DateTime(timezone=True), nullable=True)

    # ── Служебные ────────────────────────────────────────────────────────────
    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )