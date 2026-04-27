# app/models/procurement.py
"""
Гос. закупки отдела (на старте — отдел связи).

Две таблицы:
  CommsBudget   — годовой ЛБО (лимит бюджетных обязательств) отдела;
                  одна запись на (unit_username, year).
  CommsContract — отдельные гос. контракты с метаданными и статусом.

Агрегаты (запланировано / на торгах / отыграно / заключено / исполнено /
остаток / экономия) считаются на лету в роутере и на клиенте — это
безопаснее, чем поддерживать материализованные счётчики в БД.
"""

from datetime import datetime, timezone, date as date_type
from sqlalchemy import (
    Column, Integer, String, Text, Date, DateTime, Numeric,
    ForeignKey, UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship
from app.db.database import Base


# ─── Бюджет (ЛБО) ────────────────────────────────────────────────────────────

class CommsBudget(Base):
    """
    Лимит бюджетных обязательств отдела на конкретный год.
    На отдел один бюджет в год — это enforced UniqueConstraint'ом ниже.
    """
    __tablename__ = "comms_budgets"

    id            = Column(Integer, primary_key=True, index=True)
    unit_username = Column(String(100), nullable=False, index=True)
    year          = Column(Integer,     nullable=False, index=True)

    # Сумма ЛБО в рублях. Numeric хранит как точные дробные — суммы
    # могут быть с копейками; не используем Float (известная ловушка
    # с округлениями на больших суммах).
    lbo_amount    = Column(Numeric(15, 2), nullable=False, default=0)
    notes         = Column(Text,           nullable=True)

    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("unit_username", "year", name="uq_comms_budget_unit_year"),
    )


# ─── Контракт ────────────────────────────────────────────────────────────────

# Статусы жизненного цикла контракта. Строки используются и в БД,
# и в UI — поэтому не выносим в Enum (Postgres ENUM сложнее мигрировать
# при добавлении новых значений). Whitelist валидируется в pydantic.
CONTRACT_STATUSES = (
    "plan",        # запланирован (в плане закупок)
    "tender",      # торги объявлены, отыгрываются
    "awarded",     # отыграно (победитель определён, контракт ещё не подписан)
    "signed",      # заключён
    "executing",   # исполняется
    "completed",   # исполнен
    "terminated",  # расторгнут
)

# Способы закупки по 44-ФЗ — основные. Прочее → "other".
PROCUREMENT_METHODS = (
    "e_auction",        # электронный аукцион
    "tender",           # конкурс
    "quote_request",    # запрос котировок
    "single_supplier",  # у единственного поставщика
    "other",
)


class CommsContract(Base):
    """
    Отдельный гос. контракт (или закупка на этапе плана / торгов).
    """
    __tablename__ = "comms_contracts"

    id            = Column(Integer, primary_key=True, index=True)
    unit_username = Column(String(100), nullable=False, index=True)
    year          = Column(Integer,     nullable=False, index=True)  # бюджетный год

    # ── Идентификация ───────────────────────────────────────────────────────
    contract_number = Column(String(120), nullable=True)   # № контракта (может появиться позже плана)
    eis_number      = Column(String(50),  nullable=True)   # реестровый № в ЕИС (zakupki.gov.ru)

    # ── Содержание ──────────────────────────────────────────────────────────
    subject       = Column(Text,         nullable=False)   # предмет закупки (что закупаем)
    supplier_name = Column(String(300),  nullable=True)    # наименование юр.лица поставщика
    supplier_inn  = Column(String(20),   nullable=True)    # ИНН поставщика

    # ── Финансы ─────────────────────────────────────────────────────────────
    amount        = Column(Numeric(15, 2), nullable=False, default=0)  # сумма по контракту
    savings       = Column(Numeric(15, 2), nullable=False, default=0)  # экономия от НМЦК

    # ── Статус и способ ─────────────────────────────────────────────────────
    status            = Column(String(30), nullable=False, default="plan")
    procurement_method = Column(String(30), nullable=True)

    # ── Сроки ───────────────────────────────────────────────────────────────
    contract_date = Column(Date, nullable=True)   # дата заключения
    start_date    = Column(Date, nullable=True)   # начало исполнения
    end_date      = Column(Date, nullable=True)   # окончание исполнения

    notes         = Column(Text, nullable=True)

    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    __table_args__ = (
        Index("ix_comms_contracts_unit_year", "unit_username", "year"),
    )

    attachments = relationship(
        "CommsContractAttachment",
        back_populates="contract",
        cascade="all, delete-orphan",
        order_by="CommsContractAttachment.uploaded_at.desc()",
    )


# ─── Файлы, прикреплённые к контракту ────────────────────────────────────────

class CommsContractAttachment(Base):
    """
    Договор, акт, доп. соглашение и т. п. — любой файл, относящийся к контракту.
    Сам файл лежит на диске под `storage/procurement/{contract_id}/{stored_name}`,
    в БД — только метаданные. При удалении контракта файлы удаляются каскадом
    + физический файл удаляется в роутере (БД не знает о файловой системе).
    """
    __tablename__ = "comms_contract_attachments"

    id            = Column(Integer, primary_key=True, index=True)
    contract_id   = Column(
        Integer,
        ForeignKey("comms_contracts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Имя, которое видит пользователь при скачивании (исходное при загрузке).
    original_name = Column(String(300), nullable=False)
    # Уникальное имя на диске: `{uuid}_{original_name}` — защита от коллизий.
    stored_name   = Column(String(400), nullable=False)
    content_type  = Column(String(120), nullable=True)
    size_bytes    = Column(Integer,     nullable=False, default=0)

    uploaded_by   = Column(String(100), nullable=True)   # username загрузившего
    uploaded_at   = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    contract = relationship("CommsContract", back_populates="attachments")
