"""crypto_keys + agent_tokens — централизованное хранение ключей КриптоПро

Revision ID: u5v6w7x8y9z0
Revises: t4u5v6w7x8y9
Create Date: 2026-05-14 12:00:00.000000

Сервер PODS2 хранит контейнеры КриптоПро (папки xxx.000 с *.key файлами) и
открытые сертификаты (.cer) централизованно. Сами бинарники лежат в Vault
(или fallback-папке на диске), здесь — только метаданные сертификатов.

Агент на клиентской машине (Windows-служба) опрашивает /api/v1/certs/agent/sync,
скачивает назначенные пользователю контейнеры в C:\\ProgramData\\PODS2Keys\\,
и КриптоПро видит их через считыватель типа «Каталог».

Таблицы:
  • crypto_keys   — метаданные ключей (один ряд = один контейнер+сертификат);
                    бинарники в Vault, тут CN/ИНН/срок/отпечаток/owner.
  • agent_tokens  — токены установленных агентов (хеш в БД, сам токен — у клиента).
                    Один юзер может иметь несколько токенов (несколько компов).
"""
from typing import Sequence, Union

from alembic import op


revision: str = "u5v6w7x8y9z0"
down_revision: Union[str, Sequence[str], None] = "t4u5v6w7x8y9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ─── crypto_keys ────────────────────────────────────────────────────────
    # Защита от orphan pg_type, оставшегося после прерванной CREATE TABLE
    # на предыдущем deploy'е (известная особенность PostgreSQL: при ROLLBACK
    # запись в pg_class откатывается, а pg_type — нет).
    #
    # Стратегия:
    #   1) Если таблица УЖЕ есть в pg_class — миграция уже накатывалась,
    #      выходим, ничего не делаем.
    #   2) Иначе безусловно DROP TYPE IF EXISTS (любая schema), потом CREATE.
    #
    # Проверку pg_type через current_schema() убрали — в zone-aware setup'ах
    # search_path может не совпадать с фактической schema таблицы, и условие
    # n.nspname = current_schema() даёт false-negative. Без проверки schema
    # DROP TYPE IF EXISTS безопасен: типа без таблицы быть не должно (мы
    # уже подтвердили, что таблицы нет), а IF EXISTS no-op'ит если типа нет.
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_class
                 WHERE relname = 'crypto_keys'
                   AND relkind = 'r'
            ) THEN
                RETURN;
            END IF;

            EXECUTE 'DROP TYPE IF EXISTS public.crypto_keys CASCADE';

            CREATE TABLE crypto_keys (
                id                BIGSERIAL PRIMARY KEY,
                -- Может быть NULL: «свободный» ключ загружен, но ещё не назначен.
                owner_user_id     INTEGER
                                   REFERENCES users(id) ON DELETE SET NULL,
                -- Имя папки контейнера: xxx из xxx.000 (без расширения).
                container_name    VARCHAR(255) NOT NULL,
                -- SHA1 hex (40 символов) от DER-сертификата — уникальный ID ключа.
                -- УНИКАЛЬНЫЙ: один и тот же сертификат не может загружаться дважды.
                thumbprint        VARCHAR(64) NOT NULL,
                -- Парсинг X.509 subject. Cn хранится для отображения, остальное
                -- — для поиска и фильтрации.
                subject_cn        VARCHAR(500),
                subject_o         VARCHAR(500),
                subject_inn       VARCHAR(20),
                subject_snils     VARCHAR(20),
                issuer_cn         VARCHAR(500),
                serial_number     VARCHAR(80),
                valid_from        TIMESTAMP WITH TIME ZONE NOT NULL,
                valid_to          TIMESTAMP WITH TIME ZONE NOT NULL,
                -- Путь в Vault (например "secret/data/crypto-keys/<thumbprint>")
                -- или путь к файлу на диске для fallback-режима.
                storage_path      VARCHAR(500) NOT NULL,
                -- active | revoked | expired
                -- expired ставится автоматически по valid_to (можно сделать cron).
                status            VARCHAR(20) NOT NULL DEFAULT 'active',
                -- Для какой системы (eis | kazn | sed | other) — справочное поле.
                purpose           VARCHAR(50),
                note              TEXT,
                uploaded_by_id    INTEGER
                                   REFERENCES users(id) ON DELETE SET NULL,
                uploaded_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                CONSTRAINT uq_crypto_keys_thumbprint UNIQUE (thumbprint)
            );
        END $$;
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_crypto_keys_owner_user_id
            ON crypto_keys (owner_user_id);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_crypto_keys_status
            ON crypto_keys (status);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_crypto_keys_valid_to
            ON crypto_keys (valid_to);
    """)

    # ─── agent_tokens ───────────────────────────────────────────────────────
    # См. комментарий к crypto_keys выше — тот же приём.
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_class
                 WHERE relname = 'agent_tokens'
                   AND relkind = 'r'
            ) THEN
                RETURN;
            END IF;

            EXECUTE 'DROP TYPE IF EXISTS public.agent_tokens CASCADE';

            CREATE TABLE agent_tokens (
                id              BIGSERIAL PRIMARY KEY,
                user_id         INTEGER NOT NULL
                                 REFERENCES users(id) ON DELETE CASCADE,
                -- SHA256 hex от токена. Сам токен на сервере не храним —
                -- агент при каждом запросе шлёт его в Authorization, мы
                -- хешируем и ищем match. Это защищает от компрометации БД:
                -- даже если её утащат, токены остаются недоступны.
                token_hash      VARCHAR(64) NOT NULL,
                -- Свободный текст: "PC-IVANOV", "Ноутбук бухгалтерии" и т.п.
                description     VARCHAR(255),
                issued_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
                last_seen_at    TIMESTAMP WITH TIME ZONE,
                last_seen_ip    VARCHAR(64),
                revoked         BOOLEAN NOT NULL DEFAULT FALSE,
                revoked_at      TIMESTAMP WITH TIME ZONE,
                CONSTRAINT uq_agent_tokens_hash UNIQUE (token_hash)
            );
        END $$;
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_agent_tokens_user_id
            ON agent_tokens (user_id);
    """)
    # Композитный индекс для основного запроса "найди активный токен юзера":
    # WHERE user_id=? AND revoked=false AND expires_at>now()
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_agent_tokens_active
            ON agent_tokens (user_id, revoked, expires_at);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_tokens CASCADE;")
    op.execute("DROP TABLE IF EXISTS crypto_keys CASCADE;")
