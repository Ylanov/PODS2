"""add substitutes_json to duty_marks (multi-target substitutions)

Revision ID: n8o9p0q1r2s3
Revises: m7n8o9p0q1r2
Create Date: 2026-05-09 18:00:00.000000

Расширение механизма замещений: одна отметка-замещение может
заполнять несколько шаблонов/групп одновременно. Раньше у DutyMark
было ровно одно «куда» (substitute_department + substitute_template_group_id).
Теперь — массив `[{template_group_id, department}, ...]` в TEXT/JSON.

Старые поля substitute_department / substitute_template_group_id
оставлены как fallback для backward-compat (читаются, если массив пуст).

Идемпотентная через ADD COLUMN IF NOT EXISTS.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "n8o9p0q1r2s3"
down_revision: Union[str, Sequence[str], None] = "m7n8o9p0q1r2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE duty_marks
        ADD COLUMN IF NOT EXISTS substitutes_json TEXT
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE duty_marks DROP COLUMN IF EXISTS substitutes_json")
