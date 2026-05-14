"""crypto_key_usage — журнал использования ключей (для аудита админом)

Revision ID: x8y9z0a1b2c3
Revises: w7x8y9z0a1b2
Create Date: 2026-05-14 16:00:00.000000

Агент на клиенте читает Windows Event Log (Crypto-Pro и CAPI2 providers),
извлекает события подписи и батчем POST'ит сюда. Сервер сохраняет в эту
таблицу и показывает в админке во вкладке "Ключи и сертификаты" под
таблицей агентов.

Чего ЗДЕСЬ НЕТ:
  • имени подписанного файла (Word/Office не пишет его в Event Log);
  • содержимого подписи;
  • достоверного process name для всех событий (зависит от version КриптоПро).
Что ЕСТЬ:
  • кто (user_id), когда (event_time), на какой машине (hostname),
    каким контейнером (container_name + key_id если matched), какое
    действие (event_type='sign').

key_id может быть NULL если ключ был удалён или не смэтчен по container_name.
container_name всегда сохраняем raw — даже если ключ удалили, история
останется для аудита.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "x8y9z0a1b2c3"
down_revision: Union[str, Sequence[str], None] = "w7x8y9z0a1b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_class
                 WHERE relname = 'crypto_key_usage' AND relkind = 'r'
            ) THEN
                RETURN;
            END IF;

            EXECUTE 'DROP TYPE IF EXISTS public.crypto_key_usage CASCADE';

            CREATE TABLE crypto_key_usage (
                id              BIGSERIAL PRIMARY KEY,
                -- Юзер по которому пришёл токен агента (NULL если юзер удалён).
                user_id         INTEGER
                                 REFERENCES users(id) ON DELETE SET NULL,
                -- Match по container_name + user_id; NULL если ключ уже удалён.
                key_id          BIGINT
                                 REFERENCES crypto_keys(id) ON DELETE SET NULL,
                -- Имя контейнера — сохраняем всегда, даже без key_id.
                container_name  VARCHAR(255) NOT NULL,
                -- Когда подпись реально произошла (timestamp из Event Log).
                event_time      TIMESTAMP WITH TIME ZONE NOT NULL,
                -- 'sign' | 'open_container' | 'decrypt' | etc — что нашлось в логе.
                event_type      VARCHAR(50),
                -- ПК, на котором подписывали (берём из bound_hostname токена).
                hostname        VARCHAR(255),
                -- Например WINWORD.EXE, EXCEL.EXE — если CAPI2 такое отдал.
                source_process  VARCHAR(255),
                -- Когда сервер получил запись (для отладки задержек агента).
                reported_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            );
        END $$;
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_crypto_key_usage_user_time
            ON crypto_key_usage (user_id, event_time DESC);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_crypto_key_usage_container_time
            ON crypto_key_usage (container_name, event_time DESC);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_crypto_key_usage_event_time
            ON crypto_key_usage (event_time DESC);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS crypto_key_usage CASCADE;")
