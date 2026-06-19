// static/js/zone_map.js
//
// Карта зон (вкладка под permission='zone_map') — самостоятельный дубль карты
// Оперативного дежурного, заточенный под импорт координат из Excel.
//
// Что умеет:
//   • показ карты (Leaflet, тайлы Яндекса через прокси /api/v1/oper-map/...)
//   • загрузка .xlsx с координатами → точки выпадают на карту и группируются
//     в зоны (полигоны) по колонке «Зона»
//   • ручное рисование зон кликами (как в карте ОД)
//   • CRUD зон (имя / подпись / цвет / удалить)
//   • экспорт готовой карты в JPG или PDF в точном масштабе (по умолч. 1:2000)
//     со склейкой тайлов на canvas и масштабной линейкой
//
// Среда: локалка без интернета. Все запросы идут на наш бэк; тайлы и Leaflet
// бэк сам тянет у Яндекса/CDN. Тайлы и vendor реюзаем из публичных прокси
// карты ОД — дублировать их незачем.
//
// Экспорт модуля:
//   initZoneMap(containerId)   — первая инициализация (DOM + карта)
//   invalidateMapSize()        — пересчитать размер после показа таба

import { api } from './api.js';

const VENDOR    = '/api/v1/oper-map/vendor';        // реюз прокси карты ОД
const TILE_BASE = '/api/v1/oper-map/tile';          // {z}/{x}/{y}.png
const TILE_URL  = `${TILE_BASE}/{z}/{x}/{y}.png`;

const MOSCOW_CENTER = [55.7558, 37.6173];
const TILE_SIZE = 256;
const A_EARTH   = 6378137;                           // большая полуось WGS84

let _L = null;
let _map = null;
let _zonesLayer = null;
let _zonesCache = [];
let _draftMode = null;       // {points, polyline} при рисовании
let _zoneEditing = null;     // {id} при перерисовке контура

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


// ─── Загрузка Leaflet через прокси (как в oper_map.js) ─────────────────────

async function _loadLeaflet() {
    if (window.L) { _L = window.L; return; }
    if (!document.querySelector('link[data-oper-map-leaflet]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${VENDOR}/leaflet.css`;
        link.dataset.operMapLeaflet = '1';
        document.head.appendChild(link);
    }
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${VENDOR}/leaflet.js`;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Не удалось загрузить Leaflet'));
        document.head.appendChild(script);
    });
    _L = window.L;
    _L.Icon.Default.imagePath = `${VENDOR}/`;
}

let _jsPdfLoading = null;
async function _ensureJsPDF() {
    if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
    if (!_jsPdfLoading) {
        _jsPdfLoading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = `${VENDOR}/jspdf.umd.min.js`;
            s.onload = resolve;
            s.onerror = () => reject(new Error('Не удалось загрузить jsPDF'));
            document.head.appendChild(s);
        });
    }
    await _jsPdfLoading;
    if (!window.jspdf?.jsPDF) throw new Error('jsPDF не инициализировался');
    return window.jspdf.jsPDF;
}


// ─── Разметка панели ───────────────────────────────────────────────────────

function _renderShell(root) {
    root.innerHTML = `
        <div class="zone-map-wrap">
            <aside class="zone-map-side">
                <div class="zone-map-side__sec">
                    <h4>Импорт координат</h4>
                    <input id="zm-file" type="file" style="display:none;" />
                    <label class="zone-map-field">Система координат
                        <select id="zm-cs">
                            <option value="wgs84" selected>WGS-84 (широта / долгота)</option>
                            <option value="msk77">МСК-77, зона 1 (X / Y, м)</option>
                        </select>
                    </label>
                    <div class="zone-map-actions">
                        <button id="zm-import-xlsx" class="btn btn-filled btn-sm" type="button">📥 Excel</button>
                        <button id="zm-import-docx" class="btn btn-filled btn-sm" type="button">📄 Word</button>
                        <button id="zm-template-btn" class="btn btn-text btn-sm" type="button">Шаблон</button>
                    </div>
                    <label class="zone-map-radio"><input type="radio" name="zm-mode" value="replace" checked /> Заменить зоны</label>
                    <label class="zone-map-radio"><input type="radio" name="zm-mode" value="append" /> Добавить к существующим</label>
                    <small id="zm-import-hint" class="zone-map-hint">WGS-84: колонки «Зона», «Широта», «Долгота». МСК-77: колонки «X», «Y» (м) — пересчёт в WGS-84 автоматически.</small>
                </div>

                <div class="zone-map-side__sec">
                    <h4>Зоны (<span id="zm-zone-count">0</span>)</h4>
                    <div id="zm-zones-list"></div>
                    <div class="zone-map-actions" style="margin-top:6px;">
                        <button id="zm-zone-new" class="btn btn-outlined btn-sm" type="button">+ Нарисовать зону</button>
                        <button id="zm-fit" class="btn btn-outlined btn-sm" type="button">Показать все</button>
                        <button id="zm-clear" class="btn btn-text btn-sm" type="button">Очистить</button>
                    </div>
                </div>

                <div class="zone-map-side__sec">
                    <h4>Масштаб и экспорт</h4>
                    <div class="zone-map-grid2">
                        <label>Масштаб 1:
                            <input id="zm-scale" type="number" min="100" max="100000" step="100" value="2000" />
                        </label>
                        <label>DPI
                            <select id="zm-dpi">
                                <option value="96">96</option>
                                <option value="150" selected>150</option>
                                <option value="200">200</option>
                                <option value="300">300</option>
                            </select>
                        </label>
                        <label>Лист
                            <select id="zm-paper">
                                <option value="a4" selected>A4</option>
                                <option value="a3">A3</option>
                            </select>
                        </label>
                        <label>Ориентация
                            <select id="zm-orient">
                                <option value="landscape" selected>Альбомная</option>
                                <option value="portrait">Книжная</option>
                            </select>
                        </label>
                    </div>
                    <div class="zone-map-actions" style="margin-top:8px;">
                        <button id="zm-scale-apply" class="btn btn-outlined btn-sm" type="button">К масштабу 1:2000</button>
                    </div>
                    <div class="zone-map-actions" style="margin-top:6px;">
                        <button id="zm-export-jpg" class="btn btn-success btn-sm" type="button">⬇ JPG</button>
                        <button id="zm-export-pdf" class="btn btn-success btn-sm" type="button">⬇ PDF</button>
                    </div>
                    <small id="zm-export-hint" class="zone-map-hint">Карта строится по центру текущего вида в выбранном масштабе.</small>
                </div>
            </aside>
            <div class="zone-map-stage">
                <div id="zm-map" class="zone-map-canvas"></div>
                <div id="zm-edit-toolbar" class="zone-map-toolbar hidden">
                    <span id="zm-edit-status">Рисование зоны…</span>
                    <button id="zm-edit-finish" class="btn btn-success btn-sm" type="button">Готово</button>
                    <button id="zm-edit-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                </div>
                <div id="zm-scale-readout" class="zone-map-readout"></div>
            </div>
        </div>
    `;
}


// ─── Карта ───────────────────────────────────────────────────────────────────

function _initMap() {
    // crs EPSG3395 — как в карте ОД: тайлы Яндекса в этой проекции, иначе
    // маркеры разъезжаются с подложкой. zoomSnap:0 — чтобы пресет масштаба
    // мог встать на дробный зум.
    _map = _L.map('zm-map', {
        crs:      _L.CRS.EPSG3395,
        center:   MOSCOW_CENTER,
        zoom:     11,
        minZoom:  3,
        maxZoom:  19,
        zoomSnap: 0,
    });
    _L.tileLayer(TILE_URL, { maxZoom: 19, attribution: '© Яндекс' }).addTo(_map);
    _zonesLayer = _L.layerGroup().addTo(_map);
    // Убираем флаг/брендинг Leaflet справа внизу — оставляем только «© Яндекс».
    _map.attributionControl.setPrefix(false);
    _map.on('zoomend move', _updateScaleReadout);
    _updateScaleReadout();
}

// Текущий приблизительный масштаб (для экрана, при допущении 96 CSS-dpi).
function _metersPerPixelScreen() {
    const c = _map.getCenter();
    const p = _map.getZoom();
    const a = _map.containerPointToLatLng([0, 0]);
    const b = _map.containerPointToLatLng([100, 0]);
    return _map.distance(a, b) / 100;   // м на 1 CSS-пиксель
}

function _updateScaleReadout() {
    const el = document.getElementById('zm-scale-readout');
    if (!el) return;
    const mpp = _metersPerPixelScreen();
    // 96 CSS px = 1 дюйм = 0.0254 м → знаменатель масштаба на экране.
    const denom = Math.round(mpp * 96 / 0.0254);
    el.textContent = `≈ 1:${denom.toLocaleString('ru-RU')}`;
}


// ─── Зоны: рендер / CRUD ───────────────────────────────────────────────────

function _zoneRing(z) {
    const pts = Array.isArray(z.points) ? z.points : [];
    return pts.filter(p => Array.isArray(p) && p.length >= 2);
}

function _redrawZones() {
    _zonesLayer.clearLayers();
    for (const z of _zonesCache) {
        const ring = _zoneRing(z);
        if (ring.length === 0) continue;
        if (ring.length >= 3) {
            _L.polygon(ring, {
                color: z.color, fillColor: z.color, fillOpacity: 0.18, weight: 2,
            }).bindTooltip(`${z.name}${z.role ? ` · ${z.role}` : ''}`).addTo(_zonesLayer);
        }
        for (const [lat, lng] of ring) {
            _L.circleMarker([lat, lng], {
                radius: 4, color: z.color, fillColor: z.color, fillOpacity: 0.9, weight: 1,
            }).addTo(_zonesLayer);
        }
    }
}

function _renderZonesList() {
    const box = document.getElementById('zm-zones-list');
    const cnt = document.getElementById('zm-zone-count');
    if (cnt) cnt.textContent = String(_zonesCache.length);
    if (!box) return;
    if (_zonesCache.length === 0) {
        box.innerHTML = '<div class="zone-map-empty">Зон пока нет — загрузите Excel или нарисуйте.</div>';
        return;
    }
    box.innerHTML = _zonesCache.map(z => `
        <div class="zone-map-zone" data-zone="${z.id}">
            <span class="zone-map-zone__swatch" style="background:${_esc(z.color)};"></span>
            <div class="zone-map-zone__info">
                <input class="zone-map-zone__name" data-field="name" value="${_esc(z.name)}" />
                <input class="zone-map-zone__role" data-field="role" value="${_esc(z.role || '')}" placeholder="подпись (необяз.)" />
            </div>
            <input class="zone-map-zone__color" data-field="color" type="color" value="${_esc(z.color)}" />
            <div class="zone-map-zone__actions">
                <button class="btn btn-text btn-sm" data-action="zoom" type="button" title="Показать">⊙</button>
                <button class="btn btn-text btn-sm" data-action="del" type="button" title="Удалить">🗑</button>
            </div>
        </div>
    `).join('');
    box.querySelectorAll('.zone-map-zone').forEach(row => {
        const id = parseInt(row.dataset.zone, 10);
        row.querySelectorAll('input[data-field]').forEach(inp => {
            inp.addEventListener('change', () => _saveZoneField(id, inp.dataset.field, inp.value));
        });
        row.querySelector('[data-action="zoom"]').addEventListener('click', () => _zoomToZone(id));
        row.querySelector('[data-action="del"]').addEventListener('click', () => _deleteZone(id));
    });
}

async function _loadZones() {
    try {
        _zonesCache = await api.get('/zone-map/zones');
    } catch (err) {
        window.showSnackbar?.(`Не удалось загрузить зоны: ${err?.message || err}`, 'error');
        _zonesCache = [];
    }
    _redrawZones();
    _renderZonesList();
}

async function _saveZoneField(id, field, value) {
    const body = {};
    body[field] = (field === 'role') ? (value.trim() || null) : value.trim();
    try {
        const updated = await api.patch(`/zone-map/zones/${id}`, body);
        const idx = _zonesCache.findIndex(z => z.id === id);
        if (idx !== -1) _zonesCache[idx] = updated;
        _redrawZones();
    } catch (err) {
        window.showSnackbar?.(`Не сохранено: ${err?.message || err}`, 'error');
    }
}

async function _deleteZone(id) {
    const z = _zonesCache.find(z => z.id === id);
    if (!z || !confirm(`Удалить зону «${z.name}»?`)) return;
    try {
        await api.delete(`/zone-map/zones/${id}`);
        _zonesCache = _zonesCache.filter(z => z.id !== id);
        _redrawZones();
        _renderZonesList();
    } catch (err) {
        window.showSnackbar?.(`Не удалось удалить: ${err?.message || err}`, 'error');
    }
}

async function _clearAll() {
    if (_zonesCache.length === 0) return;
    if (!confirm('Удалить ВСЕ зоны?')) return;
    try {
        await api.delete('/zone-map/zones');
        _zonesCache = [];
        _redrawZones();
        _renderZonesList();
    } catch (err) {
        window.showSnackbar?.(`Не удалось очистить: ${err?.message || err}`, 'error');
    }
}

function _zonesBounds() {
    const all = [];
    for (const z of _zonesCache) for (const p of _zoneRing(z)) all.push(p);
    if (all.length === 0) return null;
    return _L.latLngBounds(all);
}

function _fitToZones() {
    const b = _zonesBounds();
    if (b) _map.fitBounds(b, { padding: [40, 40], maxZoom: 18 });
    else window.showSnackbar?.('Зон пока нет', 'info');
}

function _zoomToZone(id) {
    const z = _zonesCache.find(z => z.id === id);
    const ring = z ? _zoneRing(z) : [];
    if (ring.length === 0) return;
    if (ring.length === 1) _map.setView(ring[0], 17);
    else _map.fitBounds(_L.latLngBounds(ring), { padding: [40, 40], maxZoom: 18 });
}


// ─── Рисование зоны кликами (как в карте ОД) ───────────────────────────────

function _enterDraftMode() {
    _exitDraftMode(true);
    _draftMode = {
        points: [],
        polyline: _L.polyline([], { color: '#1976d2', weight: 2, dashArray: '4 4' }).addTo(_map),
    };
    document.getElementById('zm-edit-toolbar').classList.remove('hidden');
    document.getElementById('zm-edit-status').textContent =
        'Кликами обведите контур зоны. Двойной клик — готово.';
    _map.on('click', _onDraftClick);
    _map.on('dblclick', _onDraftFinish);
    _map.doubleClickZoom.disable();
}

function _exitDraftMode() {
    if (_draftMode?.polyline) _map.removeLayer(_draftMode.polyline);
    _draftMode = null;
    _zoneEditing = null;
    _map.off('click', _onDraftClick);
    _map.off('dblclick', _onDraftFinish);
    _map.doubleClickZoom.enable();
    document.getElementById('zm-edit-toolbar')?.classList.add('hidden');
}

function _onDraftClick(e) {
    if (!_draftMode) return;
    _draftMode.points.push([e.latlng.lat, e.latlng.lng]);
    _draftMode.polyline.setLatLngs(_draftMode.points);
}

async function _onDraftFinish() {
    if (!_draftMode || _draftMode.points.length < 3) {
        window.showSnackbar?.('Нужно минимум 3 точки', 'error');
        return;
    }
    const points = _draftMode.points.slice();
    try {
        const name = prompt('Название зоны:', `Зона ${_zonesCache.length + 1}`);
        if (!name) { _exitDraftMode(); return; }
        const created = await api.post('/zone-map/zones', {
            name, role: '', color: '#1976d2', points, sort_order: _zonesCache.length,
        });
        _zonesCache.push(created);
        _exitDraftMode();
        _redrawZones();
        _renderZonesList();
    } catch (err) {
        window.showSnackbar?.(`Не сохранено: ${err?.message || err}`, 'error');
    }
}


// ─── Импорт Excel ──────────────────────────────────────────────────────────

async function _onTemplate() {
    try {
        const blob = await api.download('/zone-map/template.xlsx');
        _saveBlob(blob, 'zone_map_template.xlsx');
    } catch (err) {
        window.showSnackbar?.(`Не удалось скачать шаблон: ${err?.message || err}`, 'error');
    }
}

const _IMPORT_HINT = 'WGS-84: колонки «Зона», «Широта», «Долгота». МСК-77: колонки «X», «Y» (м) — пересчёт в WGS-84 автоматически.';

async function _onImportFile(file) {
    if (!file) return;
    const mode = document.querySelector('input[name="zm-mode"]:checked')?.value || 'replace';
    const coordSystem = document.getElementById('zm-cs')?.value || 'wgs84';
    const hint = document.getElementById('zm-import-hint');
    if (hint) hint.textContent = 'Загрузка и разбор…';
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    fd.append('coord_system', coordSystem);
    try {
        const res = await api.upload('/zone-map/import', fd);
        await _loadZones();
        _fitToZones();
        if (hint) {
            const sk = res.rows_skipped ? `, пропущено строк: ${res.rows_skipped}` : '';
            const cs = coordSystem === 'msk77' ? ' (МСК-77→WGS-84)' : '';
            hint.textContent =
                `Готово: зон ${res.zones_created}, точек ${res.points_total}${sk}${cs}.`;
        }
        window.showSnackbar?.(`Импортировано зон: ${res.zones_created}`, 'success');
    } catch (err) {
        if (hint) hint.textContent = _IMPORT_HINT;
        window.showSnackbar?.(`Импорт не выполнен: ${err?.message || err}`, 'error');
    }
}


// ─── Масштаб: пресет 1:2000 ────────────────────────────────────────────────

function _applyScalePreset() {
    const scale = Math.max(100, parseInt(document.getElementById('zm-scale')?.value, 10) || 2000);
    const center = _map.getCenter();
    // нужный «м на CSS-пиксель» при 96 dpi
    const mppTarget = scale * 0.0254 / 96;
    // м на пиксель тайла на зуме z (сфера): 2πa·cos(lat) / (256·2^z)
    const latRad = center.lat * Math.PI / 180;
    const ground = 2 * Math.PI * A_EARTH * Math.cos(latRad);
    // mpp(z) = ground / (256 · 2^z) → z = log2(ground / (256 · mpp))
    const z = Math.log2(ground / (TILE_SIZE * mppTarget));
    _map.setView(center, Math.min(19, Math.max(3, z)));
}


// ─── Экспорт карты (склейка тайлов + оверлеи) ──────────────────────────────

const PAPER_MM = { a4: [210, 297], a3: [297, 420] };

// м на пиксель в текущей проекции карты на зуме z, около центра — численно,
// чтобы совпадало и с подложкой, и с реальными метрами (линейка честная).
function _mppAtZoom(crs, center, z) {
    const p1 = crs.latLngToPoint(center, z);
    const c2 = _L.latLng(center.lat + 0.002, center.lng);
    const p2 = crs.latLngToPoint(c2, z);
    const pxDist = Math.abs(p2.y - p1.y) || 1e-9;
    const groundM = _map.distance(center, c2);
    return groundM / pxDist;
}

function _loadTile(z, x, y) {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = `${TILE_BASE}/${z}/${x}/${y}.png`;
    });
}

async function _renderExportCanvas({ scale, dpi, paper, orient }) {
    const crs = _L.CRS.EPSG3395;
    const [pwBase, phBase] = PAPER_MM[paper] || PAPER_MM.a4;
    const [pw, ph] = (orient === 'portrait') ? [pwBase, phBase] : [phBase, pwBase];

    const outW = Math.round(pw / 25.4 * dpi);
    const outH = Math.round(ph / 25.4 * dpi);
    const mppTarget = scale * 0.0254 / dpi;          // м на выходной пиксель

    const center = _map.getCenter();

    // Подбираем зум тайлов: самый ГРУБЫЙ (наименьший z), чей mpp ещё ≤ целевого.
    // mpp падает с ростом z, поэтому идём снизу вверх и берём первый подходящий —
    // тогда mppZ максимально близок к target снизу, промежуточный холст почти
    // равен выходному (минимум растяжения и минимум тайлов). Скан сверху вниз
    // ошибочно всегда давал z=19 и раздувал область в разы.
    let z = 19;
    for (let zz = 3; zz <= 19; zz++) {
        if (_mppAtZoom(crs, center, zz) <= mppTarget) { z = zz; break; }
    }
    const mppZ = _mppAtZoom(crs, center, z);

    // Размер промежуточного холста на зуме z (после масштабирования к outW×outH
    // даст ровно mppTarget на пиксель → точный масштаб).
    const renderW = Math.max(1, Math.round(outW * mppTarget / mppZ));
    const renderH = Math.max(1, Math.round(outH * mppTarget / mppZ));

    const centerPx = crs.latLngToPoint(center, z);
    const originX = centerPx.x - renderW / 2;
    const originY = centerPx.y - renderH / 2;

    const canvas = document.createElement('canvas');
    canvas.width = renderW;
    canvas.height = renderH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e9e6e0';
    ctx.fillRect(0, 0, renderW, renderH);

    const maxIdx = Math.pow(2, z);
    const xMin = Math.floor(originX / TILE_SIZE), xMax = Math.floor((originX + renderW) / TILE_SIZE);
    const yMin = Math.floor(originY / TILE_SIZE), yMax = Math.floor((originY + renderH) / TILE_SIZE);
    const tileCount = (xMax - xMin + 1) * (yMax - yMin + 1);
    if (tileCount > 600) {
        throw new Error('Слишком большая область для этого масштаба/листа. Уменьшите DPI или масштаб.');
    }

    const jobs = [];
    for (let tx = xMin; tx <= xMax; tx++) {
        for (let ty = yMin; ty <= yMax; ty++) {
            if (tx < 0 || ty < 0 || tx >= maxIdx || ty >= maxIdx) continue;
            jobs.push(_loadTile(z, tx, ty).then(img => {
                if (img) ctx.drawImage(img, Math.round(tx * TILE_SIZE - originX), Math.round(ty * TILE_SIZE - originY));
            }));
        }
    }
    await Promise.all(jobs);

    // оверлеи зон в координатах промежуточного холста
    const project = ([lat, lng]) => {
        const p = crs.latLngToPoint(_L.latLng(lat, lng), z);
        return [p.x - originX, p.y - originY];
    };
    for (const zoneobj of _zonesCache) {
        const ring = _zoneRing(zoneobj);
        if (ring.length === 0) continue;
        const proj = ring.map(project);
        if (proj.length >= 3) {
            ctx.beginPath();
            proj.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.closePath();
            ctx.fillStyle = _hexA(zoneobj.color, 0.18);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = zoneobj.color;
            ctx.stroke();
        }
        ctx.fillStyle = zoneobj.color;
        for (const [x, y] of proj) {
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // масштабируем к выходному размеру
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(canvas, 0, 0, renderW, renderH, 0, 0, outW, outH);

    _drawDecorations(octx, { outW, outH, dpi, mppTarget, scale });

    return { canvas: out, pw, ph };
}

// #rrggbb + alpha → rgba()
function _hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return `rgba(25,118,210,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function _drawDecorations(ctx, { outW, outH, dpi, mppTarget, scale }) {
    const pad = Math.round(dpi * 0.12);
    const fs = Math.max(11, Math.round(dpi * 0.085));
    ctx.font = `${fs}px sans-serif`;
    ctx.textBaseline = 'middle';

    // ── масштабная линейка (низ-слева) ──
    const NICE = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    const maxBarPx = outW * 0.26;
    let meters = NICE[0];
    for (const m of NICE) { if (m / mppTarget <= maxBarPx) meters = m; }
    const barPx = meters / mppTarget;
    const bx = pad, by = outH - pad - fs;
    const bh = Math.max(5, Math.round(dpi * 0.04));

    const boxW = barPx + pad;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(bx - 8, by - fs - 8, boxW + 16, fs + bh + 26);

    ctx.fillStyle = '#000';
    ctx.fillRect(bx, by, barPx, bh);
    ctx.fillStyle = '#fff';
    ctx.fillRect(bx + barPx / 2, by, barPx / 2, bh);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, barPx, bh);

    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    const label = meters >= 1000 ? `${meters / 1000} км` : `${meters} м`;
    ctx.fillText(`0`, bx - 2, by + bh + fs * 0.7);
    ctx.fillText(label, bx + barPx - fs, by + bh + fs * 0.7);
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.fillText(`Масштаб 1:${scale}`, bx, by - fs * 0.6);

    // ── легенда (верх-справа) ──
    if (_zonesCache.length) {
        ctx.font = `${fs}px sans-serif`;
        const items = _zonesCache.slice(0, 14);
        const lh = fs + 8;
        let maxText = 0;
        for (const z of items) maxText = Math.max(maxText, ctx.measureText(z.name).width);
        const lw = maxText + fs * 2.4 + pad;
        const lx = outW - lw - pad, ly = pad;
        const lhTotal = items.length * lh + pad;
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.fillRect(lx - 6, ly - 6, lw + 12, lhTotal + 12);
        ctx.strokeStyle = '#888';
        ctx.strokeRect(lx - 6, ly - 6, lw + 12, lhTotal + 12);
        ctx.textAlign = 'left';
        items.forEach((z, i) => {
            const yy = ly + pad / 2 + i * lh + lh / 2;
            ctx.fillStyle = z.color;
            ctx.fillRect(lx, yy - fs / 2, fs, fs);
            ctx.strokeStyle = '#333';
            ctx.strokeRect(lx, yy - fs / 2, fs, fs);
            ctx.fillStyle = '#000';
            ctx.fillText(z.name, lx + fs * 1.5, yy);
        });
        if (_zonesCache.length > items.length) {
            ctx.fillStyle = '#555';
            ctx.fillText(`+${_zonesCache.length - items.length} ещё`, lx, ly + lhTotal + fs);
        }
    }

    // ── подпись источника ──
    ctx.font = `${Math.round(fs * 0.8)}px sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.textAlign = 'right';
    ctx.fillText('© Яндекс', outW - pad, outH - pad / 2);
}

async function _export(format) {
    const btnIds = ['zm-export-jpg', 'zm-export-pdf'];
    btnIds.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
    const hint = document.getElementById('zm-export-hint');
    const prevHint = hint?.textContent;
    if (hint) hint.textContent = 'Готовлю карту… (тяну тайлы)';
    try {
        const scale  = Math.max(100, parseInt(document.getElementById('zm-scale')?.value, 10) || 2000);
        const dpi    = parseInt(document.getElementById('zm-dpi')?.value, 10) || 150;
        const paper  = document.getElementById('zm-paper')?.value || 'a4';
        const orient = document.getElementById('zm-orient')?.value || 'landscape';

        const { canvas, pw, ph } = await _renderExportCanvas({ scale, dpi, paper, orient });
        const fname = `karta_1-${scale}`;

        if (format === 'jpg') {
            const url = canvas.toDataURL('image/jpeg', 0.92);
            _saveDataUrl(url, `${fname}.jpg`);
        } else {
            const jsPDF = await _ensureJsPDF();
            const pdf = new jsPDF({ unit: 'mm', format: paper, orientation: orient });
            const url = canvas.toDataURL('image/jpeg', 0.92);
            pdf.addImage(url, 'JPEG', 0, 0, pw, ph);
            pdf.save(`${fname}.pdf`);
        }
        if (hint) hint.textContent = 'Готово ✓';
    } catch (err) {
        if (hint) hint.textContent = prevHint || '';
        window.showSnackbar?.(`Экспорт не выполнен: ${err?.message || err}`, 'error');
    } finally {
        btnIds.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; });
    }
}


// ─── утилиты скачивания ─────────────────────────────────────────────────────

function _saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    _triggerDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function _saveDataUrl(dataUrl, filename) {
    _triggerDownload(dataUrl, filename);
}
function _triggerDownload(href, filename) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}


// ─── Public API ──────────────────────────────────────────────────────────────

export async function initZoneMap(rootId) {
    const root = document.getElementById(rootId);
    if (!root) return;
    _renderShell(root);

    try {
        await _loadLeaflet();
    } catch (err) {
        root.innerHTML = `<div class="zone-map-error">Не удалось загрузить карту: ${_esc(err.message)}</div>`;
        return;
    }
    _initMap();
    await _loadZones();
    if (_zonesCache.length) _fitToZones();

    const fileInput = document.getElementById('zm-file');
    document.getElementById('zm-import-xlsx').addEventListener('click', () => {
        fileInput.accept = '.xlsx,.xlsm';
        fileInput.click();
    });
    document.getElementById('zm-import-docx').addEventListener('click', () => {
        fileInput.accept = '.docx';
        fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
        _onImportFile(e.target.files?.[0]);
        e.target.value = '';     // позволяем повторно выбрать тот же файл
    });
    document.getElementById('zm-template-btn').addEventListener('click', _onTemplate);
    document.getElementById('zm-zone-new').addEventListener('click', _enterDraftMode);
    document.getElementById('zm-fit').addEventListener('click', _fitToZones);
    document.getElementById('zm-clear').addEventListener('click', _clearAll);
    document.getElementById('zm-edit-finish').addEventListener('click', _onDraftFinish);
    document.getElementById('zm-edit-cancel').addEventListener('click', _exitDraftMode);
    document.getElementById('zm-scale-apply').addEventListener('click', _applyScalePreset);
    document.getElementById('zm-export-jpg').addEventListener('click', () => _export('jpg'));
    document.getElementById('zm-export-pdf').addEventListener('click', () => _export('pdf'));
}

export function invalidateMapSize() {
    if (_map) {
        _map.invalidateSize();
        _updateScaleReadout();
    }
}
