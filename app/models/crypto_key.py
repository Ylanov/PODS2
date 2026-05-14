# app/models/crypto_key.py
"""
Централизованное хранилище ключей и сертификатов КриптоПро.

Сервер PODS2 хранит:
  • контейнеры КриптоПро (папки xxx.000 с 6 файлами *.key) — в Vault,
  • открытые сертификаты (.cer) — там же, рядом,
  • метаданные (CN, ИНН, срок действия, владелец) — в этих таблицах.

Агент на клиентской машине (Windows-служба) опрашивает API, скачивает
контейнеры в C:\\ProgramData\\PODS2Keys\\, и КриптоПро видит их через
считыватель типа «Каталог».

Уникальность ключа — по thumbprint (SHA1 от сертификата). Один и тот же
сертификат не может быть загружен дважды — если попытаются, бэк вернёт
HTTPException и админ увидит «такой ключ уже загружен у Иванова И.И.».

Токены агентов (agent_tokens) — отдельные от пользовательских JWT:
  • долгоживущие (год),
  • явно отзываемые из админки (revoke=True → агент перестаёт работать),
  • один user может иметь несколько (по числу компов).
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, BigInteger, String, DateTime, ForeignKey, Boolean, Text,
    UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship

from app.db.database import Base


class CryptoKey(Base):
    __tablename__ = "crypto_keys"

    id              = Column(BigInteger, primary_key=True, index=True)

    # NULL → «свободный» ключ (загружен, но не назначен пользователю).
    # ON DELETE SET NULL: при удалении юзера ключ остаётся, но без владельца —
    # админ должен переназначить (а не потерять загруженный ключ).
    owner_user_id   = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Имя папки контейнера в формате КриптоПро: xxx из xxx.000 (без .000).
    container_name  = Column(String(255), nullable=False)

    # SHA1 hex (40 символов) от DER-сертификата.
    # Уникальный идентификатор ключа: одинаковые ключи не дублируются.
    thumbprint      = Column(String(64), nullable=False, unique=True)

    # X.509 subject — распарсенные поля для отображения и фильтрации.
    # CN типично «Иванов Иван Иванович» или название ИП/ООО.
    subject_cn      = Column(String(500), nullable=True)
    subject_o       = Column(String(500), nullable=True)
    # ИНН (1.2.643.3.131.1.1) и СНИЛС (1.2.643.100.3) из OID-полей.
    subject_inn     = Column(String(20),  nullable=True)
    subject_snils   = Column(String(20),  nullable=True)
    # Кто выдал — для UI и группировки.
    issuer_cn       = Column(String(500), nullable=True)
    serial_number   = Column(String(80),  nullable=True)

    valid_from      = Column(DateTime(timezone=True), nullable=False)
    valid_to        = Column(DateTime(timezone=True), nullable=False)

    # Vault path: "secret/data/crypto-keys/<thumbprint>" — KV-engine v2.
    # Для fallback на диске — путь к файлу: "/data/crypto_keys/<thumbprint>.enc".
    storage_path    = Column(String(500), nullable=False)

    # active | revoked | expired
    # expired ставится автоматически при первом обращении после valid_to,
    # либо через периодическую задачу (можно повесить в lifespan).
    status          = Column(String(20), nullable=False, default="active")

    # Назначение: eis | kazn | sed | other — для фильтра в UI.
    purpose         = Column(String(50),  nullable=True)
    # Свободный комментарий админа.
    note            = Column(Text,        nullable=True)

    uploaded_by_id  = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    uploaded_at     = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at      = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    # Relationships — foreign_keys обязателен, так как у нас 2 FK на users:
    # owner_user_id и uploaded_by_id. Без подсказки SQLAlchemy не знает
    # по какому FK строить связь.
    owner       = relationship("User", foreign_keys=[owner_user_id])
    uploaded_by = relationship("User", foreign_keys=[uploaded_by_id])

    __table_args__ = (
        # uq_crypto_keys_thumbprint создаётся через Column(unique=True) выше —
        # дублировать здесь не нужно.
        Index("ix_crypto_keys_status",   "status"),
        Index("ix_crypto_keys_valid_to", "valid_to"),
    )


class AgentToken(Base):
    """
    Токен установленного агента (Windows-службы на клиентской машине).

    Создаётся в момент скачивания install-пакета из веб-кабинета юзера:
      • генерируется случайный токен (secrets.token_urlsafe(32)),
      • в БД пишется SHA256-хеш токена + метаданные,
      • сам токен встраивается в config.json внутри ZIP-инсталлятора,
      • при запросе агент шлёт токен в Authorization: Bearer xxx,
        мы хешируем и ищем match по token_hash.

    Отзыв: ставим revoked=True — агент перестаёт работать (получает 401),
    юзер скачивает новый пакет.
    """
    __tablename__ = "agent_tokens"

    id            = Column(BigInteger, primary_key=True, index=True)
    user_id       = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # SHA256 hex (64 символа) от токена. Сам токен не храним — даже при утечке
    # БД токены остаются недоступны (rainbow-table брутфорсу можно противостоять,
    # т.к. токен — 32 байта высокоэнтропийных).
    token_hash    = Column(String(64), nullable=False, unique=True)

    # Например: "PC-IVANOV", "Ноутбук бухгалтерии". Юзер вводит при установке
    # (или агент сам подставляет hostname).
    description   = Column(String(255), nullable=True)

    issued_at     = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    expires_at    = Column(DateTime(timezone=True), nullable=False)
    last_seen_at  = Column(DateTime(timezone=True), nullable=True)
    last_seen_ip  = Column(String(64), nullable=True)

    revoked       = Column(Boolean, nullable=False, default=False)
    revoked_at    = Column(DateTime(timezone=True), nullable=True)

    user = relationship("User")

    __table_args__ = (
        # uq_agent_tokens_hash — через unique=True на колонке.
        # Композитный индекс для основного запроса "найди активный токен":
        # WHERE user_id=? AND revoked=false AND expires_at>now()
        Index("ix_agent_tokens_active", "user_id", "revoked", "expires_at"),
    )
