"""enable pg_trgm extension (fuzzy FIO search)

Revision ID: a1e6b3c4d7f2
Revises: 875f09648202
Create Date: 2026-04-24 13:00:00.000000

Расширение pg_trgm нужно для /persons/suggest — подбор ФИО по триграммам
устойчив к опечаткам и перестановкам слов. Без него запрос падает
на function similarity(text, text) does not exist.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "a1e6b3c4d7f2"
down_revision: Union[str, Sequence[str], None] = "875f09648202"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")


def downgrade() -> None:
    # Удалять extension опасно, если у БД есть другие пользователи —
    # индексы на gist_trgm_ops/gin_trgm_ops тоже пропадут. Оставляем.
    pass
