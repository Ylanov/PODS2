"""slots.passport_number — добавить поле загранпаспорта в слотах списков

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-15 10:00:00.000000

В предыдущей миграции добавили `passport_number` в persons (источник).
Теперь нужен симметричный snapshot в slots: когда юзер заполняет слот
из общей базы людей, копируем оба номера документа.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE slots ADD COLUMN IF NOT EXISTS passport_number VARCHAR;")
    # Аналогично duty_marks: денормализованная копия для истории утверждений.
    op.execute("ALTER TABLE duty_marks ADD COLUMN IF NOT EXISTS passport_number VARCHAR(100);")


def downgrade() -> None:
    op.execute("ALTER TABLE slots DROP COLUMN IF EXISTS passport_number;")
    op.execute("ALTER TABLE duty_marks DROP COLUMN IF EXISTS passport_number;")
