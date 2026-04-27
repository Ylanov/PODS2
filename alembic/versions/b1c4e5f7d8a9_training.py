"""training topics + attempts

Revision ID: b1c4e5f7d8a9
Revises: a3f9d28b4e51
Create Date: 2026-04-26 15:30:00.000000

Создаёт таблицы для модуля «Отдел проф. подготовки»:
  • training_topics    — темы/направления тестирования
  • training_attempts  — попытки прохождения (= персональные ссылки)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "b1c4e5f7d8a9"
down_revision: Union[str, Sequence[str], None] = "a3f9d28b4e51"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Темы ───────────────────────────────────────────────────────────────
    op.create_table(
        "training_topics",
        sa.Column("id",          sa.Integer(),     primary_key=True),
        sa.Column("name",        sa.String(200),   nullable=False, unique=True),
        sa.Column("description", sa.Text(),        nullable=True),
        sa.Column("question_count",   sa.Integer(), nullable=True),
        sa.Column("pass_threshold",   sa.Integer(), nullable=True),
        sa.Column("duration_minutes", sa.Integer(), nullable=True),
        sa.Column("created_by",  sa.String(100),   nullable=False),
        sa.Column("is_active",   sa.String(1),     nullable=False, server_default="Y"),
        sa.Column("created_at",  sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at",  sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("ix_training_topics_id", "training_topics", ["id"])

    # ── Попытки ────────────────────────────────────────────────────────────
    op.create_table(
        "training_attempts",
        sa.Column("id",        sa.Integer(),  primary_key=True),

        sa.Column("person_id", sa.Integer(),  nullable=True),
        sa.Column("person_full_name", sa.String(300), nullable=True),

        sa.Column("topic_id",  sa.Integer(),  nullable=True),

        sa.Column("token",      sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),

        sa.Column("registered_at",   sa.DateTime(timezone=True), nullable=True),
        sa.Column("form_phone",      sa.String(50),  nullable=True),
        sa.Column("form_department", sa.String(100), nullable=True),
        sa.Column("form_position",   sa.String(200), nullable=True),
        sa.Column("form_extra",      JSONB(),        nullable=True),

        sa.Column("started_at",      sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at",    sa.DateTime(timezone=True), nullable=True),
        sa.Column("score",           sa.Integer(),               nullable=True),
        sa.Column("answers",         JSONB(),                    nullable=True),

        sa.Column("status",     sa.String(20), nullable=False, server_default="created"),
        sa.Column("created_by", sa.String(100), nullable=False),
        sa.Column("notes",      sa.Text(), nullable=True),

        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),

        sa.ForeignKeyConstraint(["person_id"], ["persons.id"],
                                ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["topic_id"],  ["training_topics.id"],
                                ondelete="SET NULL"),
    )
    op.create_index("ix_training_attempts_id",      "training_attempts", ["id"])
    op.create_index("ix_training_attempts_token",   "training_attempts", ["token"], unique=True)
    op.create_index("ix_training_attempts_status",  "training_attempts", ["status"])
    op.create_index("ix_training_attempts_person",  "training_attempts", ["person_id"])
    op.create_index("ix_training_attempts_creator", "training_attempts", ["created_by"])


def downgrade() -> None:
    op.drop_index("ix_training_attempts_creator", table_name="training_attempts")
    op.drop_index("ix_training_attempts_person",  table_name="training_attempts")
    op.drop_index("ix_training_attempts_status",  table_name="training_attempts")
    op.drop_index("ix_training_attempts_token",   table_name="training_attempts")
    op.drop_index("ix_training_attempts_id",      table_name="training_attempts")
    op.drop_table("training_attempts")

    op.drop_index("ix_training_topics_id", table_name="training_topics")
    op.drop_table("training_topics")
