"""crypto_key_user_assignments — many-to-many между ключами и юзерами

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-05-15 12:00:00.000000

ПОЧЕМУ:
  В реальности один ключ КриптоПро (например, сертификат организации) часто
  используется НЕСКОЛЬКИМИ людьми параллельно — главбух, замбух, секретарь.
  Старая модель `crypto_keys.owner_user_id` (Integer FK) позволяла только
  одного владельца, и для второй машины приходилось дублировать запись
  с тем же thumbprint, что упирается в unique constraint.

ЧТО ДЕЛАЕТ:
  1. Создаёт таблицу `crypto_key_user_assignments` (crypto_key_id, user_id,
     assigned_at, assigned_by_id), PK по (crypto_key_id, user_id).
     ON DELETE CASCADE с обеих сторон.
  2. Переносит существующие записи: для каждого crypto_keys.owner_user_id
     IS NOT NULL — копирует в assignments с assigned_at = uploaded_at.
  3. Удаляет колонку crypto_keys.owner_user_id.

DOWNGRADE: возвращает owner_user_id (берёт первого из assignments по
порядку assigned_at) и удаляет таблицу.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "c3d4e5f6a7b8"
down_revision: Union[str, Sequence[str], None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Защита от orphan pg_type (паттерн из ранних миграций — на случай
    # если таблица была частично создана и осталась после неудачного rollback).
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_class
                 WHERE relname = 'crypto_key_user_assignments' AND relkind = 'r'
            ) THEN
                EXECUTE 'DROP TYPE IF EXISTS public.crypto_key_user_assignments CASCADE';
            END IF;
        END $$;
    """)

    # 2. Создаём ассоциативную таблицу.
    op.execute("""
        CREATE TABLE IF NOT EXISTS crypto_key_user_assignments (
            crypto_key_id   BIGINT NOT NULL
                             REFERENCES crypto_keys(id) ON DELETE CASCADE,
            user_id         INTEGER NOT NULL
                             REFERENCES users(id) ON DELETE CASCADE,
            assigned_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            assigned_by_id  INTEGER
                             REFERENCES users(id) ON DELETE SET NULL,
            PRIMARY KEY (crypto_key_id, user_id)
        );
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_cka_user_id
            ON crypto_key_user_assignments (user_id);
    """)

    # 3. Переносим существующие данные: каждый ключ с owner_user_id → строка
    # в assignments. ON CONFLICT DO NOTHING — на случай если миграцию
    # запустят повторно (или upgrade частично прошёл).
    op.execute("""
        INSERT INTO crypto_key_user_assignments (crypto_key_id, user_id, assigned_at)
        SELECT id, owner_user_id, uploaded_at
          FROM crypto_keys
         WHERE owner_user_id IS NOT NULL
        ON CONFLICT (crypto_key_id, user_id) DO NOTHING;
    """)

    # 4. Удаляем старую колонку (через IF EXISTS — на случай повторного запуска).
    op.execute("""
        ALTER TABLE crypto_keys DROP COLUMN IF EXISTS owner_user_id;
    """)


def downgrade() -> None:
    # 1. Восстанавливаем колонку owner_user_id.
    op.execute("""
        ALTER TABLE crypto_keys
            ADD COLUMN IF NOT EXISTS owner_user_id INTEGER
            REFERENCES users(id) ON DELETE SET NULL;
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_crypto_keys_owner_user_id
            ON crypto_keys (owner_user_id);
    """)

    # 2. Берём первого юзера из assignments как owner. Это lossy downgrade —
    # если ключ был у нескольких юзеров, остальные привязки теряются.
    op.execute("""
        UPDATE crypto_keys k
           SET owner_user_id = (
               SELECT a.user_id
                 FROM crypto_key_user_assignments a
                WHERE a.crypto_key_id = k.id
                ORDER BY a.assigned_at ASC
                LIMIT 1
           )
         WHERE k.owner_user_id IS NULL;
    """)

    # 3. Удаляем таблицу.
    op.execute("DROP TABLE IF EXISTS crypto_key_user_assignments CASCADE;")
