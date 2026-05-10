"""sed_letters: кеш писем СЭД (тело + метаданные)

Revision ID: r2s3t4u5v6w7
Revises: q1r2s3t4u5v6
Create Date: 2026-05-10 12:00:00.000000

Расширение скачивает /node/{N} в СЭД, парсит и POST'ит сюда.
Pods2 хранит, чтобы пользователь смотрел письма без перехода в СЭД.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "r2s3t4u5v6w7"
down_revision: Union[str, Sequence[str], None] = "q1r2s3t4u5v6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Защита от orphan-типа (см. new-69 / new-75)
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sed_letters')
               AND NOT EXISTS (
                   SELECT 1 FROM information_schema.tables WHERE table_name = 'sed_letters'
               ) THEN
                EXECUTE 'DROP TYPE IF EXISTS sed_letters CASCADE';
            END IF;
        END $$;
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS sed_letters (
            id          SERIAL PRIMARY KEY,
            user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            node_id     INTEGER NOT NULL,
            title       TEXT NOT NULL,
            body_html   TEXT NOT NULL DEFAULT '',
            meta_json   TEXT NOT NULL DEFAULT '{}',
            files_json  TEXT NOT NULL DEFAULT '[]',
            fetched_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_sed_letters_user_node UNIQUE (user_id, node_id)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_sed_letters_user_id
        ON sed_letters (user_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_sed_letters_node_id
        ON sed_letters (node_id)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_sed_letters_node_id")
    op.execute("DROP INDEX IF EXISTS ix_sed_letters_user_id")
    op.execute("DROP TABLE IF EXISTS sed_letters")
