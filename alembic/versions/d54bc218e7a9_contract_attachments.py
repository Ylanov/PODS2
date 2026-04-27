"""comms_contract_attachments

Revision ID: d54bc218e7a9
Revises: c83a5e7f2b14
Create Date: 2026-04-25 14:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d54bc218e7a9"
down_revision: Union[str, Sequence[str], None] = "c83a5e7f2b14"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "comms_contract_attachments",
        sa.Column("id",            sa.Integer(),     primary_key=True),
        sa.Column("contract_id",   sa.Integer(),     nullable=False, index=True),
        sa.Column("original_name", sa.String(300),   nullable=False),
        sa.Column("stored_name",   sa.String(400),   nullable=False),
        sa.Column("content_type",  sa.String(120),   nullable=True),
        sa.Column("size_bytes",    sa.Integer(),     nullable=False, server_default="0"),
        sa.Column("uploaded_by",   sa.String(100),   nullable=True),
        sa.Column("uploaded_at",   sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["contract_id"], ["comms_contracts.id"],
                                ondelete="CASCADE"),
    )


def downgrade() -> None:
    op.drop_table("comms_contract_attachments")
