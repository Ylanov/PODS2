"""add substitution fields to duty_marks + source_group_id to groups

Revision ID: m7n8o9p0q1r2
Revises: l6m7n8o9p0q1
Create Date: 2026-05-09 14:00:00.000000

Поля для механизма замещений в графике наряда.

duty_marks:
  is_primary                    BOOL, default TRUE
  substitute_department         STRING, nullable
  substitute_template_group_id  INT, FK groups(id) ON DELETE SET NULL, indexed

groups:
  source_group_id  INT, FK groups(id) ON DELETE SET NULL, indexed
    (id группы-источника в шаблоне; для шаблонов/ручных групп — NULL)

Идемпотентная через PostgreSQL-нативный IF NOT EXISTS — закрывает
кейсы когда колонка уже была добавлена ранее (например, неполным
прогоном предыдущей версии миграции, у которой проверка через
inspect() не сработала под нагрузкой).
"""
from typing import Sequence, Union

from alembic import op


revision: str = "m7n8o9p0q1r2"
down_revision: Union[str, Sequence[str], None] = "l6m7n8o9p0q1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # duty_marks: поля замещения
    op.execute("""
        ALTER TABLE duty_marks
        ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT TRUE
    """)
    op.execute("""
        ALTER TABLE duty_marks
        ADD COLUMN IF NOT EXISTS substitute_department VARCHAR
    """)
    op.execute("""
        ALTER TABLE duty_marks
        ADD COLUMN IF NOT EXISTS substitute_template_group_id INTEGER
    """)
    # FK + индекс — добавляем idempotent через DO-блок (constraint без
    # IF NOT EXISTS до Postgres 15, поэтому проверяем через информацию).
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_duty_marks_subst_group'
            ) THEN
                ALTER TABLE duty_marks
                ADD CONSTRAINT fk_duty_marks_subst_group
                FOREIGN KEY (substitute_template_group_id)
                REFERENCES groups(id) ON DELETE SET NULL;
            END IF;
        END $$;
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_duty_marks_substitute_template_group_id
        ON duty_marks (substitute_template_group_id)
    """)

    # groups: source_group_id
    op.execute("""
        ALTER TABLE groups
        ADD COLUMN IF NOT EXISTS source_group_id INTEGER
    """)
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'fk_groups_source_group'
            ) THEN
                ALTER TABLE groups
                ADD CONSTRAINT fk_groups_source_group
                FOREIGN KEY (source_group_id)
                REFERENCES groups(id) ON DELETE SET NULL;
            END IF;
        END $$;
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_groups_source_group_id
        ON groups (source_group_id)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_groups_source_group_id")
    op.execute("ALTER TABLE groups DROP CONSTRAINT IF EXISTS fk_groups_source_group")
    op.execute("ALTER TABLE groups DROP COLUMN IF EXISTS source_group_id")

    op.execute("DROP INDEX IF EXISTS ix_duty_marks_substitute_template_group_id")
    op.execute("ALTER TABLE duty_marks DROP CONSTRAINT IF EXISTS fk_duty_marks_subst_group")
    op.execute("ALTER TABLE duty_marks DROP COLUMN IF EXISTS substitute_template_group_id")
    op.execute("ALTER TABLE duty_marks DROP COLUMN IF EXISTS substitute_department")
    op.execute("ALTER TABLE duty_marks DROP COLUMN IF EXISTS is_primary")
