"""create sed_inbox_snapshots table

Revision ID: j4k5l6m7n8o9
Revises: i3j4k5l6m7n8
Create Date: 2026-05-09 09:00:00.000000

Один снимок СЭД-дайджеста на пользователя (UNIQUE user_id).
Браузерное расширение POST'ит JSON со списком разделов и
заголовков писем — UI отрисовывает кнопку «Почта» с бейджем.

Идемпотентная: проверяет существование таблицы через inspector,
init_db() через Base.metadata.create_all() мог уже создать её
на новой БД до накатки alembic upgrade.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect, text
import sqlalchemy as sa


revision: str = "j4k5l6m7n8o9"
down_revision: Union[str, Sequence[str], None] = "i3j4k5l6m7n8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def _has_table(name: str) -> bool:
    bind = op.get_bind()
    return name in inspect(bind).get_table_names()


def _orphan_type_exists(name: str) -> bool:
    """
    Postgres каждой таблице сопутствует одноимённый composite type. Если
    предыдущая попытка миграции упала после CREATE TYPE, но до COMMIT —
    тип может «зависнуть» без таблицы, и следующий CREATE TABLE упадёт
    с UniqueViolation на pg_type_typname_nsp_index. Возвращаем True, если
    в pg_type есть наш typname БЕЗ соответствующей relation.
    """
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return False
    row = bind.execute(text("""
        SELECT 1
        FROM pg_type t
        WHERE t.typname = :n
          AND NOT EXISTS (
              SELECT 1 FROM pg_class c
              WHERE c.relname = t.typname AND c.relkind = 'r'
          )
        LIMIT 1
    """), {"n": name}).first()
    return bool(row)


def upgrade() -> None:
    if _has_table("sed_inbox_snapshots"):
        return
    # Подметаем orphan-тип, оставшийся от прерванной миграции — иначе
    # CREATE TABLE упадёт по pg_type_typname_nsp_index.
    if _orphan_type_exists("sed_inbox_snapshots"):
        op.execute("DROP TYPE IF EXISTS sed_inbox_snapshots CASCADE")

    op.create_table(
        "sed_inbox_snapshots",
        sa.Column("id",            sa.Integer(),  primary_key=True),
        sa.Column("user_id",       sa.Integer(),  nullable=False),
        sa.Column("taken_at",      sa.DateTime(timezone=True), nullable=False),
        sa.Column("sections_json", sa.Text(),     nullable=False, server_default="[]"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("user_id", name="uq_sed_inbox_snapshots_user"),
    )
    op.create_index(
        "ix_sed_inbox_snapshots_user_id",
        "sed_inbox_snapshots",
        ["user_id"],
    )


def downgrade() -> None:
    if not _has_table("sed_inbox_snapshots"):
        return
    op.drop_index("ix_sed_inbox_snapshots_user_id", table_name="sed_inbox_snapshots")
    op.drop_table("sed_inbox_snapshots")
