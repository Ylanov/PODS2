# app/models/media.py
"""
Учёт машинных носителей информации (МНИ): флешки, SSD, HDD, диски, SD-карты.

Две таблицы:
  MediaItem     — сам носитель: инв. №, тип, серийный, гриф, состояние,
                   текущий держатель и подразделение.
  MediaTransfer — журнал движения (выдано/возвращено) для аналитики.

Опираемся на формат «Учёт МНИ» из эталонного Excel: каждый носитель имеет
инвентарный № вида «1-ДСП», закреплён за конкретным человеком, с датой выдачи.
Бирки печатаются по этим же полям.
"""

from datetime import datetime, timezone, date as date_type
from sqlalchemy import (
    Column, Integer, String, Text, Date, DateTime,
    ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship
from app.db.database import Base


# ── Допустимые значения (whitelist) ──────────────────────────────────────────
MEDIA_TYPES = (
    "flash",     # флешка USB
    "ssd",       # внешний SSD
    "hdd",       # внешний HDD
    "sd",        # SD-карта / microSD
    "cd_dvd",    # CD/DVD-диск
    "other",     # прочее
)

# Гриф (классификация по конфиденциальности)
MEDIA_CLASSIFICATIONS = (
    "open",          # открытый
    "dsp",           # ДСП — для служебного пользования
    "secret",        # секретно
    "top_secret",    # совсекретно
)

# Состояние
MEDIA_STATUSES = (
    "available",   # на хранении / свободен
    "issued",      # выдан кому-то
    "broken",      # неисправен
    "written_off", # списан
    "lost",        # утрачен
)

# Тип события в журнале
TRANSFER_KINDS = (
    "issued",      # выдан
    "returned",    # возвращён
    "transferred", # передан между людьми
    "checked",     # проверен
    "decommissioned",  # списан
)


class MediaItem(Base):
    __tablename__ = "media_items"

    id            = Column(Integer, primary_key=True, index=True)
    unit_username = Column(String(100), nullable=False, index=True)

    # ── Идентификация ───────────────────────────────────────────────────────
    inv_number    = Column(String(50),  nullable=False)   # «1-ДСП», «100-ДСП»
    media_type    = Column(String(20),  nullable=False, default="flash")
    serial_number = Column(String(120), nullable=True)
    capacity_gb   = Column(Integer,     nullable=True)    # объём в ГБ

    # ── Гриф и состояние ────────────────────────────────────────────────────
    classification = Column(String(20), nullable=False, default="dsp")
    status         = Column(String(20), nullable=False, default="available")

    # ── Текущий держатель ───────────────────────────────────────────────────
    # holder_person_id связывает с общей базой людей (persons.id). Если задан,
    # роутер при чтении подменяет full_name/department значениями из Person —
    # так данные всегда «онлайн» при изменениях персоны.
    # holder_*_name/department хранятся как кеш + fallback для записей без
    # привязки к Person (импорт без матча, ручной ввод).
    holder_person_id  = Column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    holder_person     = relationship("Person", lazy="joined")

    holder_full_name  = Column(String(300), nullable=True)
    holder_short_name = Column(String(100), nullable=True)  # «Шевченко А.А.» — на бирку
    holder_department = Column(String(100), nullable=True)  # подразделение/упр-ние
    issue_date        = Column(Date,        nullable=True)

    # ── Сроки и проверки ────────────────────────────────────────────────────
    last_check_date   = Column(Date, nullable=True)
    next_check_date   = Column(Date, nullable=True)

    notes      = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    transfers = relationship(
        "MediaTransfer",
        back_populates="media",
        cascade="all, delete-orphan",
        order_by="MediaTransfer.event_date.desc(), MediaTransfer.id.desc()",
    )

    __table_args__ = (
        UniqueConstraint("unit_username", "inv_number",
                         name="uq_media_items_unit_inv"),
        Index("ix_media_items_status",  "unit_username", "status"),
    )


class MediaTransfer(Base):
    """Журнал движения носителя — для аналитики и аудита."""
    __tablename__ = "media_transfers"

    id          = Column(Integer, primary_key=True, index=True)
    media_id    = Column(
        Integer,
        ForeignKey("media_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind        = Column(String(20), nullable=False)   # issued / returned / …
    event_date  = Column(Date,       nullable=False)

    # Кому/от кого (свободные строки — не FK на persons, чтобы можно было
    # фиксировать события, даже если человек не в базе)
    person_full_name = Column(String(300), nullable=True)
    department       = Column(String(100), nullable=True)
    operator         = Column(String(100), nullable=True)  # кто записал событие
    notes            = Column(Text,        nullable=True)

    created_at = Column(DateTime(timezone=True),
                        default=lambda: datetime.now(timezone.utc), nullable=False)

    media = relationship("MediaItem", back_populates="transfers")
