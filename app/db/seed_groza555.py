# app/db/seed_groza555.py
"""
Seed-скрипт пресета «ГРОЗА-555» (30 человек + 4 водителя).

Запуск:
    python -m app.db.seed_groza555

Что делает:
  • Создаёт недостающие должности (Position) в БД (idempotent).
  • Создаёт Event-template с title = "ГРОЗА-555 (30 человек)" если ещё нет.
  • Создаёт 5 групп основного списка + 1 группу is_supplementary=True
    (водители) — по структуре документа-эталона.
  • В каждый слот пишет position_id и подразделение-метку в
    extra_data['subdivision'] (текстовая метка, не username управления).
  • Колонки шаблона переключены: вместо «Квота / Позывной / Примечание»
    выведена кастомная «Подразделение» — соответствует таблице
    исходного Word-документа.
"""
import json
import sys

from app.db.database import SessionLocal
from app.models.event import Event, Group, Slot, Position


# ─── Шаблон ГРОЗА-555 ─────────────────────────────────────────────────────────

PRESET_TITLE = "ГРОЗА-555 (30 человек)"

# Колонки в редакторе шаблона (что админ видит и заполняет).
COLUMNS_GROZA = [
    {"key": "full_name",   "label": "Фамилия Имя Отчество", "type": "text",            "order": 0, "width": 220, "visible": True,  "custom": False},
    {"key": "rank",        "label": "Воинское звание",      "type": "text",            "order": 1, "width": 130, "visible": True,  "custom": False},
    {"key": "doc_number",  "label": "№ документа",          "type": "text",            "order": 2, "width": 140, "visible": True,  "custom": False},
    {"key": "position_id", "label": "Должность, техника",   "type": "select_position", "order": 3, "width": 200, "visible": True,  "custom": False},
    {"key": "subdivision", "label": "Подразделение",        "type": "text",            "order": 4, "width": 130, "visible": True,  "custom": True},
    # Стандартные поля скрыты — для ГРОЗА-555 они не отображаются в Word.
    {"key": "callsign",    "label": "Позывной",             "type": "text",            "order": 5, "width": 100, "visible": False, "custom": False},
    {"key": "department",  "label": "Квота",                "type": "select_dept",     "order": 6, "width": 140, "visible": False, "custom": False},
    {"key": "note",        "label": "Примечание",           "type": "text",            "order": 7, "width": 160, "visible": False, "custom": False},
]


# Структура: (название_группы, is_supplementary, [(должность, подразделение), ...])
GROUPS_GROZA = [
    ("Группа командования", False, [
        ("командир отряда",            "1ЗНЦ"),
        ("начальник штаба",            "НОО"),
        ("начальник связи",            "НОС"),
        ("врач",                       "НУ-6"),
        ("оператор БАС",               "8 упр."),
        ("старший группы тыла",        "НПС"),
        ("повар",                      "Б(О)"),
    ]),
    ("Группа РХБ защиты", False, [
        ("старший группы",             "НУ-3 (ЗНУ-3)"),
        ("газоспасатель",              "3 упр."),
        ("газоспасатель-водитель",     "3 упр."),
    ]),
    ("Группа минимизации последствий № 1", False, [
        ("старший группы",             "НУ-1 (ЗНУ-1)"),
        ("спасатель",                  "1 упр."),
        ("спасатель",                  "1 упр."),
        ("спасатель",                  "1 упр."),
        ("спасатель",                  "1 упр."),
        ("спасатель",                  "4 упр."),
        ("спасатель",                  "4 упр."),
        ("спасатель",                  "5 упр."),
    ]),
    ("Группа минимизации последствий № 2", False, [
        ("старший группы",             "НУ-2 (ЗНУ-2)"),
        ("спасатель",                  "2 упр."),
        ("спасатель",                  "2 упр."),
        ("спасатель",                  "2 упр."),
        ("спасатель",                  "2 упр."),
        ("спасатель-водитель",         "4 упр."),
        ("спасатель-водитель",         "4 упр."),
    ]),
    ("Группа ликвидации угрозы взрыва", False, [
        ("старший группы",             "НУ-5 (ЗНУ-5)"),
        ("пиротехник-спасатель",       "5 упр."),
        ("пиротехник-спасатель",       "5 упр."),
        ("пиротехник-спасатель",       "5 упр."),
        ("кинолог",                    "5 упр."),
    ]),
    # Дополнительный список (отдельная таблица в Word под заголовком
    # «Состав сил и средств обеспечения доставки в район сбора»).
    ("Обеспечение доставки", True, [
        ("водитель",                   "ООБДД ВАИ"),
        ("водитель",                   "Б(О)"),
        ("водитель",                   "5 упр."),
        ("водитель",                   "Б(О)"),
    ]),
]


def _ensure_positions(db, names: set[str]) -> dict[str, int]:
    """Возвращает name → id, создавая недостающие должности."""
    existing = {p.name: p.id for p in db.query(Position).filter(Position.name.in_(names)).all()}
    created = 0
    for name in names:
        if name not in existing:
            pos = Position(name=name)
            db.add(pos)
            db.flush()
            existing[name] = pos.id
            created += 1
    if created:
        print(f"  [+] Создано должностей: {created}")
    return existing


def seed():
    db = SessionLocal()
    try:
        # 1. Проверка идемпотентности: уже существует?
        existing = db.query(Event).filter(
            Event.title == PRESET_TITLE,
            Event.is_template == True,
        ).first()
        if existing:
            print(f"[ГРОЗА-555] Пресет уже существует (event_id={existing.id}). Пропускаю.")
            return

        # 2. Должности — собираем уникальные и проверяем
        all_positions = {pos for _, _, slots in GROUPS_GROZA for pos, _ in slots}
        print(f"[ГРОЗА-555] Проверяю должности: {len(all_positions)} уникальных")
        pos_map = _ensure_positions(db, all_positions)

        # 3. Event-template
        evt = Event(
            title       = PRESET_TITLE,
            is_template = True,
            status      = "draft",
        )
        evt.set_columns(COLUMNS_GROZA)
        db.add(evt)
        db.flush()
        print(f"[ГРОЗА-555] Создан Event-template id={evt.id}")

        # 4. Группы и слоты
        for order, (name, is_supp, slot_specs) in enumerate(GROUPS_GROZA):
            grp = Group(
                event_id         = evt.id,
                name             = name,
                order_num        = order,
                is_supplementary = is_supp,
            )
            db.add(grp)
            db.flush()

            for position_name, subdivision in slot_specs:
                slot = Slot(
                    group_id    = grp.id,
                    position_id = pos_map[position_name],
                    department  = "admin",   # placeholder; реальная квота назначается админом позже
                )
                slot.set_extra({"subdivision": subdivision})
                db.add(slot)
            print(f"  └ Группа «{name}»{' [ДОП]' if is_supp else ''}: {len(slot_specs)} слотов")

        db.commit()
        print(f"[ГРОЗА-555] Готово. Открой шаблон в редакторе.")

    except Exception as e:
        db.rollback()
        print(f"[ГРОЗА-555] Ошибка: {e}", file=sys.stderr)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    seed()
