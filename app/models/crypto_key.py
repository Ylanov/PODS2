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
    UniqueConstraint, Index, Table,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.db.database import Base


# Many-to-many между crypto_keys и users.
#
# Сделано как Table (а не как полноценная Model-класс) сознательно: записи
# в этой таблице — чистая ассоциация, никакой бизнес-логики над ней не
# навешано. assigned_at/assigned_by_id — справочные поля для аудита
# («когда выдали», «кто из админов выдал»), но запросы к ним не идут.
#
# Если потом понадобятся события «выдал/отозвал доступ» в журнале —
# можно превратить в обычный CryptoKeyUserAssignment(Base).
crypto_key_user_assignments = Table(
    "crypto_key_user_assignments",
    Base.metadata,
    Column(
        "crypto_key_id",
        BigInteger,
        ForeignKey("crypto_keys.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "user_id",
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "assigned_at",
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    ),
    Column(
        "assigned_by_id",
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    ),
    Index("ix_cka_user_id", "user_id"),
)


class CryptoKey(Base):
    __tablename__ = "crypto_keys"

    id              = Column(BigInteger, primary_key=True, index=True)

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

    # Relationships.
    # users — список юзеров, которым выдан этот ключ. Many-to-many через
    # secondary table crypto_key_user_assignments. Используется и для UI
    # (отображение «выдан кому»), и для логики bump_force_sync — когда
    # ключ обновляется, надо дёрнуть всех получателей.
    #
    # primaryjoin/secondaryjoin обязательны: в crypto_key_user_assignments
    # есть ДВА FK на users (user_id — получатель, assigned_by_id — кто
    # из админов выдал, для аудита). SQLAlchemy без явного указания
    # не может выбрать через какой FK строить связь:
    #   sqlalchemy.exc.InvalidRequestError: Could not determine join condition
    #   between parent/child tables on relationship CryptoKey.users —
    #   there are multiple foreign key paths linking the tables via secondary
    #   table 'crypto_key_user_assignments'.
    users       = relationship(
        "User",
        secondary=crypto_key_user_assignments,
        primaryjoin="CryptoKey.id == crypto_key_user_assignments.c.crypto_key_id",
        secondaryjoin="User.id == crypto_key_user_assignments.c.user_id",
        lazy="selectin",   # один SELECT с JOIN — без N+1 при выводе таблицы
    )
    # uploaded_by — кто из админов загрузил (для аудита). Отдельная FK,
    # не пересекается с users, поэтому foreign_keys-подсказка не нужна.
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

    # MAC-привязка: при первом обращении агента запоминаем MAC primary-карты
    # и hostname. На последующих запросах сравниваем — если не совпадают,
    # токен считается утёкшим (например, скопировали config.json на другой ПК).
    # bound_mac=NULL пока агент не сообщил MAC ни разу (или явно сбросили
    # после re-binding в админке).
    bound_mac     = Column(String(32),  nullable=True)
    bound_hostname = Column(String(255), nullable=True)
    # Причина блокировки, если revoked=True по MAC mismatch (а не вручную из админки).
    block_reason  = Column(String(255), nullable=True)
    # Pull-on-command модель: агент опрашивает /agent/poll раз в минуту;
    # если force_sync_at изменился — делает полный sync. Ставится админом
    # (кнопка "Обновить подпись") либо автоматически при upload/patch/delete
    # ключа этого юзера. NULL = пока ничего не требует обновления.
    force_sync_at = Column(DateTime(timezone=True), nullable=True)

    # Каким enrollment-токеном был выпущен этот agent_token (NULL если
    # legacy-режим через /me/install-package, без enrollment).
    enrolled_via_token_id = Column(
        BigInteger,
        ForeignKey("enrollment_tokens.id", ondelete="SET NULL"),
        nullable=True,
    )

    user = relationship("User")

    __table_args__ = (
        # uq_agent_tokens_hash — через unique=True на колонке.
        # Композитный индекс для основного запроса "найди активный токен":
        # WHERE user_id=? AND revoked=false AND expires_at>now()
        Index("ix_agent_tokens_active", "user_id", "revoked", "expires_at"),
    )


class CryptoKeyUsage(Base):
    """
    Журнал использования ключей — кто, когда, какой контейнер, с какой машины.

    Заполняется агентом: sync.ps1 читает Windows Event Log (CAPI2/Crypto-Pro),
    извлекает события подписи и POST'ит сюда батчем. На сервере отображается
    в админке во вкладке "Ключи и сертификаты" под таблицей агентов.

    НЕ содержит имени файла или содержимого подписи — Event Log такое не
    логирует. Только: кто/когда/какой контейнер/с какой машины/каким приложением.
    """
    __tablename__ = "crypto_key_usage"

    id              = Column(BigInteger, primary_key=True, index=True)
    # Юзер по токену агента, который прислал событие.
    user_id         = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # NULL если ключ уже удалён или container_name не сматчили.
    key_id          = Column(
        BigInteger,
        ForeignKey("crypto_keys.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Имя контейнера сохраняем всегда — даже без key_id запись остаётся
    # в журнале как факт использования.
    container_name  = Column(String(255), nullable=False)
    event_time      = Column(DateTime(timezone=True), nullable=False)
    event_type      = Column(String(50),  nullable=True)
    hostname        = Column(String(255), nullable=True)
    source_process  = Column(String(255), nullable=True)
    reported_at     = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    user = relationship("User")
    key  = relationship("CryptoKey")


class AgentCommand(Base):
    """
    Команда от админа агенту — активация Windows/Office через MAS.

    Workflow:
      1. Админ кликает "Активировать Windows" → POST .../command → row created
         со status='pending'.
      2. Агент в /agent/poll (раз в минуту) получает массив pending команд
         для своего token_id, по одной выполняет.
      3. После выполнения агент POST'ит .../result с status='success'|'failed'
         и stdout/stderr в `result`.
      4. Админ видит результат в "Журнале команд" в админке.

    `command` — whitelist значений на стороне backend (не произвольный shell).
    """
    __tablename__ = "agent_commands"

    id              = Column(BigInteger, primary_key=True, index=True)
    agent_token_id  = Column(
        BigInteger,
        ForeignKey("agent_tokens.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    command         = Column(String(64),  nullable=False)
    params          = Column(JSONB,       nullable=True)
    status          = Column(String(20),  nullable=False, default="pending")
    result          = Column(Text,        nullable=True)
    created_by_id   = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at      = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    started_at      = Column(DateTime(timezone=True), nullable=True)
    completed_at    = Column(DateTime(timezone=True), nullable=True)

    agent_token = relationship("AgentToken")
    created_by  = relationship("User")


class EnrollmentToken(Base):
    """
    Общий установочный токен для массовой раскатки агентов админом.
    Один enrollment-токен может зарегистрировать любое количество ПК —
    при каждом enroll создаётся новый персональный AgentToken.

    Не привязан к конкретному PODS2-юзеру; mapping (Windows-username
    → PODS2-username) делается на стороне /agent/enroll по совпадению
    username, либо вручную админом в админке после enrollment.
    """
    __tablename__ = "enrollment_tokens"

    id              = Column(BigInteger, primary_key=True, index=True)
    token_hash      = Column(String(64), nullable=False, unique=True)
    description     = Column(String(255), nullable=True)
    created_at      = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    expires_at      = Column(DateTime(timezone=True), nullable=False)
    revoked         = Column(Boolean, nullable=False, default=False)
    revoked_at      = Column(DateTime(timezone=True), nullable=True)
    created_by_id   = Column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    enrolled_count  = Column(Integer, nullable=False, default=0)

    created_by = relationship("User")
