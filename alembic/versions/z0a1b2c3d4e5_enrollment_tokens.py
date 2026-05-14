"""enrollment_tokens — общие токены для массовой раскатки агентов админом

Revision ID: z0a1b2c3d4e5
Revises: y9z0a1b2c3d4
Create Date: 2026-05-14 18:00:00.000000

Раньше юзер сам ходил в свой кабинет и скачивал ZIP с уникальным личным
токеном — каждый юзер делал это вручную. Новая модель «массовая раскатка»:

  1. Админ кликает «Создать установочный токен» — выпускается ОДИН long-lived
     токен (по умолчанию на год), без привязки к конкретному PODS2-юзеру.
  2. Админ скачивает bootstrap.ps1 со встроенным токеном.
  3. Через PSExec / Invoke-Command раскатывает скрипт на список ПК.
  4. На каждом ПК bootstrap.ps1 регистрирует агента через /agent/enroll —
     создаётся персональный AgentToken, привязанный к hostname + MAC.
     Если Windows-username совпадает с PODS2-логином — owner_user_id
     ставится автоматически; иначе админ привяжет вручную в админке.
  5. Юзер вообще ничего не делает.

В одном enrollment-токене можно зарегистрировать сотни ПК — это by design.
Отзыв enrollment-токена НЕ отзывает уже зарегистрированные agent_tokens;
каждый AgentToken отзывается отдельно (хотим оставить уже работающих, даже
если новые регистрации запретили).
"""
from typing import Sequence, Union

from alembic import op


revision: str = "z0a1b2c3d4e5"
down_revision: Union[str, Sequence[str], None] = "y9z0a1b2c3d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Orphan cleanup отдельно (см. предыдущие миграции — учли грабли).
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_class
                 WHERE relname = 'enrollment_tokens' AND relkind = 'r'
            ) THEN
                EXECUTE 'DROP TYPE IF EXISTS public.enrollment_tokens CASCADE';
            END IF;
        END $$;
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS enrollment_tokens (
            id              BIGSERIAL PRIMARY KEY,
            -- SHA256 от raw токена. Сам токен показывается админу ОДИН раз
            -- при создании, потом восстановить нельзя.
            token_hash      VARCHAR(64) NOT NULL UNIQUE,
            description     VARCHAR(255),
            created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
            revoked         BOOLEAN NOT NULL DEFAULT FALSE,
            revoked_at      TIMESTAMP WITH TIME ZONE,
            created_by_id   INTEGER
                             REFERENCES users(id) ON DELETE SET NULL,
            -- Счётчик: сколько agent_tokens было выпущено через этот enrollment.
            enrolled_count  INTEGER NOT NULL DEFAULT 0
        );
    """)

    # На AgentToken добавляем ссылку на enrollment-token (для аудита: каким
    # enrollment был выпущен этот персональный токен).
    op.execute("""
        ALTER TABLE agent_tokens
            ADD COLUMN IF NOT EXISTS enrolled_via_token_id BIGINT
                REFERENCES enrollment_tokens(id) ON DELETE SET NULL;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE agent_tokens DROP COLUMN IF EXISTS enrolled_via_token_id;
    """)
    op.execute("DROP TABLE IF EXISTS enrollment_tokens CASCADE;")
