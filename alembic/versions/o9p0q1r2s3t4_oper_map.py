"""oper_map: settings + zones

Revision ID: o9p0q1r2s3t4
Revises: n8o9p0q1r2s3
Create Date: 2026-05-09 18:30:00.000000

Карта Оперативного дежурного (вкладка под permission='oper_map'):
  oper_map_settings  — одна строка с базовой точкой (адрес + lat/lng)
  oper_map_zones     — полигоны зон ответственности (GeoJSON в TEXT)

Идемпотентная: CREATE TABLE IF NOT EXISTS — повторный прогон безвреден.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "o9p0q1r2s3t4"
down_revision: Union[str, Sequence[str], None] = "n8o9p0q1r2s3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS oper_map_settings (
            id           INTEGER PRIMARY KEY,
            base_address VARCHAR,
            base_lat     DOUBLE PRECISION,
            base_lng     DOUBLE PRECISION,
            updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS oper_map_zones (
            id           SERIAL PRIMARY KEY,
            name         VARCHAR NOT NULL,
            role         VARCHAR,
            color        VARCHAR NOT NULL DEFAULT '#ff5722',
            polygon_json TEXT    NOT NULL DEFAULT '{}',
            sort_order   INTEGER NOT NULL DEFAULT 0
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_oper_map_zones_sort
        ON oper_map_zones (sort_order, id)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_oper_map_zones_sort")
    op.execute("DROP TABLE IF EXISTS oper_map_zones")
    op.execute("DROP TABLE IF EXISTS oper_map_settings")
