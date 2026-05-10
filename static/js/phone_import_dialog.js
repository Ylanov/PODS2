// static/js/phone_import_dialog.js
//
// Диалог импорта номеров телефона из Excel в Базу людей.
// Workflow:
//   1. Админ выбирает .xlsx
//   2. POST /admin/persons/import-phones/preview — бэк парсит, ищет
//      Person по ФИО, классифицирует:
//        matched   — точное совпадение (1 кандидат)
//        ambiguous — несколько кандидатов, нужно выбрать вручную
//        unknown   — ФИО не найдено в Базе
//   3. UI:
//        • matched   — таблица с галкой «применить» (по дефолту ✓ для тех
//          у кого phone пуст; снят для тех у кого уже что-то стоит)
//        • ambiguous — radio выбор кандидата для каждой строки
//        • unknown   — список «не найдены» (применять нельзя — людей
//          руками добавьте сначала)
//   4. POST /admin/persons/import-phones/apply — сохранение

import { api } from './api.js';

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


export function openPhoneImportDialog() {
    document.getElementById('phi-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'phi-overlay';
    overlay.className = 'gs-overlay';
    overlay.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
    `;
    overlay.innerHTML = `
        <div class="gs-dialog" role="dialog" aria-label="Импорт телефонов из Excel"
             style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:780px; width:100%; max-height:90vh;
                    display:flex; flex-direction:column;
                    box-shadow:0 20px 60px rgba(0,0,0,0.25);">
            <div style="display:flex; align-items:center; gap:8px; padding:14px 18px;
                        border-bottom:1px solid var(--md-outline-variant);">
                <strong style="flex:1; font-size:0.95rem;">📞 Импорт телефонов из Excel</strong>
                <button id="phi-close" class="btn btn-text btn-sm" type="button">✕</button>
            </div>
            <div id="phi-body" style="flex:1; overflow-y:auto; padding:14px 18px;">
                <p style="margin:0 0 10px; font-size:0.84rem; color:var(--md-on-surface-variant); line-height:1.4;">
                    Файл с колонками: <b>ФИО</b>, <b>Служебный телефон</b>,
                    <b>Домашний телефон</b>, <b>Мобильный телефон</b>.
                    Берётся первый непустой по приоритету: мобильный → служебный → домашний.
                </p>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
                    <input type="file" id="phi-file" accept=".xlsx,.xlsm"
                           style="flex:1; font-size:0.86rem;">
                    <button id="phi-preview" class="btn btn-filled btn-sm" type="button" disabled>
                        Распознать
                    </button>
                </div>
                <div id="phi-result"></div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#phi-close').addEventListener('click', () => overlay.remove());

    const fileInp = overlay.querySelector('#phi-file');
    const previewBtn = overlay.querySelector('#phi-preview');
    fileInp.addEventListener('change', () => {
        previewBtn.disabled = !fileInp.files?.length;
    });

    previewBtn.addEventListener('click', async () => {
        if (!fileInp.files?.length) return;
        await _runPreview(overlay, fileInp.files[0]);
    });
}


async function _runPreview(overlay, file) {
    const result = overlay.querySelector('#phi-result');
    result.innerHTML = '<p style="text-align:center; padding:20px; color:var(--md-on-surface-variant);">Распознаём…</p>';

    const fd = new FormData();
    fd.append('file', file);

    let data;
    try {
        const resp = await fetch('/api/v1/admin/persons/import-phones/preview', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token')}` },
            body:    fd,
        });
        if (!resp.ok) {
            const errTxt = await resp.text();
            throw new Error(errTxt || `HTTP ${resp.status}`);
        }
        data = await resp.json();
    } catch (err) {
        result.innerHTML = `<p style="color:var(--md-error,#b00020); padding:10px;">Ошибка: ${_esc(err.message)}</p>`;
        return;
    }

    overlay._phiData = data;
    _renderPreview(overlay, data);
}


function _renderPreview(overlay, data) {
    const result = overlay.querySelector('#phi-result');

    const matched = data.matched || [];
    const ambiguous = data.ambiguous || [];
    const unknown = data.unknown || [];

    let html = `
        <div style="display:flex; gap:12px; padding:8px 10px; background:var(--md-surface-container);
                    border-radius:6px; font-size:0.82rem; margin-bottom:12px;">
            <span>Всего строк с телефоном: <b>${data.total_rows}</b></span>
            <span>·</span>
            <span style="color:#16a34a;">Точно: <b>${matched.length}</b></span>
            <span>·</span>
            <span style="color:#d97706;">Неоднозначно: <b>${ambiguous.length}</b></span>
            <span>·</span>
            <span style="color:var(--md-on-surface-hint);">Не найдены: <b>${unknown.length}</b></span>
        </div>
    `;

    // matched
    if (matched.length > 0) {
        html += `
            <h4 class="phi-h">Точные совпадения (${matched.length})</h4>
            <p class="phi-sub">
                Галка ✓ ставит/обновляет телефон. По умолчанию <b>снята</b> для тех у
                кого телефон уже был — поставьте чтобы перезаписать.
            </p>
            <div style="display:flex; gap:8px; margin-bottom:6px; font-size:0.78rem;">
                <button type="button" class="btn btn-text btn-xs" id="phi-toggle-all">Все/никто</button>
                <button type="button" class="btn btn-text btn-xs" id="phi-only-empty">Только без телефона</button>
            </div>
            <table class="phi-table">
                <thead>
                    <tr>
                        <th style="width:32px;"><input type="checkbox" id="phi-all-cb"></th>
                        <th>ФИО (Excel)</th>
                        <th>В базе</th>
                        <th>Сейчас</th>
                        <th>→</th>
                        <th>Новый телефон</th>
                    </tr>
                </thead>
                <tbody>
                    ${matched.map((m, i) => {
                        const checked = m.has_old_phone ? '' : 'checked';
                        const rowCls = m.has_old_phone ? ' phi-row--overwrite' : '';
                        return `
                            <tr class="phi-matched-row${rowCls}" data-idx="${i}">
                                <td><input type="checkbox" class="phi-cb" data-idx="${i}" ${checked}></td>
                                <td>${_esc(m.excel_name)}</td>
                                <td>${_esc(m.person.full_name)}${m.person.department ? ` <small style="color:var(--md-on-surface-hint);">(${_esc(m.person.department)})</small>` : ''}</td>
                                <td><span class="phi-old">${_esc(m.person.phone || '—')}</span></td>
                                <td>→</td>
                                <td><code>${_esc(m.new_phone)}</code></td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    // ambiguous
    if (ambiguous.length > 0) {
        html += `
            <h4 class="phi-h" style="margin-top:18px;">Неоднозначные (${ambiguous.length})</h4>
            <p class="phi-sub">
                У этих ФИО найдено несколько кандидатов в Базе. Выберите кому записать телефон, иначе пропустится.
            </p>
            <div class="phi-amb-list">
                ${ambiguous.map((a, i) => `
                    <div class="phi-amb-row" data-amb-idx="${i}">
                        <div class="phi-amb-row__head">
                            <b>${_esc(a.excel_name)}</b> → <code>${_esc(a.new_phone)}</code>
                        </div>
                        <div class="phi-amb-row__candidates">
                            <label><input type="radio" name="phi-amb-${i}" value=""> — пропустить —</label>
                            ${a.candidates.map(c => `
                                <label>
                                    <input type="radio" name="phi-amb-${i}" value="${c.id}">
                                    ${_esc(c.full_name)}
                                    ${c.department ? `<small>· ${_esc(c.department)}</small>` : ''}
                                    ${c.phone ? `<small style="color:#d97706;">· сейчас: ${_esc(c.phone)}</small>` : ''}
                                </label>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // unknown
    if (unknown.length > 0) {
        html += `
            <h4 class="phi-h" style="margin-top:18px;">Не найдены в Базе (${unknown.length})</h4>
            <p class="phi-sub">
                Эти ФИО из Excel не нашлись. Они будут пропущены — добавьте людей в Базу руками,
                после этого можно повторить импорт.
            </p>
            <details>
                <summary style="cursor:pointer; font-size:0.84rem; color:var(--md-on-surface-variant);">
                    Показать список (${unknown.length})
                </summary>
                <ul style="font-size:0.82rem; max-height:200px; overflow-y:auto; margin:6px 0; padding-left:20px;">
                    ${unknown.map(u => `<li>${_esc(u.excel_name)} <code style="color:var(--md-on-surface-hint);">${_esc(u.new_phone)}</code></li>`).join('')}
                </ul>
            </details>
        `;
    }

    if (matched.length === 0 && ambiguous.length === 0) {
        html += `<p style="color:var(--md-on-surface-variant); padding:20px; text-align:center;">
            Нечего применять — все ФИО либо не найдены, либо файл пустой.
        </p>`;
    } else {
        html += `
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:14px;
                        padding-top:10px; border-top:1px solid var(--md-outline-variant);">
                <button id="phi-apply" class="btn btn-success btn-sm" type="button">
                    ✓ Применить
                </button>
            </div>
        `;
    }

    result.innerHTML = html;

    // Bindings
    const allCb = result.querySelector('#phi-all-cb');
    const cbs   = result.querySelectorAll('.phi-cb');

    function _syncHeader() {
        if (!allCb) return;
        const total = cbs.length;
        const on    = result.querySelectorAll('.phi-cb:checked').length;
        allCb.checked = total > 0 && on === total;
        allCb.indeterminate = on > 0 && on < total;
    }
    _syncHeader();

    allCb?.addEventListener('change', () => {
        cbs.forEach(cb => { cb.checked = allCb.checked; });
    });
    cbs.forEach(cb => cb.addEventListener('change', _syncHeader));

    result.querySelector('#phi-toggle-all')?.addEventListener('click', () => {
        const anyOn = !!result.querySelector('.phi-cb:checked');
        cbs.forEach(cb => { cb.checked = !anyOn; });
        _syncHeader();
    });
    result.querySelector('#phi-only-empty')?.addEventListener('click', () => {
        result.querySelectorAll('.phi-matched-row').forEach(row => {
            const cb = row.querySelector('.phi-cb');
            if (!cb) return;
            cb.checked = !row.classList.contains('phi-row--overwrite');
        });
        _syncHeader();
    });

    result.querySelector('#phi-apply')?.addEventListener('click', () => _applyChanges(overlay));
}


async function _applyChanges(overlay) {
    const data = overlay._phiData;
    if (!data) return;

    const changes = [];

    // matched — отмеченные галкой
    overlay.querySelectorAll('.phi-cb:checked').forEach(cb => {
        const idx = parseInt(cb.dataset.idx, 10);
        const m = data.matched[idx];
        if (m) changes.push({ person_id: m.person.id, phone: m.new_phone });
    });

    // ambiguous — выбранный radio
    (data.ambiguous || []).forEach((a, i) => {
        const sel = overlay.querySelector(`input[name="phi-amb-${i}"]:checked`);
        if (sel && sel.value) {
            changes.push({ person_id: parseInt(sel.value, 10), phone: a.new_phone });
        }
    });

    if (changes.length === 0) {
        window.showSnackbar?.('Нечего применять — ни одной строки не отмечено', 'error');
        return;
    }

    try {
        const res = await api.post('/admin/persons/import-phones/apply', { changes });
        window.showSnackbar?.(`Обновлено: ${res.updated} из ${res.received}`, 'success');
        overlay.remove();
        // Перерисуем Базу людей если открыта
        document.dispatchEvent(new CustomEvent('persons-reload-needed'));
    } catch (err) {
        window.showSnackbar?.(`Не удалось: ${err?.message || err}`, 'error');
    }
}
