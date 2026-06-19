# app/models/zone_map.py
"""
Карта зон по координатам из Excel (вкладка под permission='zone_map').

Самостоятельный «дубль» карты Оперативного дежурного (app/models/oper_map.py),
но заточенный под другой воркфлоу: пользователь загружает Excel с множеством
координат, они выпадают на карту маркерами и группируются в зоны (полигоны),
готовую карту можно скачать в JPG/PDF в масштабе 1:2000.

Отличие от oper_map: здесь нет базовой точки и маршрутов — только зоны.
Зону храним списком вершин (точек) `points_json = [[lat,lng], ...]`, а не
готовым GeoJSON-полигоном. Так одно и то же поле обслуживает оба источника
вершин: импорт из Excel и ручное рисование кликами по карте. Полигон
(замкнутое кольцо) фронт строит из points на лету, если точек ≥ 3; при 1–2
точках зона показывается просто маркерами.
"""

from sqlalchemy import Column, Integer, String
from sqlalchemy.dialects.postgresql import JSONB

from app.db.database import Base


class ZoneMapZone(Base):
    """
    Зона на карте зон.

    points_json: список вершин в порядке обхода — [[lat, lng], ...].
        lat/lng — float (WGS84), без проекций. Полигон = это кольцо,
        замкнутое на фронте. Маркеры ставятся в каждой вершине.
    """

    __tablename__ = "zone_map_zones"

    id          = Column(Integer, primary_key=True, index=True)
    name        = Column(String,  nullable=False)
    role        = Column(String,  nullable=True)    # произвольная подпись/категория
    color       = Column(String,  nullable=False, default="#1976d2")
    points_json = Column(JSONB,   nullable=False, default=list)
    sort_order  = Column(Integer, nullable=False, default=0)
    # Исходные координаты (как в файле) — для таблицы «исходные → WGS-84».
    # Для МСК это [[X, Y], ...] параллельно points_json; для WGS — те же lat/lng.
    src_points_json = Column(JSONB,  nullable=True)
    # Какая система координат была у импорта (wgs84 / msk77 / msk77_b / …).
    coord_system    = Column(String, nullable=True)

    def get_points(self) -> list:
        data = self.points_json
        return data if isinstance(data, list) else []

    def set_points(self, points: list) -> None:
        self.points_json = points or []

    def get_src_points(self) -> list:
        data = self.src_points_json
        return data if isinstance(data, list) else []

    def set_src_points(self, points) -> None:
        self.src_points_json = points if isinstance(points, list) else None
