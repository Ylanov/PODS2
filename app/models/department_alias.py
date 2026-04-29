# app/models/department_alias.py
"""
Сопоставление текстовых меток подразделений из Word-файлов с реальными
управлениями в системе.

Когда админ загружает Word-список и в колонке «Примечание» встречается
«5 упр.», «3 упр.», «НУ-3» — это короткие штатные обозначения. Они НЕ
совпадают с username управлений в БД (например, реальный username
«5 Управление»). Чтобы при следующем импорте не задавать вопрос заново,
сопоставление сохраняется здесь.
"""
from sqlalchemy import Column, Integer, String, DateTime
from datetime import datetime, timezone

from app.db.database import Base


class DepartmentAlias(Base):
    __tablename__ = "department_aliases"

    id         = Column(Integer, primary_key=True, index=True)
    # Метка из Word — нормализуется (trim + lower) перед сохранением,
    # чтобы «5 упр.», «5 упр.», «5 УПР.» сматчились в один алиас.
    alias      = Column(String(120), nullable=False, unique=True, index=True)
    # username управления, которому соответствует метка.
    department = Column(String(120), nullable=False, index=True)

    created_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
