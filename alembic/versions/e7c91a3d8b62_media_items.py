"""media_items and media_transfers (учёт МНИ — флешки, диски, носители)

Revision ID: e7c91a3d8b62
Revises: d54bc218e7a9
Create Date: 2026-04-25 16:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e7c91a3d8b62"
down_revision: Union[str, Sequence[str], None] = "d54bc218e7a9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "media_items",
        sa.Column("id",                sa.Integer(),    primary_key=True),
        sa.Column("unit_username",     sa.String(100),  nullable=False, index=True),
        sa.Column("inv_number",        sa.String(50),   nullable=False),
        sa.Column("media_type",        sa.String(20),   nullable=False, server_default="flash"),
        sa.Column("manufacturer",      sa.String(120),  nullable=True),
        sa.Column("model",             sa.String(120),  nullable=True),
        sa.Column("serial_number",     sa.String(120),  nullable=True),
        sa.Column("capacity_gb",       sa.Integer(),    nullable=True),
        sa.Column("classification",    sa.String(20),   nullable=False, server_default="dsp"),
        sa.Column("status",            sa.String(20),   nullable=False, server_default="available"),
        sa.Column("holder_full_name",  sa.String(300),  nullable=True),
        sa.Column("holder_short_name", sa.String(100),  nullable=True),
        sa.Column("holder_position",   sa.String(200),  nullable=True),
        sa.Column("holder_department", sa.String(100),  nullable=True),
        sa.Column("issue_date",        sa.Date(),       nullable=True),
        sa.Column("last_check_date",   sa.Date(),       nullable=True),
        sa.Column("next_check_date",   sa.Date(),       nullable=True),
        sa.Column("notes",             sa.Text(),       nullable=True),
        sa.Column("created_at",        sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at",        sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("unit_username", "inv_number",
                            name="uq_media_items_unit_inv"),
    )
    op.create_index("ix_media_items_status", "media_items",
                    ["unit_username", "status"])

    op.create_table(
        "media_transfers",
        sa.Column("id",               sa.Integer(),   primary_key=True),
        sa.Column("media_id",         sa.Integer(),   nullable=False, index=True),
        sa.Column("kind",             sa.String(20),  nullable=False),
        sa.Column("event_date",       sa.Date(),      nullable=False),
        sa.Column("person_full_name", sa.String(300), nullable=True),
        sa.Column("department",       sa.String(100), nullable=True),
        sa.Column("operator",         sa.String(100), nullable=True),
        sa.Column("notes",            sa.Text(),      nullable=True),
        sa.Column("created_at",       sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["media_id"], ["media_items.id"],
                                ondelete="CASCADE"),
    )


def downgrade() -> None:
    op.drop_table("media_transfers")
    op.drop_index("ix_media_items_status", table_name="media_items")
    op.drop_table("media_items")
