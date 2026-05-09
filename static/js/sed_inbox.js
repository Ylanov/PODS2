// static/js/sed_inbox.js
/**
 * Кнопка «Почта · СЭД» в шапке pods2.
 *
 * Источник данных — снимок дайджеста, который браузерное расширение
 * пользователя POST'ит в /api/v1/sed/snapshot. UI читает /api/v1/sed/snapshot,
 * рисует бейдж с общим количеством непрочитанных и выпадающую панель со
 * списком разделов и заголовков писем. Файлы открываются в новой вкладке —
 * скачивает их браузер пользователя сам, когда тот в МЧС-сети.
 *
 * Видимость кнопки: role === 'admin' || permissions.includes('sed_inbox').
 *
 * Экспорт:
 *   initSedInbox()      — после логина: проверить permission, запросить снимок,
 *                          отрисовать; повесить обработчики.
 *   onSedWsUpdate()     — вызвать при WS-событии sed_snapshot_updated.
 *   stopSedInbox()      — на logout: спрятать, очистить таймеры.
 */

import { api } from './api.js';

const STATE = {
    visible:    false,
    snapshot:   null,   // { taken_at, sections: [...], total }
    pollTimer:  null,
};

const POLL_MS = 60_000;   // каждую минуту перепроверяем снимок (на случай WS-просадки)

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _hasAccess() {
    const u = window.currentUser;
    if (!u) return false;
    if (u.role === 'admin') return true;
    return Array.isArray(u.permissions) && u.permissions.includes('sed_inbox');
}

export async function initSedInbox() {
    const btn  = document.getElementById('sed-header-btn');
    const drop = document.getElementById('sed-header-dropdown');
    if (!btn || !drop) return;

    if (!_hasAccess()) {
        btn.classList.add('hidden');
        drop.classList.add('hidden');
        STATE.visible = false;
        return;
    }

    btn.classList.remove('hidden');
    STATE.visible = true;

    // Тоггл выпадайки. Закрываем при клике вне.
    btn.onclick = (e) => {
        e.stopPropagation();
        drop.classList.toggle('hidden');
        // При открытии — освежаем данные.
        if (!drop.classList.contains('hidden')) _fetchAndRender();
    };
    document.addEventListener('click', (e) => {
        if (drop.classList.contains('hidden')) return;
        if (!drop.contains(e.target) && !btn.contains(e.target)) {
            drop.classList.add('hidden');
        }
    });

    await _fetchAndRender();

    clearInterval(STATE.pollTimer);
    STATE.pollTimer = setInterval(_fetchAndRender, POLL_MS);
}

export function stopSedInbox() {
    clearInterval(STATE.pollTimer);
    STATE.pollTimer = null;
    STATE.snapshot  = null;
    STATE.visible   = false;
    document.getElementById('sed-header-btn')?.classList.add('hidden');
    document.getElementById('sed-header-dropdown')?.classList.add('hidden');
}

export function onSedWsUpdate() {
    if (STATE.visible) _fetchAndRender();
}

async function _fetchAndRender() {
    if (!STATE.visible) return;
    try {
        const snap = await api.get('/sed/snapshot');
        STATE.snapshot = snap;   // null если расширение ещё ничего не прислало
        _renderBadge(snap);
        _renderList(snap);
    } catch (err) {
        // 403 — у юзера сняли permission. Просто прячем кнопку.
        if (err && err.status === 403) {
            stopSedInbox();
            return;
        }
        console.warn('[sed_inbox] snapshot fetch:', err);
    }
}

function _renderBadge(snap) {
    const dot = document.getElementById('sed-header-dot');
    if (!dot) return;
    const total = snap?.total ?? 0;
    if (total > 0) {
        dot.textContent = total > 99 ? '99+' : String(total);
        dot.classList.remove('hidden');
    } else {
        dot.classList.add('hidden');
    }
}

function _renderList(snap) {
    const list = document.getElementById('sed-header-list');
    const meta = document.getElementById('sed-header-meta');
    if (!list) return;

    if (!snap || !snap.sections || snap.sections.length === 0) {
        list.innerHTML = `
            <div style="padding:18px 14px; text-align:center;
                        color:var(--md-on-surface-hint); font-size:0.82rem;">
                Дайджест ещё не пришёл.<br>
                Установите расширение «pods2 СЭД-мост» в браузер,
                откройте sed.mchs.ru и подождите минуту.
            </div>`;
        if (meta) meta.textContent = '';
        return;
    }

    const html = snap.sections.map(_renderSection).join('');
    list.innerHTML = html || `
        <div style="padding:18px 14px; text-align:center;
                    color:var(--md-on-surface-hint); font-size:0.82rem;">
            Сейчас ничего не ждёт рассмотрения.
        </div>`;

    if (meta) {
        const t = snap.taken_at ? new Date(snap.taken_at) : null;
        meta.textContent = t
            ? `Обновлено ${t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
            : '';
    }
}

function _renderSection(section) {
    const count = parseInt(section.count, 10) || 0;
    const items = Array.isArray(section.items) ? section.items : [];
    if (count === 0 && items.length === 0) return '';

    const sedUrl = section.url
        ? `https://sed.mchs.ru${section.url.startsWith('/') ? '' : '/'}${section.url}`
        : 'https://sed.mchs.ru/';

    const itemsHtml = items.slice(0, 8).map(it => _renderItem(it)).join('');

    return `
        <div class="sed-section">
            <div class="sed-section__head">
                <a class="sed-section__title" href="${_esc(sedUrl)}"
                   target="_blank" rel="noopener noreferrer"
                   title="Открыть в СЭД">
                    ${_esc(section.title || section.key || 'Раздел')}
                </a>
                ${count > 0 ? `<span class="sed-section__count">${count}</span>` : ''}
            </div>
            ${itemsHtml ? `<div class="sed-section__items">${itemsHtml}</div>` : ''}
        </div>`;
}

function _renderItem(item) {
    const nodeId  = parseInt(item.node_id, 10);
    const nodeUrl = nodeId ? `https://sed.mchs.ru/node/${nodeId}` : null;

    const filesHtml = (item.files || []).slice(0, 5).map(f => {
        if (!f || !f.url) return '';
        return `
            <a class="sed-file" href="${_esc(f.url)}"
               target="_blank" rel="noopener noreferrer"
               title="Скачать вложение">
                📎 ${_esc(f.name || 'Файл')}
            </a>`;
    }).join('');

    const titleEl = nodeUrl
        ? `<a class="sed-item__title" href="${_esc(nodeUrl)}"
              target="_blank" rel="noopener noreferrer">${_esc(item.title || '—')}</a>`
        : `<span class="sed-item__title">${_esc(item.title || '—')}</span>`;

    return `
        <div class="sed-item">
            ${titleEl}
            ${filesHtml ? `<div class="sed-item__files">${filesHtml}</div>` : ''}
        </div>`;
}
