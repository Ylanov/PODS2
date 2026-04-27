# app/models/comms_report.py
"""
CommsReport — Форма 3-СВЯЗЬ. Ежегодный отчёт отдела связи об укомплектованности
средствами связи, вычислительной и оргтехники.

Хранится как JSONB-снимок за год: 18 направлений × N позиций оборудования.
Производные значения (итоги, проценты, +/−) считаются на лету на клиенте
и повторно на сервере при экспорте, чтобы в .docx попадали корректные числа.

Ключ записи — (unit_username, year): у каждого отдела свой отчёт за год.
"""

from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from app.db.database import Base


class CommsReport(Base):
    __tablename__ = "comms_reports"

    id             = Column(Integer, primary_key=True, index=True)
    # username отдела, которому принадлежит отчёт (role='unit'). Нужно, чтобы
    # у каждого отдела был свой независимый набор данных.
    unit_username  = Column(String(100), nullable=False, index=True)
    year           = Column(Integer,     nullable=False, index=True)
    # Полный снимок отчёта: список направлений с позициями (см. seed-структуру).
    data           = Column(JSONB,       nullable=False, server_default="[]")

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
        UniqueConstraint("unit_username", "year", name="uq_comms_report_unit_year"),
    )
