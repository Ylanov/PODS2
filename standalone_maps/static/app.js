// standalone_maps/static/app.js
// Две карты (ОД + зоны) на OpenStreetMap, без авторизации. Leaflet/jsPDF — с CDN.
(function () {
"use strict";

const L = window.L;
const TILE_URL = "/tiles/{z}/{x}/{y}.png";
const MOSCOW = [55.7558, 37.6173];
// провайдер карт (заполняется из /api/config при старте)
let CFG = { provider: "osm", suggest: false, attribution: "© OpenStreetMap" };

// ─── общие хелперы ──────────────────────────────────────────────────────────
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function jget(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
    return r.json();
}
async function jsend(url, method, body) {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
    return r.status === 204 ? null : r.json();
}
async function jupload(url, formData) {
    const r = await fetch(url, { method: "POST", body: formData });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.status);
    return r.json();
}
function toast(msg, kind) {
    let el = document.getElementById("toast");
    if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
    el.textContent = msg;
    el.className = "show " + (kind || "");
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ""; }, 4000);
}
function download(href, name) {
    const a = document.createElement("a"); a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
}

function ringOf(z) {
    return (Array.isArray(z.points) ? z.points : []).filter(p => Array.isArray(p) && p.length >= 2);
}
function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [yi, xi] = ring[i], [yj, xj] = ring[j];
        if (((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
}
function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return `rgba(25,118,210,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function baseMap(elId) {
    // Яндекс рендерит тайлы в EPSG:3395 — иначе маркеры разъезжаются с подложкой;
    // OSM — стандартный EPSG:3857 (дефолт Leaflet).
    const crs = CFG.provider === "yandex" ? L.CRS.EPSG3395 : L.CRS.EPSG3857;
    const map = L.map(elId, { center: MOSCOW, zoom: 11, minZoom: 3, maxZoom: 19, zoomSnap: 0, crs });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: CFG.attribution }).addTo(map);
    map.attributionControl.setPrefix(false);
    return map;
}

// ─── менеджер зон (общий для обеих карт) ────────────────────────────────────
function makeZones(map, mapKey, listEl, opts) {
    opts = opts || {};
    const layer = L.layerGroup().addTo(map);
    let cache = [];
    let draft = null, editing = null;

    function redraw() {
        layer.clearLayers();
        for (const z of cache) {
            const ring = ringOf(z);
            if (ring.length === 0) continue;
            if (ring.length >= 3) {
                L.polygon(ring, { color: z.color, fillColor: z.color, fillOpacity: 0.18, weight: 2 })
                    .bindTooltip(`${z.name}${z.role ? " · " + z.role : ""}`).addTo(layer);
            }
            if (opts.showVertices) {
                for (const [lat, lng] of ring)
                    L.circleMarker([lat, lng], { radius: 4, color: z.color, fillColor: z.color,
                        fillOpacity: 0.9, weight: 1 }).addTo(layer);
            }
        }
    }

    function renderList() {
        if (opts.onCount) opts.onCount(cache.length);
        if (!listEl) return;
        if (cache.length === 0) {
            listEl.innerHTML = '<div class="empty">Зон пока нет.</div>'; return;
        }
        listEl.innerHTML = cache.map(z => `
            <div class="zone" data-id="${z.id}">
                <span class="sw" style="background:${esc(z.color)}"></span>
                <div class="zinfo">
                    <input class="zname" data-f="name" value="${esc(z.name)}" />
                    <input class="zrole" data-f="role" value="${esc(z.role || "")}" placeholder="подпись" />
                </div>
                <input class="zcolor" data-f="color" type="color" value="${esc(z.color)}" />
                <div class="zact">
                    <button data-a="zoom" type="button" title="показать">⊙</button>
                    <button data-a="del" type="button" title="удалить">🗑</button>
                </div>
            </div>`).join("");
        listEl.querySelectorAll(".zone").forEach(row => {
            const id = parseInt(row.dataset.id, 10);
            row.querySelectorAll("input[data-f]").forEach(inp =>
                inp.addEventListener("change", () => saveField(id, inp.dataset.f, inp.value)));
            row.querySelector('[data-a="zoom"]').addEventListener("click", () => zoomTo(id));
            row.querySelector('[data-a="del"]').addEventListener("click", () => del(id));
        });
    }

    async function load() {
        try { cache = await jget(`/api/${mapKey}/zones`); }
        catch (e) { toast("Не удалось загрузить зоны: " + e.message, "err"); cache = []; }
        redraw(); renderList();
        if (opts.onChange) opts.onChange();
    }
    async function saveField(id, f, v) {
        const body = {}; body[f] = (f === "role") ? (v.trim() || null) : v.trim();
        try {
            const u = await jsend(`/api/${mapKey}/zones/${id}`, "PATCH", body);
            const i = cache.findIndex(z => z.id === id); if (i !== -1) cache[i] = u;
            redraw();
        } catch (e) { toast("Не сохранено: " + e.message, "err"); }
    }
    async function del(id) {
        const z = cache.find(z => z.id === id);
        if (!z || !confirm(`Удалить зону «${z.name}»?`)) return;
        try { await jsend(`/api/${mapKey}/zones/${id}`, "DELETE");
            cache = cache.filter(z => z.id !== id); redraw(); renderList();
            if (opts.onChange) opts.onChange();
        } catch (e) { toast("Не удалось удалить: " + e.message, "err"); }
    }
    async function clearAll() {
        if (cache.length === 0) return;
        if (!confirm("Удалить ВСЕ зоны этой карты?")) return;
        try { await jsend(`/api/${mapKey}/zones`, "DELETE"); cache = []; redraw(); renderList();
            if (opts.onChange) opts.onChange();
        } catch (e) { toast("Не удалось очистить: " + e.message, "err"); }
    }
    function bounds() {
        const all = [];
        for (const z of cache) for (const p of ringOf(z)) all.push(p);
        return all.length ? L.latLngBounds(all) : null;
    }
    function fit() {
        const b = bounds();
        if (b) map.fitBounds(b, { padding: [40, 40], maxZoom: 18 });
        else toast("Зон пока нет");
    }
    function zoomTo(id) {
        const z = cache.find(z => z.id === id); const ring = z ? ringOf(z) : [];
        if (!ring.length) return;
        if (ring.length === 1) map.setView(ring[0], 17);
        else map.fitBounds(L.latLngBounds(ring), { padding: [40, 40], maxZoom: 18 });
    }

    // рисование зоны кликами
    function enterDraft() {
        exitDraft();
        draft = { pts: [], line: L.polyline([], { color: "#1976d2", weight: 2, dashArray: "4 4" }).addTo(map) };
        if (opts.toolbar) opts.toolbar(true);
        map.on("click", onClick); map.on("dblclick", onFinish); map.doubleClickZoom.disable();
    }
    function exitDraft() {
        if (draft && draft.line) map.removeLayer(draft.line);
        draft = null; editing = null;
        map.off("click", onClick); map.off("dblclick", onFinish); map.doubleClickZoom.enable();
        if (opts.toolbar) opts.toolbar(false);
    }
    function onClick(e) { if (!draft) return; draft.pts.push([e.latlng.lat, e.latlng.lng]); draft.line.setLatLngs(draft.pts); }
    async function onFinish() {
        if (!draft || draft.pts.length < 3) { toast("Нужно минимум 3 точки", "err"); return; }
        const pts = draft.pts.slice();
        const name = prompt("Название зоны:", `Зона ${cache.length + 1}`);
        if (!name) { exitDraft(); return; }
        try {
            const z = await jsend(`/api/${mapKey}/zones`, "POST",
                { name, role: "", color: "#1976d2", points: pts, sort_order: cache.length });
            cache.push(z); exitDraft(); redraw(); renderList();
            if (opts.onChange) opts.onChange();
        } catch (e) { toast("Не сохранено: " + e.message, "err"); }
    }

    return {
        get cache() { return cache; }, set cache(v) { cache = v; },
        load, redraw, renderList, clearAll, bounds, fit, zoomTo, enterDraft, exitDraft, onFinish,
    };
}

// ─── геокодер-выпадашка ─────────────────────────────────────────────────────
async function geocodePick(q, anchor, onPick) {
    let res;
    try { res = await jget(`/api/geocode?q=${encodeURIComponent(q)}`); }
    catch (e) { toast("Геокодер недоступен: " + e.message, "err"); return; }
    const items = (res.results || []);
    if (!items.length) { toast("Ничего не найдено", "err"); return; }
    if (items.length === 1) { onPick(items[0]); return; }
    document.getElementById("gc-dd")?.remove();
    const rect = anchor.getBoundingClientRect();
    const dd = document.createElement("div"); dd.id = "gc-dd"; dd.className = "gc-dd";
    dd.style.cssText = `top:${rect.bottom + 2}px;left:${rect.left}px;width:${Math.max(rect.width, 280)}px`;
    dd.innerHTML = items.map((r, i) =>
        `<div class="gc-row" data-i="${i}"><div class="gc-t">${esc(r.text)}</div>
         <div class="gc-c">${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}</div></div>`).join("");
    document.body.appendChild(dd);
    const close = () => { dd.remove(); document.removeEventListener("click", out, true); };
    const out = e => { if (!dd.contains(e.target) && e.target !== anchor) close(); };
    dd.querySelectorAll(".gc-row").forEach(row =>
        row.addEventListener("click", () => { const i = +row.dataset.i; close(); onPick(items[i]); }));
    setTimeout(() => document.addEventListener("click", out, true), 0);
}

// ─── подсказки при наборе (Яндекс Suggest; на OSM пусто) ────────────────────
function attachSuggest(input, onPick) {
    let timer = null;
    input.addEventListener("input", () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 2) { document.getElementById("gc-dd")?.remove(); return; }
        timer = setTimeout(async () => {
            let res; try { res = await jget(`/api/suggest?q=${encodeURIComponent(q)}`); } catch (_) { return; }
            const items = res.results || [];
            if (!items.length) { document.getElementById("gc-dd")?.remove(); return; }
            showSuggest(input, items, onPick);
        }, 250);
    });
    input.addEventListener("blur", () => setTimeout(() => document.getElementById("gc-dd")?.remove(), 150));
}
function showSuggest(input, items, onPick) {
    document.getElementById("gc-dd")?.remove();
    const rect = input.getBoundingClientRect();
    const dd = document.createElement("div"); dd.id = "gc-dd"; dd.className = "gc-dd";
    dd.style.cssText = `top:${rect.bottom + 2}px;left:${rect.left}px;width:${Math.max(rect.width, 280)}px`;
    dd.innerHTML = items.map((it, i) =>
        `<div class="gc-row" data-i="${i}"><div class="gc-t">${esc(it.title)}</div>` +
        (it.subtitle ? `<div class="gc-c">${esc(it.subtitle)}</div>` : "") + `</div>`).join("");
    document.body.appendChild(dd);
    dd.querySelectorAll(".gc-row").forEach(row => row.addEventListener("mousedown", async e => {
        e.preventDefault(); const it = items[+row.dataset.i];
        document.getElementById("gc-dd")?.remove();
        input.value = it.title;
        if (it.lat != null && it.lng != null) { onPick({ text: it.title, lat: it.lat, lng: it.lng }); return; }
        try { const r = await jget(`/api/geocode?q=${encodeURIComponent(it.title)}`);
            if (r.results && r.results.length) onPick(r.results[0]); } catch (_) {}
    }));
}

// ════════════════════════ КАРТА ОД ════════════════════════════════════════
const OD = (function () {
    let map, zones, baseMarker, targetMarker, routeLayer;
    let baseLat = null, baseLng = null, tgtLat = null, tgtLng = null;
    let inited = false;

    function shell(root) {
        root.innerHTML = `
        <aside class="side">
            <div class="sec"><h4>Базовая точка</h4>
                <input id="od-base" type="text" placeholder="Адрес штаба ОД" />
                <div class="row"><button id="od-base-find" class="btn">Найти</button>
                    <button id="od-base-save" class="btn ok">Сохранить базу</button></div>
                <small id="od-base-hint" class="hint"></small></div>
            <div class="sec"><h4>Адрес и маршрут</h4>
                <input id="od-tgt" type="text" placeholder="Адрес объекта" />
                <div class="row"><button id="od-tgt-find" class="btn">Найти</button>
                    <button id="od-route" class="btn fill">Маршрут от базы</button></div>
                <small id="od-route-info" class="hint"></small>
                <small id="od-zone-hit" class="hint"></small></div>
            <div class="sec"><h4>Зоны ответственности (<span id="od-count">0</span>)</h4>
                <div id="od-zones"></div>
                <div class="row"><button id="od-new" class="btn">+ Новая зона</button>
                    <button id="od-fit" class="btn">Показать все</button></div></div>
        </aside>
        <div class="stage"><div id="od-map" class="canvas"></div>
            <div id="od-tb" class="toolbar hidden"><span>Обведите контур. Двойной клик — готово.</span>
                <button id="od-finish" class="btn ok">Готово</button>
                <button id="od-cancel" class="btn">Отмена</button></div></div>`;
    }

    function placeBase() {
        if (baseMarker) map.removeLayer(baseMarker);
        if (baseLat == null) return;
        baseMarker = L.marker([baseLat, baseLng]).bindPopup("База ОД").addTo(map);
    }
    function showHits(lat, lng) {
        const el = document.getElementById("od-zone-hit");
        const hits = zones.cache.filter(z => { const r = ringOf(z); return r.length >= 3 && pointInRing(lat, lng, r); });
        if (!hits.length) { el.textContent = "Адрес не попадает ни в одну зону."; return; }
        el.innerHTML = "Зоны: " + hits.map(z =>
            `<span class="chip" style="background:${esc(z.color)}22;color:${esc(z.color)}">${esc(z.name)}</span>`).join(" ");
    }

    async function init() {
        const root = document.getElementById("od-root");
        shell(root);
        map = baseMap("od-map");
        zones = makeZones(map, "od", document.getElementById("od-zones"),
            { onCount: n => { document.getElementById("od-count").textContent = n; },
              toolbar: on => document.getElementById("od-tb").classList.toggle("hidden", !on) });
        // settings
        try {
            const s = await jget("/api/od/settings");
            document.getElementById("od-base").value = s.base_address || "";
            if (s.base_lat != null) { baseLat = s.base_lat; baseLng = s.base_lng; placeBase();
                document.getElementById("od-base-hint").textContent = `Сохранено: ${s.base_lat.toFixed(5)}, ${s.base_lng.toFixed(5)}`; }
        } catch (_) {}
        await zones.load();

        const baseInput = document.getElementById("od-base");
        const tgtInput = document.getElementById("od-tgt");
        function pickBase(r) {
            baseLat = r.lat; baseLng = r.lng; baseInput.value = r.text;
            document.getElementById("od-base-hint").textContent = `Найдено: ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)} (нажмите «Сохранить базу»)`;
            placeBase(); map.setView([r.lat, r.lng], 15);
        }
        function pickTgt(r) {
            tgtLat = r.lat; tgtLng = r.lng; tgtInput.value = r.text;
            if (targetMarker) map.removeLayer(targetMarker);
            targetMarker = L.marker([r.lat, r.lng]).bindPopup(r.text).addTo(map);
            map.setView([r.lat, r.lng], 15); showHits(r.lat, r.lng);
        }
        document.getElementById("od-base-find").onclick = () => {
            const q = baseInput.value.trim(); if (q) geocodePick(q, baseInput, pickBase);
        };
        document.getElementById("od-base-save").onclick = async () => {
            if (baseLat == null) { toast("Сначала найдите адрес", "err"); return; }
            try { await jsend("/api/od/settings", "PUT",
                { base_address: document.getElementById("od-base").value.trim(), base_lat: baseLat, base_lng: baseLng });
                document.getElementById("od-base-hint").textContent = "База сохранена."; }
            catch (e) { toast("Не сохранено: " + e.message, "err"); }
        };
        document.getElementById("od-tgt-find").onclick = () => {
            const q = tgtInput.value.trim(); if (q) geocodePick(q, tgtInput, pickTgt);
        };
        if (CFG.suggest) { attachSuggest(baseInput, pickBase); attachSuggest(tgtInput, pickTgt); }
        document.getElementById("od-route").onclick = async () => {
            if (baseLat == null) { toast("Задайте базовую точку", "err"); return; }
            if (tgtLat == null) { toast("Найдите адрес объекта", "err"); return; }
            try {
                const r = await jsend("/api/route", "POST", { src: [baseLat, baseLng], dst: [tgtLat, tgtLng] });
                if (routeLayer) map.removeLayer(routeLayer);
                routeLayer = L.geoJSON(r.geometry, { style: { color: "#1976d2", weight: 4 } }).addTo(map);
                map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
                document.getElementById("od-route-info").textContent =
                    `${(r.distance_m / 1000).toFixed(1)} км · ≈ ${Math.round(r.duration_s / 60)} мин`;
            } catch (e) { toast("Маршрут не построен: " + e.message, "err"); }
        };
        document.getElementById("od-new").onclick = () => zones.enterDraft();
        document.getElementById("od-fit").onclick = () => zones.fit();
        document.getElementById("od-finish").onclick = () => zones.onFinish();
        document.getElementById("od-cancel").onclick = () => zones.exitDraft();
        document.getElementById("od-base").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); document.getElementById("od-base-find").click(); } });
        document.getElementById("od-tgt").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); document.getElementById("od-tgt-find").click(); } });
    }
    return {
        show() { if (!inited) { init(); inited = true; } else if (map) map.invalidateSize(); },
    };
})();

// ════════════════════════ КАРТА ЗОН ════════════════════════════════════════
const ZONE = (function () {
    let map, zones, inited = false;
    let nudgeLat = 0, nudgeLng = 0, nudgeTimer = null;
    const PAPER = { a4: [210, 297], a3: [297, 420] };
    const HINT = "WGS-84: колонки «Зона», «Широта», «Долгота». МСК-77: колонки «X», «Y» (м) — пересчёт в WGS-84.";

    function shell(root) {
        root.innerHTML = `
        <aside class="side">
            <div class="sec"><h4>Импорт координат</h4>
                <input id="zm-file" type="file" style="display:none" />
                <label class="fld">Система координат
                    <select id="zm-cs">
                        <option value="wgs84" selected>WGS-84 (широта / долгота)</option>
                        <option value="msk77">МСК-77, зона 1 (основной)</option>
                        <option value="msk77_b">МСК-77, зона 1 (вариант ключей 2)</option>
                        <option value="msk77_t">МСК-77, зона 1 (только сдвиг)</option>
                    </select></label>
                <div class="row"><button id="zm-xlsx" class="btn fill">📥 Excel</button>
                    <button id="zm-docx" class="btn fill">📄 Word</button>
                    <button id="zm-tmpl" class="btn">Шаблон</button></div>
                <label class="rad"><input type="radio" name="zm-mode" value="replace" checked /> Заменить зоны</label>
                <label class="rad"><input type="radio" name="zm-mode" value="append" /> Добавить</label>
                <small id="zm-hint" class="hint">${HINT}</small></div>
            <div class="sec"><h4>Зоны (<span id="zm-count">0</span>)</h4>
                <div id="zm-zones"></div>
                <div class="row"><button id="zm-new" class="btn">+ Нарисовать</button>
                    <button id="zm-fit" class="btn">Показать все</button>
                    <button id="zm-clear" class="btn">Очистить</button></div></div>
            <div class="sec"><h4>Масштаб и экспорт</h4>
                <div class="grid2">
                    <label>Масштаб 1:<input id="zm-scale" type="number" min="100" max="100000" step="100" value="2000" /></label>
                    <label>DPI<select id="zm-dpi"><option>96</option><option selected>150</option><option>200</option><option>300</option></select></label>
                    <label>Лист<select id="zm-paper"><option value="a4" selected>A4</option><option value="a3">A3</option></select></label>
                    <label>Ориент.<select id="zm-orient"><option value="landscape" selected>Альбом.</option><option value="portrait">Книж.</option></select></label>
                </div>
                <div class="row"><button id="zm-jpg" class="btn ok">⬇ JPG</button>
                    <button id="zm-pdf" class="btn ok">⬇ PDF</button></div>
                <small class="hint">Карта строится по центру вида в выбранном масштабе.</small></div>
            <div class="sec"><h4>Подвижка контура</h4>
                <div class="nudge">
                    <label class="fld" style="margin:0">Шаг, м<input id="zm-step" type="number" min="0.1" step="0.5" value="2" /></label>
                    <div class="pad">
                        <button data-d="n" class="btn">↑</button>
                        <div class="prow"><button data-d="w" class="btn">←</button>
                            <button id="zm-reset" class="btn">⟲</button>
                            <button data-d="e" class="btn">→</button></div>
                        <button data-d="s" class="btn">↓</button></div></div>
                <small id="zm-nudge-info" class="hint">Двигает все зоны для точной привязки.</small></div>
            <div class="sec"><h4>Таблица координат</h4><div id="zm-table" class="ctab"></div></div>
        </aside>
        <div class="stage"><div id="zm-map" class="canvas"></div>
            <div id="zm-tb" class="toolbar hidden"><span>Обведите контур. Двойной клик — готово.</span>
                <button id="zm-finish" class="btn ok">Готово</button>
                <button id="zm-cancel" class="btn">Отмена</button></div>
            <div id="zm-readout" class="readout"></div></div>`;
    }

    function mppScreen() {
        const a = map.containerPointToLatLng([0, 0]), b = map.containerPointToLatLng([100, 0]);
        return map.distance(a, b) / 100;
    }
    function updateReadout() {
        const el = document.getElementById("zm-readout"); if (!el) return;
        el.textContent = `≈ 1:${Math.round(mppScreen() * 96 / 0.0254).toLocaleString("ru-RU")}`;
    }

    function fmtNum(v) { return typeof v !== "number" ? String(v) : (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)); }
    function renderTable() {
        const box = document.getElementById("zm-table"); if (!box) return;
        const zs = zones.cache.filter(z => ringOf(z).length);
        if (!zs.length) { box.innerHTML = '<div class="empty">Загрузите координаты.</div>'; return; }
        const isMsk = zs.some(z => (z.coord_system || "").startsWith("msk"));
        const hdr = isMsk ? "X / Y (исходн.)" : "Ш / Д (исходн.)";
        let rows = "";
        for (const z of zs) {
            const pts = z.points || [], src = z.src_points || [];
            if (zs.length > 1) rows += `<tr class="zt-zone"><td colspan="3">${esc(z.name)}</td></tr>`;
            pts.forEach((p, i) => {
                const s = src[i];
                const st = (Array.isArray(s) && s.length >= 2) ? `${fmtNum(s[0])} / ${fmtNum(s[1])}` : "—";
                rows += `<tr><td>${i + 1}</td><td>${st}</td><td>${(+p[0]).toFixed(6)} / ${(+p[1]).toFixed(6)}</td></tr>`;
            });
        }
        box.innerHTML = `<table class="zt"><thead><tr><th>№</th><th>${hdr}</th><th>WGS-84 (Ш/Д)</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function applyShift(dLat, dLng) {
        for (const z of zones.cache) {
            if (!Array.isArray(z.points)) continue;
            z.points = z.points.map(([la, ln]) => [+(la + dLat).toFixed(7), +(ln + dLng).toFixed(7)]);
        }
        zones.redraw(); renderTable(); scheduleNudge();
    }
    function nudge(dir) {
        if (!zones.cache.length) { toast("Сначала загрузите координаты"); return; }
        const step = Math.max(0.1, parseFloat(document.getElementById("zm-step").value) || 2);
        const b = zones.bounds(); const lat0 = (b ? b.getCenter().lat : map.getCenter().lat) || 55.75;
        const dLat = step / 111320, dLng = step / (111320 * Math.cos(lat0 * Math.PI / 180));
        let mLat = 0, mLng = 0;
        if (dir === "n") mLat = dLat; else if (dir === "s") mLat = -dLat;
        else if (dir === "e") mLng = dLng; else if (dir === "w") mLng = -dLng;
        applyShift(mLat, mLng); nudgeLat += mLat; nudgeLng += mLng; updateNudgeInfo();
    }
    function nudgeReset() {
        if (Math.abs(nudgeLat) < 1e-12 && Math.abs(nudgeLng) < 1e-12) return;
        applyShift(-nudgeLat, -nudgeLng); nudgeLat = 0; nudgeLng = 0; updateNudgeInfo();
    }
    function updateNudgeInfo() {
        const el = document.getElementById("zm-nudge-info"); if (!el) return;
        const b = zones.bounds(); const lat0 = (b ? b.getCenter().lat : 55.75) || 55.75;
        const mN = Math.round(nudgeLat * 111320), mE = Math.round(nudgeLng * 111320 * Math.cos(lat0 * Math.PI / 180));
        el.textContent = (!mN && !mE) ? "Двигает все зоны для точной привязки."
            : `Сдвиг от импорта: ${mN >= 0 ? "+" : ""}${mN} м к С, ${mE >= 0 ? "+" : ""}${mE} м к В`;
    }
    function scheduleNudge() { clearTimeout(nudgeTimer); nudgeTimer = setTimeout(persistNudge, 600); }
    async function persistNudge() {
        for (const z of zones.cache.slice()) {
            try { await jsend(`/api/zone/zones/${z.id}`, "PATCH", { points: z.points }); }
            catch (e) { toast("Подвижка не сохранена: " + e.message, "err"); break; }
        }
    }

    async function onFile(file) {
        if (!file) return;
        const mode = document.querySelector('input[name="zm-mode"]:checked')?.value || "replace";
        const cs = document.getElementById("zm-cs").value;
        const hint = document.getElementById("zm-hint"); hint.textContent = "Загрузка и разбор…";
        const fd = new FormData(); fd.append("file", file); fd.append("mode", mode); fd.append("coord_system", cs);
        try {
            const res = await jupload("/api/zone/import", fd);
            await zones.load(); zones.fit();
            const sk = res.rows_skipped ? `, пропущено ${res.rows_skipped}` : "";
            hint.textContent = `Готово: зон ${res.zones_created}, точек ${res.points_total}${sk}${cs.startsWith("msk") ? " (МСК→WGS-84)" : ""}.`;
            toast(`Импортировано зон: ${res.zones_created}`, "ok");
        } catch (e) { hint.textContent = HINT; toast("Импорт не выполнен: " + e.message, "err"); }
    }
    function applyScalePreset() {
        const scale = Math.max(100, parseInt(document.getElementById("zm-scale").value, 10) || 2000);
        const c = map.getCenter(); const mpp = scale * 0.0254 / 96;
        const ground = 2 * Math.PI * 6378137 * Math.cos(c.lat * Math.PI / 180);
        const z = Math.log2(ground / (256 * mpp));
        map.setView(c, Math.min(19, Math.max(3, z)));
    }

    // экспорт со склейкой тайлов
    function mppAtZoom(crs, center, z) {
        const p1 = crs.latLngToPoint(center, z);
        const c2 = L.latLng(center.lat + 0.002, center.lng);
        const p2 = crs.latLngToPoint(c2, z);
        return map.distance(center, c2) / (Math.abs(p2.y - p1.y) || 1e-9);
    }
    function loadTile(z, x, y) {
        return new Promise(res => {
            const img = new Image(); img.crossOrigin = "anonymous";
            img.onload = () => res(img); img.onerror = () => res(null);
            img.src = `/tiles/${z}/${x}/${y}.png`;
        });
    }
    async function renderCanvas({ scale, dpi, paper, orient }) {
        const crs = map.options.crs;
        let [pw, ph] = PAPER[paper] || PAPER.a4; if (orient === "portrait") [pw, ph] = [Math.min(pw, ph), Math.max(pw, ph)]; else [pw, ph] = [Math.max(pw, ph), Math.min(pw, ph)];
        const outW = Math.round(pw / 25.4 * dpi), outH = Math.round(ph / 25.4 * dpi);
        const mppTarget = scale * 0.0254 / dpi;
        const center = map.getCenter();
        let z = 19; for (let zz = 3; zz <= 19; zz++) { if (mppAtZoom(crs, center, zz) <= mppTarget) { z = zz; break; } }
        const mppZ = mppAtZoom(crs, center, z);
        const rW = Math.max(1, Math.round(outW * mppTarget / mppZ)), rH = Math.max(1, Math.round(outH * mppTarget / mppZ));
        const cp = crs.latLngToPoint(center, z), oX = cp.x - rW / 2, oY = cp.y - rH / 2;
        const cv = document.createElement("canvas"); cv.width = rW; cv.height = rH;
        const ctx = cv.getContext("2d"); ctx.fillStyle = "#e9e6e0"; ctx.fillRect(0, 0, rW, rH);
        const T = 256, maxIdx = 2 ** z;
        const xMin = Math.floor(oX / T), xMax = Math.floor((oX + rW) / T), yMin = Math.floor(oY / T), yMax = Math.floor((oY + rH) / T);
        if ((xMax - xMin + 1) * (yMax - yMin + 1) > 600) throw new Error("Слишком большая область — уменьшите DPI/масштаб");
        const jobs = [];
        for (let tx = xMin; tx <= xMax; tx++) for (let ty = yMin; ty <= yMax; ty++) {
            if (tx < 0 || ty < 0 || tx >= maxIdx || ty >= maxIdx) continue;
            jobs.push(loadTile(z, tx, ty).then(img => { if (img) ctx.drawImage(img, Math.round(tx * T - oX), Math.round(ty * T - oY)); }));
        }
        await Promise.all(jobs);
        const proj = ([lat, lng]) => { const p = crs.latLngToPoint(L.latLng(lat, lng), z); return [p.x - oX, p.y - oY]; };
        for (const z2 of zones.cache) {
            const ring = ringOf(z2); if (!ring.length) continue;
            const pr = ring.map(proj);
            if (pr.length >= 3) {
                ctx.beginPath(); pr.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
                ctx.fillStyle = hexA(z2.color, 0.18); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = z2.color; ctx.stroke();
            }
            ctx.fillStyle = z2.color;
            for (const [x, y] of pr) { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }
        }
        const out = document.createElement("canvas"); out.width = outW; out.height = outH;
        const octx = out.getContext("2d"); octx.imageSmoothingQuality = "high";
        octx.drawImage(cv, 0, 0, rW, rH, 0, 0, outW, outH);
        decorate(octx, { outW, outH, dpi, mppTarget, scale });
        return { canvas: out, pw, ph };
    }
    function decorate(ctx, { outW, outH, dpi, mppTarget, scale }) {
        const pad = Math.round(dpi * 0.12), fs = Math.max(11, Math.round(dpi * 0.085));
        ctx.font = `${fs}px sans-serif`; ctx.textBaseline = "middle";
        const NICE = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
        let m = NICE[0]; for (const n of NICE) if (n / mppTarget <= outW * 0.26) m = n;
        const barPx = m / mppTarget, bx = pad, by = outH - pad - fs, bh = Math.max(5, Math.round(dpi * 0.04));
        ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.fillRect(bx - 8, by - fs - 8, barPx + pad + 16, fs + bh + 26);
        ctx.fillStyle = "#000"; ctx.fillRect(bx, by, barPx, bh); ctx.fillStyle = "#fff"; ctx.fillRect(bx + barPx / 2, by, barPx / 2, bh);
        ctx.strokeStyle = "#000"; ctx.lineWidth = 1; ctx.strokeRect(bx, by, barPx, bh);
        ctx.fillStyle = "#000"; ctx.textAlign = "left";
        ctx.fillText("0", bx - 2, by + bh + fs * 0.7); ctx.fillText(m >= 1000 ? m / 1000 + " км" : m + " м", bx + barPx - fs, by + bh + fs * 0.7);
        ctx.font = `bold ${fs}px sans-serif`; ctx.fillText(`Масштаб 1:${scale}`, bx, by - fs * 0.6);
        if (zones.cache.length) {
            ctx.font = `${fs}px sans-serif`; const items = zones.cache.slice(0, 14), lh = fs + 8;
            let mt = 0; for (const z of items) mt = Math.max(mt, ctx.measureText(z.name).width);
            const lw = mt + fs * 2.4 + pad, lx = outW - lw - pad, ly = pad, total = items.length * lh + pad;
            ctx.fillStyle = "rgba(255,255,255,0.88)"; ctx.fillRect(lx - 6, ly - 6, lw + 12, total + 12);
            ctx.strokeStyle = "#888"; ctx.strokeRect(lx - 6, ly - 6, lw + 12, total + 12); ctx.textAlign = "left";
            items.forEach((z, i) => { const yy = ly + pad / 2 + i * lh + lh / 2;
                ctx.fillStyle = z.color; ctx.fillRect(lx, yy - fs / 2, fs, fs);
                ctx.strokeStyle = "#333"; ctx.strokeRect(lx, yy - fs / 2, fs, fs);
                ctx.fillStyle = "#000"; ctx.fillText(z.name, lx + fs * 1.5, yy); });
        }
        ctx.font = `${Math.round(fs * 0.8)}px sans-serif`; ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.textAlign = "right";
        ctx.fillText(CFG.attribution, outW - pad, outH - pad / 2);
    }
    async function doExport(fmt) {
        const ids = ["zm-jpg", "zm-pdf"]; ids.forEach(i => document.getElementById(i).disabled = true);
        try {
            const scale = Math.max(100, parseInt(document.getElementById("zm-scale").value, 10) || 2000);
            const dpi = parseInt(document.getElementById("zm-dpi").value, 10) || 150;
            const paper = document.getElementById("zm-paper").value, orient = document.getElementById("zm-orient").value;
            const { canvas, pw, ph } = await renderCanvas({ scale, dpi, paper, orient });
            const url = canvas.toDataURL("image/jpeg", 0.92), fname = `karta_1-${scale}`;
            if (fmt === "jpg") download(url, fname + ".jpg");
            else { const { jsPDF } = window.jspdf; const pdf = new jsPDF({ unit: "mm", format: paper, orientation: orient });
                pdf.addImage(url, "JPEG", 0, 0, pw, ph); pdf.save(fname + ".pdf"); }
        } catch (e) { toast("Экспорт не выполнен: " + e.message, "err"); }
        finally { ids.forEach(i => document.getElementById(i).disabled = false); }
    }

    async function init() {
        shell(document.getElementById("zone-root"));
        map = baseMap("zm-map");
        map.on("zoomend move", updateReadout); updateReadout();
        zones = makeZones(map, "zone", document.getElementById("zm-zones"),
            { showVertices: true, onCount: n => { document.getElementById("zm-count").textContent = n; },
              onChange: () => { renderTable(); nudgeLat = 0; nudgeLng = 0; updateNudgeInfo(); },
              toolbar: on => document.getElementById("zm-tb").classList.toggle("hidden", !on) });
        await zones.load();
        if (zones.cache.length) zones.fit();

        const file = document.getElementById("zm-file");
        document.getElementById("zm-xlsx").onclick = () => { file.accept = ".xlsx,.xlsm"; file.click(); };
        document.getElementById("zm-docx").onclick = () => { file.accept = ".docx"; file.click(); };
        file.addEventListener("change", e => { onFile(e.target.files?.[0]); e.target.value = ""; });
        document.getElementById("zm-tmpl").onclick = () => download("/api/zone/template.xlsx", "zone_template.xlsx");
        document.getElementById("zm-new").onclick = () => zones.enterDraft();
        document.getElementById("zm-fit").onclick = () => zones.fit();
        document.getElementById("zm-clear").onclick = () => zones.clearAll();
        document.getElementById("zm-finish").onclick = () => zones.onFinish();
        document.getElementById("zm-cancel").onclick = () => zones.exitDraft();
        document.getElementById("zm-jpg").onclick = () => doExport("jpg");
        document.getElementById("zm-pdf").onclick = () => doExport("pdf");
        document.getElementById("zm-reset").onclick = nudgeReset;
        document.querySelectorAll(".pad [data-d]").forEach(b => b.onclick = () => nudge(b.dataset.d));
    }
    return { show() { if (!inited) { init(); inited = true; } else if (map) { map.invalidateSize(); updateReadout(); } } };
})();

// ─── вкладки ────────────────────────────────────────────────────────────────
function switchTab(which) {
    const od = which === "od";
    document.getElementById("od-root").classList.toggle("hidden", !od);
    document.getElementById("zone-root").classList.toggle("hidden", od);
    document.getElementById("tab-od").classList.toggle("active", od);
    document.getElementById("tab-zone").classList.toggle("active", !od);
    (od ? OD : ZONE).show();
}
document.getElementById("tab-od").onclick = () => switchTab("od");
document.getElementById("tab-zone").onclick = () => switchTab("zone");

// старт: сначала узнаём провайдера карт (Яндекс/OSM) — от него зависит проекция,
// затем инициализируем карты.
(async function boot() {
    try { CFG = await jget("/api/config"); } catch (_) {}
    switchTab("od");
})();

})();
