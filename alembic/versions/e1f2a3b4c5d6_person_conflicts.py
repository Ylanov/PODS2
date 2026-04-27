"""person data conflicts table

Revision ID: e1f2a3b4c5d6
Revises: d6a7b8c9e0f1
Create Date: 2026-04-26 18:30:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e1f2a3b4c5d6"
down_revision: Union[str, Sequence[str], None] = "d6a7b8c9e0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "person_data_conflicts",
        sa.Column("id",          sa.Integer(), primary_key=True),
        sa.Column("person_id",   sa.Integer(), nullable=False),
        sa.Column("attempt_id",  sa.Integer(), nullable=True),
        sa.Column("field_name",  sa.String(50), nullable=False),
        sa.Column("old_value",   sa.Text(),    nullable=True),
        sa.Column("new_value",   sa.Text(),    nullable=True),
        sa.Column("source",      sa.String(50), nullable=False, server_default="training"),
        sa.Column("created_at",  sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.String(100), nullable=True),
        sa.Column("resolved_choice", sa.String(20), nullable=True),
        sa.ForeignKeyConstraint(["person_id"],  ["persons.id"],
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["attempt_id"], ["training_attempts.id"],
                                ondelete="SET NULL"),
    )
    op.create_index("ix_person_data_conflicts_id",      "person_data_conflicts", ["id"])
    op.create_index("ix_person_data_conflicts_person",  "person_data_conflicts", ["person_id"])
    op.create_index("ix_person_data_conflicts_attempt", "person_data_conflicts", ["attempt_id"])
    # Частичный индекс по pending (resolved_at IS NULL) для быстрого подсчёта
    op.execute(
        "CREATE INDEX ix_person_data_conflicts_pending "
        "ON person_data_conflicts (created_at) "
        "WHERE resolved_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_person_data_conflicts_pending")
    op.drop_index("ix_person_data_conflicts_attempt", table_name="person_data_conflicts")
    op.drop_index("ix_person_data_conflicts_person",  table_name="person_data_conflicts")
    op.drop_index("ix_person_data_conflicts_id",      table_name="person_data_conflicts")
    op.drop_table("person_data_conflicts")
