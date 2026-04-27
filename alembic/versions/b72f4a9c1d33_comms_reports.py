"""comms_reports table (Форма 3-СВЯЗЬ)

Revision ID: b72f4a9c1d33
Revises: a1e6b3c4d7f2
Create Date: 2026-04-24 17:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "b72f4a9c1d33"
down_revision: Union[str, Sequence[str], None] = "a1e6b3c4d7f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "comms_reports",
        sa.Column("id",            sa.Integer(),  primary_key=True),
        sa.Column("unit_username", sa.String(100), nullable=False, index=True),
        sa.Column("year",          sa.Integer(),   nullable=False, index=True),
        sa.Column("data",          postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at",    sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at",    sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.UniqueConstraint("unit_username", "year", name="uq_comms_report_unit_year"),
    )


def downgrade() -> None:
    op.drop_table("comms_reports")
