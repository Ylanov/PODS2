"""create sed_inbox_snapshots table

Revision ID: j4k5l6m7n8o9
Revises: i3j4k5l6m7n8
Create Date: 2026-05-09 09:00:00.000000

Один снимок СЭД-дайджеста на пользователя (UNIQUE user_id).
Браузерное расширение POST'ит JSON со списком разделов и
заголовков писем — UI отрисовывает кнопку «Почта» с бейджем.

Идемпотентная: проверяет существование таблицы через inspector,
init_db() через Base.metadata.create_all() мог уже создать её
на новой БД до накатки alembic upgrade.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "j4k5l6m7n8o9"
down_revision: Union[str, Sequence[str], None] = "i3j4k5l6m7n8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Подметаем orphan-тип, оставшийся от прерванной миграции — иначе
    # CREATE TABLE упадёт по pg_type_typname_nsp_index.
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_type t
                WHERE t.typname = 'sed_inbox_snapshots'
                  AND NOT EXISTS (
                      SELECT 1 FROM pg_class c
                       WHERE c.relname = t.typname AND c.relkind = 'r'
                  )
            ) THEN
                EXECUTE 'DROP TYPE sed_inbox_snapshots CASCADE';
            END IF;
        END $$;
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS sed_inbox_snapshots (
            id            SERIAL PRIMARY KEY,
            user_id       INTEGER NOT NULL,
            taken_at      TIMESTAMP WITH TIME ZONE NOT NULL,
            sections_json TEXT NOT NULL DEFAULT '[]',
            CONSTRAINT uq_sed_inbox_snapshots_user UNIQUE (user_id),
            CONSTRAINT fk_sed_inbox_snapshots_user
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_sed_inbox_snapshots_user_id
        ON sed_inbox_snapshots (user_id)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_sed_inbox_snapshots_user_id")
    op.execute("DROP TABLE IF EXISTS sed_inbox_snapshots")
