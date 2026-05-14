"""agent_tokens.force_sync_at — pull-on-command модель синхронизации

Revision ID: w7x8y9z0a1b2
Revises: v6w7x8y9z0a1
Create Date: 2026-05-14 15:00:00.000000

Раньше агент дёргал /agent/sync каждые 5 минут — это было: (а) лишняя
нагрузка на Vault, (б) повод для антивирусов реагировать на регулярное
изменение HKLM, (в) задержка до 5 минут между действием админа и реакцией
на ПК юзера.

Новая модель: агент опрашивает лёгкий /agent/poll раз в минуту.
poll возвращает timestamp force_sync_at; если он изменился с прошлого тика —
агент делает полный sync, иначе тихо exit'ит. force_sync_at ставится:
  • кнопкой "Обновить подпись" в админке (admin/agent-tokens/{id}/force-sync);
  • автоматически при upload/patch/delete ключа admin'ом;
  • кнопкой "Обновить сейчас" в кабинете самого юзера.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "w7x8y9z0a1b2"
down_revision: Union[str, Sequence[str], None] = "v6w7x8y9z0a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE agent_tokens
            ADD COLUMN IF NOT EXISTS force_sync_at TIMESTAMP WITH TIME ZONE;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE agent_tokens
            DROP COLUMN IF EXISTS force_sync_at;
    """)
