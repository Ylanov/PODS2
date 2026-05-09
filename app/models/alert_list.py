# app/models/alert_list.py
"""
Списки оповещения. Структура:

  AlertList     — два общих списка (id=1, id=2). Сидируются миграцией.
  AlertPosition — словарь должностей (Начальник 5 упр / ЗНЦ / …) с
                  единственным ФИО на каждую. ФИО общее на всех — если
                  изменили в одном списке, отражается во всех, потому что
                  привязка идёт через AlertPosition.
  AlertSlot     — размещение должности в конкретном списке. У каждого
                  AlertSlot свой sort_order; одна и та же AlertPosition
                  может попасть и в список 1, и в список 2 (один раз в
                  каждом — UNIQUE list_id+position_id).
  AlertMark     — отметка (N/O/V) на день для AlertPosition.
                  Привязана к должности, а не к слоту → видна в обоих
                  списках где должность присутствует. Так и нужно: если
                  человек в отпуске, он недоступен по любому списку.

Все данные общие у всех с permission='alert_lists'.
"""

from sqlalchemy import (
    Column, Integer, String, Date, ForeignKey, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from app.db.database import Base


# Допустимые типы отметки.
ALERT_MARK_DUTY      = "N"
ALERT_MARK_RESP      = "O"
ALERT_MARK_VACATION  = "V"
ALL_ALERT_MARK_TYPES = (ALERT_MARK_DUTY, ALERT_MARK_RESP, ALERT_MARK_VACATION)

# Тип позиции — для фильтра в модалке выбора зама.
ALERT_ROLE_UPR = "upr"   # управление
ALERT_ROLE_OTD = "otd"   # отдел
ALERT_ROLE_CNC = "cnc"   # центр (ЗНЦ)
ALL_ALERT_ROLES = (ALERT_ROLE_UPR, ALERT_ROLE_OTD, ALERT_ROLE_CNC)


class AlertList(Base):
    """Один из двух фиксированных списков оповещения (id=1 или id=2)."""

    __tablename__ = "alert_lists"

    id   = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)


class AlertPosition(Base):
    """
    Должность («Начальник 5 упр», «ЗНЦ по воспитательной работе», …).
    Title уникален — две позиции с одним именем не допускаются (вся
    логика «одно ФИО — везде» строится на этом).

    primary_person_id ON DELETE SET NULL — при удалении человека из
    Базы людей позиция остаётся, просто становится «не назначена».
    """

    __tablename__ = "alert_positions"

    id                = Column(Integer, primary_key=True, index=True)
    title             = Column(String(200), nullable=False, unique=True)
    role_kind         = Column(String(10),  nullable=False, default=ALERT_ROLE_UPR)
    primary_person_id = Column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    primary_person = relationship("Person", lazy="joined")


class AlertSlot(Base):
    """
    Привязка должности к списку. У каждого свой sort_order — порядок
    позиций в списке независим от других списков. UNIQUE (list_id, position_id):
    одна должность не может быть дважды в одном списке.
    """

    __tablename__ = "alert_slots"

    id          = Column(Integer, primary_key=True, index=True)
    list_id     = Column(
        Integer,
        ForeignKey("alert_lists.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    position_id = Column(
        Integer,
        ForeignKey("alert_positions.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    sort_order  = Column(Integer, nullable=False, default=0)

    position = relationship("AlertPosition", lazy="joined")

    __table_args__ = (
        UniqueConstraint("list_id", "position_id", name="uq_alert_slots_list_position"),
    )


class AlertMark(Base):
    """
    Отметка на конкретный день для конкретной ДОЛЖНОСТИ. Видна в любом
    списке где эта должность присутствует. UNIQUE (position_id, mark_date)
    — только одна отметка на ячейку.
    """

    __tablename__ = "alert_marks"

    id          = Column(Integer, primary_key=True, index=True)
    position_id = Column(
        Integer,
        ForeignKey("alert_positions.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    mark_date            = Column(Date, nullable=False, index=True)
    mark_type            = Column(String(2), nullable=False)
    substitute_person_id = Column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
    )

    substitute_person = relationship("Person", foreign_keys=[substitute_person_id], lazy="joined")

    __table_args__ = (
        UniqueConstraint("position_id", "mark_date", name="uq_alert_marks_position_date"),
    )
