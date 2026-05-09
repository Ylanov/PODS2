"""add applicable_template_ids to duty_schedules

Revision ID: k5l6m7n8o9p0
Revises: j4k5l6m7n8o9
Create Date: 2026-05-09 12:00:00.000000

Опциональная привязка графика наряда к конкретным шаблонам списков.

Новое поле applicable_template_ids (Text, JSON-массив id template-event'ов):
- NULL / []   → график применяется ко всем спискам (старая семантика)
- [42, 17, …] → автозаполнение слотов работает только для тех событий,
                чей event.source_template_id входит в массив

Идемпотентная через PostgreSQL-нативный ADD COLUMN IF NOT EXISTS.
Раньше использовался inspect(), но в редких случаях (напр. под Docker
после неполного предыдущего прогона) inspector мог не увидеть свежий
ALTER TABLE и допустить дублирующее ADD COLUMN — IF NOT EXISTS этот
край закрывает без шансов на сюрприз.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "k5l6m7n8o9p0"
down_revision: Union[str, Sequence[str], None] = "j4k5l6m7n8o9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE duty_schedules
        ADD COLUMN IF NOT EXISTS applicable_template_ids TEXT
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE duty_schedules
        DROP COLUMN IF EXISTS applicable_template_ids
    """)
