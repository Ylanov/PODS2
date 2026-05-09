"""add kind column to duty_schedules

Revision ID: l6m7n8o9p0q1
Revises: k5l6m7n8o9p0
Create Date: 2026-05-09 13:00:00.000000

Тип графика — 'duty' (default) или 'amg_duty'.

  duty      — обычный наряд: автозаполняет слоты в списках при наличии
              position_id и прохождении прочих фильтров.
  amg_duty  — дежурство в АМГ: учётный график, в слоты ФИО не подставляет.

server_default='duty' гарантирует, что существующие записи получат
корректное значение без явного UPDATE.

Идемпотентная через PostgreSQL-нативный IF NOT EXISTS.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "l6m7n8o9p0q1"
down_revision: Union[str, Sequence[str], None] = "k5l6m7n8o9p0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE duty_schedules
        ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT 'duty'
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_duty_schedules_kind
        ON duty_schedules (kind)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_duty_schedules_kind")
    op.execute("ALTER TABLE duty_schedules DROP COLUMN IF EXISTS kind")
