"""drop agent_commands — активация Win/Office переведена на standalone

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-05-15 14:30:00.000000

Активация Windows/Office через очередь команд агенту (таблица agent_commands)
была слишком сложной для простой задачи. Заменена на standalone-инструмент
`/api/v1/activator/run.ps1` — admin копирует одну строку `irm | iex`, юзер
вставляет в PowerShell от админа, MAS активирует Win+Office, окно
закрывается. Никаких токенов, очередей, scheduled tasks для команд.

Эта миграция удаляет таблицу agent_commands вместе с её индексами.
Поле AgentToken.force_sync_at и сам polling-механизм остаются — они
нужны для крипто-ключей (когда админ загружает/удаляет ключ, агенту
выставляется force_sync, и при следующем /agent/poll он обновляет
контейнеры в C:\\ProgramData\\PODS2Keys\\). Это про синхронизацию ключей,
не про активацию.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, Sequence[str], None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_commands CASCADE;")


def downgrade() -> None:
    # Восстановление — на случай отката. Структуру дублируем как было
    # в исходной миграции y9z0a1b2c3d4_agent_commands.
    op.execute("""
        CREATE TABLE IF NOT EXISTS agent_commands (
            id              BIGSERIAL PRIMARY KEY,
            agent_token_id  BIGINT NOT NULL
                             REFERENCES agent_tokens(id) ON DELETE CASCADE,
            command         VARCHAR(64) NOT NULL,
            params          JSONB,
            status          VARCHAR(20) NOT NULL DEFAULT 'pending',
            result          TEXT,
            created_by_id   INTEGER
                             REFERENCES users(id) ON DELETE SET NULL,
            created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            started_at      TIMESTAMP WITH TIME ZONE,
            completed_at    TIMESTAMP WITH TIME ZONE
        );
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_agent_commands_token_pending
            ON agent_commands (agent_token_id, status, created_at);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_agent_commands_created_at
            ON agent_commands (created_at DESC);
    """)
