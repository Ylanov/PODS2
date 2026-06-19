"""zone_map: исходные координаты + система координат

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-06-19 14:30:00.000000

Добавляет в zone_map_zones две колонки:
  src_points_json — исходные координаты как в файле (для таблицы «исходные → WGS-84»)
  coord_system    — система координат импорта (wgs84 / msk77 / msk77_b / …)

Идемпотентная: ADD COLUMN IF NOT EXISTS — повторный прогон безвреден.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "b8c9d0e1f2a3"
down_revision: Union[str, Sequence[str], None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE zone_map_zones ADD COLUMN IF NOT EXISTS src_points_json JSONB")
    op.execute("ALTER TABLE zone_map_zones ADD COLUMN IF NOT EXISTS coord_system VARCHAR")


def downgrade() -> None:
    op.execute("ALTER TABLE zone_map_zones DROP COLUMN IF EXISTS coord_system")
    op.execute("ALTER TABLE zone_map_zones DROP COLUMN IF EXISTS src_points_json")
