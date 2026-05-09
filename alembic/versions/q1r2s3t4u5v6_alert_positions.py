"""alert_lists: вынос должностей в отдельную таблицу alert_positions

Revision ID: q1r2s3t4u5v6
Revises: p0q1r2s3t4u5
Create Date: 2026-05-09 20:30:00.000000

Меняем структуру: должность с ФИО (alert_positions) общая, а alert_slots
становятся просто привязкой «эта должность входит в этот список». Отметки
тоже переезжают на position — один V автоматически виден в обоих списках
если должность в обоих.

Шаги:
  1. Создаём alert_positions
  2. Заполняем уникальными title/role_kind/primary_person из alert_slots
     (если первый прогон — таблица пуста, вставка ничего не делает)
  3. alert_slots: добавляем position_id, заполняем по совпадению title
  4. alert_marks: добавляем position_id, заполняем через slot_id → position_id
  5. Меняем UNIQUE на marks с (slot_id, mark_date) на (position_id, mark_date)
  6. Удаляем устаревшие колонки (title/role_kind/primary_person_id из slots,
     slot_id из marks)
  7. Делаем position_id NOT NULL и UNIQUE (list_id, position_id) у slots

Идемпотентная: каждый шаг через IF NOT EXISTS / IF EXISTS.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "q1r2s3t4u5v6"
down_revision: Union[str, Sequence[str], None] = "p0q1r2s3t4u5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Защита от orphan-типа в pg_type (см. new-69).
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'alert_positions')
               AND NOT EXISTS (
                   SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'alert_positions'
               ) THEN
                EXECUTE 'DROP TYPE IF EXISTS alert_positions CASCADE';
            END IF;
        END $$;
    """)

    # 1. Создаём alert_positions
    op.execute("""
        CREATE TABLE IF NOT EXISTS alert_positions (
            id                SERIAL PRIMARY KEY,
            title             VARCHAR(200) NOT NULL UNIQUE,
            role_kind         VARCHAR(10)  NOT NULL DEFAULT 'upr',
            primary_person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_alert_positions_primary_person
        ON alert_positions (primary_person_id)
    """)

    # 2. Переносим уникальные title из старого alert_slots, если он
    #    содержал колонки title/role_kind/primary_person_id (структура
    #    до этой миграции). На свежей БД INSERT ... SELECT отработает
    #    с пустым списком — ничего не вставится.
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'alert_slots' AND column_name = 'title'
            ) THEN
                INSERT INTO alert_positions (title, role_kind, primary_person_id)
                SELECT DISTINCT ON (title) title, role_kind, primary_person_id
                FROM alert_slots
                ORDER BY title, id
                ON CONFLICT (title) DO NOTHING;
            END IF;
        END $$;
    """)

    # 3. alert_slots: добавляем position_id и заполняем
    op.execute("""
        ALTER TABLE alert_slots
        ADD COLUMN IF NOT EXISTS position_id INTEGER
    """)
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_alert_slots_position'
            ) THEN
                ALTER TABLE alert_slots
                ADD CONSTRAINT fk_alert_slots_position
                FOREIGN KEY (position_id)
                REFERENCES alert_positions(id) ON DELETE CASCADE;
            END IF;
        END $$;
    """)
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'alert_slots' AND column_name = 'title'
            ) THEN
                UPDATE alert_slots s
                   SET position_id = p.id
                  FROM alert_positions p
                 WHERE p.title = s.title AND s.position_id IS NULL;
            END IF;
        END $$;
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_alert_slots_position
        ON alert_slots (position_id)
    """)

    # 4. alert_marks: добавляем position_id и заполняем через slot_id
    op.execute("""
        ALTER TABLE alert_marks
        ADD COLUMN IF NOT EXISTS position_id INTEGER
    """)
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_alert_marks_position'
            ) THEN
                ALTER TABLE alert_marks
                ADD CONSTRAINT fk_alert_marks_position
                FOREIGN KEY (position_id)
                REFERENCES alert_positions(id) ON DELETE CASCADE;
            END IF;
        END $$;
    """)
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'alert_marks' AND column_name = 'slot_id'
            ) THEN
                UPDATE alert_marks m
                   SET position_id = s.position_id
                  FROM alert_slots s
                 WHERE s.id = m.slot_id AND m.position_id IS NULL;
                -- старые отметки которые остались без position_id (slot был
                -- удалён каскадно) — удалим, иначе NOT NULL не дадим поставить
                DELETE FROM alert_marks WHERE position_id IS NULL;
            END IF;
        END $$;
    """)

    # 5. UNIQUE на marks: было (slot_id, mark_date), станет (position_id, mark_date)
    op.execute("ALTER TABLE alert_marks DROP CONSTRAINT IF EXISTS uq_alert_marks_slot_date")
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'uq_alert_marks_position_date'
            ) THEN
                ALTER TABLE alert_marks
                ADD CONSTRAINT uq_alert_marks_position_date
                UNIQUE (position_id, mark_date);
            END IF;
        END $$;
    """)
    op.execute("DROP INDEX IF EXISTS ix_alert_marks_slot_date")
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_alert_marks_position_date
        ON alert_marks (position_id, mark_date)
    """)

    # 6. Удаляем устаревшие колонки
    op.execute("ALTER TABLE alert_marks DROP COLUMN IF EXISTS slot_id")
    op.execute("ALTER TABLE alert_slots DROP COLUMN IF EXISTS title")
    op.execute("ALTER TABLE alert_slots DROP COLUMN IF EXISTS role_kind")
    op.execute("ALTER TABLE alert_slots DROP COLUMN IF EXISTS primary_person_id")
    op.execute("DROP INDEX IF EXISTS ix_alert_slots_primary_person")

    # 7. Делаем position_id NOT NULL и UNIQUE (list_id, position_id)
    op.execute("ALTER TABLE alert_marks  ALTER COLUMN position_id SET NOT NULL")
    op.execute("ALTER TABLE alert_slots  ALTER COLUMN position_id SET NOT NULL")
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'uq_alert_slots_list_position'
            ) THEN
                ALTER TABLE alert_slots
                ADD CONSTRAINT uq_alert_slots_list_position
                UNIQUE (list_id, position_id);
            END IF;
        END $$;
    """)


def downgrade() -> None:
    # Откат — без переноса данных, для теста.
    op.execute("ALTER TABLE alert_slots DROP CONSTRAINT IF EXISTS uq_alert_slots_list_position")
    op.execute("ALTER TABLE alert_slots ADD COLUMN IF NOT EXISTS title VARCHAR(200)")
    op.execute("ALTER TABLE alert_slots ADD COLUMN IF NOT EXISTS role_kind VARCHAR(10) DEFAULT 'upr'")
    op.execute("ALTER TABLE alert_slots ADD COLUMN IF NOT EXISTS primary_person_id INTEGER")
    op.execute("ALTER TABLE alert_marks ADD COLUMN IF NOT EXISTS slot_id INTEGER")
    op.execute("ALTER TABLE alert_marks DROP CONSTRAINT IF EXISTS uq_alert_marks_position_date")
    op.execute("DROP INDEX IF EXISTS ix_alert_marks_position_date")
    op.execute("ALTER TABLE alert_marks DROP CONSTRAINT IF EXISTS fk_alert_marks_position")
    op.execute("ALTER TABLE alert_marks DROP COLUMN IF EXISTS position_id")
    op.execute("ALTER TABLE alert_slots DROP CONSTRAINT IF EXISTS fk_alert_slots_position")
    op.execute("DROP INDEX IF EXISTS ix_alert_slots_position")
    op.execute("ALTER TABLE alert_slots DROP COLUMN IF EXISTS position_id")
    op.execute("DROP INDEX IF EXISTS ix_alert_positions_primary_person")
    op.execute("DROP TABLE IF EXISTS alert_positions")
