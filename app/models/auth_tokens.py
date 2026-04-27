# app/models/auth_tokens.py
"""
Хранилище refresh-токенов — нужно чтобы реально отзывать токены
при logout/компрометации, а не просто ждать истечения.

Зачем это надо:
    Refresh-токен долгий (30 дней). Если просто чистить его на клиенте
    при logout, украденный токен продолжит работать до истечения. С этой
    таблицей logout отмечает revoked_at → /auth/refresh видит запись
    и отвергает её с 401.

Что храним:
    jti         — уникальный ID токена, кладётся в payload JWT. Сравниваем
                  его, а не сам токен (длинный, не умещается в индекс).
    user_id     — для массового отзыва «разлогинить юзера X со всех устройств».
    issued_at   — для аудита.
    expires_at  — совпадает с exp в JWT. Если jti пропал из БД (чистка),
                  валидность определяется по exp в JWT — это graceful fallback.
    revoked_at  — NULL если активен; иначе timestamp отзыва.
    user_agent  — для UI «Мои активные сессии» (не реализовано, но место есть).
    ip_address  — то же.

Почему НЕ храним сам токен:
    JWT подписан SECRET_KEY, атакующий без ключа не подделает токен с
    произвольным jti. Значит для ревокации достаточно сравнить jti —
    хранить всю строку токена избыточно и увеличивает поверхность атаки
    (дамп БД → все активные токены).
"""
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, DateTime, ForeignKey, Index,
)
from sqlalchemy.dialects.postgresql import INET

from app.db.database import Base


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id          = Column(Integer, primary_key=True)
    jti         = Column(String(64), unique=True, nullable=False, index=True)
    user_id     = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    issued_at   = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    expires_at  = Column(DateTime(timezone=True), nullable=False, index=True)
    revoked_at  = Column(DateTime(timezone=True), nullable=True)
    user_agent  = Column(String(400), nullable=True)
    ip_address  = Column(INET, nullable=True)

    __table_args__ = (
        # Самый частый запрос на /refresh: «найти неотозванный токен по jti».
        # Покрывающий индекс по (jti, revoked_at) позволит Postgres сразу
        # понять статус без прочтения строки. jti уже unique-индексирован,
        # так что отдельный составной не всегда нужен — оставим как оптимизацию.
        Index("ix_refresh_user_active", "user_id", "revoked_at"),
    )
