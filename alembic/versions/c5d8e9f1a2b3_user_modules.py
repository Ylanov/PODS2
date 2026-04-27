"""add modules column to users

Revision ID: c5d8e9f1a2b3
Revises: b1c4e5f7d8a9
Create Date: 2026-04-26 16:30:00.000000

users.modules — JSONB-массив идентификаторов модулей-операций, доступных
unit-пользователю. Используется для фильтрации карточек в «Операциях».
NULL у существующих юзеров означает «не настроено» — админ через UI
проставит нужные модули каждому отделу.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "c5d8e9f1a2b3"
down_revision: Union[str, Sequence[str], None] = "b1c4e5f7d8a9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("modules", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "modules")
