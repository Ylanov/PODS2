"""drop manufacturer/model/holder_position from media_items

Revision ID: f12e6a4b9c33
Revises: e7c91a3d8b62
Create Date: 2026-04-25 18:00:00.000000

Эти поля по факту в учёте МНИ не нужны: производитель/модель — это маркетинг,
а должность дублирует данные в подразделении/ФИО. Убираем, чтобы не плодить
пустые столбцы в форме и шаблоне Excel.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f12e6a4b9c33"
down_revision: Union[str, Sequence[str], None] = "e7c91a3d8b62"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_column("media_items", "manufacturer")
    op.drop_column("media_items", "model")
    op.drop_column("media_items", "holder_position")


def downgrade() -> None:
    op.add_column("media_items",
                  sa.Column("manufacturer", sa.String(120), nullable=True))
    op.add_column("media_items",
                  sa.Column("model", sa.String(120), nullable=True))
    op.add_column("media_items",
                  sa.Column("holder_position", sa.String(200), nullable=True))
