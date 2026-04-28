// static/js/print_settings_dialog.js
//
// Модалка «Настройки шапки печати» для admin'а.
// Редактирует 6 ключей в /settings:
//   print_approve_position/rank/name  — блок УТВЕРЖДАЮ справа сверху
//   print_footer_position/rank/name   — подпись под графиком
// Ниже шаблон ФГКУ «ЦСООР «Лидер», но любой admin может изменить под
// своё подразделение — изменения подхватятся в /settings и применятся
// в шапке print cover при следующем рендере графика.

import { api } from './api.js';
import { invalidatePrintSettingsCache } from './duty_ui.js';

const FIELDS = [
    { key: 'print_approve_position', label: 'Должность утверждающего',  ph: 'Начальник штаба ФГКУ «ЦСООР «Лидер»' },
    { key: 'print_approve_rank',     label: 'Звание утверждающего',     ph: 'полковник' },
    { key: 'print_approve_name',     label: 'ФИО утверждающего',        ph: 'А.А. Шевченко' },
    { key: 'print_footer_position',  label: 'Должность подписывающего', ph: 'Начальник отдела (связи, ...)' },
    { key: 'print_footer_rank',      label: 'Звание подписывающего',    ph: 'подполковник' },
    { key: 'print_footer_name',      label: 'ФИО подписывающего',       ph: 'С.А. Цауменко' },
];


export async function openPrintSettingsDialog() {
    if (document.getElementById('print-settings-overlay')) return;

    let current = {};
    try {
        current = await api.get('/settings');
    } catch (err) {
        console.warn('[print_settings] load failed:', err);
    }

    const overlay = document.createElement('div');
    overlay.id = 'print-settings-overlay';
    overlay.className = 'gs-overlay';   // переиспользуем стили оверлея Ctrl+K
    overlay.innerHTML = `
        <div class="gs-dialog" role="dialog" aria-label="Настройки шапки печати"
             style="max-width:520px;">
            <div class="gs-header" style="padding:14px 16px;">
                <strong style="flex:1; font-size:0.95rem;">Шапка / подпись в распечатке графика наряда</strong>
                <button type="button" class="btn btn-text btn-sm" id="ps-close">Закрыть</button>
            </div>
            <div style="padding:14px 16px; display:flex; flex-direction:column; gap:10px;">
                ${FIELDS.map(f => `
                    <div class="field">
                        <label class="field-label" for="ps-${f.key}">${_esc(f.label)}</label>
                        <input type="text" id="ps-${f.key}" data-key="${f.key}"
                               value="${_esc(current[f.key] || '')}"
                               placeholder="${_esc(f.ph)}"
                               autocomplete="off">
                    </div>
                `).join('')}
                <p style="margin:4px 0 0; font-size:0.78rem; color:var(--md-on-surface-hint);">
                    Изменения применяются к шапке/подписи на печати графиков нарядов.
                    Сохраняются глобально для всего сервера.
                </p>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end; padding:10px 16px;
                        border-top:1px solid var(--md-outline-variant); background:var(--md-surface-container);">
                <button type="button" class="btn btn-outlined btn-sm" id="ps-cancel">Отмена</button>
                <button type="button" class="btn btn-success btn-sm"  id="ps-save">Сохранить</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
    overlay.querySelector('#ps-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#ps-cancel')?.addEventListener('click', () => overlay.remove());

    overlay.querySelector('#ps-save')?.addEventListener('click', async () => {
        const payload = {};
        overlay.querySelectorAll('input[data-key]').forEach(inp => {
            payload[inp.dataset.key] = inp.value.trim();
        });
        try {
            await api.patch('/settings', payload);
            invalidatePrintSettingsCache();
            window.showSnackbar?.('Настройки шапки сохранены', 'success');
            overlay.remove();
        } catch (err) {
            window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
        }
    });

    document.getElementById(`ps-${FIELDS[0].key}`)?.focus();
}


function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
