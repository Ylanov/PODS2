# app/models/alert_list.py
"""
Списки оповещения — два общих списка (id=1, id=2) с привязкой
к Базе людей. Колонки таблицы — слоты (должности типа «Начальник 5 упр»),
строки — дни месяца. В каждой ячейке — отметка (N наряд / O ответственный
/ V отпуск) + опциональный ручной заместитель (для V — фиксируется
после диалога «выбрать зама»).

Все данные общие — кто угодно с permission='alert_lists' видит и
редактирует одно и то же.
"""

from sqlalchemy import (
    Column, Integer, String, Date, ForeignKey, UniqueConstraint,
)
from sqlalchemy.orm import relationship
from app.db.database import Base


# Допустимые типы отметки в ячейке.
ALERT_MARK_DUTY      = "N"   # наряд
ALERT_MARK_RESP      = "O"   # ответственный
ALERT_MARK_VACATION  = "V"   # отпуск (требует ручной выбор зама)
ALL_ALERT_MARK_TYPES = (ALERT_MARK_DUTY, ALERT_MARK_RESP, ALERT_MARK_VACATION)

# Тип позиции — нужен только для фильтра в модалке выбора зама.
ALERT_ROLE_UPR = "upr"   # управление  → зам только из того же управления
ALERT_ROLE_OTD = "otd"   # отдел       → зам только из того же отдела
ALERT_ROLE_CNC = "cnc"   # центр (ЗНЦ) → зам кто угодно из руководящего состава
ALL_ALERT_ROLES = (ALERT_ROLE_UPR, ALERT_ROLE_OTD, ALERT_ROLE_CNC)


class AlertList(Base):
    """Один из двух фиксированных списков оповещения (id=1 или id=2)."""

    __tablename__ = "alert_lists"

    id   = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)

    slots = relationship(
        "AlertSlot",
        back_populates="alert_list",
        order_by="AlertSlot.sort_order, AlertSlot.id",
        cascade="all, delete-orphan",
    )


class AlertSlot(Base):
    """
    Одна позиция в списке оповещения — соответствует должности
    («Начальник 5 упр», «ЗНЦ по воспитательной работе», …).

    primary_person_id — кого считать основным. ON DELETE SET NULL,
    чтобы при удалении человека из базы слот не падал, а просто
    помечался как «не назначен».
    """

    __tablename__ = "alert_slots"

    id           = Column(Integer, primary_key=True, index=True)
    list_id      = Column(
        Integer,
        ForeignKey("alert_lists.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    title        = Column(String(200), nullable=False)
    role_kind    = Column(String(10),  nullable=False, default=ALERT_ROLE_UPR)
    sort_order   = Column(Integer,     nullable=False, default=0)
    primary_person_id = Column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    alert_list      = relationship("AlertList", back_populates="slots")
    primary_person  = relationship("Person", foreign_keys=[primary_person_id], lazy="joined")


class AlertMark(Base):
    """
    Отметка на конкретный день для конкретного слота.

    UNIQUE (slot_id, mark_date) — только одна отметка на ячейку.
    substitute_person_id заполняется только при mark_type=V (отпуск),
    остальным типам он не нужен.
    """

    __tablename__ = "alert_marks"

    id        = Column(Integer, primary_key=True, index=True)
    slot_id   = Column(
        Integer,
        ForeignKey("alert_slots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    mark_date = Column(Date, nullable=False, index=True)
    mark_type = Column(String(2), nullable=False)
    substitute_person_id = Column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
    )

    substitute_person = relationship("Person", foreign_keys=[substitute_person_id], lazy="joined")

    __table_args__ = (
        UniqueConstraint("slot_id", "mark_date", name="uq_alert_marks_slot_date"),
    )
