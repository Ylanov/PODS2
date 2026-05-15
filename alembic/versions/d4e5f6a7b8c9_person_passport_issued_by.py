"""persons.passport_issued_by — кем выдан загранпаспорт

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-05-15 13:00:00.000000

Загранпаспорт у нас уже есть — поле persons.passport_number, добавлено
в миграции a1b2c3d4e5f6. Но просто номер мало: при контроле часто нужно
знать **кем выдан** (МВД, ФМС, конкретный номер ОВД). Поле свободное —
строка как пишут в самом паспорте.

NULL по умолчанию: у большинства паспортов в базе сейчас оно неизвестно;
заполнится по мере того как админ откроет каждую карточку.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, Sequence[str], None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE persons
            ADD COLUMN IF NOT EXISTS passport_issued_by VARCHAR(300);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE persons
            DROP COLUMN IF EXISTS passport_issued_by;
    """)
