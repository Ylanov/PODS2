"""add is_supplementary to groups

Revision ID: g1h2i3j4k5l6
Revises: e1f2a3b4c5d6
Create Date: 2026-04-28 21:00:00.000000

Поле is_supplementary позволяет помечать группы как «дополнительный список»
в шаблоне (например, водители в ГРОЗА-555 идут отдельной таблицей под
основным списком). Дефолт False — для существующих групп ничего не меняется.

ИСТОРИЯ: изначально down_revision был "f12e6a4b9c33", но на main параллельно
ушла ветка a3f9d28b4e51 → ... → e1f2a3b4c5d6, в результате alembic ловил
«Multiple head revisions». Подвешиваем миграцию после последней реальной
головы — e1f2a3b4c5d6 (person_conflicts).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "g1h2i3j4k5l6"
down_revision: Union[str, Sequence[str], None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "groups",
        sa.Column("is_supplementary", sa.Boolean(),
                  nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("groups", "is_supplementary")
