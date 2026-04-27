// static/js/notifications.js
//
// Центр уведомлений — отображает персональную ленту пользователя.
//
// Две точки монтирования:
//   1. Правая колонка на дашборде (постоянно видно — #dashboard-notif-center)
//   2. Header-кнопка-колокольчик у управлений (у них нет дашборда) —
//      #notif-header-btn + dropdown #notif-header-dropdown
//
// Realtime: при WS-сообщении {action:"notification_new"} (push_to_user)
// перезагружает ленту. WS-identify посылается автоматически после логина
// в auth.js.

import { api } from './api.js';

// ─── Иконки для разных kind'ов ─────────────────────────────────────────────
const KIND_ICONS = {
    slot_filled: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    slot_changed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    duty_assigned: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    task_assigned: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    person_applied: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 11v6M20 14h6"/></svg>`,
    permissions_changed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    system: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8"  x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
};

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(iso) {
    // Компактное "N минут назад" — для ленты удобнее абсолютного времени
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 45)       return 'только что';
    if (diff < 60 * 2)   return 'минуту назад';
    if (diff < 60 * 60)  return `${Math.floor(diff / 60)} мин назад`;
    if (diff < 60 * 60 * 2) return 'час назад';
    if (diff < 60 * 60 * 24) return `${Math.floor(diff / 3600)} ч назад`;
    if (diff < 60 * 60 * 48) return 'вчера';
    if (diff < 60 * 60 * 24 * 7) return `${Math.floor(diff / 86400)} дн назад`;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// ─── Кеш стейта (чтобы не дёргать API чаще раза в 3 сек) ──────────────────
let _items        = [];
let _unread       = 0;
let _lastLoadedAt = 0;
let _refreshPromise = null;

const REFRESH_THROTTLE_MS = 3000;

async function _fetchNotifications(force = false) {
    if (!force && Date.now() - _lastLoadedAt < REFRESH_THROTTLE_MS) return;
    if (_refreshPromise) return _refreshPromise;

    _refreshPromise = (async () => {
        try {
            const res = await api.get('/notifications?limit=50');
            _items  = res.items  || [];
            _unread = res.unread || 0;
            _lastLoadedAt = Date.now();
            _renderAll();
        } catch (e) {
            // Тихий фейл — уведомления не критичны. Логируем.
            console.warn('notifications fetch:', e);
        } finally {
            _refreshPromise = null;
        }
    })();
    return _refreshPromise;
}

// ─── Рендер одной записи ──────────────────────────────────────────────────
function _renderItem(n) {
    const icon = KIND_ICONS[n.kind] || KIND_ICONS.system;
    const unreadClass = n.is_read ? 'read' : 'unread';
    return `
        <div class="notif-item ${unreadClass}" data-id="${n.id}"
             ${n.link ? `data-link="${esc(n.link)}"` : ''}>
            <div class="notif-item__icon notif-item__icon--${esc(n.kind)}">${icon}</div>
            <div class="notif-item__body">
                <div class="notif-item__title">${esc(n.title)}</div>
                ${n.body ? `<div class="notif-item__text">${esc(n.body)}</div>` : ''}
                <div class="notif-item__time">${esc(timeAgo(n.created_at))}</div>
            </div>
            <button class="notif-item__close" data-close="${n.id}" title="Удалить" type="button">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6"  y2="18"/>
                    <line x1="6"  y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>
    `;
}

function _renderList(listEl) {
    if (!listEl) return;
    if (_items.length === 0) {
        listEl.innerHTML = `
            <div class="notif-center__empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                <p>Нет новых уведомлений</p>
            </div>`;
        return;
    }
    listEl.innerHTML = _items.map(_renderItem).join('');

    // Делегирование: закрытие + переход по ссылке + отметка прочитанным
    listEl.querySelectorAll('.notif-item').forEach(row => {
        const id = parseInt(row.dataset.id, 10);

        row.addEventListener('click', async (e) => {
            if (e.target.closest('[data-close]')) return;   // закрытие — отдельная логика
            if (!row.classList.contains('read')) {
                await _markRead(id);
            }
            const link = row.dataset.link;
            if (link && link !== 'null') {
                // Если ссылка внутренняя (начинается с /static/) — не перезагружаем,
                // просто переключаем вкладку по hash.
                window.location.href = link;
            }
        });

        const closeBtn = row.querySelector('[data-close]');
        closeBtn?.addEventListener('click', async (e) => {
            e.stopPropagation();
            await _delete(id);
        });
    });
}

function _renderBadges() {
    // Бейдж в dashboard center header
    const dbBadge = document.getElementById('notif-center-badge');
    if (dbBadge) {
        dbBadge.textContent = String(_unread);
        dbBadge.classList.toggle('zero', _unread === 0);
    }

    // Кнопка «Прочитать все» активна только если есть непрочитанные
    const markAllBtn = document.getElementById('notif-center-mark-all');
    if (markAllBtn) markAllBtn.disabled = _unread === 0;

    // Dot в header (колокольчик)
    const hdrDot = document.getElementById('notif-header-dot');
    if (hdrDot) {
        if (_unread > 0) {
            hdrDot.textContent = _unread > 99 ? '99+' : String(_unread);
            hdrDot.classList.remove('hidden');
        } else {
            hdrDot.classList.add('hidden');
        }
    }
}

function _renderAll() {
    _renderList(document.getElementById('notif-center-list'));
    _renderList(document.getElementById('notif-header-list'));
    _renderBadges();
}

// ─── Действия ──────────────────────────────────────────────────────────────
async function _markRead(id) {
    try {
        await api.post(`/notifications/${id}/read`, {});
        const n = _items.find(x => x.id === id);
        if (n) n.is_read = true;
        _unread = Math.max(0, _unread - 1);
        _renderAll();
    } catch (e) { console.warn('mark read:', e); }
}

async function _markAll() {
    try {
        await api.post('/notifications/read-all', {});
        _items = _items.map(n => ({ ...n, is_read: true }));
        _unread = 0;
        _renderAll();
    } catch (e) { console.warn('mark all:', e); }
}

async function _delete(id) {
    try {
        await api.delete(`/notifications/${id}`);
        const n = _items.find(x => x.id === id);
        if (n && !n.is_read) _unread = Math.max(0, _unread - 1);
        _items = _items.filter(x => x.id !== id);
        _renderAll();
    } catch (e) { console.warn('delete notif:', e); }
}

// ─── Публичный API ─────────────────────────────────────────────────────────

export function initNotifications() {
    // Привязка обработчиков один раз при загрузке страницы.
    // Используется в app.js:bindEvents.
    document.getElementById('notif-center-mark-all')
        ?.addEventListener('click', _markAll);

    // Header-колокольчик (если есть на странице): клик — показать dropdown
    const btn = document.getElementById('notif-header-btn');
    const dd  = document.getElementById('notif-header-dropdown');
    if (btn && dd) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            dd.classList.toggle('hidden');
            if (!dd.classList.contains('hidden')) _fetchNotifications(true);
        });
        // Клик вне — закрываем
        document.addEventListener('click', (e) => {
            if (!btn.contains(e.target) && !dd.contains(e.target)) {
                dd.classList.add('hidden');
            }
        });
        // Mark-all внутри dropdown
        document.getElementById('notif-header-mark-all')
            ?.addEventListener('click', _markAll);
    }

    // Периодический poll раз в 60 сек — на случай если WS отвалился.
    // Основной канал доставки всё равно WS (push_to_user в auth.js).
    setInterval(() => _fetchNotifications(false), 60_000);

    // Инициальная загрузка — сразу после login
    _fetchNotifications(true);
}

export function refreshNotifications() {
    // Публичная точка для вызова из WS-обработчика в auth.js:
    // при получении {action:"notification_new"} дёргаем сразу.
    return _fetchNotifications(true);
}

// Экспорт для inline-использования
window._refreshNotifications = refreshNotifications;
