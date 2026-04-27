"""comms_budgets and comms_contracts (procurement tracking)

Revision ID: c83a5e7f2b14
Revises: b72f4a9c1d33
Create Date: 2026-04-25 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c83a5e7f2b14"
down_revision: Union[str, Sequence[str], None] = "b72f4a9c1d33"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "comms_budgets",
        sa.Column("id",            sa.Integer(),       primary_key=True),
        sa.Column("unit_username", sa.String(100),     nullable=False, index=True),
        sa.Column("year",          sa.Integer(),       nullable=False, index=True),
        sa.Column("lbo_amount",    sa.Numeric(15, 2),  nullable=False, server_default="0"),
        sa.Column("notes",         sa.Text(),          nullable=True),
        sa.Column("created_at",    sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at",    sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("unit_username", "year",
                            name="uq_comms_budget_unit_year"),
    )

    op.create_table(
        "comms_contracts",
        sa.Column("id",                sa.Integer(),       primary_key=True),
        sa.Column("unit_username",     sa.String(100),     nullable=False, index=True),
        sa.Column("year",              sa.Integer(),       nullable=False, index=True),
        sa.Column("contract_number",   sa.String(120),     nullable=True),
        sa.Column("eis_number",        sa.String(50),      nullable=True),
        sa.Column("subject",           sa.Text(),          nullable=False),
        sa.Column("supplier_name",     sa.String(300),     nullable=True),
        sa.Column("supplier_inn",      sa.String(20),      nullable=True),
        sa.Column("amount",            sa.Numeric(15, 2),  nullable=False, server_default="0"),
        sa.Column("savings",           sa.Numeric(15, 2),  nullable=False, server_default="0"),
        sa.Column("status",            sa.String(30),      nullable=False, server_default="plan"),
        sa.Column("procurement_method",sa.String(30),      nullable=True),
        sa.Column("contract_date",     sa.Date(),          nullable=True),
        sa.Column("start_date",        sa.Date(),          nullable=True),
        sa.Column("end_date",          sa.Date(),          nullable=True),
        sa.Column("notes",             sa.Text(),          nullable=True),
        sa.Column("created_at",        sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at",        sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.text("now()")),
    )
    op.create_index(
        "ix_comms_contracts_unit_year", "comms_contracts",
        ["unit_username", "year"],
    )


def downgrade() -> None:
    op.drop_index("ix_comms_contracts_unit_year", table_name="comms_contracts")
    op.drop_table("comms_contracts")
    op.drop_table("comms_budgets")
