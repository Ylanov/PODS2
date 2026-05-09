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
    // Накопительный список выбранных файлов. Держим явно массив (не
    // полагаемся на input.files), чтобы пользователь мог добирать
    // файлы несколькими кликами «Выбрать», и убирать ✕ конкретные.
    overlay._selectedFiles = [];

    overlay.innerHTML = `
        <div class="gs-dialog" role="dialog" aria-label="Импорт квот из Word"
             style="max-width:640px; max-height:85vh; display:flex; flex-direction:column;">
            <div class="gs-header" style="padding:14px 16px;">
                <strong style="flex:1; font-size:0.95rem;">📥 Импорт квот людей из Word</strong>
                <button type="button" class="btn btn-text btn-sm" id="di-close">Закрыть</button>
            </div>
            <div id="di-body" style="flex:1; overflow-y:auto; padding:14px 16px; min-height:200px;">
                <div class="field">
                    <label class="field-label" for="di-file">Word-файлы со штатным составом (.docx)</label>
                    <input type="file" id="di-file" accept=".docx" multiple>
                </div>
                <div id="di-files-list" class="di-files-list"></div>
                <p style="margin-top:8px; font-size:0.78rem; color:var(--md-on-surface-hint); line-height:1.5;">
                    Можно выбрать сразу несколько файлов или добирать их по одному.
                    Система прочитает таблицы (колонки <b>«ФИО»</b> и <b>«Примечание»</b>),
                    дедуплицирует одинаковые записи между файлами и сопоставит каждого
                    с управлением. Неизвестные метки спросит у вас один раз и запомнит.
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
    const filesList  = overlay.querySelector('#di-files-list');
    const previewBtn = overlay.querySelector('#di-preview');

    function _renderFilesList() {
        const items = overlay._selectedFiles;
        if (!items.length) {
            filesList.innerHTML = '';
            previewBtn.disabled = true;
            return;
        }
        filesList.innerHTML = items.map((f, idx) => `
            <div class="di-file-row">
                <span class="di-file-row__name" title="${_esc(f.name)}">${_esc(f.name)}</span>
                <span class="di-file-row__size">${(f.size / 1024).toFixed(0)} КБ</span>
                <button type="button" class="btn-tiny-danger" data-remove-idx="${idx}" title="Убрать">✕</button>
            </div>
        `).join('');
        previewBtn.disabled = false;
    }

    fileInput.addEventListener('change', () => {
        const incoming = Array.from(fileInput.files || []);
        // Дедуп по имени+размеру — пользователь не должен случайно выбрать
        // тот же файл дважды и получить «дубликаты» в per_file.
        const existing = new Set(
            overlay._selectedFiles.map(f => `${f.name}::${f.size}`)
        );
        for (const f of incoming) {
            const key = `${f.name}::${f.size}`;
            if (!existing.has(key)) {
                overlay._selectedFiles.push(f);
                existing.add(key);
            }
        }
        // Очищаем input — иначе при повторном выборе того же файла событие
        // 'change' не сработает.
        fileInput.value = '';
        _renderFilesList();
    });

    filesList.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-remove-idx]');
        if (!btn) return;
        const idx = parseInt(btn.dataset.removeIdx, 10);
        if (Number.isFinite(idx)) {
            overlay._selectedFiles.splice(idx, 1);
            _renderFilesList();
        }
    });

    previewBtn.addEventListener('click', async () => {
        if (!overlay._selectedFiles.length) return;
        previewBtn.disabled = true;
        previewBtn.textContent = 'Распознаём…';
        try {
            await _runPreview(overlay, overlay._selectedFiles);
        } catch (err) {
            const msg = err?.message || err;
            window.showSnackbar?.(`Ошибка: ${msg}`, 'error');
            previewBtn.disabled = false;
            previewBtn.textContent = 'Распознать';
        }
    });
}


async function _runPreview(overlay, files) {
    const form = new FormData();
    // FastAPI принимает list[UploadFile] как несколько значений с одним
    // именем поля. Имя совпадает с параметром в роутере: `files`.
    for (const f of files) form.append('files', f);

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
    // unknown_persons — массив объектов с candidates[]; нормализуем формат
    // на случай если бэк (старый) ещё отдаёт массив строк.
    overlay._unknownPersons  = (data.unknown_persons || []).map(u =>
        (typeof u === 'string')
            ? { full_name: u, alias: '', department: '', candidates: [] }
            : u
    );

    const changedCount = (data.matched || []).filter(m => m.changed).length;
    const unknownPersonsCount = overlay._unknownPersons.length;

    const perFile = Array.isArray(data.per_file) ? data.per_file : [];
    const filesCount = data.files_count || perFile.length || 1;
    const fileErrors = perFile.filter(f => f.error);

    const perFileBlock = perFile.length > 1 || fileErrors.length ? `
        <details class="di-perfile" ${fileErrors.length ? 'open' : ''}>
            <summary>Файлы (${filesCount})${fileErrors.length ? ` · ошибок: ${fileErrors.length}` : ''}</summary>
            <ul class="di-perfile__list">
                ${perFile.map(f => `
                    <li class="${f.error ? 'di-perfile__item--err' : ''}">
                        <span class="di-perfile__name" title="${_esc(f.filename || '')}">${_esc(f.filename || '—')}</span>
                        ${f.error
                            ? `<span class="di-perfile__err">${_esc(f.error)}</span>`
                            : `<span class="di-perfile__stat">${f.added} добавлено${f.skipped_duplicates ? `, ${f.skipped_duplicates} дублей` : ''}</span>`}
                    </li>
                `).join('')}
            </ul>
        </details>
    ` : '';

    body.innerHTML = `
        ${perFileBlock}

        <div class="di-summary">
            <div class="di-stat"><b>${data.total_rows}</b> строк прочитано</div>
            <div class="di-stat"><b>${data.matched.length}</b> сопоставлено</div>
            <div class="di-stat di-stat--changed"><b>${changedCount}</b> с изменениями</div>
            ${data.unknown_aliases.length ? `<div class="di-stat di-stat--warn"><b>${data.unknown_aliases.length}</b> неизвестных меток</div>` : ''}
            ${unknownPersonsCount ? `<div class="di-stat di-stat--warn"><b>${unknownPersonsCount}</b> ФИО не в базе</div>` : ''}
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

        ${unknownPersonsCount ? `
            <h4 class="di-h">ФИО не найдены в базе людей (${unknownPersonsCount})</h4>
            <p class="di-sub">Для каждого человека выберите: совпадает с кем-то из базы (тогда обновим у него управление), или это новый человек (создадим запись), или пропустить эту строку.</p>
            <div class="di-unk-list">
                ${overlay._unknownPersons.map((u, idx) => _renderUnknownRow(u, idx)).join('')}
            </div>
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
    const hasWork = changedCount || data.unknown_aliases.length || unknownPersonsCount;
    previewBtn.textContent = hasWork ? '✓ Применить' : 'Закрыть';
    previewBtn.onclick = async () => {
        if (!hasWork) {
            overlay.remove();
            return;
        }
        await _applyChanges(overlay);
    };

    // Привязываем интерактив на строки unknown_persons (radio + поиск).
    _bindUnknownRows(overlay);
}


// ─── Секция «ФИО не найдены»: рендер строки + bind событий ──────────────────

function _renderUnknownRow(u, idx) {
    const cands = u.candidates || [];
    const top   = cands[0];
    // Если есть сильный кандидат (≥70) — по умолчанию выбираем его, иначе
    // «Создать нового» (это безопасный путь — админ всегда может изменить).
    const defaultMerge = top && top.score >= 70;
    const fioEsc  = _esc(u.full_name);
    const deptEsc = _esc(u.department || '');

    const candItems = cands.map((c, ci) => `
        <label class="di-unk-opt">
            <input type="radio" name="u${idx}"
                   value="merge:${c.id}"
                   ${defaultMerge && ci === 0 ? 'checked' : ''}>
            <span class="di-unk-opt__main">
                Это <b>${_esc(c.full_name)}</b>
                ${c.rank ? `· <span class="di-unk-meta">${_esc(c.rank)}</span>` : ''}
                ${c.department ? `· <span class="di-unk-meta">${_esc(c.department)}</span>` : ''}
            </span>
            <span class="di-unk-score" title="Похожесть по trigram-индексу">${c.score}%</span>
        </label>
    `).join('');

    return `
        <div class="di-unk-row" data-unknown-idx="${idx}">
            <div class="di-unk-row__head">
                <div class="di-unk-row__fio">
                    <span class="di-unk-row__name">${fioEsc}</span>
                    ${deptEsc ? `<span class="di-unk-row__dept">→ ${deptEsc}</span>` : ''}
                </div>
                ${cands.length === 0
                    ? '<span class="di-unk-row__hint">похожих в базе нет</span>'
                    : ''}
            </div>
            <div class="di-unk-row__opts">
                ${candItems}
                <label class="di-unk-opt">
                    <input type="radio" name="u${idx}" value="create"
                           ${!defaultMerge ? 'checked' : ''}>
                    <span class="di-unk-opt__main">Создать нового в базе людей</span>
                </label>
                <label class="di-unk-opt">
                    <input type="radio" name="u${idx}" value="search">
                    <span class="di-unk-opt__main">Найти в базе вручную…</span>
                </label>
                <label class="di-unk-opt">
                    <input type="radio" name="u${idx}" value="skip">
                    <span class="di-unk-opt__main">Пропустить эту строку</span>
                </label>
            </div>
            <div class="di-unk-search hidden">
                <input type="text" class="di-unk-search__input"
                       placeholder="Введите фамилию для поиска по базе людей…"
                       autocomplete="off">
                <div class="di-unk-search__results"></div>
                <div class="di-unk-search__chosen hidden"></div>
            </div>
        </div>
    `;
}

function _bindUnknownRows(overlay) {
    overlay.querySelectorAll('.di-unk-row').forEach(row => {
        // Показ/скрытие inline-поиска при выборе радио «search».
        row.querySelectorAll('input[type=radio]').forEach(r => {
            r.addEventListener('change', () => {
                const showSearch = r.value === 'search' && r.checked;
                row.querySelector('.di-unk-search').classList.toggle('hidden', !showSearch);
                if (!showSearch) {
                    // Сбросили выбор поиска — очищаем привязку
                    delete row.dataset.searchPersonId;
                    const chosen = row.querySelector('.di-unk-search__chosen');
                    chosen.classList.add('hidden');
                    chosen.innerHTML = '';
                }
            });
        });

        // Поиск в базе людей через /persons/suggest (с debounce).
        const input    = row.querySelector('.di-unk-search__input');
        const results  = row.querySelector('.di-unk-search__results');
        const chosen   = row.querySelector('.di-unk-search__chosen');
        let timer = null;
        input?.addEventListener('input', () => {
            clearTimeout(timer);
            const q = input.value.trim();
            if (q.length < 2) {
                results.innerHTML = '';
                return;
            }
            timer = setTimeout(async () => {
                try {
                    const r = await api.get(`/persons/suggest?full_name=${encodeURIComponent(q)}&limit=8`);
                    if (!r || r.length === 0) {
                        results.innerHTML = '<div class="di-unk-search__empty">Никто не найден</div>';
                        return;
                    }
                    results.innerHTML = r.map(p => `
                        <div class="di-unk-search__item" data-person-id="${p.id}">
                            <span><b>${_esc(p.full_name)}</b>
                                ${p.rank ? `· ${_esc(p.rank)}` : ''}
                                ${p.department ? `· ${_esc(p.department)}` : ''}
                            </span>
                            <span class="di-unk-score">${p.match_score}%</span>
                        </div>
                    `).join('');
                } catch (err) {
                    results.innerHTML = '<div class="di-unk-search__empty">Ошибка поиска</div>';
                }
            }, 250);
        });

        // Клик по найденному — фиксируем выбор для apply.
        results?.addEventListener('click', (e) => {
            const item = e.target.closest('.di-unk-search__item');
            if (!item) return;
            const pid = item.dataset.personId;
            row.dataset.searchPersonId = pid;
            chosen.classList.remove('hidden');
            chosen.innerHTML = `Выбрано: ${item.querySelector('span').innerHTML}`;
            results.innerHTML = '';
            input.value = '';
        });
    });
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
            // и эти строки уйдут в matched. Используем накопленный
            // список файлов (тот же, который был при первом распознавании).
            await _runPreview(overlay, overlay._selectedFiles || []);
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

    // Решения по неизвестным ФИО (radio + поиск).
    const unknownDecisions = [];
    overlay.querySelectorAll('.di-unk-row').forEach(row => {
        const idx = parseInt(row.dataset.unknownIdx, 10);
        const u   = overlay._unknownPersons[idx];
        if (!u) return;
        const checked = row.querySelector('input[type=radio]:checked');
        if (!checked) return;

        const v = checked.value;
        const base = { full_name: u.full_name, department: u.department };

        if (v === 'skip') {
            unknownDecisions.push({ ...base, action: 'skip' });
        } else if (v === 'create') {
            unknownDecisions.push({ ...base, action: 'create' });
        } else if (v.startsWith('merge:')) {
            const personId = parseInt(v.slice(6), 10);
            unknownDecisions.push({ ...base, action: 'merge', person_id: personId });
        } else if (v === 'search') {
            const pid = parseInt(row.dataset.searchPersonId || '', 10);
            if (pid) {
                unknownDecisions.push({ ...base, action: 'merge', person_id: pid });
            } else {
                // Радио «найти» выбрано, но никого не выбрали — пропускаем.
                unknownDecisions.push({ ...base, action: 'skip' });
            }
        }
    });

    if (!changes.length && !unknownDecisions.length) {
        overlay.remove();
        return;
    }

    const previewBtn = overlay.querySelector('#di-preview');
    previewBtn.disabled    = true;
    previewBtn.textContent = 'Применяем…';

    try {
        const r = await api.post('/admin/persons/import-departments/apply', {
            changes,
            new_aliases: {},
            unknown_decisions: unknownDecisions,
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
