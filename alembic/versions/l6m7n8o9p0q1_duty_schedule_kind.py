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

Идемпотентная: проверяет колонку через inspector — init_db() через
Base.metadata.create_all() мог уже создать колонку на новой БД.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa


revision: str = "l6m7n8o9p0q1"
down_revision: Union[str, Sequence[str], None] = "k5l6m7n8o9p0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns(table)}
    return column in cols


def _has_index(table: str, name: str) -> bool:
    bind = op.get_bind()
    idx = {i["name"] for i in inspect(bind).get_indexes(table)}
    return name in idx


def upgrade() -> None:
    if not _has_column("duty_schedules", "kind"):
        op.add_column(
            "duty_schedules",
            sa.Column("kind", sa.String(),
                      nullable=False, server_default="duty"),
        )
    if not _has_index("duty_schedules", "ix_duty_schedules_kind"):
        op.create_index(
            "ix_duty_schedules_kind",
            "duty_schedules",
            ["kind"],
        )


def downgrade() -> None:
    if _has_index("duty_schedules", "ix_duty_schedules_kind"):
        op.drop_index("ix_duty_schedules_kind", table_name="duty_schedules")
    if _has_column("duty_schedules", "kind"):
        op.drop_column("duty_schedules", "kind")
