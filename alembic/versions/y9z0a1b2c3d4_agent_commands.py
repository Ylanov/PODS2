"""agent_commands — очередь команд от админа агентам (активация Win/Office)

Revision ID: y9z0a1b2c3d4
Revises: x8y9z0a1b2c3
Create Date: 2026-05-14 17:00:00.000000

Когда админ нажимает "Активировать Windows" / "Активировать Office" в
админке — мы кладём команду в эту таблицу. Агент при следующем /agent/poll
видит её, выполняет (скачивает MAS из GitHub releases и запускает HWID
или Ohook), отчитывается результатом.

ВАЖНО про активацию: MAS — Microsoft Activation Scripts от massgravel —
содержит код, который антивирусы (включая Касперский) классифицируют как
HackTool. На клиентских ПК нужно дополнительно к нашим уже добавленным
исключениям KSC внести:
  • C:\\Windows\\Temp\\MAS\\*
  • процесс cmd.exe / powershell.exe когда родитель — sync.ps1
См. полные инструкции в README.txt агента.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "y9z0a1b2c3d4"
down_revision: Union[str, Sequence[str], None] = "x8y9z0a1b2c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Сначала отдельно — orphan cleanup, БЕЗ CREATE TABLE в том же блоке.
    # Так PostgreSQL гарантированно увидит DROP в pg_catalog к моменту CREATE,
    # без знакомых нам граблей с pg_type_typname_nsp_index.
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_class
                 WHERE relname = 'agent_commands' AND relkind = 'r'
            ) THEN
                EXECUTE 'DROP TYPE IF EXISTS public.agent_commands CASCADE';
            END IF;
        END $$;
    """)

    # Затем — обычный CREATE TABLE IF NOT EXISTS, не в DO-блоке.
    op.execute("""
        CREATE TABLE IF NOT EXISTS agent_commands (
            id              BIGSERIAL PRIMARY KEY,
            agent_token_id  BIGINT NOT NULL
                             REFERENCES agent_tokens(id) ON DELETE CASCADE,
            -- 'activate_windows_hwid' | 'activate_office_ohook' | 'get_activation_status'
            command         VARCHAR(64) NOT NULL,
            -- Произвольный JSON с параметрами команды (зарезервировано).
            params          JSONB,
            -- pending → агент ещё не забрал
            -- running → агент забрал и работает (не реализовано, для будущего streaming)
            -- success / failed → выполнено, есть result
            status          VARCHAR(20) NOT NULL DEFAULT 'pending',
            -- stdout + stderr скрипта, либо распарсенный статус.
            result          TEXT,
            -- Кто из админов поставил команду.
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


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_commands CASCADE;")
