# app/models/setting.py

from sqlalchemy import Column, String, Text, DateTime
from datetime import datetime, timezone
from app.db.database import Base


class Setting(Base):
    """
    Глобальные настройки приложения — таблица ключ/значение.
    Используется для данных которые меняются в рантайме без перезапуска
    (дежурный, реквизиты организации и т.п.).

    Текущие ключи:
        duty_rank  — воинское звание дежурного (например: подполковник)
        duty_name  — ФИО дежурного (например: Д.М. Патетия)
        duty_title — должность подписывающего (например: Оперативный дежурный)
        org_name   — название организации
    """
    __tablename__ = "settings"

    key        = Column(String(100), primary_key=True)
    value      = Column(Text, nullable=True, default="")
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )