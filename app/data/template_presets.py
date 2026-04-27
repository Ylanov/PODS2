# app/data/template_presets.py
"""
Каталог пресетов шаблонов — заготовки на основе реальных docx-документов
(АМГ эшелон, АМГ паводки, Аэрозоль, ГРОЗА и т. д.).

Админ выбирает пресет при создании нового шаблона — получает уже готовую
структуру: настроенные колонки, группы и типовые слоты с должностями.
ФИО, документы и квоты-управления проставляются потом в редакторе.

Формат пресета:
    {
      "id":           str  — slug, используется в URL
      "name":         str  — отображаемое название
      "description":  str  — короткое пояснение
      "columns":      list — columns_config в формате DEFAULT_COLUMNS (event.py)
      "groups":       list — [{"name": str, "slots": [{"position": str}, ...]}]
    }

Как добавить новый пресет:
    1. Взять один из COL_* наборов колонок ниже (или описать свой).
    2. Перечислить группы с типовыми должностями — имена должностей
       будут автоматически upsert-нуты в справочник positions.
    3. Вписать словарь в PRESETS.
"""

# ─── Наборы колонок ──────────────────────────────────────────────────────────

# Стандартный АМГ: Звание · ФИО · № документа · Должность · Квота · Примечание
# (callsign скрыт — в большинстве шаблонов позывные не используются)
COLS_STANDARD = [
    {"key": "full_name",   "label": "ФИО",         "type": "text",            "order": 0, "width": 220, "visible": True,  "custom": False},
    {"key": "rank",        "label": "Звание",       "type": "text",            "order": 1, "width": 130, "visible": True,  "custom": False},
    {"key": "doc_number",  "label": "№ документа",  "type": "text",            "order": 2, "width": 140, "visible": True,  "custom": False},
    {"key": "position_id", "label": "Должность",    "type": "select_position", "order": 3, "width": 200, "visible": True,  "custom": False},
    {"key": "callsign",    "label": "Позывной",     "type": "text",            "order": 4, "width": 100, "visible": False, "custom": False},
    {"key": "department",  "label": "Квота",        "type": "select_dept",     "order": 5, "width": 120, "visible": True,  "custom": False},
    {"key": "note",        "label": "Примечание",   "type": "text",            "order": 6, "width": 160, "visible": True,  "custom": False},
]

# АМГ с позывным — дополнительная колонка callsign (для 1-го эшелона
# и где позывные принципиальны для связи)
COLS_WITH_CALLSIGN = [
    {**c, "visible": True} if c["key"] == "callsign" else c
    for c in COLS_STANDARD
]

# Аэрозоль (ХЛК): В/звание · Ф.И.О. · Должность · Подразделение —
# без № документа, без примечания, квота переименована в «Подразделение»
COLS_AEROSOL = [
    {"key": "full_name",   "label": "Ф.И.О.",        "type": "text",            "order": 0, "width": 220, "visible": True,  "custom": False},
    {"key": "rank",        "label": "В/звание",      "type": "text",            "order": 1, "width": 130, "visible": True,  "custom": False},
    {"key": "doc_number",  "label": "№ документа",   "type": "text",            "order": 2, "width": 140, "visible": False, "custom": False},
    {"key": "position_id", "label": "Должность",     "type": "select_position", "order": 3, "width": 220, "visible": True,  "custom": False},
    {"key": "callsign",    "label": "Позывной",      "type": "text",            "order": 4, "width": 100, "visible": False, "custom": False},
    {"key": "department",  "label": "Подразделение", "type": "select_dept",     "order": 5, "width": 140, "visible": True,  "custom": False},
    {"key": "note",        "label": "Примечание",    "type": "text",            "order": 6, "width": 160, "visible": False, "custom": False},
]


# ─── Переиспользуемые блоки групп ────────────────────────────────────────────

# Повторяющееся ядро многих АМГ: группа управления → медики → БАС → СПГ
_AMG_CORE_GROUPS = [
    {"name": "Группа управления", "slots": [
        {"position": "старший АМГ"},
        {"position": "начальник штаба"},
        {"position": "оператор"},
        {"position": "начальник связи"},
    ]},
    {"name": "Медико-спасательная группа", "slots": [
        {"position": "врач (фельдшер)"},
        {"position": "водитель"},
    ]},
    {"name": "Расчёт БАС", "slots": [
        {"position": "старший расчёта-оператор БАС"},
        {"position": "оператор БАС"},
    ]},
    {"name": "Группа сил постоянной готовности", "slots": [
        {"position": "старший группы СПГ"},
        {"position": "спасатель ДС"},
        {"position": "спасатель ДС"},
        {"position": "старший расчёта РХР"},
        {"position": "химик-дозиметрист расчёта РХР"},
    ]},
]


def _rescuers_group(num: int, size: int = 5) -> dict:
    """Группа спасателей №N: старший + (size-1) спасателей."""
    return {
        "name": f"Группа спасателей № {num}",
        "slots": [{"position": "старший группы"}] + [
            {"position": "спасатель"} for _ in range(size - 1)
        ],
    }


def _watercraft_group(num: int, size: int = 4) -> dict:
    """Группа спасателей на плавсредстве №N."""
    return {
        "name": f"Группа спасателей на плавсредстве № {num}",
        "slots": [{"position": "старший группы"}] + [
            {"position": "спасатель-водолаз"} for _ in range(size - 1)
        ],
    }


def _evac_group(num: int, size: int = 4) -> dict:
    """Группа организации эвакуационных и спасательных работ №N."""
    return {
        "name": f"Группа организации эвакуационных и спасательных работ № {num}",
        "slots": [{"position": "старший группы"}] + [
            {"position": "спасатель"} for _ in range(size - 1)
        ],
    }


_AMG_REAR_GROUPS = [
    {"name": "Группа тылового обеспечения", "slots": [
        {"position": "старший группы тылового обеспечения"},
        {"position": "водитель"},
        {"position": "водитель"},
    ]},
    {"name": "Обеспечение АМГ", "slots": [
        {"position": "водитель"},
        {"position": "водитель"},
        {"position": "водитель"},
    ]},
]


# ─── Каталог пресетов ────────────────────────────────────────────────────────

PRESETS: list[dict] = [

    # ── 1. АМГ эшелон (стандарт) ─────────────────────────────────────────────
    {
        "id": "amg_standard",
        "name": "АМГ эшелон (стандарт)",
        "description": "Состав эшелона аэромобильной группировки. "
                       "Базовый шаблон: управление, медики, БАС, СПГ, "
                       "три группы спасателей, тыл, обеспечение.",
        "columns": COLS_STANDARD,
        "groups": [
            *_AMG_CORE_GROUPS,
            _rescuers_group(1),
            _rescuers_group(2),
            _rescuers_group(3),
            *_AMG_REAR_GROUPS,
        ],
    },

    # ── 2. АМГ эшелон (с позывным) ────────────────────────────────────────────
    {
        "id": "amg_with_callsign",
        "name": "АМГ эшелон (с позывным)",
        "description": "То же, что стандарт, но со столбцом «Позывной» — "
                       "для шаблонов, где каждому слоту присваивается код связи.",
        "columns": COLS_WITH_CALLSIGN,
        "groups": [
            *_AMG_CORE_GROUPS,
            _rescuers_group(1),
            _rescuers_group(2),
            _rescuers_group(3),
            *_AMG_REAR_GROUPS,
        ],
    },

    # ── 3. АМГ Паводки ────────────────────────────────────────────────────────
    {
        "id": "amg_floods",
        "name": "АМГ Паводки",
        "description": "Состав сил для ликвидации последствий ЧС в паводкоопасный "
                       "период. Водолазная группа, плавсредства, группы эвакуации.",
        "columns": COLS_STANDARD,
        "groups": [
            {"name": "Группа управления", "slots": [
                {"position": "старший АМГ"},
                {"position": "начальник штаба"},
                {"position": "оператор"},
                {"position": "начальник связи"},
            ]},
            {"name": "Группа тылового обеспечения", "slots": [
                {"position": "старший группы тылового обеспечения"},
                {"position": "водитель"},
            ]},
            {"name": "Расчёт БАС", "slots": [
                {"position": "старший расчёта-оператор БАС"},
                {"position": "оператор БАС"},
            ]},
            {"name": "Медико-спасательная группа", "slots": [
                {"position": "врач (фельдшер)"},
                {"position": "водитель"},
            ]},
            {"name": "Пиротехническая группа", "slots": [
                {"position": "старший пиротехнической группы"},
                {"position": "пиротехник"},
                {"position": "пиротехник"},
            ]},
            {"name": "Водолазная группа", "slots": [
                {"position": "старший водолазной группы"},
                {"position": "водолаз"},
                {"position": "водолаз"},
                {"position": "врач (фельдшер)"},
            ]},
            _watercraft_group(1),
            _watercraft_group(2),
            _watercraft_group(3),
            _watercraft_group(4),
            _evac_group(1),
            _evac_group(2),
            _evac_group(3),
            _evac_group(4),
            {"name": "Обеспечение АМГ", "slots": [
                {"position": "водитель"},
                {"position": "водитель"},
                {"position": "водитель"},
            ]},
        ],
    },

    # ── 4. Аэрозоль (ХЛК) ─────────────────────────────────────────────────────
    {
        "id": "aerosol",
        "name": "Аэрозоль (ХЛК)",
        "description": "Ликвидация последствий террористических акций с применением "
                       "отравляющих веществ. Две волны: дежурные («Ч»+1.00) "
                       "и основные («Ч»+3.00).",
        "columns": COLS_AEROSOL,
        "groups": [
            # Дежурные силы реагирования («Ч»+1.00)
            {"name": "«Ч»+1.00 · Группа управления", "slots": [
                {"position": "старший"},
                {"position": "начальник штаба"},
                {"position": "оператор"},
            ]},
            {"name": "«Ч»+1.00 · Группа спасательных работ", "slots": [
                {"position": "старший группы"},
                {"position": "спасатель"},
                {"position": "спасатель"},
                {"position": "спасатель"},
            ]},
            {"name": "«Ч»+1.00 · Группа газоспасательных работ", "slots": [
                {"position": "старший группы"},
                {"position": "газоспасатель"},
                {"position": "газоспасатель"},
                {"position": "газоспасатель"},
            ]},
            # Основные силы реагирования («Ч»+3.00)
            {"name": "«Ч»+3.00 · Группа управления", "slots": [
                {"position": "старший"},
                {"position": "начальник штаба"},
                {"position": "оператор"},
                {"position": "начальник связи"},
            ]},
            {"name": "«Ч»+3.00 · Группа тылового обеспечения", "slots": [
                {"position": "старший группы тылового обеспечения"},
                {"position": "водитель"},
                {"position": "водитель"},
            ]},
            {"name": "«Ч»+3.00 · Группа спасательных работ", "slots": [
                {"position": "старший группы"},
                {"position": "спасатель"},
                {"position": "спасатель"},
            ]},
            {"name": "«Ч»+3.00 · Газоспасательное отделение № 1", "slots": [
                {"position": "старший отделения"},
                {"position": "газоспасатель"},
                {"position": "газоспасатель"},
            ]},
            {"name": "«Ч»+3.00 · Газоспасательное отделение № 2", "slots": [
                {"position": "старший отделения"},
                {"position": "газоспасатель"},
                {"position": "газоспасатель"},
            ]},
            {"name": "«Ч»+3.00 · Газоспасательное отделение № 3", "slots": [
                {"position": "старший отделения"},
                {"position": "газоспасатель"},
                {"position": "газоспасатель"},
            ]},
            {"name": "«Ч»+3.00 · Группа робототехнических средств", "slots": [
                {"position": "старший расчёта робототехнических средств"},
                {"position": "оператор РТС"},
            ]},
            {"name": "«Ч»+3.00 · Группа пиротехнических работ", "slots": [
                {"position": "старший группы"},
                {"position": "пиротехник"},
                {"position": "пиротехник"},
            ]},
            {"name": "«Ч»+3.00 · Медико-спасательная группа", "slots": [
                {"position": "врач (фельдшер)"},
                {"position": "водитель"},
            ]},
            {"name": "«Ч»+3.00 · Группа обеспечения спасательных работ", "slots": [
                {"position": "старший группы"},
                {"position": "водитель"},
                {"position": "водитель"},
            ]},
        ],
    },

    # ── 5. ГРОЗА (сигнал тревоги) ─────────────────────────────────────────────
    {
        "id": "groza",
        "name": "ГРОЗА (сигнал)",
        "description": "Состав сил по сигналу «ГРОЗА» (террористическая угроза "
                       "со взрывоопасным предметом). Командование + РХБ + "
                       "минимизация последствий + ликвидация взрыва.",
        "columns": COLS_STANDARD,
        "groups": [
            {"name": "Группа командования", "slots": [
                {"position": "старший"},
                {"position": "начальник штаба"},
                {"position": "оператор"},
                {"position": "начальник связи"},
            ]},
            {"name": "Группа РХБ защиты", "slots": [
                {"position": "старший группы"},
                {"position": "химик-дозиметрист"},
                {"position": "химик-дозиметрист"},
            ]},
            {"name": "Группа минимизации последствий № 1", "slots": [
                {"position": "старший группы"},
                {"position": "спасатель"},
                {"position": "спасатель"},
                {"position": "спасатель"},
            ]},
            {"name": "Группа минимизации последствий № 2", "slots": [
                {"position": "старший группы"},
                {"position": "спасатель"},
                {"position": "спасатель"},
                {"position": "спасатель"},
            ]},
            {"name": "Группа ликвидации угрозы взрыва", "slots": [
                {"position": "старший пиротехнической группы"},
                {"position": "пиротехник"},
                {"position": "пиротехник"},
                {"position": "кинолог"},
            ]},
        ],
    },
]


def get_preset(preset_id: str) -> dict | None:
    """Возвращает пресет по id или None."""
    return next((p for p in PRESETS if p["id"] == preset_id), None)


def list_presets_meta() -> list[dict]:
    """
    Лёгкий список пресетов для дропдауна в UI —
    без полного содержимого групп, только счётчики.
    """
    return [
        {
            "id":           p["id"],
            "name":         p["name"],
            "description":  p["description"],
            "groups_count": len(p["groups"]),
            "slots_count":  sum(len(g["slots"]) for g in p["groups"]),
        }
        for p in PRESETS
    ]
