// static/js/groza_export_dialog.js
//
// Диалог скачивания ГРОЗА-555 в Word. Спрашивает у админа:
//   • звание оперативного дежурного (default из /settings.duty_rank)
//   • ФИО оперативного дежурного    (default из /settings.duty_name)
//   • дату «на DD.MM.YYYY» в шапке  (default — сегодня)
// и зовёт endpoint /admin/events/{id}/export-groza-docx.

import { api } from './api.js';


export async function openGrozaExportDialog(eventId) {
    if (!eventId) {
        window.showSnackbar?.('Выберите список для выгрузки', 'error');
        return;
    }

    // Дефолты из настроек — те же значения, что используются в обычной
    // подписи документа. Админ может перезаписать в форме.
    let defaults = {};
    try { defaults = await api.get('/settings'); }
    catch (_) { /* не критично — оставим пустыми */ }

    const today = new Date().toISOString().slice(0, 10);

    const overlay = document.createElement('div');
    overlay.className = 'gs-overlay';
    overlay.id = 'groza-export-overlay';
    overlay.innerHTML = `
        <div class="gs-dialog" role="dialog" aria-label="Выгрузка ГРОЗА-555">
            <div class="gs-header" style="padding:14px 16px;">
                <strong style="flex:1; font-size:0.95rem;">⬇ Выгрузка ГРОЗА-555 в Word</strong>
                <button type="button" class="btn btn-text btn-sm" id="ge-close">Закрыть</button>
            </div>
            <div style="padding:14px 16px; display:flex; flex-direction:column; gap:10px;">
                <div class="field">
                    <label class="field-label" for="ge-date">Дата (на DD.MM.YYYY в шапке)</label>
                    <input type="date" id="ge-date" value="${today}">
                </div>
                <div class="field">
                    <label class="field-label" for="ge-rank">Звание оперативного дежурного</label>
                    <input type="text" id="ge-rank" placeholder="подполковник"
                           value="${_esc(defaults.duty_rank || '')}" autocomplete="off">
                </div>
                <div class="field">
                    <label class="field-label" for="ge-name">ФИО оперативного дежурного</label>
                    <input type="text" id="ge-name" placeholder="Д.М. Патетин"
                           value="${_esc(defaults.duty_name || '')}" autocomplete="off">
                </div>
                <p style="margin:4px 0 0; font-size:0.78rem; color:var(--md-on-surface-hint);">
                    Звание и ФИО можно изменить только для этой выгрузки. Дефолты берутся
                    из текущего дежурного (Настройки → Дежурный).
                </p>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end; padding:10px 16px;
                        border-top:1px solid var(--md-outline-variant); background:var(--md-surface-container);">
                <button type="button" class="btn btn-outlined btn-sm" id="ge-cancel">Отмена</button>
                <button type="button" class="btn btn-success btn-sm"  id="ge-download">⬇ Скачать</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#ge-close')?.addEventListener('click', close);
    overlay.querySelector('#ge-cancel')?.addEventListener('click', close);

    overlay.querySelector('#ge-download')?.addEventListener('click', async () => {
        const date = document.getElementById('ge-date').value;
        const rank = document.getElementById('ge-rank').value.trim();
        const name = document.getElementById('ge-name').value.trim();

        const params = new URLSearchParams();
        if (date) params.set('target_date', date);
        if (rank) params.set('duty_rank',   rank);
        if (name) params.set('duty_name',   name);

        try {
            const blob = await api.download(
                `/admin/events/${eventId}/export-groza-docx?${params.toString()}`,
            );
            const url = URL.createObjectURL(blob);
            const a   = document.createElement('a');
            a.href = url;
            a.download = `GROZA-555_${(date || today).split('-').reverse().join('.')}.docx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            close();
        } catch (err) {
            window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
        }
    });

    document.getElementById('ge-rank')?.focus();
}


function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
