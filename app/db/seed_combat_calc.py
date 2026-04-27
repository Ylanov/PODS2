# app/db/seed_combat_calc.py
"""
Засев шаблонов боевого расчёта из документов.
Вызывается один раз из init_db.py если шаблоны ещё не существуют.
"""

from app.models.combat_calc import CombatCalcTemplate

# ─── Шаблон 1: Расчёт выделения л/с для выполнения первоочередных мероприятий ─

TEMPLATE_1 = {
    "sections": [
        {
            "title": "При приведении Центра в боевую готовность",
            "rows": [
                {
                    "key": "s1_r1a", "num": "1",
                    "label": "Оповещение л/с в общежитии №1",
                    "time": "Ч+0.10",
                    "who_provides": "база (обеспечения) — 2 чел.",
                    "slots": [
                        {"index": 0, "location": "1 под.", "department": ""},
                        {"index": 1, "location": "2 под.", "department": ""}
                    ]
                },
                {
                    "key": "s1_r1b", "num": "",
                    "label": "Оповещение л/с в общежитии №2",
                    "time": "Ч+0.10",
                    "who_provides": "база (обеспечения) — 2 чел.",
                    "slots": [
                        {"index": 0, "location": "2 и 3 эт.", "department": ""},
                        {"index": 1, "location": "4 и 5 эт.", "department": ""}
                    ]
                },
                {
                    "key": "s1_r1c", "num": "",
                    "label": "Оповещение л/с в общежитии №3, здании офицерского клуба",
                    "time": "Ч+0.10",
                    "who_provides": "база (обеспечения) — 1 чел.",
                    "slots": [
                        {"index": 0, "location": "2 и 3 эт.", "department": ""},
                        {"index": 1, "location": "2 эт.",     "department": ""}
                    ]
                },
                {
                    "key": "s1_r1d", "num": "",
                    "label": "Оповещение л/с в общежитии №4",
                    "time": "Ч+0.10",
                    "who_provides": "база (обеспечения) — 2 чел.",
                    "slots": [
                        {"index": 0, "location": "1 и 2 эт.", "department": ""},
                        {"index": 1, "location": "3 и 4 эт.", "department": ""}
                    ]
                },
                {
                    "key": "s1_r2", "num": "2",
                    "label": "Вооружённая охрана штаба",
                    "time": "Ч+0.40",
                    "who_provides": "база (обеспечения), дежурное подразделение — 2 чел.",
                    "slots": [
                        {"index": 0, "location": "", "department": ""}
                    ]
                },
                {
                    "key": "s1_r3", "num": "3",
                    "label": "Вооружённая охрана территории Центра путём патрулирования",
                    "time": "Ч+0.40",
                    "who_provides": "база (обеспечения), дежурное подразделение — 4 чел.",
                    "slots": [
                        {"index": 0, "location": "", "department": ""}
                    ]
                },
                {
                    "key": "s1_r4", "num": "4",
                    "label": "Выставление ПРХН",
                    "time": "Ч+0.40",
                    "who_provides": "3 управления — 2 чел.",
                    "slots": [
                        {"index": 0, "location": "", "department": ""}
                    ]
                },
                {
                    "key": "s1_r5", "num": "5",
                    "label": "Регулирование движения автотранспорта",
                    "time": "Ч+0.10",
                    "who_provides": "база (обеспечения) — 3 чел.",
                    "slots": [
                        {"index": 0, "location": "", "department": ""}
                    ]
                },
                {
                    "key": "s1_r6a", "num": "6",
                    "label": "Вооружённое сопровождение получения оружия и боеприпасов в Ногинском СЦ",
                    "time": "Ч+3.30",
                    "who_provides": "полученение вооружения, автомобиль",
                    "slots": [
                        {"index": 0, "location": "САВ", "department": ""},
                        {"index": 1, "location": "2 упр.", "department": ""},
                        {"index": 2, "location": "2 упр.", "department": ""}
                    ]
                },
                {
                    "key": "s1_r7", "num": "7",
                    "label": "Вывоз документов составляющих государственную тайну",
                    "time": "Ч+20.00",
                    "who_provides": "УЦ — 4 чел. (вооружённое сопровождение)",
                    "slots": [
                        {"index": 0, "location": "Секретное отделение", "department": ""},
                        {"index": 1, "location": "ФЭО",                 "department": ""},
                        {"index": 2, "location": "Отдел кадров",        "department": ""},
                        {"index": 3, "location": "Отдел ОиК",           "department": ""},
                        {"index": 4, "location": "Б(О)",                "department": ""}
                    ]
                },
                {
                    "key": "s1_r8", "num": "8",
                    "label": "Вывоз секретных документов и боевого знамени в новый район сосредоточения",
                    "time": "Ч+24.00",
                    "who_provides": "2 управления — 4 чел. (вооружённое сопровождение)",
                    "slots": [
                        {"index": 0, "location": "2 упр.", "department": ""}
                    ]
                }
            ]
        },
        {
            "title": "Мероприятия в интересах ЦА МЧС России",
            "rows": [
                {
                    "key": "s2_r1", "num": "1",
                    "label": "Усиление охраны и пропускного режима на территории административных зданий ЦА МЧС России (второй состав суточных нарядов №1,2,3)",
                    "time": "Ч+4.00",
                    "who_provides": "2 управления — 6 чел.",
                    "slots": [
                        {"index": 0, "location": "СН №1", "department": ""},
                        {"index": 1, "location": "СН №2", "department": ""},
                        {"index": 2, "location": "СН №3", "department": ""}
                    ]
                },
                {
                    "key": "s2_r2", "num": "2",
                    "label": "Проведение РХБ наблюдения на территории административных зданий ЦА МЧС России",
                    "time": "Ч+1.00",
                    "who_provides": "по 2 чел. от каждого СН",
                    "slots": [
                        {"index": 0, "location": "СН №1", "department": ""},
                        {"index": 1, "location": "СН №2", "department": ""},
                        {"index": 2, "location": "СН №3", "department": ""}
                    ]
                },
                {
                    "key": "s2_r3", "num": "3",
                    "label": "Организация выдачи СИЗ сотрудникам ЦА МЧС России",
                    "time": "Ч+9.00",
                    "who_provides": "УЦ, Б(О)",
                    "slots": [
                        {"index": 0, "location": "УЦ",   "department": ""},
                        {"index": 1, "location": "Б(О)",  "department": ""},
                        {"index": 2, "location": "3 упр.", "department": ""}
                    ]
                }
            ]
        },
        {
            "title": "Вывод ОГ МЧС России на ЗПУ (г. Звенигород)",
            "rows": [
                {
                    "key": "s3_r4", "num": "4",
                    "label": "Охрана и оборона ЗПУ Рузского ЦОПУ (Московская обл., г. Звенигород, панс. «Солнечный»)",
                    "time": "Ч+10.00",
                    "who_provides": "16 чел., 7 упр.",
                    "slots": [
                        {"index": 0, "location": "КПП №1",        "department": ""},
                        {"index": 1, "location": "КПП №2",        "department": ""},
                        {"index": 2, "location": "Патруль №1",    "department": ""},
                        {"index": 3, "location": "Патруль №2",    "department": ""},
                        {"index": 4, "location": "Мобильный рез.", "department": ""},
                        {"index": 5, "location": "авт.",           "department": ""},
                        {"index": 6, "location": "КПП №3 (8 чел.), 2 упр.", "department": ""},
                        {"index": 7, "location": "Патруль №3",    "department": ""},
                        {"index": 8, "location": "Резерв",        "department": ""}
                    ]
                },
                {
                    "key": "s3_r5", "num": "5",
                    "label": "Сопровождение колонн",
                    "time": "Ч+8.00",
                    "who_provides": "ВАИ — автомобиль",
                    "slots": [
                        {"index": 0, "location": "ВАИ", "department": ""}
                    ]
                },
                {
                    "key": "s3_r6", "num": "6",
                    "label": "Вывоз секретной документации оперативных групп на ЗПУ",
                    "time": "Ч+8.00",
                    "who_provides": "2 упр. — автомобиль (бронированный)",
                    "slots": [
                        {"index": 0, "location": "2 упр.", "department": ""}
                    ]
                },
                {
                    "key": "s3_r7", "num": "7",
                    "label": "Перевозка личного состава ОГ МЧС России (не менее 45 посадочных мест)",
                    "time": "Ч+8.00",
                    "who_provides": "Б(О) — автобус",
                    "slots": [
                        {"index": 0, "location": "Б(О)", "department": ""}
                    ]
                },
                {
                    "key": "s3_r8", "num": "8",
                    "label": "Медицинское обеспечение ОГ МЧС России",
                    "time": "Ч+8.00",
                    "who_provides": "6 упр. — автомобиль",
                    "slots": [
                        {"index": 0, "location": "6 упр.", "department": ""}
                    ]
                },
                {
                    "key": "s3_r9", "num": "9",
                    "label": "Проведение РХБ разведки на маршрутах вывода ОГ МЧС России",
                    "time": "Ч+8.00",
                    "who_provides": "3 упр. — автомобиль",
                    "slots": [
                        {"index": 0, "location": "г. Звенигород — Верхнепосадское шоссе, 3 упр.", "department": ""},
                        {"index": 1, "location": "Рузский район, дер. Устье, 3 упр.", "department": ""}
                    ]
                }
            ]
        },
        {
            "title": "Расчёт смены лиц в суточном наряде",
            "rows": [
                {
                    "key": "sn_r1", "num": "",
                    "label": "Помощник ОД",
                    "time": "Ч+3.00",
                    "who_provides": "Офицер 8 упр.",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn_r2", "num": "",
                    "label": "Помощник ОД по связи",
                    "time": "Ч+3.00",
                    "who_provides": "Офицер О(САСУиТ)",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn_r3", "num": "",
                    "label": "Дежурный по Центру",
                    "time": "Ч+3.00",
                    "who_provides": "НУ (О-А)",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn_r4", "num": "",
                    "label": "Помощник дежурного по Центру",
                    "time": "Ч+3.00",
                    "who_provides": "Начальник клуба",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn_r5", "num": "",
                    "label": "Дежурный по парку",
                    "time": "Ч+3.00",
                    "who_provides": "Начальник КТП",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn_r6", "num": "",
                    "label": "Дежурный по КПП-2",
                    "time": "Ч+3.00",
                    "who_provides": "Техник ГСВ и БВС",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn_r7", "num": "",
                    "label": "Дежурный по столовой",
                    "time": "Ч+3.00",
                    "who_provides": "Начальник столовой",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                }
            ]
        }
    ]
}

# ─── Шаблон 2: Оповещение посыльными и смена наряда ──────────────────────────

TEMPLATE_2 = {
    "sections": [
        {
            "title": "Оповещение военнослужащих по контракту, проживающих на служебной территории",
            "rows": [
                {
                    "key": "op_r1", "num": "",
                    "label": "Общежитие №1",
                    "time": "Ч+0.10",
                    "who_provides": "2 чел. от базы (обеспечения)",
                    "slots": [
                        {"index": 0, "location": "1 под.", "department": ""},
                        {"index": 1, "location": "2 под.", "department": ""}
                    ]
                },
                {
                    "key": "op_r2", "num": "",
                    "label": "Общежитие №2",
                    "time": "Ч+0.10",
                    "who_provides": "2 чел. от базы (обеспечения)",
                    "slots": [
                        {"index": 0, "location": "2 и 3 эт.", "department": ""},
                        {"index": 1, "location": "4 и 5 эт.", "department": ""}
                    ]
                },
                {
                    "key": "op_r3", "num": "",
                    "label": "Общежитие №3",
                    "time": "Ч+0.10",
                    "who_provides": "1 чел. от базы (обеспечения)",
                    "slots": [
                        {"index": 0, "location": "2 и 3 эт.", "department": ""}
                    ]
                },
                {
                    "key": "op_r4", "num": "",
                    "label": "Общежитие №4",
                    "time": "Ч+0.10",
                    "who_provides": "2 чел. от базы (обеспечения)",
                    "slots": [
                        {"index": 0, "location": "1 и 2 эт.", "department": ""},
                        {"index": 1, "location": "3 и 4 эт.", "department": ""}
                    ]
                }
            ]
        },
        {
            "title": "Выставление регулировщиков",
            "rows": [
                {
                    "key": "reg_r1", "num": "",
                    "label": "Регулировщик 1",
                    "time": "Ч+0.10",
                    "who_provides": "3 чел. от базы (обеспечения)",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "reg_r2", "num": "",
                    "label": "Регулировщик 2",
                    "time": "Ч+0.10",
                    "who_provides": "",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "reg_r3", "num": "",
                    "label": "Регулировщик 3",
                    "time": "Ч+0.10",
                    "who_provides": "",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                }
            ]
        },
        {
            "title": "Расчёт смены лиц в суточном наряде",
            "rows": [
                {
                    "key": "sn2_r1", "num": "",
                    "label": "Помощник ОД",
                    "time": "Ч+3.00",
                    "who_provides": "",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn2_r2", "num": "",
                    "label": "Помощник ОД по связи",
                    "time": "Ч+3.00",
                    "who_provides": "",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn2_r3", "num": "",
                    "label": "Дежурный по Центру",
                    "time": "Ч+3.00",
                    "who_provides": "",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn2_r4", "num": "",
                    "label": "Помощник ДЧ",
                    "time": "Ч+3.00",
                    "who_provides": "",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn2_r5", "num": "",
                    "label": "Дежурный по парку",
                    "time": "Ч+3.00",
                    "who_provides": "",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                },
                {
                    "key": "sn2_r6", "num": "",
                    "label": "Дежурный по КПП-2",
                    "time": "Ч+3.00",
                    "who_provides": "",
                    "slots": [{"index": 0, "location": "", "department": ""}]
                }
            ]
        }
    ]
}


def seed_templates(db) -> None:
    """Создаёт шаблоны если они ещё не существуют."""
    existing = db.query(CombatCalcTemplate).first()
    if existing:
        return

    templates = [
        CombatCalcTemplate(
            title="Расчёт выделения л/с для выполнения первоочередных мероприятий",
            description="При приведении ФГКУ «ЦСООР «Лидер» в боевую готовность",
            is_active=True,
        ),
        CombatCalcTemplate(
            title="Расчёт оповещения посыльными и смена наряда",
            description="При приведении Центра в готовность к оперативному реагированию",
            is_active=True,
        ),
    ]

    import json
    templates[0].structure_json = json.dumps(TEMPLATE_1, ensure_ascii=False)
    templates[1].structure_json = json.dumps(TEMPLATE_2, ensure_ascii=False)

    for t in templates:
        db.add(t)

    db.commit()
    print("[combat_calc] Шаблоны боевого расчёта созданы")