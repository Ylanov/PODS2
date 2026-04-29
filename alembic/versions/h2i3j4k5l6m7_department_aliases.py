"""create department_aliases table

Revision ID: h2i3j4k5l6m7
Revises: g1h2i3j4k5l6
Create Date: 2026-04-29 08:00:00.000000

Таблица для запоминания сопоставлений «5 упр.» → «5 Управление». Заполняется
админом из UI «Импорт квот из Word»; при следующем импорте используется
автоматически.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "h2i3j4k5l6m7"
down_revision: Union[str, Sequence[str], None] = "g1h2i3j4k5l6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "department_aliases",
        sa.Column("id",         sa.Integer(),    primary_key=True),
        sa.Column("alias",      sa.String(120),  nullable=False, unique=True),
        sa.Column("department", sa.String(120),  nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("ix_department_aliases_alias",      "department_aliases", ["alias"])
    op.create_index("ix_department_aliases_department", "department_aliases", ["department"])


def downgrade() -> None:
    op.drop_index("ix_department_aliases_department", "department_aliases")
    op.drop_index("ix_department_aliases_alias",      "department_aliases")
    op.drop_table("department_aliases")
