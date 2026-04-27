# app/data/comms_report_defaults.py
"""
Дефолтная структура отчёта 3-СВЯЗЬ — 18 направлений (категорий) с типовыми
позициями из docx-шаблона. При первом обращении к отчёту за год структура
копируется в БД, дальше отдел редактирует значения.

Формат одного направления:
  {
    "id":        slug-идентификатор (стабильный, используется в UI для ключа)
    "index":     номер направления в отчёте (1..18)
    "title":     название направления
    "unit":      единица измерения ("к-т", "км", …)
    "items": [
      {
        "id":         slug модели
        "name":       полное название (например "Такт-201")
        "required":   потребность (штат)
        "start":      состояло на 1 января (прошлый год)
        "arrived":    прибыло за период
        "removed":    убыло за период
        # производные считаются клиентом/экспортёром:
        #   total     = start + arrived - removed
        #   working, modern, overdue — три поля «в том числе»
        #   plus      = кроме того
        #   percent   = округлённый total/required*100 (0 если required=0)
        #   diff      = total - required  (выводится с + или −)
        "working":    в наличии исправной
        "modern":     в наличии современной
        "overdue":    со сроком службы свыше установленного
        "plus":       кроме того
        "note":       примечание
      },
      …
    ]
  }

Позиция-«заголовок направления» (без name, агрегирующая строка) хранится
отдельно в поле "summary" — её числа клиент пересчитывает как сумму items.
"""

# Порядок и состав категорий — один-в-один с docx (см. Форма 3-СВЯЗЬ_26.docx).
# Внутри каждого направления: именованные группы (напр. «стационарные» /
# «автомобильные» / «переносные» для УКВ) — это разделители, не элементы.
# В MVP группы плоско встроены в items как отдельные строки с флагом
# "is_group": True. Админ сможет добавлять/удалять строки в UI.

DEFAULTS = [
    {
        "id": "avia", "index": 1, "unit": "к-т",
        "title": "Авиационная техника связи",
        "items": [
            {"id": "r853",      "name": "Радиостанции Р-853"},
            {"id": "icom_a14",  "name": "Авиационная радиостанция Icom Ic-a14"},
        ],
    },
    {
        "id": "kv", "index": 2, "unit": "к-т",
        "title": "Радиостанции КВ",
        "items": [
            {"id": "kv_stat",      "name": "Стационарные КВ", "is_group": True},
            {"id": "r163_50k",     "name": "Р-163-50к"},
            {"id": "kordon_r12",   "name": "Кордон Р-12"},
            {"id": "kv_auto",      "name": "Автомобильные КВ", "is_group": True},
            {"id": "kordon_r12_a", "name": "Кордон Р-12"},
            {"id": "ic78",         "name": "Ic-78"},
            {"id": "kv_port",      "name": "Переносные КВ",  "is_group": True},
            {"id": "r168_1k",      "name": "Р-168-1к"},
            {"id": "vertex1210",   "name": "Vertex vx-1210"},
            {"id": "kordon_r23",   "name": "Кордон Р-23"},
            {"id": "hf90",         "name": "HF-90"},
        ],
    },
    {
        "id": "ukv", "index": 3, "unit": "к-т",
        "title": "Радиостанции УКВ",
        "items": [
            {"id": "ukv_stat",   "name": "Радиостанции УКВ стационарные", "is_group": True},
            {"id": "takt102",    "name": "Такт-102"},
            {"id": "icom5000",   "name": "Icom-5000"},
            {"id": "vertex7000", "name": "Vertex-7000"},
            {"id": "ukv_auto",   "name": "Радиостанции УКВ автомобильные", "is_group": True},
            {"id": "takt101",    "name": "Такт-101"},
            {"id": "takt201",    "name": "Такт-201"},
            {"id": "icf111",     "name": "Ic-f111"},
            {"id": "motorola_gm1200e", "name": "Моторола Gm-1200е"},
            {"id": "kenwood_tk760", "name": "Kenwood Tk 760 hg"},
            {"id": "icf5061",    "name": "Ic-f5061"},
            {"id": "ukv_port",   "name": "Радиостанции УКВ переносные", "is_group": True},
            {"id": "r159m",      "name": "Р-159м"},
            {"id": "r168_5un",   "name": "Р-168-5ун"},
            {"id": "takt301",    "name": "Такт-301"},
            {"id": "takt162",    "name": "Такт-162"},
            {"id": "takt362",    "name": "Такт-362"},
            {"id": "takt363",    "name": "Такт-363"},
            {"id": "takt364",    "name": "Такт-364"},
            {"id": "granit_r32", "name": "Гранит Р-32"},
            {"id": "motorola_dp4800", "name": "Motorola DP 4800 VHF 403-527 МГц"},
            {"id": "icf16",      "name": "Ic-f16"},
            {"id": "icf33gs",    "name": "Ic-f33gs"},
            {"id": "vertex821v", "name": "Vertex 821v"},
            {"id": "standart_hx390", "name": "Standart НХ 390 ved"},
            {"id": "kenwood_tk2206", "name": "Kenwood Tk 2206"},
            {"id": "apex351",    "name": "Apex 351.01 п 45 ЯШВА"},
            {"id": "hp_hytera565", "name": "HP Hytera 565 U DMR UHF"},
            {"id": "astra_dpv2", "name": "Астра DP V2"},
        ],
    },
    {
        "id": "sat", "index": 4, "unit": "к-т",
        "title": "Станции спутниковой связи",
        "items": [
            {"id": "r438",        "name": "Станции спутниковой связи Р-438"},
            {"id": "iridium_ext", "name": "Спутниковый телефон Iridium extreme"},
            {"id": "iridium_9555","name": "Спутниковый телефон Iridium 9555"},
            {"id": "sss_tt700",   "name": "ССС ТТ Explorer-700"},
        ],
    },
    {
        "id": "receiver", "index": 5, "unit": "к-т",
        "title": "Радиоприёмники",
        "items": [
            {"id": "r160p", "name": "Р-160п"},
        ],
    },
    {
        "id": "telegr", "index": 6, "unit": "к-т",
        "title": "Средства телеграфной и телефонной связи",
        "items": [
            {"id": "p330_6", "name": "П-330-6"},
        ],
    },
    {
        "id": "switch", "index": 7, "unit": "к-т",
        "title": "Коммутаторы",
        "items": [
            {"id": "p193", "name": "П-193"},
        ],
    },
    {
        "id": "wired", "index": 8, "unit": "к-т",
        "title": "Средства проводной связи",
        "items": [
            {"id": "ats300",     "name": "АТС на 300 номеров"},
            {"id": "ats_protey", "name": "АТС протей-imswitch5 СП"},
        ],
    },
    {
        "id": "service", "index": 9, "unit": "к-т",
        "title": "Аппаратура и оборудование служебной связи",
        "items": [
            {"id": "ikm30",   "name": "Аппаратура уплотнения ИКМ-30"},
            {"id": "komplekt5","name": "Комплект №5"},
        ],
    },
    {
        "id": "cables", "index": 10, "unit": "км",
        "title": "Кабели телефонно-телеграфные",
        "items": [
            {"id": "p274m", "name": "Кабель П-274м"},
        ],
    },
    {
        "id": "phones", "index": 11, "unit": "к-т",
        "title": "Телефонные аппараты",
        "items": [
            {"id": "ta57",     "name": "ТА-57"},
            {"id": "phone_wired","name": "Проводной телефон"},
        ],
    },
    {
        "id": "special", "index": 12, "unit": "к-т",
        "title": "Техника и средства специальной связи",
        "items": [
            {"id": "bm2",     "name": "Бумагорезательные машины БМ-2"},
            {"id": "m500",    "name": "Сотовые телефоны М-500"},
            {"id": "m633s",   "name": "Сотовые телефоны М-633с"},
        ],
    },
    {
        "id": "power", "index": 13, "unit": "к-т",
        "title": "Системы электропитания АСП-202",
        "items": [
            {"id": "asp202", "name": "АСП-202"},
        ],
    },
    {
        "id": "alert", "index": 14, "unit": "к-т",
        "title": "Аппаратура оповещения",
        "items": [
            {"id": "aso4m",   "name": "АСО-4м"},
            {"id": "aso8",    "name": "АСО-8"},
            {"id": "ktso_trv","name": "КТСО-ТРВ"},
            {"id": "p166m",   "name": "П-166м"},
        ],
    },
    {
        "id": "genset", "index": 15, "unit": "к-т",
        "title": "Электроагрегаты АБ-4-Т230-ВП",
        "items": [
            {"id": "gen_1kw",  "name": "Однофазные 1 кВт 230 в"},
            {"id": "gen_2kw",  "name": "Однофазные 2 кВт 230 в"},
            {"id": "gen_3kw",  "name": "Однофазные 3 кВт 230 в"},
        ],
    },
    {
        "id": "pc", "index": 16, "unit": "к-т",
        "title": "Персональные профессиональные ЭВМ",
        "items": [
            {"id": "pc_std",   "name": "Персональные ЭВМ"},
            {"id": "pc_gfx",   "name": "Графические станции"},
            {"id": "pc_port",  "name": "Портативные ПЭВМ"},
        ],
    },
    {
        "id": "lan", "index": 17, "unit": "к-т",
        "title": "Оборудование локальных вычислительных сетей",
        "items": [
            {"id": "lan_server", "name": "Серверы ЛВС"},
        ],
    },
    {
        "id": "periph", "index": 18, "unit": "к-т",
        "title": "Аппаратура и отдельные устройства персональных ЭВМ",
        "items": [
            {"id": "printer",   "name": "Принтеры ПЭВМ"},
            {"id": "mfu",       "name": "МФУ ПЭВМ"},
            {"id": "copier",    "name": "Копировальный аппарат ПЭВМ"},
            {"id": "fax",       "name": "Факс ПЭВМ"},
            {"id": "plotter",   "name": "Плоттеры ПЭВМ"},
            {"id": "scanner",   "name": "Сканеры ПЭВМ"},
            {"id": "ups",       "name": "Источники бесперебойного питания"},
        ],
    },
]


# ── Утилиты ──────────────────────────────────────────────────────────────────

# Числовые поля одной позиции. Помимо базовых движения (required/start/
# arrived/removed) и трёх «в том числе» (working/modern/overdue), храним
# 8 «кроме того» подкатегорий — точно как в docx (колонки 12-19):
#   nz             — В «НЗ» (неприкосновенный запас)
#   td             — На «ТД» (текущий довольствующий)
#   backup_fund    — Подменный фонд 2-3 кат.
#   mchs_reserve   — Резерв МЧС России
#   capital_repair — В т.ч. кап. ремонт
#   mb             — На МБ (материальная база)
#   written_off    — В т.ч. списано
#   plus           — В запасах центров (раньше единственное поле «кроме того»,
#                    оставляем имя для обратной совместимости со старыми записями)
_NUMERIC_FIELDS = (
    "required", "start", "arrived", "removed",
    "working", "modern", "overdue",
    "nz", "td", "backup_fund", "mchs_reserve",
    "capital_repair", "mb", "written_off", "plus",
)


def normalize_item(item: dict) -> dict:
    """
    Гарантирует наличие всех числовых полей и примечания у позиции.
    Сохраняет is_group=True у строк-разделителей. Неизвестные поля не теряет.
    """
    out = dict(item)
    for f in _NUMERIC_FIELDS:
        v = out.get(f, 0)
        try:
            out[f] = int(v) if v not in (None, "") else 0
        except (ValueError, TypeError):
            out[f] = 0
    out.setdefault("note", "")
    return out


def make_default_report() -> list[dict]:
    """
    Возвращает глубокую копию DEFAULTS с нулевыми числовыми полями в каждой
    позиции. Именно это сохраняется при создании нового отчёта.
    """
    result = []
    for cat in DEFAULTS:
        cat_copy = {
            "id":    cat["id"],
            "index": cat["index"],
            "title": cat["title"],
            "unit":  cat["unit"],
            "items": [normalize_item(it) for it in cat["items"]],
        }
        result.append(cat_copy)
    return result


def compute_derived(item: dict) -> dict:
    """
    Считает производные значения (total, percent, diff) на основе числовых
    полей позиции. Не мутирует оригинал, возвращает dict с добавленными
    ключами total, percent, diff. Используется на бэке при экспорте.
    """
    normalized = normalize_item(item)
    total   = normalized["start"] + normalized["arrived"] - normalized["removed"]
    req     = normalized["required"]
    percent = round(total / req * 100) if req > 0 else (0 if total == 0 else 100)
    diff    = total - req
    return {
        **normalized,
        "total":   total,
        "percent": percent,
        "diff":    diff,
    }
