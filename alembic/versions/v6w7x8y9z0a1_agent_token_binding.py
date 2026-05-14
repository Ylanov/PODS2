"""agent_tokens: bound_mac / bound_hostname / block_reason для защиты от копирования config.json

Revision ID: v6w7x8y9z0a1
Revises: u5v6w7x8y9z0
Create Date: 2026-05-14 14:00:00.000000

Защита от компрометации токена через копирование config.json:
  • bound_mac — MAC primary-карты ПК, на котором впервые использовался токен;
  • bound_hostname — имя машины (для удобства аудита в админке);
  • block_reason — почему токен revoked (вручную / MAC mismatch / hostname change).

При первом обращении агента (X-Agent-MAC / X-Agent-Hostname в заголовках)
сервер запоминает. На последующих — проверяет. Если расходится — token
помечается revoked + block_reason.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "v6w7x8y9z0a1"
down_revision: Union[str, Sequence[str], None] = "u5v6w7x8y9z0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE agent_tokens
            ADD COLUMN IF NOT EXISTS bound_mac      VARCHAR(32),
            ADD COLUMN IF NOT EXISTS bound_hostname VARCHAR(255),
            ADD COLUMN IF NOT EXISTS block_reason   VARCHAR(255);
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE agent_tokens
            DROP COLUMN IF EXISTS bound_mac,
            DROP COLUMN IF EXISTS bound_hostname,
            DROP COLUMN IF EXISTS block_reason;
    """)
