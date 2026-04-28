# app/db/seed_team333.py
"""
Seed-скрипт пресета «КОМАНДА-333» — расчёт выделения личного состава
для усиления охраны военного городка.

Запуск:
    python -m app.db.seed_team333

Что делает:
  • Создаёт недостающие должности/расчёты (Position) — idempotent.
  • Создаёт Event-template "КОМАНДА-333 (расчёт усиления)" если ещё нет.
  • 11 групп-«задач», каждая со своим task_time и набором подрасчётов.
  • Внутри каждого подрасчёта пустые слоты (без ФИО) с заполненной квотой.
  • Колонки: Задача / Время / Расчёт / Кто выделяет / ФИО (Звание/№ док
    скрыты — не присутствуют в шаблоне Word).
"""
import sys

from app.db.database import SessionLocal
from app.models.event import Event, Group, Slot, Position


PRESET_TITLE = "КОМАНДА-333 (расчёт усиления)"

COLUMNS_TEAM333 = [
    {"key": "task_time",   "label": "Время выделения",          "type": "text",            "order": 0, "width": 120, "visible": True,  "custom": True},
    {"key": "position_id", "label": "Расчёт (по постам)",       "type": "select_position", "order": 1, "width": 200, "visible": True,  "custom": False},
    {"key": "deployment",  "label": "Кто выделяет (количество)","type": "text",            "order": 2, "width": 200, "visible": True,  "custom": True},
    {"key": "full_name",   "label": "Ф.И.О.",                   "type": "text",            "order": 3, "width": 220, "visible": True,  "custom": False},
    {"key": "rank",        "label": "Звание",                   "type": "text",            "order": 4, "width": 120, "visible": False, "custom": False},
    {"key": "doc_number",  "label": "№ документа",              "type": "text",            "order": 5, "width": 130, "visible": False, "custom": False},
    {"key": "callsign",    "label": "Позывной",                 "type": "text",            "order": 6, "width": 100, "visible": False, "custom": False},
    {"key": "department",  "label": "Квота",                    "type": "select_dept",     "order": 7, "width": 140, "visible": False, "custom": False},
    {"key": "note",        "label": "Примечание",               "type": "text",            "order": 8, "width": 160, "visible": False, "custom": False},
]


# (имя_задачи, time, [(position, deployment, count), ...])
# count — сколько пустых слотов создать в этом подрасчёте.
TASKS_TEAM333 = [
    ("Усиление пропускного режима в штабе", "«Ч»+0.10", [
        ("ПОД, ПОД по связи",                 "ОДС – 2 чел.",                                  2),
        ("дежурная смена",                    "1 упр., по графику, по графику – 3 чел.",       3),
        ("расчёт РХР",                        "3 упр. – 2 чел.",                                2),
    ]),
    ("Группа оцепления (оцепление территории с целью недопущения посторонних лиц)", "«Ч»+0.15", [
        ("детская площадка",                  "2 упр. – 4 чел.",                                1),
        ("с торца общежития №2",              "2 упр. – 4 чел.",                                1),
        ("возле 1 ворот РТК",                 "2 упр. – 4 чел.",                                1),
        ("возле запасного входа (выхода) в столовую", "2 упр. – 4 чел.",                        1),
    ]),
    ("Дежурное подразделение", "«Ч»+0.20", [
        ("Патрулирование служебной территории согласно схеме", "Б(О) – 6 чел.",                 6),
    ]),
    ("Выставление дополнительных вооружённых постов", "«Ч»+01.00", [
        ("на крыше общежития № 2",            "1 упр. – 2 чел.",                                2),
        ("на крыше бокса оперативных машин",  "1 упр. – 1 чел., 3 упр. – 1 чел.",               2),
        ("на крыше РТК",                      "4 упр. – 2 чел.",                                2),
        ("на крыше бойлерной",                "5 упр. – 2 чел.",                                2),
    ]),
    ("Пожарный расчёт (по дополнительному распоряжению)", "«Ч»+0.10", [
        ("пожарная команда",                  "Б(О) – 3 чел.",                                  3),
    ]),
    ("Мобильный резерв (по дополнительному распоряжению)", "«Ч»+0.40", [
        ("мобильный резерв",                  "2 упр. – 6 чел.",                                6),
    ]),
    ("Выставление ПРХН (по дополнительному распоряжению)", "«Ч»+0.40", [
        ("возле КПП №2",                      "3 упр. – 2 чел.",                                2),
    ]),
    ("Группа спец. работ с применением РТС (по дополнительному распоряжению)", "«Ч»+1.00", [
        ("расчёты РТС «TEL-630»",             "4 упр. – 4 чел.",                                4),
    ]),
    ("Группа пиротехнических и кинологических работ (по дополнительному распоряжению)", "«Ч»+1.00", [
        ("пиротехнический расчёт",            "5 упр. – 3 чел.",                                3),
    ]),
    ("МСГ (по дополнительному распоряжению)", "«Ч»+1.00", [
        ("медико-спасательная группа",        "6 упр. – 2 чел.",                                2),
    ]),
    ("Расчёт беспилотной авиационной системы (по дополнительному распоряжению)", "«Ч»+1.00", [
        ("оператор беспилотного воздушного судна", "8 упр. – 1 чел.",                           1),
    ]),
]


def _ensure_positions(db, names: set[str]) -> dict[str, int]:
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
        existing = db.query(Event).filter(
            Event.title == PRESET_TITLE,
            Event.is_template == True,
        ).first()
        if existing:
            print(f"[КОМАНДА-333] Пресет уже существует (event_id={existing.id}). Пропускаю.")
            return

        all_positions = {pos for _, _, items in TASKS_TEAM333 for pos, _, _ in items}
        print(f"[КОМАНДА-333] Проверяю должности: {len(all_positions)} уникальных")
        pos_map = _ensure_positions(db, all_positions)

        evt = Event(title=PRESET_TITLE, is_template=True, status="draft")
        evt.set_columns(COLUMNS_TEAM333)
        db.add(evt)
        db.flush()
        print(f"[КОМАНДА-333] Создан Event-template id={evt.id}")

        total_slots = 0
        for order, (task_name, task_time, items) in enumerate(TASKS_TEAM333):
            grp = Group(event_id=evt.id, name=task_name, order_num=order)
            db.add(grp)
            db.flush()

            for position_name, deployment, count in items:
                for _ in range(count):
                    slot = Slot(
                        group_id    = grp.id,
                        position_id = pos_map[position_name],
                        department  = "admin",
                    )
                    slot.set_extra({"task_time": task_time, "deployment": deployment})
                    db.add(slot)
                    total_slots += 1
            print(f"  └ «{task_name[:50]}»: {sum(c for _,_,c in items)} слотов, время {task_time}")

        db.commit()
        print(f"[КОМАНДА-333] Готово: {len(TASKS_TEAM333)} задач, {total_slots} слотов.")

    except Exception as e:
        db.rollback()
        print(f"[КОМАНДА-333] Ошибка: {e}", file=sys.stderr)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    seed()
