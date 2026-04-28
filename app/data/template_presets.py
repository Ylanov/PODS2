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

    # ── 5. ГРОЗА-555 (сигнал, 30 человек + водители) ─────────────────────────
    # При выгрузке через «⬇ Скачать .docx» автоматически выходит формат
    # штабного шаблона: шапка с датой, основная таблица, отдельная
    # вспомогательная таблица «Состав сил обеспечения доставки» (водители
    # из supplementary-группы), подпись оперативного дежурного.
    {
        "id": "groza555",
        "name": "ГРОЗА-555 (30 человек + водители)",
        "description": "Состав сил по сигналу «ГРОЗА-555» — 30 человек в пяти "
                       "основных группах и доп. список из 4 водителей. "
                       "Колонка «Подразделение» как текстовая метка (1ЗНЦ, НОО, "
                       "НУ-1…, 5 упр. и т.п.).",
        "columns": [
            {"key": "full_name",   "label": "Фамилия Имя Отчество", "type": "text",            "order": 0, "width": 220, "visible": True,  "custom": False},
            {"key": "rank",        "label": "Воинское звание",      "type": "text",            "order": 1, "width": 130, "visible": True,  "custom": False},
            {"key": "doc_number",  "label": "№ документа",          "type": "text",            "order": 2, "width": 140, "visible": True,  "custom": False},
            {"key": "position_id", "label": "Должность, техника",   "type": "select_position", "order": 3, "width": 200, "visible": True,  "custom": False},
            {"key": "subdivision", "label": "Подразделение",        "type": "text",            "order": 4, "width": 130, "visible": True,  "custom": True},
            {"key": "callsign",    "label": "Позывной",             "type": "text",            "order": 5, "width": 100, "visible": False, "custom": False},
            {"key": "department",  "label": "Квота",                "type": "select_dept",     "order": 6, "width": 140, "visible": False, "custom": False},
            {"key": "note",        "label": "Примечание",           "type": "text",            "order": 7, "width": 160, "visible": False, "custom": False},
        ],
        "groups": [
            {"name": "Группа командования", "slots": [
                {"position": "командир отряда",     "extra": {"subdivision": "1ЗНЦ"}},
                {"position": "начальник штаба",    "extra": {"subdivision": "НОО"}},
                {"position": "начальник связи",    "extra": {"subdivision": "НОС"}},
                {"position": "врач",               "extra": {"subdivision": "НУ-6"}},
                {"position": "оператор БАС",       "extra": {"subdivision": "8 упр."}},
                {"position": "старший группы тыла","extra": {"subdivision": "НПС"}},
                {"position": "повар",              "extra": {"subdivision": "Б(О)"}},
            ]},
            {"name": "Группа РХБ защиты", "slots": [
                {"position": "старший группы",         "extra": {"subdivision": "НУ-3 (ЗНУ-3)"}},
                {"position": "газоспасатель",          "extra": {"subdivision": "3 упр."}},
                {"position": "газоспасатель-водитель", "extra": {"subdivision": "3 упр."}},
            ]},
            {"name": "Группа минимизации последствий № 1", "slots": [
                {"position": "старший группы", "extra": {"subdivision": "НУ-1 (ЗНУ-1)"}},
                {"position": "спасатель",      "extra": {"subdivision": "1 упр."}},
                {"position": "спасатель",      "extra": {"subdivision": "1 упр."}},
                {"position": "спасатель",      "extra": {"subdivision": "1 упр."}},
                {"position": "спасатель",      "extra": {"subdivision": "1 упр."}},
                {"position": "спасатель",      "extra": {"subdivision": "4 упр."}},
                {"position": "спасатель",      "extra": {"subdivision": "4 упр."}},
                {"position": "спасатель",      "extra": {"subdivision": "5 упр."}},
            ]},
            {"name": "Группа минимизации последствий № 2", "slots": [
                {"position": "старший группы",     "extra": {"subdivision": "НУ-2 (ЗНУ-2)"}},
                {"position": "спасатель",          "extra": {"subdivision": "2 упр."}},
                {"position": "спасатель",          "extra": {"subdivision": "2 упр."}},
                {"position": "спасатель",          "extra": {"subdivision": "2 упр."}},
                {"position": "спасатель",          "extra": {"subdivision": "2 упр."}},
                {"position": "спасатель-водитель", "extra": {"subdivision": "4 упр."}},
                {"position": "спасатель-водитель", "extra": {"subdivision": "4 упр."}},
            ]},
            {"name": "Группа ликвидации угрозы взрыва", "slots": [
                {"position": "старший группы",        "extra": {"subdivision": "НУ-5 (ЗНУ-5)"}},
                {"position": "пиротехник-спасатель",  "extra": {"subdivision": "5 упр."}},
                {"position": "пиротехник-спасатель",  "extra": {"subdivision": "5 упр."}},
                {"position": "пиротехник-спасатель",  "extra": {"subdivision": "5 упр."}},
                {"position": "кинолог",               "extra": {"subdivision": "5 упр."}},
            ]},
            # Доп. список — водители обеспечения. is_supplementary=True
            # запускает отдельную таблицу в Word при выгрузке.
            {"name": "Обеспечение доставки", "is_supplementary": True, "slots": [
                {"position": "водитель", "extra": {"subdivision": "ООБДД ВАИ"}},
                {"position": "водитель", "extra": {"subdivision": "Б(О)"}},
                {"position": "водитель", "extra": {"subdivision": "5 упр."}},
                {"position": "водитель", "extra": {"subdivision": "Б(О)"}},
            ]},
        ],
    },

    # ── 6. КОМАНДА-333 (расчёт усиления охраны) ─────────────────────────────
    # При выгрузке: таблица из 5 колонок (Задача / Время выделения /
    # Расчёт / Кто выделяет / ФИО), задача и время merged по строкам группы.
    #
    # Поле «Кто выделяет» = стандартное Slot.department (как Квота). Это
    # значит, что управления видят свои слоты в разделе «Списки» и сами
    # заполняют ФИО — точно так же, как в обычных шаблонах. В Word
    # колонка автоматически дополняется «– N чел.» по числу слотов
    # каждого управления в группе.
    {
        "id": "team333",
        "name": "КОМАНДА-333 (расчёт усиления)",
        "description": "Расчёт выделения личного состава для усиления охраны "
                       "военного городка по сигналу «КОМАНДА-333». 11 задач, "
                       "у каждой — своё время выделения. «Кто выделяет» — это "
                       "квота на управление, заполняется как обычно.",
        "columns": [
            {"key": "task_time",   "label": "Время выделения",          "type": "text",            "order": 0, "width": 120, "visible": True,  "custom": True},
            {"key": "position_id", "label": "Расчёт (по постам)",       "type": "select_position", "order": 1, "width": 200, "visible": True,  "custom": False},
            {"key": "department",  "label": "Квота",                    "type": "select_dept",     "order": 2, "width": 160, "visible": True,  "custom": False},
            {"key": "full_name",   "label": "Ф.И.О.",                   "type": "text",            "order": 3, "width": 220, "visible": True,  "custom": False},
            {"key": "rank",        "label": "Звание",                   "type": "text",            "order": 4, "width": 120, "visible": False, "custom": False},
            {"key": "doc_number",  "label": "№ документа",              "type": "text",            "order": 5, "width": 130, "visible": False, "custom": False},
            {"key": "callsign",    "label": "Позывной",                 "type": "text",            "order": 6, "width": 100, "visible": False, "custom": False},
            {"key": "note",        "label": "Примечание",               "type": "text",            "order": 7, "width": 160, "visible": False, "custom": False},
        ],
        "groups": [
            {"name": "Усиление пропускного режима в штабе", "slots": [
                {"position": "ПОД, ПОД по связи", "department": "ОДС",    "extra": {"task_time": "«Ч»+0.10"}},
                {"position": "ПОД, ПОД по связи", "department": "ОДС",    "extra": {"task_time": "«Ч»+0.10"}},
                {"position": "дежурная смена",    "department": "1 упр.", "extra": {"task_time": "«Ч»+0.10"}},
                {"position": "дежурная смена",    "department": "1 упр.", "extra": {"task_time": "«Ч»+0.10"}},
                {"position": "дежурная смена",    "department": "1 упр.", "extra": {"task_time": "«Ч»+0.10"}},
                {"position": "расчёт РХР",        "department": "3 упр.", "extra": {"task_time": "«Ч»+0.10"}},
                {"position": "расчёт РХР",        "department": "3 упр.", "extra": {"task_time": "«Ч»+0.10"}},
            ]},
            {"name": "Группа оцепления (оцепление территории с целью недопущения посторонних лиц)", "slots": [
                {"position": "детская площадка",                          "department": "2 упр.", "extra": {"task_time": "«Ч»+0.15"}},
                {"position": "с торца общежития №2",                     "department": "2 упр.", "extra": {"task_time": "«Ч»+0.15"}},
                {"position": "возле 1 ворот РТК",                        "department": "2 упр.", "extra": {"task_time": "«Ч»+0.15"}},
                {"position": "возле запасного входа (выхода) в столовую","department": "2 упр.", "extra": {"task_time": "«Ч»+0.15"}},
            ]},
            {"name": "Дежурное подразделение", "slots": [
                *[{"position": "Патрулирование служебной территории согласно схеме",
                   "department": "Б(О)", "extra": {"task_time": "«Ч»+0.20"}} for _ in range(6)],
            ]},
            {"name": "Выставление дополнительных вооружённых постов", "slots": [
                {"position": "на крыше общежития № 2",            "department": "1 упр.", "extra": {"task_time": "«Ч»+01.00"}},
                {"position": "на крыше общежития № 2",            "department": "1 упр.", "extra": {"task_time": "«Ч»+01.00"}},
                {"position": "на крыше бокса оперативных машин",  "department": "1 упр.", "extra": {"task_time": "«Ч»+01.00"}},
                {"position": "на крыше бокса оперативных машин",  "department": "3 упр.", "extra": {"task_time": "«Ч»+01.00"}},
                {"position": "на крыше РТК",                      "department": "4 упр.", "extra": {"task_time": "«Ч»+01.00"}},
                {"position": "на крыше РТК",                      "department": "4 упр.", "extra": {"task_time": "«Ч»+01.00"}},
                {"position": "на крыше бойлерной",                "department": "5 упр.", "extra": {"task_time": "«Ч»+01.00"}},
                {"position": "на крыше бойлерной",                "department": "5 упр.", "extra": {"task_time": "«Ч»+01.00"}},
            ]},
            {"name": "Пожарный расчёт (по дополнительному распоряжению)", "slots": [
                *[{"position": "пожарная команда", "department": "Б(О)",
                   "extra": {"task_time": "«Ч»+0.10"}} for _ in range(3)],
            ]},
            {"name": "Мобильный резерв (по дополнительному распоряжению)", "slots": [
                *[{"position": "мобильный резерв", "department": "2 упр.",
                   "extra": {"task_time": "«Ч»+0.40"}} for _ in range(6)],
            ]},
            {"name": "Выставление ПРХН (по дополнительному распоряжению)", "slots": [
                *[{"position": "возле КПП №2", "department": "3 упр.",
                   "extra": {"task_time": "«Ч»+0.40"}} for _ in range(2)],
            ]},
            {"name": "Группа спец. работ с применением РТС (по дополнительному распоряжению)", "slots": [
                *[{"position": "расчёты РТС «TEL-630»", "department": "4 упр.",
                   "extra": {"task_time": "«Ч»+1.00"}} for _ in range(4)],
            ]},
            {"name": "Группа пиротехнических и кинологических работ (по дополнительному распоряжению)", "slots": [
                *[{"position": "пиротехнический расчёт", "department": "5 упр.",
                   "extra": {"task_time": "«Ч»+1.00"}} for _ in range(3)],
            ]},
            {"name": "МСГ (по дополнительному распоряжению)", "slots": [
                *[{"position": "медико-спасательная группа", "department": "6 упр.",
                   "extra": {"task_time": "«Ч»+1.00"}} for _ in range(2)],
            ]},
            {"name": "Расчёт беспилотной авиационной системы (по дополнительному распоряжению)", "slots": [
                {"position": "оператор беспилотного воздушного судна",
                 "department": "8 упр.", "extra": {"task_time": "«Ч»+1.00"}},
            ]},
        ],
    },

    # ── 7. Пиротехнические расчёты 5 управления ──────────────────────────────
    # Многотабличный шаблон: 3 пиротехнических расчёта (1 час / 3 часа / 3 часа)
    # + кинологические расчёты по отдельной команде (supplementary). Дефолт
    # квоты — «5 Управление». Если в системе управление называется иначе,
    # после создания шаблона: выделить все строки чекбоксом → bulk-action
    # «🔀 Переназначить» → выбрать нужное управление → ОК.
    {
        "id": "pyro5",
        "name": "Пиротехнические расчёты (5 Управление)",
        "description": "Список пиротехнических расчётов 5 Управления в постоянной "
                       "готовности к ЧС со взрывчатыми веществами. 3 расчёта "
                       "(1 час / 3 часа / 3 часа) + кинологические расчёты "
                       "по отдельной команде. Все слоты предзаполнены квотой "
                       "«5 Управление» — поменять на другое можно одной "
                       "командой через bulk-«Переназначить».",
        "columns": COLS_STANDARD,
        "groups": [
            {"name": "Пиротехнический расчёт №1: готовность к применению 1 час", "slots": [
                {"position": "старший расчёта",          "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "водитель Форд Транзит",    "department": "5 Управление"},
            ]},
            {"name": "Пиротехнический расчёт №2: готовность к применению 3 часа", "slots": [
                {"position": "старший расчёта",          "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "водитель Форд Транзит",    "department": "5 Управление"},
            ]},
            {"name": "Пиротехнический расчёт №3: готовность к применению 3 часа", "slots": [
                {"position": "старший расчёта",          "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "пиротехник",               "department": "5 Управление"},
                {"position": "водитель Форд Транзит",    "department": "5 Управление"},
            ]},
            # Кинологические — отдельная таблица «по отдельной команде».
            {"name": "Кинологические расчёты: по отдельной команде",
             "is_supplementary": True, "slots": [
                {"position": "кинолог", "department": "5 Управление"},
                {"position": "кинолог", "department": "5 Управление"},
                {"position": "кинолог", "department": "5 Управление"},
                {"position": "кинолог", "department": "5 Управление"},
                {"position": "кинолог", "department": "5 Управление"},
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
