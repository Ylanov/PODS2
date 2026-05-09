# app/api/v1/routers/oper_map.py
"""
Карта Оперативного Дежурного — pods2-сторона.

Сервер pods2 имеет две сетевухи: одна — в интернет, другая — в локалку
пользователей. Браузер пользователя (в локалке, без интернета) ходит
ТОЛЬКО на наш бэк, а бэк сам тащит тайлы/геокодер у Яндекса и маршруты
у OSRM через инет-сетевуху. API-ключ Яндекса живёт в .env, до браузера
не доходит.

Эндпоинты (все защищены permission='oper_map'; admin проходит всегда):

  CRUD:
    GET    /api/v1/oper-map/settings        — базовая точка (адрес+lat/lng)
    PUT    /api/v1/oper-map/settings
    GET    /api/v1/oper-map/zones           — все зоны
    POST   /api/v1/oper-map/zones           — новая зона
    PATCH  /api/v1/oper-map/zones/{id}
    DELETE /api/v1/oper-map/zones/{id}

  Прокси к внешним сервисам (через инет-сетевуху сервера):
    GET    /api/v1/oper-map/tile/{z}/{x}/{y}.png
    GET    /api/v1/oper-map/geocode?q=...
    POST   /api/v1/oper-map/route           — body: {from:[lat,lng], to:[lat,lng]}

Кеш тайлов — на диске сервера (settings.OPER_MAP_TILE_CACHE_DIR), чтобы
не дёргать Яндекс на каждый зум одной и той же области.
"""

import json
import logging
import os
from pathlib import Path
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import require_permission
from app.core.config import settings
from app.db.database import get_db
from app.models.oper_map import OperMapSettings, OperMapZone


logger = logging.getLogger(__name__)
router = APIRouter(dependencies=[Depends(require_permission("oper_map"))])


# ─── Pydantic ────────────────────────────────────────────────────────────────

class SettingsOut(BaseModel):
    base_address: Optional[str] = None
    base_lat:     Optional[float] = None
    base_lng:     Optional[float] = None


class SettingsIn(BaseModel):
    base_address: Optional[str] = Field(default=None, max_length=500)
    base_lat:     Optional[float] = None
    base_lng:     Optional[float] = None


class ZoneOut(BaseModel):
    id:         int
    name:       str
    role:       Optional[str] = None
    color:      str
    polygon:    dict
    sort_order: int


class ZoneIn(BaseModel):
    name:       str = Field(..., min_length=1, max_length=200)
    role:       Optional[str] = Field(default=None, max_length=200)
    color:      str = Field(default="#ff5722", max_length=20)
    polygon:    dict = Field(default_factory=dict)
    sort_order: int = 0


class ZonePatch(BaseModel):
    name:       Optional[str] = Field(default=None, min_length=1, max_length=200)
    role:       Optional[str] = Field(default=None, max_length=200)
    color:      Optional[str] = Field(default=None, max_length=20)
    polygon:    Optional[dict] = None
    sort_order: Optional[int] = None


class RouteIn(BaseModel):
    # [lat, lng] — пары координат. Source/destination передаём явно, чтобы
    # фронт не тащил базу из БД и не дублировал логику.
    src: List[float] = Field(..., min_length=2, max_length=2)
    dst: List[float] = Field(..., min_length=2, max_length=2)


# ─── Settings (одна строка id=1) ─────────────────────────────────────────────

def _get_or_create_settings(db: Session) -> OperMapSettings:
    row = db.query(OperMapSettings).filter(OperMapSettings.id == 1).first()
    if not row:
        row = OperMapSettings(id=1)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("/settings", response_model=SettingsOut, summary="Базовая точка карты ОД")
def get_settings(db: Session = Depends(get_db)):
    s = _get_or_create_settings(db)
    return SettingsOut(
        base_address=s.base_address,
        base_lat=s.base_lat,
        base_lng=s.base_lng,
    )


@router.put("/settings", response_model=SettingsOut, summary="Обновить базовую точку")
def put_settings(payload: SettingsIn, db: Session = Depends(get_db)):
    s = _get_or_create_settings(db)
    s.base_address = (payload.base_address or "").strip() or None
    s.base_lat     = payload.base_lat
    s.base_lng     = payload.base_lng
    db.commit()
    db.refresh(s)
    return SettingsOut(
        base_address=s.base_address,
        base_lat=s.base_lat,
        base_lng=s.base_lng,
    )


# ─── Zones CRUD ──────────────────────────────────────────────────────────────

def _zone_out(z: OperMapZone) -> ZoneOut:
    return ZoneOut(
        id=z.id,
        name=z.name,
        role=z.role,
        color=z.color,
        polygon=z.get_polygon(),
        sort_order=z.sort_order,
    )


@router.get("/zones", response_model=List[ZoneOut], summary="Список зон")
def list_zones(db: Session = Depends(get_db)):
    rows = (
        db.query(OperMapZone)
        .order_by(OperMapZone.sort_order.asc(), OperMapZone.id.asc())
        .all()
    )
    return [_zone_out(z) for z in rows]


@router.post("/zones", response_model=ZoneOut, status_code=201, summary="Создать зону")
def create_zone(payload: ZoneIn, db: Session = Depends(get_db)):
    z = OperMapZone(
        name=payload.name.strip(),
        role=(payload.role or "").strip() or None,
        color=payload.color or "#ff5722",
        sort_order=payload.sort_order or 0,
    )
    z.set_polygon(payload.polygon or {})
    db.add(z)
    db.commit()
    db.refresh(z)
    return _zone_out(z)


@router.patch("/zones/{zone_id}", response_model=ZoneOut, summary="Обновить зону")
def patch_zone(zone_id: int, payload: ZonePatch, db: Session = Depends(get_db)):
    z = db.query(OperMapZone).filter(OperMapZone.id == zone_id).first()
    if not z:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    if payload.name is not None:
        z.name = payload.name.strip()
    if payload.role is not None:
        z.role = payload.role.strip() or None
    if payload.color is not None:
        z.color = payload.color
    if payload.polygon is not None:
        z.set_polygon(payload.polygon)
    if payload.sort_order is not None:
        z.sort_order = payload.sort_order
    db.commit()
    db.refresh(z)
    return _zone_out(z)


@router.delete("/zones/{zone_id}", status_code=204, summary="Удалить зону")
def delete_zone(zone_id: int, db: Session = Depends(get_db)):
    z = db.query(OperMapZone).filter(OperMapZone.id == zone_id).first()
    if not z:
        raise HTTPException(status_code=404, detail="Зона не найдена")
    db.delete(z)
    db.commit()


# ─── Прокси: тайлы Яндекса ───────────────────────────────────────────────────
#
# Леaflet просит у фронта `/api/v1/oper-map/tile/{z}/{x}/{y}.png`. Бэк лезет
# к core-renderer-tilesN.maps.yandex.net с API-ключом, скачивает PNG и
# отдаёт его браузеру. На диске кешируем — Яндекс лимит на запросы общий.

def _tile_cache_path(z: int, x: int, y: int) -> Optional[Path]:
    cache_dir = settings.OPER_MAP_TILE_CACHE_DIR
    if not cache_dir:
        return None
    p = Path(cache_dir) / str(z) / str(x) / f"{y}.png"
    return p


@router.get("/tile/{z}/{x}/{y}.png", summary="Прокси для тайлов Яндекс.Карт")
async def proxy_tile(z: int, x: int, y: int):
    if not settings.YANDEX_MAPS_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="YANDEX_MAPS_API_KEY не задан в .env — карта не настроена",
        )
    if not (0 <= z <= 23 and 0 <= x < (1 << z) and 0 <= y < (1 << z)):
        raise HTTPException(status_code=400, detail="Неверные координаты тайла")

    cache_path = _tile_cache_path(z, x, y)
    if cache_path and cache_path.exists():
        return Response(
            content=cache_path.read_bytes(),
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    url = (
        "https://core-renderer-tiles.maps.yandex.net/tiles"
        f"?l=map&x={x}&y={y}&z={z}&scale=1&lang=ru_RU"
        f"&apikey={settings.YANDEX_MAPS_API_KEY}"
    )
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.content
    except httpx.HTTPError as exc:
        logger.warning("oper_map: tile fetch failed z=%s x=%s y=%s: %s", z, x, y, exc)
        raise HTTPException(status_code=502, detail="Не удалось получить тайл")

    if cache_path:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(data)
        except OSError as exc:
            logger.warning("oper_map: tile cache write failed: %s", exc)

    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ─── Прокси: Яндекс-геокодер ─────────────────────────────────────────────────

@router.get("/geocode", summary="Прокси Яндекс-геокодера: адрес → координаты")
async def proxy_geocode(
    q:    str = Query(..., min_length=2, max_length=500),
    bbox: Optional[str] = Query(default=None, description="lng1,lat1~lng2,lat2"),
):
    if not settings.YANDEX_MAPS_API_KEY:
        raise HTTPException(status_code=503, detail="YANDEX_MAPS_API_KEY не задан")

    params = {
        "apikey":  settings.YANDEX_MAPS_API_KEY,
        "format":  "json",
        "geocode": q,
        "lang":    "ru_RU",
        "results": "10",
    }
    if bbox:
        params["bbox"]  = bbox
        params["rspn"]  = "1"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get("https://geocode-maps.yandex.ru/1.x/", params=params)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as exc:
        logger.warning("oper_map: geocode failed q=%r: %s", q, exc)
        raise HTTPException(status_code=502, detail="Геокодер недоступен")

    # Упрощаем ответ Яндекса — фронту не нужны его GeoObject-обёртки.
    out = []
    try:
        members = data["response"]["GeoObjectCollection"]["featureMember"]
    except (KeyError, TypeError):
        members = []
    for m in members:
        try:
            obj = m["GeoObject"]
            pos = obj["Point"]["pos"].split()  # "lng lat"
            lng, lat = float(pos[0]), float(pos[1])
            text = (
                obj.get("metaDataProperty", {})
                   .get("GeocoderMetaData", {})
                   .get("text")
                or obj.get("name")
                or ""
            )
            out.append({"text": text, "lat": lat, "lng": lng})
        except (KeyError, ValueError, TypeError, IndexError):
            continue
    return {"results": out}


# ─── Прокси: Leaflet vendor (CDN → диск → браузер) ───────────────────────────
#
# Браузер пользователя в локалке не может ходить на cdnjs/unpkg напрямую.
# Поэтому раздаём Leaflet через свой эндпоинт: при первом запросе бэк
# тянет файл с CDN (через инет-сетевуху), сохраняет в OPER_MAP_TILE_CACHE_DIR/_vendor/,
# дальше всё отдаётся из кеша. Whitelist фиксированный — открытого
# проксирования произвольных URL'ов нет.

_VENDOR_FILES = {
    "leaflet.js":         "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "leaflet.css":        "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
    "marker-icon.png":    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    "marker-icon-2x.png": "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    "marker-shadow.png":  "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    "layers.png":         "https://unpkg.com/leaflet@1.9.4/dist/images/layers.png",
    "layers-2x.png":      "https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png",
}
_VENDOR_MIME = {
    ".js":  "application/javascript",
    ".css": "text/css",
    ".png": "image/png",
}


@router.get("/vendor/{name}", summary="Прокси для статики Leaflet (через CDN→диск кеш)")
async def proxy_vendor(name: str):
    upstream = _VENDOR_FILES.get(name)
    if not upstream:
        raise HTTPException(status_code=404, detail="Файл не в whitelist")

    cache_dir = settings.OPER_MAP_TILE_CACHE_DIR
    cache_path: Optional[Path] = None
    if cache_dir:
        cache_path = Path(cache_dir) / "_vendor" / name

    ext = os.path.splitext(name)[1].lower()
    media_type = _VENDOR_MIME.get(ext, "application/octet-stream")
    headers = {"Cache-Control": "public, max-age=604800"}

    if cache_path and cache_path.exists():
        return Response(
            content=cache_path.read_bytes(),
            media_type=media_type,
            headers=headers,
        )

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            r = await client.get(upstream)
            r.raise_for_status()
            data = r.content
    except httpx.HTTPError as exc:
        logger.warning("oper_map: vendor fetch failed %s: %s", name, exc)
        raise HTTPException(status_code=502, detail="Не удалось получить файл с CDN")

    if cache_path:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(data)
        except OSError as exc:
            logger.warning("oper_map: vendor cache write failed: %s", exc)

    return Response(content=data, media_type=media_type, headers=headers)


# ─── Прокси: OSRM-маршрут ────────────────────────────────────────────────────

@router.post("/route", summary="Прокси OSRM: маршрут от точки A к точке B")
async def proxy_route(payload: RouteIn):
    if not settings.OSRM_BASE_URL:
        raise HTTPException(status_code=503, detail="OSRM_BASE_URL не задан")
    src_lat, src_lng = payload.src
    dst_lat, dst_lng = payload.dst
    url = (
        f"{settings.OSRM_BASE_URL.rstrip('/')}/route/v1/driving/"
        f"{src_lng},{src_lat};{dst_lng},{dst_lat}"
        "?overview=full&geometries=geojson&steps=false"
    )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as exc:
        logger.warning("oper_map: OSRM route failed: %s", exc)
        raise HTTPException(status_code=502, detail="Маршрутизатор недоступен")

    if data.get("code") != "Ok" or not data.get("routes"):
        raise HTTPException(status_code=400, detail="Маршрут не построен")
    route = data["routes"][0]
    return {
        "geometry":    route.get("geometry"),       # GeoJSON LineString
        "distance_m":  route.get("distance"),       # метры
        "duration_s":  route.get("duration"),       # секунды
    }
