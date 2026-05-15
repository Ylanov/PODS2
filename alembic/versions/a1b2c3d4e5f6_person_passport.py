"""persons.passport_number — добавить поле для загранпаспорта

Revision ID: a1b2c3d4e5f6
Revises: z0a1b2c3d4e5
Create Date: 2026-05-15 09:00:00.000000

Помимо номера документа (doc_number, обычно удостоверение личности или
внутренний паспорт), нужно отдельное поле для номера ЗАГРАНПАСПОРТА.
Используется при выездных операциях / командировках за границу.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "z0a1b2c3d4e5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE persons
            ADD COLUMN IF NOT EXISTS passport_number VARCHAR(100);
    """)


def downgrade() -> None:
    op.execute("ALTER TABLE persons DROP COLUMN IF EXISTS passport_number;")
