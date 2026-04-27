// static/js/slot_history.js
//
// Модалка «История изменений слота» — общая для department и admin.
//
// Вызывается:
//   import { openSlotHistory } from './slot_history.js';
//   openSlotHistory(slotId, { canRevert: userIsOwner || isAdmin });
//
// Рисует таймлайн событий (GET /slots/{id}/history), для update-записей
// показывает diff old → new. Кнопка «Откатить» — только для update и
// только если canRevert = true. После отката дёргает API и перезагружает.

import { api } from './api.js';
import { showError } from './ui.js';

// Совпадает с ALL_PERMISSIONS в admin.js — но мы не импортируем чтобы
// избежать циклических зависимостей. Нужны только лейблы полей.
const FIELD_LABELS = {
    full_name:   'ФИО',
    rank:        'Звание',
    doc_number:  '№ документа',
    position_id: 'Должность',
    department:  'Квота',
    callsign:    'Позывной',
    note:        'Примечание',
};

const ACTION_LABELS = {
    create: 'Создание',
    update: 'Изменение',
    delete: 'Удаление',
    revert: 'Откат',
};

const ACTION_COLORS = {
    create: { bg: '#dcfce7', fg: '#166534' },
    update: { bg: '#e0f2fe', fg: '#075985' },
    delete: { bg: '#fee2e2', fg: '#991b1b' },
    revert: { bg: '#fef3c7', fg: '#92400e' },
};

function esc(v) {
    if (v == null || v === '') return '—';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(iso) {
    try {
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} `
             + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch { return iso; }
}

function fmtValue(key, value) {
    if (value == null || value === '') return '—';
    // position_id показываем как "ID: N" — полное имя должности потребовало
    // бы доп. запроса; для истории достаточно видеть что оно менялось
    if (key === 'position_id') return `ID: ${value}`;
    return String(value);
}

function _renderDiffRow(field, oldVal, newVal) {
    const label = FIELD_LABELS[field] || field;
    return `
        <div class="slot-history__diff-row">
            <div class="slot-history__diff-label">${esc(label)}</div>
            <div class="slot-history__diff-values">
                <span class="slot-history__diff-old">${esc(fmtValue(field, oldVal))}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     style="flex-shrink:0; color:var(--md-on-surface-hint);">
                    <line x1="5" y1="12" x2="19" y2="12"/>
                    <polyline points="12 5 19 12 12 19"/>
                </svg>
                <span class="slot-history__diff-new">${esc(fmtValue(field, newVal))}</span>
            </div>
        </div>
    `;
}

function _renderEntry(entry, slotId, canRevert, isNewestUpdate) {
    const actionLabel = ACTION_LABELS[entry.action] || entry.action;
    const color       = ACTION_COLORS[entry.action] || { bg: '#f1f5f9', fg: '#334155' };

    // Собираем diff: объединяем ключи old и new, показываем ряд на каждое поле
    const keys = new Set([
        ...Object.keys(entry.old_values || {}),
        ...Object.keys(entry.new_values || {}),
    ]);
    const diffRows = [...keys]
        .map(k => _renderDiffRow(k, entry.old_values?.[k], entry.new_values?.[k]))
        .join('');

    // Кнопка отката: только для update-записей с old_values и только для
    // свежайшей записи (иначе откат промежуточной ломает последовательность).
    const revertBtn = (canRevert && entry.action === 'update' && isNewestUpdate && diffRows)
        ? `<button class="btn btn-outlined btn-xs slot-history__revert-btn"
                   data-audit-id="${entry.id}" type="button">
             ↶ Откатить
           </button>`
        : '';

    const ip   = entry.ip_address ? ` · IP ${esc(entry.ip_address)}` : '';
    const user = entry.username   ? esc(entry.username) : 'система';

    return `
        <div class="slot-history__entry" data-audit-id="${entry.id}">
            <div class="slot-history__entry-head">
                <span class="slot-history__action-pill"
                      style="background:${color.bg}; color:${color.fg};">
                    ${esc(actionLabel)}
                </span>
                <span class="slot-history__who">${user}</span>
                <span class="slot-history__when">${fmtTime(entry.timestamp)}${ip}</span>
                ${revertBtn}
            </div>
            ${diffRows
                ? `<div class="slot-history__diff">${diffRows}</div>`
                : `<div class="slot-history__empty-diff">нет изменений полей</div>`}
        </div>
    `;
}

export async function openSlotHistory(slotId, { canRevert = false } = {}) {
    // Удаляем предыдущий инстанс модалки если открывали раньше
    document.getElementById('slot-history-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'slot-history-modal';
    modal.className = 'slot-history__backdrop';
    modal.innerHTML = `
        <div class="slot-history__dialog">
            <div class="slot-history__header">
                <div>
                    <h3 style="margin:0; font-size:1.05rem;">История изменений</h3>
                    <p style="margin:2px 0 0; font-size:0.78rem; color:var(--md-on-surface-hint);">
                        Слот #${esc(slotId)}
                    </p>
                </div>
                <button class="users-v2__icon-btn" id="slot-history-close" type="button" title="Закрыть">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6"  y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div id="slot-history-body" class="slot-history__body">
                <div class="slot-history__loading">Загрузка истории…</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('slot-history-close').addEventListener('click', () => modal.remove());

    try {
        const entries = await api.get(`/slots/${slotId}/history?limit=100`);
        const body    = document.getElementById('slot-history-body');
        if (!body) return;

        if (!entries.length) {
            body.innerHTML = `
                <div class="slot-history__empty">
                    <p>Эта строка ещё не изменялась.</p>
                </div>`;
            return;
        }

        // Определяем "самое свежее update-событие" — только у него показываем
        // кнопку отката (чтобы откат не ломал цепочку промежуточных изменений).
        const firstUpdateId = entries.find(e => e.action === 'update')?.id;

        body.innerHTML = entries
            .map(e => _renderEntry(e, slotId, canRevert, e.id === firstUpdateId))
            .join('');

        body.querySelectorAll('.slot-history__revert-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const auditId = parseInt(btn.dataset.auditId, 10);
                if (!confirm('Откатить слот к состоянию до этого изменения?')) return;
                try {
                    await api.post(`/slots/${slotId}/revert/${auditId}`, {});
                    if (window.showSnackbar) window.showSnackbar('Слот откатан', 'success');
                    modal.remove();
                    // Сигнал родителю что слот изменился — он перечитает таблицу
                    document.dispatchEvent(new CustomEvent('slot-reverted', {
                        detail: { slotId },
                    }));
                } catch (e) {
                    console.error('revert:', e);
                    showError(e.status === 409
                        ? 'Данные уже изменены — обновите страницу'
                        : 'Не удалось откатить изменение');
                }
            });
        });
    } catch (e) {
        console.error('openSlotHistory:', e);
        const body = document.getElementById('slot-history-body');
        if (body) body.innerHTML = `
            <div class="slot-history__empty">
                <p>Не удалось загрузить историю: ${esc(e.message || 'ошибка')}</p>
            </div>`;
    }
}

// Экспортируем глобально чтобы использовать из inline-атрибутов
// (департаментский department.js рендерит HTML строкой, дёргать через window
// проще чем пробрасывать импорт).
window.openSlotHistory = openSlotHistory;
