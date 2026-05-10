# app/models/oper_map.py
"""
Карта Оперативного Дежурного: одна базовая точка (откуда строятся
маршруты) и набор полигонов «зон ответственности» (Пожарные / ДС / …).

Под одного-двух пользователей — без PostGIS. Полигон храним как
GeoJSON-строку (массив координат), геокодинг и роутинг живут в
прокси-эндпоинтах (см. app/api/v1/routers/oper_map.py).
"""

from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, Text, Float, DateTime
from sqlalchemy.dialects.postgresql import JSONB
from app.db.database import Base


class OperMapSettings(Base):
    """
    Глобальные настройки карты ОД. Одна строка (id=1). Хранит базовую
    точку — адрес штаба + координаты, от которых считается маршрут.

    Хранение в строке-сингтоне (а не в `settings` keyvalue) — потому что
    три связанных поля удобнее держать вместе, и валидируются они одной
    PUT-ручкой, а не по отдельности.
    """

    __tablename__ = "oper_map_settings"

    id            = Column(Integer, primary_key=True, default=1)
    base_address  = Column(String, nullable=True)
    base_lat      = Column(Float,  nullable=True)
    base_lng      = Column(Float,  nullable=True)
    updated_at    = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class OperMapZone(Base):
    """
    Полигон зоны ответственности.

    polygon_json: GeoJSON-полигон в формате
        {"type":"Polygon","coordinates":[[[lng,lat],...,[lng,lat]]]}
    Принимаем именно эту форму, чтобы не городить переход в Leaflet
    (он отдаёт `[[lat,lng], ...]` — фронт нормализует к GeoJSON перед
    отправкой). lat/lng — float, без проекций.
    """

    __tablename__ = "oper_map_zones"

    id           = Column(Integer, primary_key=True, index=True)
    name         = Column(String,  nullable=False)
    role         = Column(String,  nullable=True)   # «Пожарные», «ДС», …
    color        = Column(String,  nullable=False, default="#ff5722")
    polygon_json = Column(JSONB,   nullable=False, default=dict)
    sort_order   = Column(Integer, nullable=False, default=0)

    def get_polygon(self) -> dict:
        data = self.polygon_json
        return data if isinstance(data, dict) else {}

    def set_polygon(self, polygon: dict) -> None:
        self.polygon_json = polygon or {}
