# app/models/combat_calc.py
"""
Боевой расчёт — система заполнения документов с фиксированной структурой.

ИСПРАВЛЕНИЯ (индексы):
  CombatCalcInstance.calc_date  — добавлен index=True
    (частый фильтр: GET /combat/instances?date=YYYY-MM-DD)

  CombatCalcSlot.instance_id    — добавлен index=True
    (FK, каждый запрос слотов фильтрует по instance_id)

  CombatCalcSlot.row_key        — добавлен index=True
    (используется в _sync_slots и при построении slots_map)

  Добавлен составной индекс (instance_id, row_key) через __table_args__
    для быстрого поиска конкретной строки внутри экземпляра.
"""

import json
from sqlalchemy import Column, Integer, String, Date, Text, Boolean, ForeignKey, UniqueConstraint, Index
from sqlalchemy.orm import relationship
from app.db.database import Base


class CombatCalcTemplate(Base):
    """
    Шаблон боевого расчёта.
    structure_json — JSON со списком секций и строк.

    Структура:
    {
      "sections": [
        {
          "title": "Оповещение личного состава",
          "rows": [
            {
              "key": "r1",
              "label": "Оповещение в общежитии №1",
              "time": "Ч+0.10",
              "who_provides": "2 чел. от базы (обеспечения)",
              "slots": [
                {"index": 0, "location": "1 под.", "department": "base"},
                {"index": 1, "location": "2 под.", "department": "base"}
              ]
            }
          ]
        }
      ]
    }
    """
    __tablename__ = "combat_calc_templates"

    id             = Column(Integer, primary_key=True, index=True)
    title          = Column(String, nullable=False)
    description    = Column(String, nullable=True)
    structure_json = Column(Text, nullable=False, default="{}")
    is_active      = Column(Boolean, default=True, nullable=False)

    instances = relationship(
        "CombatCalcInstance",
        back_populates="template",
        cascade="all, delete-orphan",
    )

    def get_structure(self) -> dict:
        try:
            return json.loads(self.structure_json)
        except (json.JSONDecodeError, TypeError):
            return {"sections": []}

    def set_structure(self, data: dict) -> None:
        self.structure_json = json.dumps(data, ensure_ascii=False)


class CombatCalcInstance(Base):
    """Экземпляр расчёта на конкретную дату."""
    __tablename__ = "combat_calc_instances"

    id          = Column(Integer, primary_key=True, index=True)
    template_id = Column(
        Integer,
        ForeignKey("combat_calc_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,   # ← FK всегда должен иметь индекс
    )
    calc_date   = Column(Date, nullable=False, index=True)   # ← ИСПРАВЛЕНО: добавлен index
    status      = Column(String, default="active", nullable=False)

    template = relationship("CombatCalcTemplate", back_populates="instances")
    slots    = relationship(
        "CombatCalcSlot",
        back_populates="instance",
        cascade="all, delete-orphan",
        lazy="selectin",   # загружаем слоты вместе с экземпляром одним SELECT IN
    )

    __table_args__ = (
        UniqueConstraint("template_id", "calc_date", name="uq_combat_calc_instance"),
        Index("ix_combat_calc_instances_date_status", "calc_date", "status"),  # ← для фильтра по дате+статусу
    )


class CombatCalcSlot(Base):
    """
    Заполняемая ячейка расчёта.
    row_key + slot_index уникально идентифицируют слот в шаблоне.
    """
    __tablename__ = "combat_calc_slots"

    id          = Column(Integer, primary_key=True, index=True)
    instance_id = Column(
        Integer,
        ForeignKey("combat_calc_instances.id", ondelete="CASCADE"),
        nullable=False,
        index=True,   # ← ИСПРАВЛЕНО: добавлен index (FK без индекса = full scan при каждом запросе)
    )
    row_key     = Column(String, nullable=False, index=True)   # ← ИСПРАВЛЕНО: добавлен index
    slot_index  = Column(Integer, default=0, nullable=False)
    department  = Column(String, nullable=True)
    full_name   = Column(String, nullable=True)
    rank        = Column(String, nullable=True)
    note        = Column(String, nullable=True)
    version     = Column(Integer, default=1, nullable=False)

    instance = relationship("CombatCalcInstance", back_populates="slots")

    __table_args__ = (
        UniqueConstraint(
            "instance_id", "row_key", "slot_index",
            name="uq_combat_calc_slot",
        ),
        # Составной индекс для быстрого поиска всех слотов строки внутри экземпляра
        Index("ix_combat_calc_slots_instance_row", "instance_id", "row_key"),  # ← НОВЫЙ
    )