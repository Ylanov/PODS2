"""media_items: add holder_person_id FK to persons

Revision ID: a3f9d28b4e51
Revises: f12e6a4b9c33
Create Date: 2026-04-25 19:30:00.000000

Связываем держателя носителя с записью в общей базе людей. Денормализованные
holder_full_name / holder_short_name / holder_department остаются как кеш и
fallback (если человек не выбран из общей базы — например, импорт без матча).
При изменении персоны (переименование, перевод в другое управление) видимые
ФИО/подразделение в учёте МНИ обновятся автоматически — роутер берёт их через
JOIN.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a3f9d28b4e51"
down_revision: Union[str, Sequence[str], None] = "f12e6a4b9c33"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "media_items",
        sa.Column("holder_person_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_media_holder_person",
        "media_items", "persons",
        ["holder_person_id"], ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_media_items_holder_person",
        "media_items", ["holder_person_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_media_items_holder_person", table_name="media_items")
    op.drop_constraint("fk_media_holder_person", "media_items", type_="foreignkey")
    op.drop_column("media_items", "holder_person_id")
