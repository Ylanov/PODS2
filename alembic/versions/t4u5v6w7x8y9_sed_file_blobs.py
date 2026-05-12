"""sed_file_blobs — кеш файлов СЭД на pods2-сервере

Revision ID: t4u5v6w7x8y9
Revises: s3t4u5v6w7x8
Create Date: 2026-05-12 09:00:00.000000

Расширение sed-bridge у пользователя качает каждый файл из СЭД через свою
cookie-сессию и POST'ит сюда. Бинарный контент лежит на диске
(volume seddata:/data/sed_files), в этой таблице — метаданные:
размер, mime, sha256 (для пути), статус загрузки, счётчик попыток.

Уникальность по (user_id, sed_url). Идемпотентная (IF NOT EXISTS).
"""
from typing import Sequence, Union

from alembic import op


revision: str = "t4u5v6w7x8y9"
down_revision: Union[str, Sequence[str], None] = "s3t4u5v6w7x8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Создание таблицы. Защита от orphan-записи в pg_type, оставшейся от
    # упавшей предыдущей попытки CREATE TABLE: PostgreSQL при CREATE TABLE
    # автоматически создаёт composite-тип в pg_type, и при ROLLBACK
    # запись pg_class откатывается, а pg_type — нет (известный баг при
    # параллельных DDL / прерванной миграции). Тогда CREATE TABLE IF NOT
    # EXISTS видит «таблицы нет» (pg_class), пытается создать → "тип уже
    # есть" в pg_type → UniqueViolation pg_type_typname_nsp_index.
    #
    # Решение: проверяем оба каталога. Если таблица в pg_class — выходим.
    # Если orphan-тип в pg_type — дропаем тип и создаём таблицу заново.
    op.execute("""
        DO $$
        BEGIN
            -- Таблица уже есть в pg_class — миграция уже накатывалась,
            -- ничего не делаем.
            IF EXISTS (
                SELECT 1 FROM pg_class c
                  JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relname = 'sed_file_blobs'
                   AND c.relkind = 'r'
                   AND n.nspname = current_schema()
            ) THEN
                RETURN;
            END IF;

            -- Orphan-тип от ROLLBACK'a — убираем чтобы CREATE TABLE прошёл.
            IF EXISTS (
                SELECT 1 FROM pg_type t
                  JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname  = 'sed_file_blobs'
                   AND n.nspname  = current_schema()
            ) THEN
                EXECUTE 'DROP TYPE IF EXISTS sed_file_blobs CASCADE';
            END IF;

            CREATE TABLE sed_file_blobs (
                id               BIGSERIAL PRIMARY KEY,
                user_id          INTEGER NOT NULL
                                  REFERENCES users(id) ON DELETE CASCADE,
                sed_url          VARCHAR(2000) NOT NULL,
                name             VARCHAR(500) NOT NULL DEFAULT 'file',
                mime             VARCHAR(120),
                size             INTEGER NOT NULL DEFAULT 0,
                sha256           VARCHAR(64),
                status           VARCHAR(20) NOT NULL DEFAULT 'pending',
                attempts         INTEGER NOT NULL DEFAULT 0,
                error            VARCHAR(500),
                last_attempt_at  TIMESTAMP WITH TIME ZONE,
                fetched_at       TIMESTAMP WITH TIME ZONE,
                created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                CONSTRAINT uq_sed_file_user_url UNIQUE (user_id, sed_url)
            );
        END $$;
    """)

    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_sed_file_blobs_user_id
            ON sed_file_blobs (user_id);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_sed_file_blobs_sha256
            ON sed_file_blobs (sha256);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_sed_file_status_updated
            ON sed_file_blobs (status, updated_at);
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS sed_file_blobs CASCADE;")
