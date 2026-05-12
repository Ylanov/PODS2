# app/models/sed_file.py
"""
Кеш бинарных файлов СЭД.

Расширение sed-bridge у пользователя в браузере, имея cookie-сессию СЭД,
скачивает каждый прикреплённый к письму файл и POST'ит сюда. pods2 сохраняет
blob на диск (volume seddata:/data/sed_files) и потом отдаёт его клиенту
напрямую — браузеру СЭД больше не нужен, pdf-viewer и pdf-shadow-dom
больше не мешают.

Уникальность по (user_id, sed_url): один файл на пользователя. Разные
пользователи могут иметь одинаковые URL'ы (разные cookie-сессии — разные
права), поэтому файлы НЕ дедуплицируются между юзерами.

Хранение на диске: {SED_FILES_DIR}/{user_id}/{sha256[:2]}/{sha256[2:]}.bin
Имя файла (для скачивания клиентом) — в БД, не в имени на диске.

Статусы:
  • pending — расширение ещё не загрузило (запись создана из POST /letter)
  • ok      — файл успешно сохранён, отдаётся клиенту с /file/{id}
  • failed  — N попыток подряд провалились (404 у СЭД, сессия и т.п.)
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, BigInteger, String, DateTime, ForeignKey,
    UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship

from app.db.database import Base


class SedFileBlob(Base):
    __tablename__ = "sed_file_blobs"

    id              = Column(BigInteger, primary_key=True, index=True)
    user_id         = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # URL файла на sed.mchs.ru — ключ для дедупликации в рамках юзера.
    sed_url         = Column(String(2000), nullable=False)
    # Имя для пользователя (показывается в UI и Content-Disposition).
    name            = Column(String(500), nullable=False, default="file")
    # MIME-тип, определённый по Content-Type ответа СЭД (или mime/magic).
    mime            = Column(String(120), nullable=True)
    # Размер в байтах (после успешной загрузки).
    size            = Column(Integer, nullable=False, default=0)
    # sha256 hex (64 символа) — используется для путей на диске,
    # и опционально для будущей дедупликации.
    sha256          = Column(String(64), nullable=True, index=True)
    # Статус: pending / ok / failed
    status          = Column(String(20), nullable=False, default="pending")
    # Количество попыток скачать (счётчик retry в расширении).
    attempts        = Column(Integer, nullable=False, default=0)
    # Текст последней ошибки (для отладки и UI badge).
    error           = Column(String(500), nullable=True)
    # Когда последний раз пытались загрузить — для backoff'а retry в расширении.
    last_attempt_at = Column(DateTime(timezone=True), nullable=True)
    # Когда успешно загрузили — для TTL-cleanup (старые удаляем по age).
    fetched_at      = Column(DateTime(timezone=True), nullable=True)
    created_at      = Column(
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

    user = relationship("User")

    __table_args__ = (
        UniqueConstraint("user_id", "sed_url", name="uq_sed_file_user_url"),
        Index("ix_sed_file_status_updated", "status", "updated_at"),
    )
