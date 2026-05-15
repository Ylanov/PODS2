# app/models/event.py
"""
ИСПРАВЛЕНИЯ (индексы):
  Group.event_id    — добавлен index=True (FK, частый фильтр)
  Group.order_num   — добавлен index=True (частая сортировка)
  Slot.group_id     — добавлен index=True (FK, частый JOIN)
  Slot.department   — добавлен index=True (фильтр по управлению в каждом запросе)
  Slot.position_id  — добавлен index=True (FK, автозаполнение по должности)

  Без этих индексов каждый запрос к слотам делал FULL SCAN таблицы.
  При 10 000+ слотах это становится критично.

  Составной индекс (date, is_template) на таблице events добавляется
  через Alembic-миграцию (см. файл миграции fix_indexes).
"""

from sqlalchemy import Column, Integer, String, ForeignKey, Date, Boolean, Text, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship
from app.db.database import Base


# ─── Дефолтная конфигурация столбцов ─────────────────────────────────────────
DEFAULT_COLUMNS = [
    {"key": "full_name",       "label": "ФИО",              "type": "text",            "order": 0, "width": 200, "visible": True, "custom": False},
    {"key": "rank",            "label": "Звание",           "type": "text",            "order": 1, "width": 110, "visible": True, "custom": False},
    {"key": "doc_number",      "label": "№ Документа",      "type": "text",            "order": 2, "width": 130, "visible": True, "custom": False},
    # Загранпаспорт — необязателен (visible=False по умолчанию, админ
    # включает через «Столбцы» если в этом списке нужен выезд за границу).
    {"key": "passport_number", "label": "№ Загранпаспорта", "type": "text",            "order": 3, "width": 130, "visible": False, "custom": False},
    {"key": "position_id",     "label": "Должность",        "type": "select_position", "order": 4, "width": 160, "visible": True, "custom": False},
    {"key": "callsign",        "label": "Позывной",         "type": "text",            "order": 5, "width": 100, "visible": True, "custom": False},
    {"key": "department",      "label": "Квота",            "type": "select_dept",     "order": 6, "width": 140, "visible": True, "custom": False},
    {"key": "note",            "label": "Примечание",       "type": "text",            "order": 7, "width": 160, "visible": True, "custom": False},
]


class Event(Base):
    __tablename__ = "events"

    id             = Column(Integer, primary_key=True, index=True)
    title          = Column(String, nullable=False)
    date           = Column(Date, nullable=True, index=True)       # ← index для фильтра по дате
    status         = Column(String, default="draft", index=True)   # ← index для фильтра по статусу
    is_template    = Column(Boolean, default=False, nullable=False, index=True)  # ← index
    # JSONB вместо Text-with-json: на каждый рендер списка дёргается
    # get_columns() — миллионы вызовов в день под нагрузкой.
    columns_config = Column(JSONB, nullable=True)
    # Ссылка на шаблон-источник из которого сгенерирован этот список.
    # NULL для шаблонов и «ручных» списков. Используется:
    #   1) endpoint instantiate_template — защита от дублей (один шаблон
    #      не может быть развёрнут на одну дату дважды);
    #   2) UI расписания — индикатор «уже сгенерирован» для дня недели.
    # ON DELETE SET NULL: при удалении шаблона сгенерированные списки
    # сохраняются, просто теряют связь с ним.
    source_template_id = Column(
        Integer,
        ForeignKey("events.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    groups = relationship("Group", back_populates="event", cascade="all, delete-orphan")

    # Составной индекс (date, is_template) — самая частая комбинация фильтров в dashboard и duty
    # Определяется здесь декларативно; Alembic-миграция создаёт его в БД
    __table_args__ = (
        Index("ix_events_date_template", "date", "is_template"),
    )

    def get_columns(self) -> list:
        """
        Возвращает массив колонок шаблона.
        Если у Event есть сохранённая columns_config — берём её и **доливаем
        отсутствующие стандартные колонки** (custom=False) из DEFAULT_COLUMNS.
        Это нужно когда мы добавляем новую дефолтную колонку (например
        passport_number в мае 2026) — у существующих шаблонов в БД
        columns_config зафиксирован со старым набором, и без auto-merge
        админ её не увидит в «Настройке столбцов».
        Custom-колонки (которые админ добавил руками) остаются как есть.
        """
        cfg = self.columns_config
        if not isinstance(cfg, list) or not cfg:
            return [col.copy() for col in DEFAULT_COLUMNS]

        # Что в БД сейчас — индексируем по key для быстрого поиска
        present_keys = {c.get("key") for c in cfg if isinstance(c, dict)}
        result = list(cfg)
        added = False
        for std in DEFAULT_COLUMNS:
            if std.get("custom") is False and std["key"] not in present_keys:
                result.append(std.copy())
                added = True

        # Если что-то добавили — пересортируем по order, чтобы новые
        # колонки заняли своё логичное место (не в конце).
        if added:
            result.sort(key=lambda c: c.get("order", 999))
        return result

    def set_columns(self, columns: list) -> None:
        self.columns_config = columns or None


class Group(Base):
    __tablename__ = "groups"

    id        = Column(Integer, primary_key=True, index=True)
    event_id  = Column(Integer, ForeignKey("events.id"), nullable=False, index=True)  # ← index=True
    name      = Column(String, nullable=False)
    order_num = Column(Integer, default=0, index=True)   # ← index=True (ORDER BY)
    version   = Column(Integer, server_default="1", default=1, nullable=False)
    # Группа-«дополнительный список»: рендерится отдельной таблицей под
    # основной (например, водители в ГРОЗА-555). По умолчанию False.
    is_supplementary = Column(Boolean, default=False, nullable=False, server_default="0")

    # Метка времени готовности группы — отображается рядом с названием и
    # используется для подбора цвета в UI (одинаковые метки → одинаковый
    # пастельный фон). Свободная строка вида «Ч+0.10», «Ч+1.00», «Ч+3.00».
    time_offset = Column(String, nullable=False, default="", server_default="")

    # Какой день наряда подставлять в слоты этой группы при автозаполнении:
    #   0 — сегодняшний наряд (на event.date),
    #   1 — завтрашний (event.date + 1 день).
    # «Завтрашний» нужен для групп с большим временем готовности, где к
    # моменту реакции уже сменится суточный наряд.
    duty_day_offset = Column(Integer, nullable=False, default=0, server_default="0")

    # Ссылка на группу-источник из шаблона: при инстанцировании шаблона
    # каждая копируемая группа получает source_group_id = id оригинала.
    # Нужно для механизма «замещений» (DutyMark.substitute_template_group_id):
    # когда замещающий наряд указывает «положить ФИО в группу X шаблона Y»,
    # бэк находит конкретные инстансные groups через source_group_id.
    # Для шаблонов и ручных групп — NULL.
    source_group_id = Column(
        Integer,
        ForeignKey("groups.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    event = relationship("Event", back_populates="groups")
    slots = relationship("Slot",  back_populates="group", cascade="all, delete-orphan")


class Position(Base):
    __tablename__ = "positions"

    id   = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, unique=True)

    slots = relationship("Slot", back_populates="position")


class Slot(Base):
    __tablename__ = "slots"

    id              = Column(Integer, primary_key=True, index=True)
    group_id        = Column(Integer, ForeignKey("groups.id"),    nullable=False, index=True)  # ← index=True
    position_id     = Column(Integer, ForeignKey("positions.id"), nullable=True,  index=True)  # ← index=True
    department      = Column(String, nullable=False, index=True)   # ← index=True (фильтр по управлению)
    rank            = Column(String, nullable=True)
    full_name       = Column(String, nullable=True)
    doc_number      = Column(String, nullable=True)
    passport_number = Column(String, nullable=True)               # № загранпаспорта (snapshot из persons)
    callsign        = Column(String, nullable=True)
    note            = Column(String, nullable=True)
    version     = Column(Integer, default=1, nullable=False)
    # JSONB. Slots — самая «горячая» таблица: каждый рендер сетки слотов
    # дёргает get_extra() для substitute_note и кастомных столбцов.
    extra_data  = Column(JSONB, nullable=True)

    group    = relationship("Group",    back_populates="slots")
    position = relationship("Position", back_populates="slots")

    def get_extra(self) -> dict:
        data = self.extra_data
        return data if isinstance(data, dict) else {}

    def set_extra(self, data: dict) -> None:
        self.extra_data = data if data else None