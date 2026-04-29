"""create department_aliases table

Revision ID: h2i3j4k5l6m7
Revises: g1h2i3j4k5l6
Create Date: 2026-04-29 08:00:00.000000

Таблица для запоминания сопоставлений «5 упр.» → «5 Управление». Заполняется
админом из UI «Импорт квот из Word»; при следующем импорте используется
автоматически.

Идемпотентная: проверяет существование таблицы/индексов через inspector.
В проекте init_db() запускается раньше alembic upgrade и через
Base.metadata.create_all() мог уже создать эту таблицу — поэтому простой
op.create_table падал с DuplicateObject.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa


revision: str = "h2i3j4k5l6m7"
down_revision: Union[str, Sequence[str], None] = "g1h2i3j4k5l6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    if "department_aliases" not in insp.get_table_names():
        op.create_table(
            "department_aliases",
            sa.Column("id",         sa.Integer(),    primary_key=True),
            sa.Column("alias",      sa.String(120),  nullable=False, unique=True),
            sa.Column("department", sa.String(120),  nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.func.now()),
        )
    # Индексы создаём отдельно — даже если таблица существовала, они могли
    # отсутствовать (Base.metadata create_all не создаёт ix_* кроме как для
    # колонок с index=True; alembic-миграция должна обеспечить полное состояние).
    existing_indexes = {ix["name"] for ix in insp.get_indexes("department_aliases")} \
        if "department_aliases" in insp.get_table_names() else set()
    if "ix_department_aliases_alias" not in existing_indexes:
        op.create_index("ix_department_aliases_alias", "department_aliases", ["alias"])
    if "ix_department_aliases_department" not in existing_indexes:
        op.create_index("ix_department_aliases_department", "department_aliases", ["department"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    if "department_aliases" in insp.get_table_names():
        existing_indexes = {ix["name"] for ix in insp.get_indexes("department_aliases")}
        if "ix_department_aliases_department" in existing_indexes:
            op.drop_index("ix_department_aliases_department", "department_aliases")
        if "ix_department_aliases_alias" in existing_indexes:
            op.drop_index("ix_department_aliases_alias", "department_aliases")
        op.drop_table("department_aliases")
