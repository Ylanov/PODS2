# app/models/duty.py
"""
Модели для системы графиков наряда.

DutySchedule        — сам график (название + привязка к должности)
DutySchedulePerson  — люди, включённые в этот график
DutyMark            — отметка «в наряде» (человек × дата)

Связи:
  DutySchedule.position  → Position   (ManyToOne, ondelete=SET NULL)
  DutySchedule.persons   → DutySchedulePerson[]  (OneToMany, cascade delete)
  DutySchedule.marks     → DutyMark[]            (OneToMany, cascade delete)
  DutySchedulePerson.person → Person  (ManyToOne, ondelete=CASCADE)
  DutyMark.person           → Person  (ManyToOne, ondelete=CASCADE)
"""

from datetime import datetime, timezone

import json

from sqlalchemy import (
    Column, Integer, String, Date, ForeignKey, Boolean, Text,
    DateTime, UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.db.database import Base


# Константы типов отметок — используются в endpoint'ах и модели
MARK_DUTY     = "N"   # Наряд
MARK_LEAVE    = "U"   # Увольнение
MARK_VACATION = "V"   # Отпуск (один день)
MARK_RESERVE  = "R"   # Резерв (UI: «РЗ», свой счётчик, без переработки)
ALL_MARK_TYPES = (MARK_DUTY, MARK_LEAVE, MARK_VACATION, MARK_RESERVE)


# Тип графика наряда (DutySchedule.kind):
#   DUTY_KIND_DUTY      — обычный наряд. Отметки 'N' автозаполняют слоты
#                         в списках, при условии что у графика задан
#                         position_id и пройдены остальные фильтры
#                         (applicable_template_ids, daily window и т.д.)
#   DUTY_KIND_AMG_DUTY  — дежурство в АМГ. Учётный график: считает часы,
#                         наряды, отпуска у людей, но в слоты списков
#                         НИКОГДА не подставляет ФИО. Используется как
#                         справочный/планёрный инструмент.
DUTY_KIND_DUTY     = "duty"
DUTY_KIND_AMG_DUTY = "amg_duty"
ALL_DUTY_KINDS = (DUTY_KIND_DUTY, DUTY_KIND_AMG_DUTY)


class DutySchedule(Base):
    """График наряда — один на должность (или без привязки к должности)."""

    __tablename__ = "duty_schedules"

    id            = Column(Integer, primary_key=True, index=True)
    title         = Column(String,  nullable=False)
    # Внешний ключ на таблицу positions; при удалении должности — ставим NULL,
    # чтобы не потерять сам график.
    position_id   = Column(
        Integer,
        ForeignKey("positions.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Кэшированное имя должности — сохраняется на момент создания/изменения
    # и используется как fallback если должность была удалена.
    position_name = Column(String, nullable=True)
    owner = Column(String, nullable=True, index=True)

    # Тип графика — DUTY_KIND_DUTY (default) или DUTY_KIND_AMG_DUTY.
    # 'amg_duty' исключает график из автозаполнения слотов, оставаясь
    # учётным инструментом. См. константы ALL_DUTY_KINDS выше.
    kind = Column(
        String,
        nullable=False,
        default=DUTY_KIND_DUTY,
        server_default=DUTY_KIND_DUTY,
        index=True,
    )

    # Опциональный фильтр: к каким template-event'ам применять автозаполнение.
    # Хранится как JSON-массив id (template event'ов). Семантика:
    #   NULL или []  → график применяется ко всем спискам с такой position
    #                  (бэк-совместимое поведение по умолчанию)
    #   [42, 17, …]  → только к спискам, у которых event.source_template_id
    #                  присутствует в этом массиве
    applicable_template_ids = Column(Text, nullable=True)

    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    def get_applicable_template_ids(self) -> list[int]:
        raw = self.applicable_template_ids
        if not raw:
            return []
        try:
            data = json.loads(raw)
            return [int(x) for x in data if isinstance(x, (int, str)) and str(x).isdigit()]
        except (json.JSONDecodeError, ValueError, TypeError):
            return []

    def set_applicable_template_ids(self, ids: list[int]) -> None:
        clean = sorted({int(x) for x in (ids or []) if x})
        self.applicable_template_ids = json.dumps(clean) if clean else None

    def applies_to_event(self, event) -> bool:
        """
        Применим ли этот график при автозаполнении слотов в данном event'е.
        Возвращает True если:
          - у графика нет фильтра (применяется ко всем);
          - либо event.source_template_id присутствует в applicable_template_ids.
        """
        ids = self.get_applicable_template_ids()
        if not ids:
            return True
        src = getattr(event, "source_template_id", None)
        if src is None:
            # Список вручную создан, не из шаблона — фильтр по шаблонам
            # не имеет смысла, считаем что не подпадает.
            return False
        return int(src) in ids

    # ── Relationships ─────────────────────────────────────────────────────────
    position = relationship(
        "Position",
        foreign_keys=[position_id],
        lazy="joined",
    )
    persons = relationship(
        "DutySchedulePerson",
        back_populates="schedule",
        cascade="all, delete-orphan",
        order_by="DutySchedulePerson.order_num, DutySchedulePerson.id",
        lazy="selectin",
    )
    marks = relationship(
        "DutyMark",
        back_populates="schedule",
        cascade="all, delete-orphan",
        lazy="dynamic",
    )


class DutySchedulePerson(Base):
    """
    Человек, включённый в конкретный график наряда.

    Уникальный constraint: (schedule_id, person_id) — один человек не может
    быть добавлен в один и тот же график дважды.
    """

    __tablename__ = "duty_schedule_persons"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    schedule_id = Column(
        Integer,
        ForeignKey("duty_schedules.id", ondelete="CASCADE"),
        nullable=False,
    )
    person_id   = Column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Порядок отображения в сетке (0-based, возрастает при добавлении)
    order_num   = Column(Integer, default=0, nullable=False)

    # ── Relationships ─────────────────────────────────────────────────────────
    schedule = relationship("DutySchedule", back_populates="persons")
    person   = relationship("Person", lazy="joined")

    __table_args__ = (
        UniqueConstraint(
            "schedule_id", "person_id",
            name="uq_duty_schedule_person",
        ),
    )


class DutyMark(Base):
    """
    Отметка в графике.

    Типы (колонка mark_type):
      'N' — Наряд (дежурство);   UI: чёрный квадрат с буквой «Н»
      'U' — Увольнение;          UI: квадрат с буквой «У»
      'V' — Отпуск (один день);  UI: объединённая полоса с надписью «Отпуск»

    Уникальный constraint: (schedule_id, person_id, duty_date).
    mark_type в ключ НЕ входит — один день = один тип.

    При создании отметки 'N' бэкенд автоматически заполняет слоты во всех
    списках (events) за эту дату, где должность совпадает со schedule.position_id.
    Для 'U'/'V' автозаполнение НЕ выполняется.
    """

    __tablename__ = "duty_marks"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    schedule_id = Column(
        Integer,
        ForeignKey("duty_schedules.id", ondelete="CASCADE"),
        nullable=False,
    )
    person_id   = Column(
        Integer,
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
    )
    duty_date   = Column(Date, nullable=False)
    mark_type   = Column(
        String(2),
        nullable=False,
        server_default="N",
        default=MARK_DUTY,
    )

    # ── Замещения («Иванов идёт на квоту 5 управления вместо своей должности»)
    # Применяется только к mark_type='N' и только когда в один день у графика
    # стоит >1 наряда. Один из них становится "основным" (is_primary=True,
    # default), остальные — "замещающие".
    #
    # is_primary=True   → ФИО подставляется в слоты с position_id графика
    #                     (старая логика автозаполнения)
    # is_primary=False  → ФИО подставляется только в слоты, у которых
    #                     group.source_group_id == substitute_template_group_id
    #                     И department == substitute_department.
    #
    # До первого утверждения is_primary=True у всех (бэк-совместимо).
    # При утверждении wizard собирает решения админа.
    is_primary = Column(
        Boolean,
        nullable=False,
        default=True,
        server_default="1",
    )
    # Legacy «одиночное» замещение — одна цель. Сохраняем колонки ради
    # backward compat. Если substitutes_json непустой, эти два поля
    # игнорируются (см. get_substitutes()).
    substitute_department = Column(String, nullable=True)
    substitute_template_group_id = Column(
        Integer,
        ForeignKey("groups.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # JSON-массив целей замещения вида:
    #   [{"department": "5_uprav", "template_group_id": 42}, ...]
    # Один наряд может покрывать несколько разных мест в разных списках.
    # Если NULL/пусто — используется legacy-пара (substitute_department +
    # substitute_template_group_id).
    substitutes_json = Column(Text, nullable=True)

    # ── Relationships ─────────────────────────────────────────────────────────
    schedule = relationship("DutySchedule", back_populates="marks")
    person   = relationship("Person", lazy="joined")

    def get_substitutes(self) -> list[dict]:
        """
        Возвращает список замещений для этой отметки в едином формате
        [{"department": str, "template_group_id": int}, ...].

        Источник: substitutes_json если он заполнен; иначе legacy-пара
        substitute_department + substitute_template_group_id (как одна
        запись в списке, чтобы вызывающий код не различал случаи).
        """
        import json as _json
        raw = self.substitutes_json
        if raw:
            try:
                data = _json.loads(raw)
                if isinstance(data, list):
                    out = []
                    for item in data:
                        if not isinstance(item, dict):
                            continue
                        dept = (item.get("department") or "").strip()
                        gid  = item.get("template_group_id")
                        try:
                            gid = int(gid) if gid is not None else None
                        except (TypeError, ValueError):
                            gid = None
                        if dept and gid:
                            out.append({"department": dept, "template_group_id": gid})
                    if out:
                        return out
            except (_json.JSONDecodeError, ValueError, TypeError):
                pass
        if self.substitute_department and self.substitute_template_group_id:
            return [{
                "department":        self.substitute_department,
                "template_group_id": int(self.substitute_template_group_id),
            }]
        return []

    def set_substitutes(self, items: list[dict]) -> None:
        """
        Записывает массив замещений. Для backward compat первая запись
        (если есть) копируется в legacy-поля — чтобы экспорт docx и
        прочий код, который ещё смотрит на старые колонки, не сломался.
        """
        import json as _json
        clean = []
        for it in (items or []):
            dept = (it.get("department") or "").strip()
            try:
                gid = int(it.get("template_group_id"))
            except (TypeError, ValueError):
                continue
            if dept and gid:
                clean.append({"department": dept, "template_group_id": gid})

        self.substitutes_json = _json.dumps(clean, ensure_ascii=False) if clean else None
        if clean:
            self.substitute_department        = clean[0]["department"]
            self.substitute_template_group_id = clean[0]["template_group_id"]
        else:
            self.substitute_department        = None
            self.substitute_template_group_id = None

    __table_args__ = (
        UniqueConstraint(
            "schedule_id", "person_id", "duty_date",
            name="uq_duty_mark",
        ),
    )


class DutyScheduleApproval(Base):
    """
    Утверждение графика наряда за конкретный месяц.

    Пока записи нет для пары (schedule_id, year, month) — месяц в draft.
    Есть запись — месяц approved. Повторное утверждение после разблокировки
    удаляет старую запись и создаёт новую (версий не храним).

    Snapshot состава и отметок денормализован в дочерние таблицы
    (approval_persons, approval_marks) — чтобы история не менялась после
    увольнений, переименований или правок текущего графика.
    """

    __tablename__ = "duty_schedule_approvals"

    id                  = Column(Integer, primary_key=True, autoincrement=True)
    schedule_id         = Column(
        Integer,
        ForeignKey("duty_schedules.id", ondelete="CASCADE"),
        nullable=False,
    )
    year                = Column(Integer, nullable=False)
    month               = Column(Integer, nullable=False)
    approved_at         = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    approved_by_user_id = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    # ── Relationships ─────────────────────────────────────────────────────────
    schedule = relationship("DutySchedule", lazy="joined")
    persons = relationship(
        "DutyScheduleApprovalPerson",
        back_populates="approval",
        cascade="all, delete-orphan",
        order_by="DutyScheduleApprovalPerson.order_num, DutyScheduleApprovalPerson.id",
        lazy="selectin",
    )
    marks = relationship(
        "DutyScheduleApprovalMark",
        back_populates="approval",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    __table_args__ = (
        UniqueConstraint(
            "schedule_id", "year", "month",
            name="uq_duty_approval_schedule_month",
        ),
    )


class DutyScheduleApprovalPerson(Base):
    """
    Запись о человеке в snapshot'е утверждённого графика.

    person_id nullable: если после утверждения запись в persons
    физически удалена (hard-delete), FK обнуляется — но full_name / rank /
    doc_number остаются как фиксированная копия на момент утверждения.
    """

    __tablename__ = "duty_schedule_approval_persons"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    approval_id = Column(
        Integer,
        ForeignKey("duty_schedule_approvals.id", ondelete="CASCADE"),
        nullable=False,
    )
    person_id   = Column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
    )
    full_name   = Column(String(300), nullable=False)
    rank        = Column(String(100), nullable=True)
    doc_number  = Column(String(100), nullable=True)
    order_num   = Column(Integer, nullable=False, default=0)

    approval = relationship("DutyScheduleApproval", back_populates="persons")


class DutyScheduleApprovalMark(Base):
    """
    Snapshot отдельной отметки за утверждённый месяц.

    full_name_at_time дублирует ФИО для быстрого рендера таблицы истории
    без join на approval_persons (и чтобы отметка осталась осмысленной,
    если запись человека потом удалена hard-delete).
    """

    __tablename__ = "duty_schedule_approval_marks"

    id                = Column(Integer, primary_key=True, autoincrement=True)
    approval_id       = Column(
        Integer,
        ForeignKey("duty_schedule_approvals.id", ondelete="CASCADE"),
        nullable=False,
    )
    person_id         = Column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True,
    )
    full_name_at_time = Column(String(300), nullable=False)
    duty_date         = Column(Date,    nullable=False)
    mark_type         = Column(String(2), nullable=False)

    approval = relationship("DutyScheduleApproval", back_populates="marks")


class Holiday(Base):
    """
    Справочник праздников / каникулярных дней.

    Используется для подсветки столбцов в графике и подсчёта переработки.
    is_last_day = True помечает последний день каникулярного блока —
    по ТЗ за него +12ч, а не +20ч.

    Начальный набор (праздники РФ 2026) засеян миграцией e5f6a7b8c9d0.
    Управляется админом через /api/v1/admin/holidays.
    """
    __tablename__ = "holidays"

    date        = Column(Date,         primary_key=True)
    title       = Column(String(200),  nullable=False)
    is_last_day = Column(Boolean,      nullable=False, default=False, server_default="false")
    created_at  = Column(DateTime(timezone=True), nullable=False,
                         default=lambda: datetime.now(timezone.utc))
    updated_at  = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )