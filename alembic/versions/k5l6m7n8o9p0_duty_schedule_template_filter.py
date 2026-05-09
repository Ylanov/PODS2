"""add applicable_template_ids to duty_schedules

Revision ID: k5l6m7n8o9p0
Revises: j4k5l6m7n8o9
Create Date: 2026-05-09 12:00:00.000000

Опциональная привязка графика наряда к конкретным шаблонам списков.

Новое поле applicable_template_ids (Text, JSON-массив id template-event'ов):
- NULL / []   → график применяется ко всем спискам (старая семантика)
- [42, 17, …] → автозаполнение слотов работает только для тех событий,
                чей event.source_template_id входит в массив

Идемпотентная: проверяем колонку через inspector, чтобы init_db() через
Base.metadata.create_all() уже мог поставить её на чистой БД.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa


revision: str = "k5l6m7n8o9p0"
down_revision: Union[str, Sequence[str], None] = "j4k5l6m7n8o9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns(table)}
    return column in cols


def upgrade() -> None:
    if not _has_column("duty_schedules", "applicable_template_ids"):
        op.add_column(
            "duty_schedules",
            sa.Column("applicable_template_ids", sa.Text(), nullable=True),
        )


def downgrade() -> None:
    if _has_column("duty_schedules", "applicable_template_ids"):
        op.drop_column("duty_schedules", "applicable_template_ids")
