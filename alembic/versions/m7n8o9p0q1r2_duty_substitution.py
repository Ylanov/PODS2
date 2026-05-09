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

Идемпотентная: каждое поле/индекс проверяется через inspector.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa


revision: str = "m7n8o9p0q1r2"
down_revision: Union[str, Sequence[str], None] = "l6m7n8o9p0q1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns(table)}
    return column in cols


def _has_index(table: str, name: str) -> bool:
    bind = op.get_bind()
    return any(i["name"] == name for i in inspect(bind).get_indexes(table))


def upgrade() -> None:
    # duty_marks: is_primary
    if not _has_column("duty_marks", "is_primary"):
        op.add_column(
            "duty_marks",
            sa.Column("is_primary", sa.Boolean(),
                      nullable=False, server_default=sa.true()),
        )

    # duty_marks: substitute_department
    if not _has_column("duty_marks", "substitute_department"):
        op.add_column(
            "duty_marks",
            sa.Column("substitute_department", sa.String(), nullable=True),
        )

    # duty_marks: substitute_template_group_id
    if not _has_column("duty_marks", "substitute_template_group_id"):
        op.add_column(
            "duty_marks",
            sa.Column("substitute_template_group_id", sa.Integer(), nullable=True),
        )
        op.create_foreign_key(
            "fk_duty_marks_subst_group",
            source_table="duty_marks",
            referent_table="groups",
            local_cols=["substitute_template_group_id"],
            remote_cols=["id"],
            ondelete="SET NULL",
        )
    if not _has_index("duty_marks", "ix_duty_marks_substitute_template_group_id"):
        op.create_index(
            "ix_duty_marks_substitute_template_group_id",
            "duty_marks",
            ["substitute_template_group_id"],
        )

    # groups: source_group_id
    if not _has_column("groups", "source_group_id"):
        op.add_column(
            "groups",
            sa.Column("source_group_id", sa.Integer(), nullable=True),
        )
        op.create_foreign_key(
            "fk_groups_source_group",
            source_table="groups",
            referent_table="groups",
            local_cols=["source_group_id"],
            remote_cols=["id"],
            ondelete="SET NULL",
        )
    if not _has_index("groups", "ix_groups_source_group_id"):
        op.create_index(
            "ix_groups_source_group_id",
            "groups",
            ["source_group_id"],
        )


def downgrade() -> None:
    if _has_index("groups", "ix_groups_source_group_id"):
        op.drop_index("ix_groups_source_group_id", table_name="groups")
    if _has_column("groups", "source_group_id"):
        # foreign key — Postgres удаляет автоматически при drop_column
        op.drop_column("groups", "source_group_id")

    if _has_index("duty_marks", "ix_duty_marks_substitute_template_group_id"):
        op.drop_index("ix_duty_marks_substitute_template_group_id",
                      table_name="duty_marks")
    if _has_column("duty_marks", "substitute_template_group_id"):
        op.drop_column("duty_marks", "substitute_template_group_id")
    if _has_column("duty_marks", "substitute_department"):
        op.drop_column("duty_marks", "substitute_department")
    if _has_column("duty_marks", "is_primary"):
        op.drop_column("duty_marks", "is_primary")
