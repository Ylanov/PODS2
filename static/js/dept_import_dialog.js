// static/js/dept_import_dialog.js
//
// Диалог импорта квот людей из Word-документа. Поток:
//   1. Админ выбирает .docx → POST /persons/import-departments/preview.
//   2. Бэк парсит таблицы, возвращает:
//        matched         — пары (ФИО, управление) которые система резолвила
//                           через таблицу алиасов или прямое совпадение.
//        unknown_aliases — метки которые админ должен сопоставить вручную.
//        unknown_persons — ФИО которых нет в Person.
//   3. Если есть unknown_aliases — показываем для каждого dropdown
//      «Какое управление?». После сопоставления админ жмёт «Применить».
//   4. POST /persons/import-departments/apply — алиасы сохраняются,
//      Person.department обновляется. Список «База людей» перезагружается
//      через WS person_update.

import { api } from './api.js';
import { ApiError } from './api.js';


export async function openDeptImportDialog() {
    if (document.getElementById('di-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'di-overlay';
    overlay.className = 'gs-overlay';
    overlay.innerHTML = `
        <div class="gs-dialog" role="dialog" aria-label="Импорт квот из Word"
             style="max-width:640px; max-height:85vh; display:flex; flex-direction:column;">
            <div class="gs-header" style="padding:14px 16px;">
                <strong style="flex:1; font-size:0.95rem;">📥 Импорт квот людей из Word</strong>
                <button type="button" class="btn btn-text btn-sm" id="di-close">Закрыть</button>
            </div>
            <div id="di-body" style="flex:1; overflow-y:auto; padding:14px 16px; min-height:200px;">
                <div class="field">
                    <label class="field-label" for="di-file">Word-файл со штатным составом (.docx)</label>
                    <input type="file" id="di-file" accept=".docx">
                </div>
                <p style="margin-top:8px; font-size:0.78rem; color:var(--md-on-surface-hint); line-height:1.5;">
                    Система прочитает таблицы, найдёт колонки <b>«ФИО»</b> и
                    <b>«Примечание»</b>, и сопоставит каждого человека с управлением.
                    Если метка («5 упр.», «НУ-3» и т.п.) не сопоставлена ранее —
                    спросит, что это за управление. Ответ запомнится навсегда.
                </p>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end; padding:10px 16px;
                        border-top:1px solid var(--md-outline-variant); background:var(--md-surface-container);">
                <button type="button" class="btn btn-outlined btn-sm" id="di-cancel">Отмена</button>
                <button type="button" class="btn btn-success btn-sm"  id="di-preview" disabled>Распознать</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#di-close')?.addEventListener('click',  () => overlay.remove());
    overlay.querySelector('#di-cancel')?.addEventListener('click', () => overlay.remove());

    const fileInput  = overlay.querySelector('#di-file');
    const previewBtn = overlay.querySelector('#di-preview');
    fileInput.addEventListener('change', () => {
        previewBtn.disabled = !fileInput.files?.length;
    });

    previewBtn.addEventListener('click', async () => {
        const f = fileInput.files?.[0];
        if (!f) return;
        previewBtn.disabled = true;
        previewBtn.textContent = 'Распознаём…';
        try {
            await _runPreview(overlay, f);
        } catch (err) {
            const msg = err?.message || err;
            window.showSnackbar?.(`Ошибка: ${msg}`, 'error');
            previewBtn.disabled = false;
            previewBtn.textContent = 'Распознать';
        }
    });
}


async function _runPreview(overlay, file) {
    const form = new FormData();
    form.append('file', file);

    const resp = await fetch('/api/v1/admin/persons/import-departments/preview', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
        body: form,
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: 'Server error' }));
        throw new ApiError(err.detail || 'Server error', resp.status);
    }
    const data = await resp.json();
    _renderPreview(overlay, data);
}


function _renderPreview(overlay, data) {
    const body = overlay.querySelector('#di-body');
    const departments = data.departments || [];

    // Сохраняем state в DOM dataset — чтобы apply мог собрать всё разом.
    overlay._matched         = data.matched || [];
    overlay._unknownAliases  = data.unknown_aliases || [];
    overlay._unknownPersons  = data.unknown_persons || [];

    const changedCount = (data.matched || []).filter(m => m.changed).length;

    body.innerHTML = `
        <div class="di-summary">
            <div class="di-stat"><b>${data.total_rows}</b> строк прочитано</div>
            <div class="di-stat"><b>${data.matched.length}</b> сопоставлено</div>
            <div class="di-stat di-stat--changed"><b>${changedCount}</b> с изменениями</div>
            ${data.unknown_aliases.length ? `<div class="di-stat di-stat--warn"><b>${data.unknown_aliases.length}</b> неизвестных меток</div>` : ''}
            ${data.unknown_persons.length ? `<div class="di-stat di-stat--warn"><b>${data.unknown_persons.length}</b> ФИО не в базе</div>` : ''}
        </div>

        ${data.unknown_aliases.length ? `
            <h4 class="di-h">Неизвестные метки подразделений</h4>
            <p class="di-sub">Выберите для каждой метки реальное управление. Сопоставление сохранится — при следующем импорте этот вопрос больше не появится. Можно оставить «— пропустить —».</p>
            <table class="di-table">
                <thead><tr><th>Метка из Word</th><th>Сопоставить с управлением</th></tr></thead>
                <tbody>
                ${data.unknown_aliases.map(a => `
                    <tr>
                        <td><code>${_esc(a)}</code></td>
                        <td>
                            <select data-alias="${_esc(a)}" class="di-alias-select">
                                <option value="">— пропустить —</option>
                                ${departments.map(d => `<option value="${_esc(d)}">${_esc(d)}</option>`).join('')}
                            </select>
                        </td>
                    </tr>
                `).join('')}
                </tbody>
            </table>
        ` : ''}

        ${data.unknown_persons.length ? `
            <h4 class="di-h">ФИО не найдены в базе людей</h4>
            <p class="di-sub">Эти строки будут пропущены. Чтобы их применить — сначала добавь людей в базу или поправь ФИО в исходном Word.</p>
            <ul class="di-ulist">${data.unknown_persons.slice(0, 50).map(n => `<li>${_esc(n)}</li>`).join('')}</ul>
            ${data.unknown_persons.length > 50 ? `<p class="di-sub">…и ещё ${data.unknown_persons.length - 50}.</p>` : ''}
        ` : ''}

        ${changedCount === 0 && !data.unknown_aliases.length && !data.unknown_persons.length ? `
            <p class="di-sub">Все сопоставления уже актуальны — нечего изменять.</p>
        ` : ''}

        ${changedCount > 0 ? `
            <h4 class="di-h">Изменения, которые будут применены (${changedCount})</h4>
            <table class="di-table">
                <thead><tr><th>ФИО</th><th>Сейчас</th><th>→</th><th>Будет</th></tr></thead>
                <tbody>
                ${data.matched.filter(m => m.changed).slice(0, 80).map(m => `
                    <tr>
                        <td>${_esc(m.full_name)}</td>
                        <td><span class="di-old">${_esc(m.current || '—')}</span></td>
                        <td>→</td>
                        <td><b>${_esc(m.department)}</b></td>
                    </tr>
                `).join('')}
                </tbody>
            </table>
            ${changedCount > 80 ? `<p class="di-sub">…и ещё ${changedCount - 80}.</p>` : ''}
        ` : ''}
    `;

    // Заменяем кнопку «Распознать» на «Применить»
    const previewBtn = overlay.querySelector('#di-preview');
    previewBtn.disabled    = false;
    previewBtn.textContent = changedCount || data.unknown_aliases.length
        ? '✓ Применить'
        : 'Закрыть';
    previewBtn.onclick = async () => {
        if (changedCount === 0 && !data.unknown_aliases.length) {
            overlay.remove();
            return;
        }
        await _applyChanges(overlay);
    };
}


async function _applyChanges(overlay) {
    // Собираем ответы админа для unknown_aliases
    const newAliases = {};
    overlay.querySelectorAll('.di-alias-select').forEach(sel => {
        const alias = sel.dataset.alias;
        const dept  = sel.value;
        if (alias && dept) newAliases[alias] = dept;
    });

    // Если админ задал новые алиасы — нужно запросить preview ещё раз
    // чтобы появились changes для тех людей, чьи метки только что
    // расшифрованы. Сделаем это серверно: apply принимает new_aliases,
    // но для полного эффекта применит только matched (уже резолвленные).
    // Поэтому если есть новые алиасы — сохраняем их и рестартуем preview.
    if (Object.keys(newAliases).length > 0) {
        const previewBtn = overlay.querySelector('#di-preview');
        previewBtn.disabled    = true;
        previewBtn.textContent = 'Сохраняем алиасы…';
        try {
            // Сначала сохраним алиасы (через apply без changes — он сохранит
            // только new_aliases и не тронет людей).
            await api.post('/admin/persons/import-departments/apply', {
                changes: [], new_aliases: newAliases,
            });
            // Теперь повторяем preview — теперь «5 упр.» система знает,
            // и эти строки уйдут в matched.
            const fileInput = overlay.querySelector('#di-file');
            await _runPreview(overlay, fileInput.files[0]);
            return;
        } catch (err) {
            window.showSnackbar?.(`Ошибка сохранения алиасов: ${err?.message || err}`, 'error');
            previewBtn.disabled    = false;
            previewBtn.textContent = '✓ Применить';
            return;
        }
    }

    // Применяем уже резолвленные изменения
    const changes = (overlay._matched || []).filter(m => m.changed).map(m => ({
        person_id:  m.person_id,
        department: m.department,
    }));
    if (!changes.length) {
        overlay.remove();
        return;
    }

    const previewBtn = overlay.querySelector('#di-preview');
    previewBtn.disabled    = true;
    previewBtn.textContent = 'Применяем…';

    try {
        const r = await api.post('/admin/persons/import-departments/apply', {
            changes, new_aliases: {},
        });
        window.showSnackbar?.(r.message || `Применено: ${r.updated_persons}`, 'success');
        overlay.remove();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
        previewBtn.disabled    = false;
        previewBtn.textContent = '✓ Применить';
    }
}


function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
