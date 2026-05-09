// static/js/oper_map.js
//
// Карта Оперативного Дежурного (вкладка под permission='oper_map').
//
// Особенность среды: проект работает в локалке без интернета. Все запросы
// браузера идут только на наш бэк (/api/v1/oper-map/...), а бэк уже сам
// тащит у Яндекса/OSRM/CDN через интернет-сетевуху сервера. Поэтому
// Leaflet тоже грузится по нашему пути /api/v1/oper-map/vendor/...
//
// Что умеет:
//   • показ карты, ограниченной bbox Москва+МО
//   • базовая точка (адрес штаба ОД), задаётся в шапке панели
//   • полигоны зон ответственности (Пожарные / ДС / …) с цветами
//   • поиск адреса (наш геокодер-прокси), маркер цели
//   • маршрут от базы к цели (OSRM-прокси), вывод distance/ETA
//   • CRUD зон (имя/role/цвет/полигон); рисование клик-кликом, готово по
//     двойному клику; редактирование вершин — через перетаскивание
//
// Экспорт:
//   initOperMap(containerId)        — первая инициализация (DOM + карта)
//   invalidateMapSize()             — пересчитать размер после показа таба

import { api } from './api.js';

const VENDOR = '/api/v1/oper-map/vendor';
const TILE_URL = '/api/v1/oper-map/tile/{z}/{x}/{y}.png';

// bbox Москва+МО (юго-запад / северо-восток) — карту по этим границам и
// центрируем на Москве при старте.
const MO_BBOX = [[54.25, 35.15], [56.97, 40.20]];
const MOSCOW_CENTER = [55.7558, 37.6173];

let _L = null;          // глобальный Leaflet, ленивая загрузка
let _map = null;
let _baseMarker = null;
let _targetMarker = null;
let _routeLayer = null;
let _zonesLayer = null;
let _zoneEditing = null;   // {polygon: L.Polygon, vertices: L.Marker[]} при редактировании
let _draftMode = null;     // {points: [[lat,lng], ...], polyline: L.Polyline}
let _zonesCache = [];

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// ─── Загрузка Leaflet через прокси ────────────────────────────────────────

async function _loadLeaflet() {
    if (window.L) {
        _L = window.L;
        return;
    }
    // CSS
    if (!document.querySelector('link[data-oper-map-leaflet]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${VENDOR}/leaflet.css`;
        link.dataset.operMapLeaflet = '1';
        document.head.appendChild(link);
    }
    // JS
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${VENDOR}/leaflet.js`;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Не удалось загрузить Leaflet'));
        document.head.appendChild(script);
    });
    _L = window.L;
    // Иконки маркеров — переопределяем пути на наш прокси, иначе Leaflet
    // ищет images/marker-icon.png относительно URL leaflet.css.
    _L.Icon.Default.mergeOptions({
        iconUrl:       `${VENDOR}/marker-icon.png`,
        iconRetinaUrl: `${VENDOR}/marker-icon-2x.png`,
        shadowUrl:     `${VENDOR}/marker-shadow.png`,
    });
}


// ─── Разметка панели ──────────────────────────────────────────────────────

function _renderShell(root) {
    root.innerHTML = `
        <div class="oper-map-wrap">
            <aside class="oper-map-side">
                <div class="oper-map-side__sec">
                    <h4>Базовая точка</h4>
                    <input id="om-base-input" type="text" placeholder="Адрес штаба ОД" />
                    <div class="oper-map-actions">
                        <button id="om-base-find" class="btn btn-outlined btn-sm" type="button">Найти</button>
                        <button id="om-base-save" class="btn btn-success  btn-sm" type="button">Сохранить базу</button>
                    </div>
                    <small id="om-base-hint" class="oper-map-hint"></small>
                </div>

                <div class="oper-map-side__sec">
                    <h4>Адрес и маршрут</h4>
                    <input id="om-target-input" type="text" placeholder="Адрес объекта" />
                    <div class="oper-map-actions">
                        <button id="om-target-find" class="btn btn-outlined btn-sm" type="button">Найти</button>
                        <button id="om-route-build" class="btn btn-filled   btn-sm" type="button">Маршрут от базы</button>
                    </div>
                    <small id="om-route-info" class="oper-map-hint"></small>
                    <small id="om-zone-hit" class="oper-map-hint"></small>
                </div>

                <div class="oper-map-side__sec">
                    <h4>Зоны ответственности</h4>
                    <div id="om-zones-list"></div>
                    <button id="om-zone-new" class="btn btn-outlined btn-sm" type="button" style="margin-top:6px;">+ Новая зона</button>
                </div>
            </aside>
            <div class="oper-map-stage">
                <div id="om-map" class="oper-map-canvas"></div>
                <div id="om-edit-toolbar" class="oper-map-toolbar hidden">
                    <span id="om-edit-status">Редактирование зоны…</span>
                    <button id="om-edit-finish" class="btn btn-success  btn-sm" type="button">Готово</button>
                    <button id="om-edit-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                </div>
            </div>
        </div>
    `;
}


// ─── Карта ────────────────────────────────────────────────────────────────

function _initMap() {
    _map = _L.map('om-map', {
        center: MOSCOW_CENTER,
        zoom:   10,
        minZoom: 8,
        maxZoom: 18,
        maxBounds: MO_BBOX,
        maxBoundsViscosity: 0.6,
    });
    _L.tileLayer(TILE_URL, { maxZoom: 18, attribution: '© Яндекс' }).addTo(_map);
    _zonesLayer = _L.layerGroup().addTo(_map);
}


// ─── Зоны: рендер и CRUD ──────────────────────────────────────────────────

function _renderZonesList() {
    const box = document.getElementById('om-zones-list');
    if (!box) return;
    if (_zonesCache.length === 0) {
        box.innerHTML = '<div class="oper-map-empty">Зон ещё нет — добавьте первую.</div>';
        return;
    }
    box.innerHTML = _zonesCache.map(z => `
        <div class="oper-map-zone" data-zone="${z.id}">
            <span class="oper-map-zone__swatch" style="background:${_esc(z.color)};"></span>
            <div class="oper-map-zone__info">
                <input class="oper-map-zone__name"  data-field="name"  value="${_esc(z.name)}" />
                <input class="oper-map-zone__role"  data-field="role"  value="${_esc(z.role || '')}" placeholder="роль (Пожарные, ДС…)" />
                <input class="oper-map-zone__color" data-field="color" type="color" value="${_esc(z.color)}" />
            </div>
            <div class="oper-map-zone__actions">
                <button class="btn btn-text btn-sm" data-action="edit"  type="button">✎</button>
                <button class="btn btn-text btn-sm" data-action="del"   type="button">🗑</button>
            </div>
        </div>
    `).join('');
    box.querySelectorAll('.oper-map-zone').forEach(row => {
        const id = parseInt(row.dataset.zone, 10);
        row.querySelectorAll('input').forEach(inp => {
            inp.addEventListener('change', () => _saveZoneField(id, inp.dataset.field, inp.value));
        });
        row.querySelector('[data-action="edit"]').addEventListener('click', () => _startEditZone(id));
        row.querySelector('[data-action="del"]').addEventListener('click',  () => _deleteZone(id));
    });
}

async function _loadZones() {
    try {
        _zonesCache = await api.get('/oper-map/zones');
    } catch (err) {
        window.showSnackbar?.(`Не удалось загрузить зоны: ${err?.message || err}`, 'error');
        _zonesCache = [];
    }
    _redrawZones();
    _renderZonesList();
}

function _redrawZones() {
    _zonesLayer.clearLayers();
    for (const z of _zonesCache) {
        const ring = _polygonRing(z.polygon);
        if (!ring) continue;
        const layer = _L.polygon(ring, {
            color:       z.color,
            fillColor:   z.color,
            fillOpacity: 0.18,
            weight:      2,
        }).bindTooltip(`${z.name}${z.role ? ` · ${z.role}` : ''}`);
        layer.addTo(_zonesLayer);
    }
}

// GeoJSON polygon → массив [[lat,lng], ...] для Leaflet (он принимает lat,lng).
function _polygonRing(polygon) {
    if (!polygon || polygon.type !== 'Polygon') return null;
    const ring = polygon.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 3) return null;
    return ring.map(([lng, lat]) => [lat, lng]);
}

function _ringToGeoJSON(latlngs) {
    if (!Array.isArray(latlngs) || latlngs.length < 3) return {};
    const coords = latlngs.map(p => [p.lng ?? p[1], p.lat ?? p[0]]);
    // GeoJSON-кольцо должно быть замкнутым: первая = последней.
    if (coords[0][0] !== coords[coords.length - 1][0]
        || coords[0][1] !== coords[coords.length - 1][1]) {
        coords.push([...coords[0]]);
    }
    return { type: 'Polygon', coordinates: [coords] };
}

async function _saveZoneField(id, field, value) {
    const body = {};
    body[field] = (field === 'role') ? (value.trim() || null) : value.trim();
    try {
        const updated = await api.patch(`/oper-map/zones/${id}`, body);
        const idx = _zonesCache.findIndex(z => z.id === id);
        if (idx !== -1) _zonesCache[idx] = updated;
        _redrawZones();
    } catch (err) {
        window.showSnackbar?.(`Не сохранено: ${err?.message || err}`, 'error');
    }
}

async function _deleteZone(id) {
    const z = _zonesCache.find(z => z.id === id);
    if (!z) return;
    if (!confirm(`Удалить зону «${z.name}»?`)) return;
    try {
        await api.delete(`/oper-map/zones/${id}`);
        _zonesCache = _zonesCache.filter(z => z.id !== id);
        _redrawZones();
        _renderZonesList();
    } catch (err) {
        window.showSnackbar?.(`Не удалось удалить: ${err?.message || err}`, 'error');
    }
}


// ─── Создание / редактирование полигона ──────────────────────────────────

function _enterDraftMode(zoneId = null) {
    _exitDraftMode(true);
    _zoneEditing = zoneId ? { id: zoneId } : null;
    _draftMode = {
        points:   [],
        polyline: _L.polyline([], { color: '#1976d2', weight: 2, dashArray: '4 4' }).addTo(_map),
    };
    document.getElementById('om-edit-toolbar').classList.remove('hidden');
    document.getElementById('om-edit-status').textContent = zoneId
        ? 'Кликами обведите контур заново. Двойной клик — готово.'
        : 'Кликами обведите контур зоны. Двойной клик — готово.';
    _map.on('click',    _onDraftClick);
    _map.on('dblclick', _onDraftFinish);
    _map.doubleClickZoom.disable();
}

function _exitDraftMode(silent = false) {
    if (_draftMode?.polyline) _map.removeLayer(_draftMode.polyline);
    _draftMode = null;
    _zoneEditing = null;
    _map.off('click',    _onDraftClick);
    _map.off('dblclick', _onDraftFinish);
    _map.doubleClickZoom.enable();
    document.getElementById('om-edit-toolbar')?.classList.add('hidden');
}

function _onDraftClick(e) {
    if (!_draftMode) return;
    _draftMode.points.push(e.latlng);
    _draftMode.polyline.setLatLngs(_draftMode.points);
}

async function _onDraftFinish() {
    if (!_draftMode || _draftMode.points.length < 3) {
        window.showSnackbar?.('Нужно минимум 3 точки', 'error');
        return;
    }
    const polygon = _ringToGeoJSON(_draftMode.points);
    const zoneId = _zoneEditing?.id;
    try {
        if (zoneId) {
            const updated = await api.patch(`/oper-map/zones/${zoneId}`, { polygon });
            const idx = _zonesCache.findIndex(z => z.id === zoneId);
            if (idx !== -1) _zonesCache[idx] = updated;
        } else {
            const name = prompt('Название зоны:', 'Новая зона');
            if (!name) { _exitDraftMode(); return; }
            const created = await api.post('/oper-map/zones', {
                name, role: '', color: '#ff5722', polygon, sort_order: _zonesCache.length,
            });
            _zonesCache.push(created);
        }
        _exitDraftMode();
        _redrawZones();
        _renderZonesList();
    } catch (err) {
        window.showSnackbar?.(`Не сохранено: ${err?.message || err}`, 'error');
    }
}

function _startEditZone(id) {
    const z = _zonesCache.find(z => z.id === id);
    if (!z) return;
    if (!confirm(`Перерисовать контур «${z.name}»? Существующий контур будет заменён.`)) return;
    _enterDraftMode(id);
}


// ─── Базовая точка ────────────────────────────────────────────────────────

let _baseLat = null;
let _baseLng = null;

async function _loadSettings() {
    try {
        const s = await api.get('/oper-map/settings');
        document.getElementById('om-base-input').value = s.base_address || '';
        if (s.base_lat && s.base_lng) {
            _baseLat = s.base_lat;
            _baseLng = s.base_lng;
            _placeBaseMarker();
            document.getElementById('om-base-hint').textContent =
                `Сохранено: ${s.base_lat.toFixed(5)}, ${s.base_lng.toFixed(5)}`;
        }
    } catch { /* ignore */ }
}

function _placeBaseMarker() {
    if (_baseMarker) _map.removeLayer(_baseMarker);
    if (_baseLat == null || _baseLng == null) return;
    _baseMarker = _L.marker([_baseLat, _baseLng], { title: 'База ОД' })
        .bindPopup('База ОД')
        .addTo(_map);
}

async function _findBase() {
    const q = document.getElementById('om-base-input').value.trim();
    if (!q) return;
    const result = await _geocode(q);
    if (!result) return;
    _baseLat = result.lat;
    _baseLng = result.lng;
    document.getElementById('om-base-input').value = result.text;
    document.getElementById('om-base-hint').textContent =
        `Найдено: ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)} (нажмите «Сохранить базу»)`;
    _placeBaseMarker();
    _map.setView([result.lat, result.lng], 14);
}

async function _saveBase() {
    const address = document.getElementById('om-base-input').value.trim();
    if (_baseLat == null || _baseLng == null) {
        window.showSnackbar?.('Сначала найдите адрес — нужны координаты', 'error');
        return;
    }
    try {
        await api.put('/oper-map/settings', {
            base_address: address, base_lat: _baseLat, base_lng: _baseLng,
        });
        document.getElementById('om-base-hint').textContent = 'База сохранена.';
    } catch (err) {
        window.showSnackbar?.(`Не сохранено: ${err?.message || err}`, 'error');
    }
}


// ─── Геокодер ─────────────────────────────────────────────────────────────

async function _geocode(q) {
    // Ограничиваем bbox Москва+МО — Яндекс отдаёт первый локальный матч.
    const bbox = '35.15,54.25~40.20,56.97';
    try {
        const res = await api.get(`/oper-map/geocode?q=${encodeURIComponent(q)}&bbox=${encodeURIComponent(bbox)}`);
        const first = res?.results?.[0];
        if (!first) {
            window.showSnackbar?.('Адрес не найден', 'error');
            return null;
        }
        return first;
    } catch (err) {
        window.showSnackbar?.(`Геокодер недоступен: ${err?.message || err}`, 'error');
        return null;
    }
}


// ─── Цель и маршрут ───────────────────────────────────────────────────────

let _targetLat = null;
let _targetLng = null;

async function _findTarget() {
    const q = document.getElementById('om-target-input').value.trim();
    if (!q) return;
    const r = await _geocode(q);
    if (!r) return;
    _targetLat = r.lat;
    _targetLng = r.lng;
    document.getElementById('om-target-input').value = r.text;
    if (_targetMarker) _map.removeLayer(_targetMarker);
    _targetMarker = _L.marker([r.lat, r.lng], { title: r.text })
        .bindPopup(r.text)
        .addTo(_map);
    _map.setView([r.lat, r.lng], 14);
    _showZoneHits(r.lat, r.lng);
}

function _showZoneHits(lat, lng) {
    const hits = [];
    for (const z of _zonesCache) {
        const ring = _polygonRing(z.polygon);
        if (ring && _pointInRing(lat, lng, ring)) {
            hits.push(z);
        }
    }
    const el = document.getElementById('om-zone-hit');
    if (!el) return;
    if (hits.length === 0) {
        el.textContent = 'Адрес не попадает ни в одну зону.';
        el.style.color = '';
    } else {
        el.innerHTML = 'Зоны: ' + hits.map(z =>
            `<span style="display:inline-block; padding:1px 6px; border-radius:8px; background:${_esc(z.color)}22; color:${_esc(z.color)};">${_esc(z.name)}${z.role ? ` · ${_esc(z.role)}` : ''}</span>`
        ).join(' ');
    }
}

// Простой ray-casting: для точки (lat,lng) и ring [[lat,lng],...].
function _pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [yi, xi] = ring[i];
        const [yj, xj] = ring[j];
        const intersect = ((yi > lat) !== (yj > lat))
            && (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

async function _buildRoute() {
    if (_baseLat == null || _baseLng == null) {
        window.showSnackbar?.('Сначала задайте базовую точку', 'error');
        return;
    }
    if (_targetLat == null || _targetLng == null) {
        window.showSnackbar?.('Сначала найдите адрес объекта', 'error');
        return;
    }
    try {
        const r = await api.post('/oper-map/route', {
            src: [_baseLat, _baseLng],
            dst: [_targetLat, _targetLng],
        });
        if (_routeLayer) _map.removeLayer(_routeLayer);
        _routeLayer = _L.geoJSON(r.geometry, { style: { color: '#1976d2', weight: 4 } }).addTo(_map);
        _map.fitBounds(_routeLayer.getBounds(), { padding: [40, 40] });
        const km = (r.distance_m / 1000).toFixed(1);
        const min = Math.round(r.duration_s / 60);
        document.getElementById('om-route-info').textContent =
            `${km} км · ≈ ${min} мин (по дорогам, без учёта пробок)`;
    } catch (err) {
        window.showSnackbar?.(`Маршрут не построен: ${err?.message || err}`, 'error');
    }
}


// ─── Public API ───────────────────────────────────────────────────────────

export async function initOperMap(rootId) {
    const root = document.getElementById(rootId);
    if (!root) return;
    _renderShell(root);

    try {
        await _loadLeaflet();
    } catch (err) {
        root.innerHTML = `<div class="oper-map-error">Не удалось загрузить карту: ${_esc(err.message)}</div>`;
        return;
    }
    _initMap();
    await Promise.all([_loadSettings(), _loadZones()]);

    document.getElementById('om-base-find').addEventListener('click',   _findBase);
    document.getElementById('om-base-save').addEventListener('click',   _saveBase);
    document.getElementById('om-target-find').addEventListener('click', _findTarget);
    document.getElementById('om-route-build').addEventListener('click', _buildRoute);
    document.getElementById('om-zone-new').addEventListener('click',    () => _enterDraftMode(null));
    document.getElementById('om-edit-finish').addEventListener('click', _onDraftFinish);
    document.getElementById('om-edit-cancel').addEventListener('click', () => _exitDraftMode());

    document.getElementById('om-base-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); _findBase(); }
    });
    document.getElementById('om-target-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); _findTarget(); }
    });
}

export function invalidateMapSize() {
    if (_map) _map.invalidateSize();
}
