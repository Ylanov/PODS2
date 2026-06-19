"""zone_map: zones from Excel coordinates

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-06-19 14:00:00.000000

Карта зон (вкладка под permission='zone_map') — самостоятельный дубль карты
ОД, заточенный под импорт координат из Excel. Одна таблица:

  zone_map_zones — зоны, каждая хранит список вершин в JSONB
                   (points_json = [[lat,lng], ...]).

Идемпотентная: CREATE TABLE IF NOT EXISTS — повторный прогон безвреден.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, Sequence[str], None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS zone_map_zones (
            id          SERIAL PRIMARY KEY,
            name        VARCHAR NOT NULL,
            role        VARCHAR,
            color       VARCHAR NOT NULL DEFAULT '#1976d2',
            points_json JSONB   NOT NULL DEFAULT '[]'::jsonb,
            sort_order  INTEGER NOT NULL DEFAULT 0
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_zone_map_zones_sort
        ON zone_map_zones (sort_order, id)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_zone_map_zones_sort")
    op.execute("DROP TABLE IF EXISTS zone_map_zones")
