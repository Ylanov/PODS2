"""alert_lists: lists + slots + marks + seed two lists

Revision ID: p0q1r2s3t4u5
Revises: o9p0q1r2s3t4
Create Date: 2026-05-09 19:30:00.000000

Списки оповещения (вкладка под permission='alert_lists'):
  alert_lists  — два сидируемых списка (id=1, id=2)
  alert_slots  — позиции (Начальник такой-то…), привязка к persons
  alert_marks  — отметки N/O/V на дни месяца + ручной зам при V

Идемпотентная: CREATE TABLE IF NOT EXISTS + INSERT … ON CONFLICT DO NOTHING.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "p0q1r2s3t4u5"
down_revision: Union[str, Sequence[str], None] = "o9p0q1r2s3t4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Защита от orphan-типов в pg_type. Бывает что предыдущая попытка
    # CREATE TABLE упала после регистрации типа, но до создания самой
    # таблицы — `pg_type` видит «alert_lists, 2200», а таблицы нет, и
    # повторный CREATE TABLE IF NOT EXISTS падает с UniqueViolation
    # (pg_type_typname_nsp_index). DROP TYPE IF EXISTS … CASCADE снимает
    # такой висяк, на здоровых базах — no-op.
    for tname in ("alert_lists", "alert_slots", "alert_marks"):
        op.execute(f"""
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = '{tname}')
                   AND NOT EXISTS (
                       SELECT 1 FROM information_schema.tables
                        WHERE table_name = '{tname}'
                   ) THEN
                    EXECUTE 'DROP TYPE IF EXISTS {tname} CASCADE';
                END IF;
            END $$;
        """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS alert_lists (
            id   INTEGER PRIMARY KEY,
            name VARCHAR(100) NOT NULL
        )
    """)
    # Seed: два фиксированных списка. id явный, чтобы фронт мог
    # ссылаться на них стабильно. ON CONFLICT — повторный прогон безвреден.
    op.execute("""
        INSERT INTO alert_lists (id, name) VALUES
            (1, 'Список оповещения 1'),
            (2, 'Список оповещения 2')
        ON CONFLICT (id) DO NOTHING
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS alert_slots (
            id                SERIAL PRIMARY KEY,
            list_id           INTEGER NOT NULL REFERENCES alert_lists(id) ON DELETE CASCADE,
            title             VARCHAR(200) NOT NULL,
            role_kind         VARCHAR(10)  NOT NULL DEFAULT 'upr',
            sort_order        INTEGER      NOT NULL DEFAULT 0,
            primary_person_id INTEGER      REFERENCES persons(id) ON DELETE SET NULL
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_alert_slots_list_sort
        ON alert_slots (list_id, sort_order, id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_alert_slots_primary_person
        ON alert_slots (primary_person_id)
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS alert_marks (
            id                   SERIAL PRIMARY KEY,
            slot_id              INTEGER NOT NULL REFERENCES alert_slots(id) ON DELETE CASCADE,
            mark_date            DATE    NOT NULL,
            mark_type            VARCHAR(2) NOT NULL,
            substitute_person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
            CONSTRAINT uq_alert_marks_slot_date UNIQUE (slot_id, mark_date)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_alert_marks_slot_date
        ON alert_marks (slot_id, mark_date)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_alert_marks_slot_date")
    op.execute("DROP TABLE IF EXISTS alert_marks")
    op.execute("DROP INDEX IF EXISTS ix_alert_slots_primary_person")
    op.execute("DROP INDEX IF EXISTS ix_alert_slots_list_sort")
    op.execute("DROP TABLE IF EXISTS alert_slots")
    op.execute("DROP TABLE IF EXISTS alert_lists")
