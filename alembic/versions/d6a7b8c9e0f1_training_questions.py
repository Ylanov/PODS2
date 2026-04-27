"""training questions + multi-topic attempts

Revision ID: d6a7b8c9e0f1
Revises: c5d8e9f1a2b3
Create Date: 2026-04-26 17:30:00.000000

Расширение модуля проф. подготовки:
  • training_questions          — вопросы внутри темы с вариантами ответов
  • training_attempts.topic_ids — JSONB-массив id тем (вместо одного topic_id)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "d6a7b8c9e0f1"
down_revision: Union[str, Sequence[str], None] = "c5d8e9f1a2b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "training_questions",
        sa.Column("id",          sa.Integer(), primary_key=True),
        sa.Column("topic_id",    sa.Integer(), nullable=False),
        sa.Column("text",        sa.Text(),    nullable=False),
        sa.Column("options",     JSONB(),      nullable=False),
        sa.Column("points",      sa.Integer(), nullable=False, server_default="1"),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at",  sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at",  sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["topic_id"], ["training_topics.id"],
                                ondelete="CASCADE"),
    )
    op.create_index("ix_training_questions_id",       "training_questions", ["id"])
    op.create_index("ix_training_questions_topic",    "training_questions", ["topic_id"])

    op.add_column("training_attempts",
                  sa.Column("topic_ids", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("training_attempts", "topic_ids")
    op.drop_index("ix_training_questions_topic", table_name="training_questions")
    op.drop_index("ix_training_questions_id",    table_name="training_questions")
    op.drop_table("training_questions")
