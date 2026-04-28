// static/js/admin.js

import { api } from './api.js';
import { showError, showSuccess, formatRole, loadEventsDropdowns, getCachedEvents } from './ui.js';

// ─── Локальный кэш ────────────────────────────────────────────────────────────
let availablePositions   = [];
let availableDepartments = [];
let currentEditorEventId = null;
let currentColumns       = []; // активная конфигурация столбцов загруженного списка
let currentEditorData    = null; // полные данные загруженного события (для фильтрации)

// Состояние фильтров редактора
const editorFilter = {
    query:          '',
    department:     '',
    unfilledOnly:   false,
};

// ─── Столбцы по умолчанию (зеркало Python DEFAULT_COLUMNS) ───────────────────
const DEFAULT_COLUMNS = [
    { key: 'full_name',   label: 'ФИО',         type: 'text',            order: 0, visible: true },
    { key: 'rank',        label: 'Звание',       type: 'text',            order: 1, visible: true },
    { key: 'doc_number',  label: '№ Документа',  type: 'text',            order: 2, visible: true },
    { key: 'position_id', label: 'Должность',    type: 'select_position', order: 3, visible: true },
    { key: 'callsign',    label: 'Позывной',     type: 'text',            order: 4, visible: true },
    { key: 'department',  label: 'Квота',        type: 'select_dept',     order: 5, visible: true },
    { key: 'note',        label: 'Примечание',   type: 'text',            order: 6, visible: true },
];

// Встроенные ключи: у них есть своё поле в Slot; остальные — кастомные (extra_data)
const BUILTIN_KEYS = new Set(['full_name','rank','doc_number','position_id','callsign','department','note']);

// Маппинг key → префикс id инпута (совместимость с автодополнением ui.js)
const FIELD_INPUT_PREFIX = {
    full_name:  'name',
    rank:       'rank',
    doc_number: 'doc',
    callsign:   'call',
    note:       'note',
};

// ─── Хелперы ─────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function esc(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
        .replace(/'/g,'&#039;');
}

function notify(message, type = 'success') {
    if (typeof window.showSnackbar === 'function') window.showSnackbar(message, type);
}

// ─── Управление списками ──────────────────────────────────────────────────────

export async function handleCreateEvent() {
    const title = el('event-title').value.trim();
    // Редактор работает только с шаблонами — всегда ставим is_template=true
    if (!title) return showError('Введите название шаблона');
    try {
        await api.post('/admin/events', { title, is_template: true });
        notify('Шаблон создан!');
        el('event-title').value = '';
        if (el('event-is-template')) el('event-is-template').checked = true;
        await loadEventsDropdowns();
    } catch (e) { console.error('handleCreateEvent:', e); showError('Ошибка создания шаблона'); }
}

export async function handleAddGroup() {
    // Группа добавляется в текущий открытый в редакторе шаблон —
    // пользователь сначала выбирает шаблон, потом внизу таблицы пишет
    // имя новой группы. Отдельный dropdown «Список» убран, поскольку
    // контекст шаблона уже есть (currentEditorEventId).
    if (!currentEditorEventId) {
        return showError('Сначала откройте шаблон в редакторе');
    }
    const input = el('editor-new-group-name');
    const groupName = input?.value.trim();
    if (!groupName) {
        return showError('Введите название группы');
    }
    const isSupp = !!el('editor-new-group-supp')?.checked;
    try {
        await api.post(`/admin/events/${currentEditorEventId}/groups`, {
            name:             groupName,
            order_num:        1,
            is_supplementary: isSupp,
        });
        notify(isSupp ? 'Группа добавлена в доп. список' : 'Группа добавлена');
        if (input) input.value = '';
        const suppCheckbox = el('editor-new-group-supp');
        if (suppCheckbox) suppCheckbox.checked = false;
        // Перерисуем редактор чтобы новая группа сразу появилась в таблице
        await renderAdminEditor(currentEditorEventId, true);
    } catch (e) { console.error('handleAddGroup:', e); showError('Ошибка добавления группы'); }
}

// Toggle is_supplementary: переключаем группу между основным и доп. списком.
export async function toggleGroupSupplementary(groupId, makeSupp) {
    try {
        await api.patch(`/admin/groups/${groupId}`, { is_supplementary: makeSupp });
        notify(makeSupp ? 'Группа перенесена в доп. список' : 'Группа возвращена в основной список');
        if (currentEditorEventId) {
            await renderAdminEditor(currentEditorEventId, true);
        }
    } catch (e) {
        console.error('toggleGroupSupplementary:', e);
        showError('Ошибка переноса группы');
    }
}

export async function handleDeleteEvent() {
    if (!currentEditorEventId) return;
    if (!confirm('Вы уверены, что хотите удалить этот список?\n\nВсе группы и заполненные управлениями данные будут безвозвратно удалены!')) return;
    try {
        await api.delete(`/admin/events/${currentEditorEventId}`);
        notify('Список успешно удалён');
        currentEditorEventId = null;
        el('editor-container').classList.add('hidden');
        el('editor-empty').classList.remove('hidden');
        await loadEventsDropdowns();
    } catch (e) { console.error('handleDeleteEvent:', e); showError('Ошибка при удалении списка'); }
}

// ─── Управление должностями (глобальные) ─────────────────────────────────────

export async function loadAndRenderPositions() {
    const container = el('positions-list');
    if (!container) return;
    try {
        const positions = await api.get('/admin/positions');
        // Обновляем глобальный кэш — чтобы редактор сразу видел актуальный список
        availablePositions = positions;
        container.innerHTML = positions.length
            ? positions.map(p => `
                <div class="position-item">
                    <span>${esc(p.name)}</span>
                    <button class="btn-tiny-danger" data-del-pos-id="${p.id}" title="Удалить должность">✕</button>
                </div>`).join('')
            : '<p class="hint">Нет должностей — добавьте первую</p>';
    } catch (e) { console.error('loadAndRenderPositions:', e); showError('Ошибка загрузки должностей'); }
}

export async function handleAddPosition() {
    const nameInput = el('new-position-name');
    const name      = nameInput?.value.trim();
    if (!name) return showError('Введите название должности');
    try {
        await api.post('/admin/positions', { name });
        nameInput.value = '';
        await loadAndRenderPositions();
        notify('Должность добавлена');
    } catch (e) {
        console.error('handleAddPosition:', e);
        if (e.status === 409) return showError('Должность с таким названием уже существует');
        showError('Ошибка добавления должности');
    }
}

export async function handleDeletePosition(positionId) {
    if (!confirm('Удалить должность? Она будет убрана у всех сотрудников.')) return;
    try {
        await api.delete(`/admin/positions/${positionId}`);
        notify('Должность удалена');
        await loadAndRenderPositions();
    } catch (e) { console.error('handleDeletePosition:', e); showError('Ошибка удаления должности'); }
}

// ─── Редактор таблицы ─────────────────────────────────────────────────────────

function buildPositionOptions(selectedId) {
    return availablePositions.reduce(
        (html, p) => html + `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}</option>`,
        '<option value="">— Должность —</option>'
    );
}

function buildDeptOptions(selectedDept) {
    return availableDepartments.reduce(
        (html, username) => html + `<option value="${username}"${username === selectedDept ? ' selected' : ''}>${esc(formatRole(username))}</option>`,
        '<option value="">— Управление —</option>'
    );
}

/**
 * Строит <td> для одного столбца в одной строке (слоте).
 */
function buildCell(col, slot) {
    switch (col.type) {
        case 'select_position':
            return `<td><select id="pos-${slot.id}">${buildPositionOptions(slot.position_id)}</select></td>`;

        case 'select_dept':
            return `<td><select id="dept-${slot.id}">${buildDeptOptions(slot.department)}</select></td>`;

        default: {
            let inputId, rawVal;
            if (FIELD_INPUT_PREFIX[col.key]) {
                inputId = `${FIELD_INPUT_PREFIX[col.key]}-${slot.id}`;
                rawVal  = slot[col.key] ?? '';
            } else {
                inputId = `cx-${col.key}-${slot.id}`;
                rawVal  = slot.extra_data?.[col.key] ?? '';
            }
            return `<td><input id="${inputId}" value="${esc(rawVal)}" placeholder="${esc(col.label)}"></td>`;
        }
    }
}

async function renderAdminEditor(eventId, isSilentUpdate = false) {
    const focusId    = isSilentUpdate ? document.activeElement?.id    : null;
    const focusValue = isSilentUpdate ? document.activeElement?.value : null;

    try {
        // ОПТИМИЗАЦИЯ: Должности загружаем из кэша, если они уже есть
        const [positions, data] = await Promise.all([
            availablePositions.length > 0
                ? Promise.resolve(availablePositions)
                : api.get('/admin/positions'),
            api.get(`/admin/events/${eventId}/full`),
        ]);

        availablePositions = positions;
        currentEditorData  = data;

        const allCols = data.columns || DEFAULT_COLUMNS;
        currentColumns = [...allCols].sort((a, b) => a.order - b.order);
        const visibleCols = currentColumns.filter(c => c.visible !== false);

        el('editor-container')?.classList.remove('hidden');
        el('editor-empty')?.classList.add('hidden');

        // Наполняем фильтр управлений уникальными значениями из слотов
        _populateEditorDeptFilter(data);

        if (el('editor-title')) el('editor-title').textContent = data.event.title;

        const toggleWrap = el('editor-template-toggle-wrap');
        const cb = el('editor-is-template-cb');
        if (toggleWrap && cb) {
            toggleWrap.classList.remove('hidden');
            cb.checked = data.event.is_template;
        }

        const statusBtn = el('editor-toggle-status-btn');
        if (statusBtn) {
            if (data.event.is_template) {
                statusBtn.classList.add('hidden');
            } else {
                statusBtn.classList.remove('hidden');
                const isActive        = data.event.status === 'active';
                statusBtn.textContent = isActive ? '⏸ Деактивировать' : '▶ Активировать для управлений';
                statusBtn.className   = `btn btn-sm ${isActive ? 'btn-outlined' : 'btn-success'}`;
                statusBtn.dataset.status = data.event.status;
            }
        }

        // ── Динамический заголовок таблицы ────────────────────────────────────
        // + чекбокс «выделить все» в первой колонке — для bulk-операций
        // (массовое переназначение квоты / очистка ФИО в шаблоне).
        const thead = el('master-table')?.querySelector('thead');
        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th style="width:30px; text-align:center;">
                        <input type="checkbox" class="editor-row-check" id="editor-select-all" title="Выделить все">
                    </th>
                    <th style="width:30px;">№</th>
                    ${visibleCols.map(col => `<th>${esc(col.label)}</th>`).join('')}
                    <th style="width:40px;"></th>
                </tr>`;
        }

        // ── Тело таблицы ──────────────────────────────────────────────────────
        let globalIndex = 1;
        const colspan   = visibleCols.length + 3; // чекбокс + № + столбцы + действия

        const renderGroup = (group) => {
            const isSupp = !!group.is_supplementary;
            const slotRows = group.slots.map(slot => `
                <tr data-slot-id="${slot.id}" data-version="${slot.version || 1}">
                    <td style="text-align:center;">
                        <input type="checkbox" class="editor-row-check" data-slot-check="${slot.id}">
                    </td>
                    <td style="text-align:center; color:var(--md-on-surface-hint); font-size:0.78rem;">${globalIndex++}</td>
                    ${visibleCols.map(col => buildCell(col, slot)).join('')}
                    <td style="text-align:center;">
                        <div style="display:flex; gap:4px; justify-content:center;">
                            <button class="users-v2__icon-btn" title="История изменений"
                                    onclick="window.openSlotHistory(${slot.id}, { canRevert: true })"
                                    type="button" style="width:26px; height:26px;">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                                     style="width:12px; height:12px;">
                                    <circle cx="12" cy="12" r="10"/>
                                    <polyline points="12 6 12 12 16 14"/>
                                </svg>
                            </button>
                            <button class="btn-tiny-danger" data-delete-id="${slot.id}" title="Удалить строку">✕</button>
                        </div>
                    </td>
                </tr>`).join('');

            // Кнопка-toggle: переносит группу в дополнительный список / обратно.
            // Для supplementary показываем «↑ В основной», для обычной — «↓ В доп.».
            const toggleLabel = isSupp ? '↑ В основной' : '↓ В доп.';
            const toggleTitle = isSupp
                ? 'Перенести группу в основной список'
                : 'Перенести группу в дополнительный список (отдельная таблица в Word)';

            return `
                <tr class="group-header">
                    <td colspan="${colspan}">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span class="group-header__name">${esc(group.name)}</span>
                            <div style="display:flex; gap:6px;">
                                <button class="btn btn-success btn-xs group-add-row-btn" data-group-id="${group.id}" title="Добавить пустую строку в группу">+ Строку</button>
                                <button class="btn btn-outlined btn-xs group-toggle-supp-btn" data-group-id="${group.id}" data-make-supp="${isSupp ? '0' : '1'}" title="${toggleTitle}">${toggleLabel}</button>
                                <button class="btn btn-outlined btn-xs group-delete-btn" data-group-id="${group.id}" title="Удалить группу">✕ Группу</button>
                            </div>
                        </div>
                    </td>
                </tr>
                ${slotRows}`;
        };

        const mainGroups = data.groups.filter(g => !g.is_supplementary);
        const suppGroups = data.groups.filter(g =>  g.is_supplementary);

        let tableHtml = mainGroups.map(renderGroup).join('');

        // Если есть supplementary-группы — рисуем разделитель и затем их.
        if (suppGroups.length) {
            tableHtml += `
                <tr class="group-section-divider">
                    <td colspan="${colspan}"
                        style="background:var(--md-surface-variant); border-top:2px solid var(--md-outline);
                               padding:10px 14px; text-align:center; font-weight:700;
                               color:var(--md-on-surface-variant); font-size:0.86rem;
                               text-transform:uppercase; letter-spacing:0.06em;">
                        ── Дополнительный список (отдельная таблица в Word) ──
                    </td>
                </tr>`;
            tableHtml += suppGroups.map(renderGroup).join('');
        }

        el('master-tbody').innerHTML = tableHtml;

        _bindBulkEditor();

        _applyEditorFilters();
        _updateEditorStats();

        if (focusId) {
            const focused = el(focusId);
            if (focused) {
                focused.focus();
                if (focused.tagName === 'INPUT') { focused.value = ''; focused.value = focusValue; }
            }
        }
    } catch (e) {
        console.error('renderAdminEditor:', e);
        showError(`Ошибка загрузки редактора: ${e.message ?? e}`);
    }
}

// ─── Bulk-actions в редакторе (чекбоксы + массовое переназначение) ──────────
// Стейт локальный к модулю, очищается при каждом _bindBulkEditor.
let _bulkBound = false;

function _getCheckedSlotIds() {
    return Array.from(document.querySelectorAll('[data-slot-check]:checked'))
        .map(cb => parseInt(cb.dataset.slotCheck, 10));
}

function _updateBulkBar() {
    const ids = _getCheckedSlotIds();
    const bar = document.getElementById('editor-bulk-bar');
    const cnt = document.getElementById('editor-bulk-count');
    if (!bar) return;
    if (ids.length === 0) {
        bar.classList.add('hidden');
    } else {
        bar.classList.remove('hidden');
        if (cnt) cnt.textContent = ids.length;
    }
    // Подсветка строк с чекнутыми чекбоксами
    document.querySelectorAll('#master-tbody tr[data-slot-id]').forEach(tr => {
        const cb = tr.querySelector('[data-slot-check]');
        tr.classList.toggle('editor-row--checked', !!cb?.checked);
    });
}

function _bindBulkEditor() {
    // Чекбоксы в строках
    document.querySelectorAll('[data-slot-check]').forEach(cb => {
        cb.onchange = _updateBulkBar;
    });
    // «Выделить все» в шапке
    const all = document.getElementById('editor-select-all');
    if (all) {
        all.onchange = () => {
            document.querySelectorAll('[data-slot-check]').forEach(cb => {
                // Чекаем только видимые (не скрытые фильтром) строки
                const tr = cb.closest('tr');
                if (tr && tr.style.display !== 'none') cb.checked = all.checked;
            });
            _updateBulkBar();
        };
    }

    // Глобальные кнопки — биндим один раз (на весь жизненный цикл страницы)
    if (!_bulkBound) {
        _bulkBound = true;
        document.getElementById('editor-bulk-clear')?.addEventListener('click', () => {
            document.querySelectorAll('[data-slot-check]').forEach(cb => cb.checked = false);
            const all = document.getElementById('editor-select-all');
            if (all) all.checked = false;
            _updateBulkBar();
        });
        document.getElementById('editor-bulk-reassign')?.addEventListener('click', _openBulkReassignModal);
    }

    _updateBulkBar();
}

function _openBulkReassignModal() {
    const ids = _getCheckedSlotIds();
    if (ids.length === 0) return;

    // Опции department — берём из списка активных управлений.
    // availableDepartments заполняется в loadUsers (у админа).
    const deptOpts = ['<option value="">— не менять —</option>']
        .concat((availableDepartments || []).map(u =>
            `<option value="${esc(u)}">${esc(formatRole(u))}</option>`
        ))
        .concat(['<option value="__CLEAR__" style="color:#b91c1c;">— снять квоту —</option>'])
        .join('');

    document.getElementById('bulk-reassign-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'bulk-reassign-modal';
    modal.className = 'bulk-reassign-modal';
    modal.innerHTML = `
        <div class="bulk-reassign-modal__dialog">
            <h3 class="bulk-reassign-modal__title">Массовое переназначение</h3>
            <p class="bulk-reassign-modal__hint">
                Выбрано строк: <b>${ids.length}</b>.
                Экстренная замена людей в шаблоне: смените квоту — другое управление
                начнёт заполнять, а старое получит уведомление.
            </p>

            <div class="bulk-reassign-modal__section">
                <label class="bulk-reassign-modal__label" for="bulk-re-dept">Новая квота</label>
                <select id="bulk-re-dept" style="width:100%; padding:6px 8px;
                        border:1px solid var(--md-outline-variant); border-radius:var(--md-radius-sm);
                        background:var(--md-surface); font-size:0.88rem; outline:none;">
                    ${deptOpts}
                </select>
            </div>

            <div class="bulk-reassign-modal__section">
                <label class="bulk-reassign-modal__label">Очистить поля у этих строк</label>
                <label class="bulk-reassign-modal__checkrow">
                    <input type="checkbox" id="bulk-re-clear-name">
                    ФИО, звание и № документа
                </label>
                <label class="bulk-reassign-modal__checkrow">
                    <input type="checkbox" id="bulk-re-clear-callsign">
                    Позывной
                </label>
                <label class="bulk-reassign-modal__checkrow">
                    <input type="checkbox" id="bulk-re-clear-note">
                    Примечание
                </label>
            </div>

            <div class="bulk-reassign-modal__actions">
                <button id="bulk-re-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                <button id="bulk-re-apply"  class="btn btn-success  btn-sm" type="button">Применить</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('bulk-re-cancel').addEventListener('click', () => modal.remove());

    document.getElementById('bulk-re-apply').addEventListener('click', async () => {
        const deptRaw = document.getElementById('bulk-re-dept').value;
        const payload = {
            slot_ids:       ids,
            clear_name:     document.getElementById('bulk-re-clear-name').checked,
            clear_callsign: document.getElementById('bulk-re-clear-callsign').checked,
            clear_note:     document.getElementById('bulk-re-clear-note').checked,
        };
        if (deptRaw === '__CLEAR__') payload.department = '';
        else if (deptRaw)             payload.department = deptRaw;

        // Если ничего не выбрано — нечего делать
        if (payload.department === undefined
            && !payload.clear_name
            && !payload.clear_callsign
            && !payload.clear_note) {
            showError('Выберите что изменить');
            return;
        }

        try {
            const res = await api.post('/admin/slots/bulk-patch', payload);
            notify(`Обновлено строк: ${res.updated}`);
            modal.remove();
            // Перезагружаем редактор с актуальными данными
            if (currentEditorEventId) await renderAdminEditor(currentEditorEventId);
        } catch (e) {
            console.error('bulk-patch:', e);
            showError(`Ошибка: ${e.message ?? 'неизвестная'}`);
        }
    });
}

// ─── Фильтры редактора (поиск, управление, незаполненные) ───────────────────

function _populateEditorDeptFilter(data) {
    const sel = el('editor-filter-dept');
    if (!sel) return;
    const prev = sel.value;
    const unique = new Set();
    (data.groups || []).forEach(g => (g.slots || []).forEach(s => {
        if (s.department) unique.add(s.department);
    }));
    const opts = ['<option value="">Все управления</option>']
        .concat([...unique].sort().map(d => `<option value="${esc(d)}">${esc(formatRole(d))}</option>`));
    sel.innerHTML = opts.join('');
    // Сохраняем выбранное значение, если оно ещё актуально
    if (prev && [...unique].includes(prev)) sel.value = prev;
}

function _applyEditorFilters() {
    const tbody = el('master-tbody');
    if (!tbody) return;
    const q        = (editorFilter.query || '').toLowerCase();
    const dept     = editorFilter.department || '';
    const unfilled = !!editorFilter.unfilledOnly;

    // Для каждой строки-слота решаем, показывать ли её
    let visibleCount = 0;
    tbody.querySelectorAll('tr[data-slot-id]').forEach(row => {
        // Собираем текст всех инпутов в строке для поиска
        const slotId = row.dataset.slotId;
        const inputs = row.querySelectorAll('input, select');
        let hay      = '';
        let deptVal  = '';
        let nameVal  = '';
        inputs.forEach(inp => {
            const idPrefix = inp.id.split('-')[0]; // name, rank, doc, call, note, pos, dept, cx
            if (inp.tagName === 'SELECT') {
                const opt = inp.options[inp.selectedIndex];
                const txt = opt?.textContent ?? '';
                hay += ' ' + txt.toLowerCase();
                if (idPrefix === 'dept') deptVal = inp.value || '';
            } else {
                const v = (inp.value || '').toLowerCase();
                hay += ' ' + v;
                if (idPrefix === 'name') nameVal = inp.value || '';
            }
        });

        let show = true;
        if (q        && !hay.includes(q))        show = false;
        if (dept     && deptVal !== dept)        show = false;
        if (unfilled && nameVal.trim())          show = false;

        row.style.display = show ? '' : 'none';
        if (show) visibleCount++;
    });

    // Скрываем заголовки групп, если все их строки отфильтрованы
    tbody.querySelectorAll('tr.group-header').forEach(headerRow => {
        let next = headerRow.nextElementSibling;
        let hasVisible = false;
        while (next && !next.classList.contains('group-header')) {
            if (next.style.display !== 'none') { hasVisible = true; break; }
            next = next.nextElementSibling;
        }
        const hasAnyFilter = q || dept || unfilled;
        headerRow.style.display = (hasAnyFilter && !hasVisible) ? 'none' : '';
    });

    const visEl = el('editor-stats-visible');
    if (visEl) {
        const anyFilter = q || dept || unfilled;
        if (anyFilter) {
            visEl.classList.remove('hidden');
            visEl.textContent = `Показано: ${visibleCount}`;
        } else {
            visEl.classList.add('hidden');
        }
    }
}

function _updateEditorStats() {
    if (!currentEditorData) return;
    let total = 0, filled = 0;
    (currentEditorData.groups || []).forEach(g => (g.slots || []).forEach(s => {
        total++;
        if (s.full_name && s.full_name.trim()) filled++;
    }));
    const empty = total - filled;

    const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
    set('editor-stats-total',  `Всего: ${total}`);
    set('editor-stats-filled', `✓ ${filled}`);
    set('editor-stats-empty',  `○ ${empty}`);
}

function _bindEditorFilterEvents() {
    const searchInput = el('editor-search-input');
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = '1';
        let t = null;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(t);
            t = setTimeout(() => {
                editorFilter.query = (e.target.value || '').trim();
                _applyEditorFilters();
            }, 150);
        });
    }

    const deptFilter = el('editor-filter-dept');
    if (deptFilter && !deptFilter.dataset.bound) {
        deptFilter.dataset.bound = '1';
        deptFilter.addEventListener('change', (e) => {
            editorFilter.department = e.target.value || '';
            _applyEditorFilters();
        });
    }

    const unfilledBtn = el('editor-filter-unfilled');
    if (unfilledBtn && !unfilledBtn.dataset.bound) {
        unfilledBtn.dataset.bound = '1';
        unfilledBtn.addEventListener('click', () => {
            editorFilter.unfilledOnly = !editorFilter.unfilledOnly;
            unfilledBtn.classList.toggle('btn-filled',   editorFilter.unfilledOnly);
            unfilledBtn.classList.toggle('btn-outlined', !editorFilter.unfilledOnly);
            _applyEditorFilters();
        });
    }

    const clearBtn = el('editor-filter-clear');
    if (clearBtn && !clearBtn.dataset.bound) {
        clearBtn.dataset.bound = '1';
        clearBtn.addEventListener('click', () => {
            editorFilter.query        = '';
            editorFilter.department   = '';
            editorFilter.unfilledOnly = false;
            if (searchInput) searchInput.value = '';
            if (deptFilter)  deptFilter.value  = '';
            if (unfilledBtn) {
                unfilledBtn.classList.remove('btn-filled');
                unfilledBtn.classList.add('btn-outlined');
            }
            _applyEditorFilters();
        });
    }
}

// ─── Действия со строками ─────────────────────────────────────────────────────

export async function updateAdminSlot(slotId) {
    const tr             = document.querySelector(`tr[data-slot-id="${slotId}"]`);
    const currentVersion = tr?.dataset.version ? parseInt(tr.dataset.version, 10) : 1;

    const data = {
        version:     currentVersion,
        position_id: el(`pos-${slotId}`)?.value ? parseInt(el(`pos-${slotId}`).value, 10) : null,
        department:  el(`dept-${slotId}`)?.value ?? '',
        callsign:    el(`call-${slotId}`)?.value || null,
        note:        el(`note-${slotId}`)?.value || null,
        full_name:   el(`name-${slotId}`)?.value || null,
        rank:        el(`rank-${slotId}`)?.value || null,
        doc_number:  el(`doc-${slotId}`)?.value  || null,
    };

    const extraData = {};
    let hasExtra = false;
    currentColumns.forEach(col => {
        if (!BUILTIN_KEYS.has(col.key)) {
            const input = el(`cx-${col.key}-${slotId}`);
            if (input) { extraData[col.key] = input.value || null; hasExtra = true; }
        }
    });
    if (hasExtra) data.extra_data = extraData;

    try {
        const updatedSlot = await api.put(`/admin/slots/${slotId}`, data);
        if (tr && updatedSlot?.version != null) tr.dataset.version = updatedSlot.version;

        // Обновляем кэшированные данные события для корректной статистики
        if (currentEditorData && updatedSlot) {
            (currentEditorData.groups || []).forEach(g => {
                (g.slots || []).forEach(s => {
                    if (s.id === updatedSlot.id) {
                        s.full_name  = updatedSlot.full_name;
                        s.rank       = updatedSlot.rank;
                        s.doc_number = updatedSlot.doc_number;
                        s.department = updatedSlot.department;
                        s.callsign   = updatedSlot.callsign;
                        s.note       = updatedSlot.note;
                        s.version    = updatedSlot.version;
                    }
                });
            });
            _updateEditorStats();
        }
    } catch (e) {
        console.error('updateAdminSlot:', e);
        if (e.status === 409) showError('Конфликт! Данные были изменены другим пользователем. Таблица обновляется.');
        else showError('Ошибка сохранения строки');
    }
}

export function loadAdminEditor() {
    const eventId = el('editor-event-id')?.value;
    if (!eventId) {
        // Если селект пуст — вероятно нет шаблонов. Подсказываем как создать.
        const hasOptions = Array.from(el('editor-event-id')?.options || [])
            .some(o => o.value);
        showError(hasOptions
            ? 'Выберите шаблон из выпадающего меню'
            : 'Нет шаблонов. Создайте первый через «+ Новый список»');
        return;
    }
    currentEditorEventId = eventId;
    renderAdminEditor(eventId);
}

/**
 * Автозагрузка редактора при смене выбранного шаблона в селекте.
 * Вызывается из app.js как обработчик change на #editor-event-id.
 */
export function autoLoadEditorOnChange() {
    const eventId = el('editor-event-id')?.value;
    if (!eventId) return;
    currentEditorEventId = eventId;
    renderAdminEditor(eventId);
}

/**
 * Открыть шаблон в редакторе по id. Вызывается из editor_sidebar.js
 * при клике по карточке шаблона в левом списке. Синхронизирует скрытый
 * <select id="editor-event-id"> (он используется как source-of-truth для
 * активной карточки сайдбара и некоторых обработчиков) и рендерит редактор.
 */
export function openEventInEditor(eventId) {
    if (!eventId) return;
    const sel = el('editor-event-id');
    if (sel) sel.value = String(eventId);
    currentEditorEventId = eventId;
    renderAdminEditor(eventId);
}

export async function deleteSlot(slotId) {
    if (!confirm('Удалить эту строку?')) return;
    try {
        await api.delete(`/admin/slots/${slotId}`);
        notify('Строка удалена');
        // Явный rerender — таблица не ждала WS-события и не обновлялась
        // до перезагрузки страницы.
        if (currentEditorEventId) {
            await renderAdminEditor(currentEditorEventId, true);
        }
    } catch (e) {
        console.error('deleteSlot:', e);
        showError('Ошибка удаления строки');
    }
}

export async function addBlankRow(groupId) {
    const defaultDept = availableDepartments[0] ?? 'department';
    try {
        await api.post(`/admin/groups/${groupId}/slots`,
                       { department: defaultDept, position_id: null });
        notify('Строка добавлена');
        // Явный rerender — раньше не вызывался, и пользователь думал, что
        // кнопка не работает: API срабатывал, но UI ничего не показывал
        // до прихода WS-события (которое могло опаздывать или не дойти).
        if (currentEditorEventId) {
            await renderAdminEditor(currentEditorEventId, true);
        }
    } catch (e) {
        console.error('addBlankRow:', e);
        showError('Ошибка добавления строки');
    }
}

export async function deleteGroup(groupId) {
    if (!confirm('Удалить группу вместе со всеми строками внутри?')) return;
    try {
        await api.delete(`/admin/groups/${groupId}`);
        notify('Группа удалена');
        if (currentEditorEventId) {
            await renderAdminEditor(currentEditorEventId, true);
        }
    } catch (e) {
        console.error('deleteGroup:', e);
        showError('Ошибка удаления группы');
    }
}

// ─── Редактор столбцов ────────────────────────────────────────────────────────

export async function openColumnEditor() {
    if (!currentEditorEventId) return showError('Сначала загрузите список');
    try {
        const cols = await api.get(`/admin/events/${currentEditorEventId}/columns`);
        _showColumnModal(cols);
    } catch (e) {
        console.error('openColumnEditor:', e);
        showError('Ошибка загрузки конфигурации столбцов');
    }
}

function _showColumnModal(columns) {
    el('col-editor-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'col-editor-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML = `
        <div style="background:var(--md-surface);border-radius:var(--md-radius-lg);padding:24px;width:100%;max-width:560px;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.18);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong style="font-size:1rem;">⚙ Настройка столбцов</strong>
                <button id="col-editor-close" class="btn btn-outlined btn-xs">✕ Закрыть</button>
            </div>
            <p style="font-size:0.78rem;color:var(--md-on-surface-hint);margin-bottom:14px;line-height:1.5;">
                Переименуйте, скройте, удалите или добавьте столбцы.<br>
                Стандартные столбцы можно переименовывать и скрывать, но не удалять.
            </p>
            <div id="col-editor-rows" style="display:flex;flex-direction:column;gap:6px;"></div>
            <div style="display:flex;gap:8px;margin-top:16px;padding-top:14px;border-top:1px solid var(--md-outline-variant);">
                <button id="col-add-btn"   class="btn btn-outlined btn-sm">+ Новый столбец</button>
                <div style="margin-left:auto;display:flex;gap:8px;">
                    <button id="col-reset-btn" class="btn btn-outlined btn-sm" title="Сбросить к стандартным столбцам">Сбросить</button>
                    <button id="col-save-btn"  class="btn btn-filled btn-sm">Сохранить</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);

    _renderColumnRows(columns);

    modal.addEventListener('click', e => { if (e.target === modal) _closeColumnModal(); });
    el('col-editor-close')?.addEventListener('click', _closeColumnModal);
    el('col-add-btn')?.addEventListener('click', _addColumnRow);
    el('col-reset-btn')?.addEventListener('click', () => {
        if (confirm('Сбросить к стандартным столбцам? Кастомные столбцы будут удалены из конфигурации (данные в строках сохранятся).')) {
            _renderColumnRows(JSON.parse(JSON.stringify(DEFAULT_COLUMNS)));
        }
    });
    el('col-save-btn')?.addEventListener('click', _saveColumnConfig);
}

function _renderColumnRows(columns) {
    const container = el('col-editor-rows');
    if (!container) return;

    const eyeOn  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const eyeOff = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

    container.innerHTML = columns.map((col, idx) => {
        const isBuiltin = BUILTIN_KEYS.has(col.key);
        const isVisible = col.visible !== false;
        const isFirst   = idx === 0;
        const isLast    = idx === columns.length - 1;

        return `
        <div class="col-row"
             data-idx="${idx}"
             data-key="${esc(col.key)}"
             data-type="${esc(col.type || 'text')}"
             style="display:flex;align-items:center;gap:6px;padding:7px 10px;
                    background:var(--md-surface-variant);border-radius:var(--md-radius-sm);
                    border:1px solid ${isVisible ? 'var(--md-outline-variant)' : 'transparent'};
                    opacity:${isVisible ? '1' : '0.55'};">
            <div style="display:flex;flex-direction:column;gap:1px;flex-shrink:0;">
                <button class="col-row-up  btn-tiny" data-idx="${idx}" ${isFirst ? 'disabled' : ''} style="padding:1px 5px;font-size:0.6rem;line-height:1.2;">▲</button>
                <button class="col-row-down btn-tiny" data-idx="${idx}" ${isLast  ? 'disabled' : ''} style="padding:1px 5px;font-size:0.6rem;line-height:1.2;">▼</button>
            </div>
            <input class="col-row-label" value="${esc(col.label)}" placeholder="Название"
                   style="flex:1;padding:5px 8px;border:1px solid var(--md-outline);
                          border-radius:var(--md-radius-sm);font-size:0.85rem;
                          background:var(--md-surface);min-width:0;">
            <span style="font-size:0.65rem;color:var(--md-on-surface-hint);font-family:var(--md-font-mono);
                         flex-shrink:0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                  title="${esc(col.key)}">${esc(col.key)}</span>
            <button class="col-row-vis btn btn-xs ${isVisible ? 'btn-filled' : 'btn-outlined'}"
                    data-idx="${idx}" title="${isVisible ? 'Скрыть' : 'Показать'}"
                    style="flex-shrink:0;min-width:30px;padding:4px 6px;">
                ${isVisible ? eyeOn : eyeOff}
            </button>
            ${!isBuiltin
                ? `<button class="col-row-del btn-tiny-danger" data-idx="${idx}" title="Удалить столбец" style="flex-shrink:0;">✕</button>`
                : `<span style="width:22px;flex-shrink:0;"></span>`}
        </div>`;
    }).join('');

    container.querySelectorAll('.col-row-up').forEach(btn =>
        btn.addEventListener('click', () => _moveColumnRow(parseInt(btn.dataset.idx), -1)));
    container.querySelectorAll('.col-row-down').forEach(btn =>
        btn.addEventListener('click', () => _moveColumnRow(parseInt(btn.dataset.idx), 1)));
    container.querySelectorAll('.col-row-vis').forEach(btn =>
        btn.addEventListener('click', () => _toggleColumnVis(parseInt(btn.dataset.idx))));
    container.querySelectorAll('.col-row-del').forEach(btn =>
        btn.addEventListener('click', () => _deleteColumnRow(parseInt(btn.dataset.idx))));
}

/**
 * Читает текущее состояние строк редактора из DOM.
 * Ключ и тип берём из data-атрибутов строк — они не меняются при перестановке.
 */
function _getColumnsFromModal() {
    return Array.from(document.querySelectorAll('#col-editor-rows .col-row')).map((row, idx) => ({
        key:     row.dataset.key,
        label:   row.querySelector('.col-row-label')?.value.trim() || row.dataset.key,
        type:    row.dataset.type || 'text',
        order:   idx,
        visible: row.querySelector('.col-row-vis')?.classList.contains('btn-filled') ?? true,
        custom:  !BUILTIN_KEYS.has(row.dataset.key),
        width:   120,
    }));
}

function _moveColumnRow(idx, dir) {
    const cols = _getColumnsFromModal();
    const to   = idx + dir;
    if (to < 0 || to >= cols.length) return;
    [cols[idx], cols[to]] = [cols[to], cols[idx]];
    cols.forEach((c, i) => { c.order = i; });
    _renderColumnRows(cols);
}

function _toggleColumnVis(idx) {
    const cols = _getColumnsFromModal();
    cols[idx].visible = !cols[idx].visible;
    _renderColumnRows(cols);
}

function _deleteColumnRow(idx) {
    if (!confirm('Удалить этот столбец из конфигурации?\nДанные уже заполненных строк останутся в базе.')) return;
    const cols = _getColumnsFromModal();
    cols.splice(idx, 1);
    cols.forEach((c, i) => { c.order = i; });
    _renderColumnRows(cols);
}

function _addColumnRow() {
    const cols = _getColumnsFromModal();
    cols.push({ key: `cx_${Date.now()}`, label: 'Новый столбец', type: 'text', order: cols.length, visible: true, custom: true, width: 120 });
    _renderColumnRows(cols);
    const rows = document.querySelectorAll('#col-editor-rows .col-row');
    rows[rows.length - 1]?.querySelector('.col-row-label')?.focus();
}

async function _saveColumnConfig() {
    const cols = _getColumnsFromModal();
    if (!cols.length) return showError('Нельзя сохранить пустую конфигурацию');
    try {
        await api.put(`/admin/events/${currentEditorEventId}/columns`, { columns: cols });
        currentColumns = [...cols].sort((a, b) => a.order - b.order);
        notify('Конфигурация столбцов сохранена');
        _closeColumnModal();
        renderAdminEditor(currentEditorEventId, false);
    } catch (e) {
        console.error('_saveColumnConfig:', e);
        showError('Ошибка сохранения конфигурации');
    }
}

function _closeColumnModal() { el('col-editor-modal')?.remove(); }

// ─── Управление пользователями (users-v2 — карточки + чипы + поиск) ──────────

// Каталог вкладок. Иконки inline-SVG для отображения в permission-чипах.
// При добавлении новой вкладки: добавь сюда + в AVAILABLE_PERMISSIONS
// (app/models/user.py) + в app.js:PERM_TAB_MAP (скрытие у пользователя).
const ALL_PERMISSIONS = [
    {
        key: 'lists',   label: 'Списки',          hint: 'Рабочие списки слотов',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    },
    {
        key: 'duty',    label: 'Графики нарядов', hint: 'Личные графики суточного наряда',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    },
    {
        key: 'combat',  label: 'Боевой расчёт',   hint: 'Заполнение боевых расчётов',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    },
    {
        key: 'tasks',   label: 'Календарь',       hint: 'Личные задачи и планы',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M9 16l2 2 4-4"/></svg>',
    },
    {
        key: 'persons', label: 'База людей',      hint: 'Общий справочник людей',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>',
    },
];

// Локальный кеш для клиент-сайд фильтрации (не дёргать API на каждое keypress)
let _usersCache   = [];
let _usersFilter  = 'all';   // 'all' | 'admin' | 'department'
let _usersQuery   = '';
let _usersSearchTimer = null;

// Рендер чипов — и в форме создания, и в модалке редактирования
export function renderPermsCheckboxes(selected = null, containerId = 'new-user-perms') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const active = selected === null
        ? new Set(ALL_PERMISSIONS.map(p => p.key))
        : new Set(selected || []);

    container.innerHTML = ALL_PERMISSIONS.map(p => `
        <label class="users-v2__perm-chip ${active.has(p.key) ? 'active' : ''}"
               data-perm="${p.key}" title="${esc(p.hint)}">
            <input type="checkbox" class="perm-checkbox"
                   data-perm="${p.key}"
                   ${active.has(p.key) ? 'checked' : ''}>
            ${p.icon}
            ${esc(p.label)}
        </label>
    `).join('');

    // Toggle-поведение: клик по chip переключает состояние
    container.querySelectorAll('.users-v2__perm-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
            // preventDefault — клик по label сам переключит input, но мы
            // управляем `active` классом вручную для мгновенного фидбека
            e.preventDefault();
            const cb = chip.querySelector('.perm-checkbox');
            cb.checked = !cb.checked;
            chip.classList.toggle('active', cb.checked);
        });
    });
}

function collectCheckedPerms(containerId = 'new-user-perms') {
    const container = document.getElementById(containerId);
    if (!container) return null;
    return Array.from(container.querySelectorAll('.perm-checkbox'))
        .filter(cb => cb.checked)
        .map(cb => cb.dataset.perm);
}

// Для роли 'admin' permissions неактуальны → прячем весь блок
function _togglePermsBlock() {
    const role  = el('new-role')?.value;
    const block = document.getElementById('new-user-perms-block');
    if (block) block.style.display = role === 'admin' ? 'none' : '';
}

// Получить инициалы для аватарки (первые буквы слов)
function _initials(name) {
    const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2);
    return (parts[0][0] + parts[parts.length - 1][0]);
}

// Рендер permission-иконок на карточке пользователя
function _cardPermsHtml(user) {
    if (user.role === 'admin') {
        return `<span class="users-v2__perm-icon users-v2__perm-icon--admin-all" title="Полный доступ">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            все вкладки
        </span>`;
    }
    const p = Array.isArray(user.permissions) ? user.permissions : [];
    if (p.length === 0) {
        return `<span class="users-v2__perm-icon users-v2__perm-icon--none" title="Нет доступа ни к одной вкладке">
            нет доступа
        </span>`;
    }
    return p.map(key => {
        const def = ALL_PERMISSIONS.find(x => x.key === key);
        if (!def) return '';
        return `<span class="users-v2__perm-icon" title="${esc(def.hint)}">
            ${def.icon}${esc(def.label)}
        </span>`;
    }).join('');
}

// Метка роли для бейджа на карточке. Короткая, помещается в pill.
function _roleBadge(role) {
    if (role === 'admin')      return 'Админ';
    if (role === 'unit')       return 'Отдел';
    if (role === 'department') return 'Управление';
    return role || '';
}

// Рендер одной карточки
function _renderUserCard(user) {
    const isAdmin     = user.role === 'admin';
    const isUnit      = user.role === 'unit';
    const isProtected = user.username === 'admin';
    const isInactive  = !user.is_active;

    const avatarClass = isAdmin ? 'users-v2__avatar--admin'
                       : isUnit ? 'users-v2__avatar--unit'
                       :          'users-v2__avatar--dept';
    const roleClass   = isAdmin ? 'users-v2__card-role--admin'
                       : isUnit ? 'users-v2__card-role--unit'
                       :          'users-v2__card-role--dept';
    const cardMods    = [
        isAdmin     ? 'users-v2__card--admin'    : '',
        isUnit      ? 'users-v2__card--unit'     : '',
        isInactive  ? 'users-v2__card--inactive' : '',
    ].filter(Boolean).join(' ');

    const editBtn = isProtected || isAdmin
        ? `<button class="users-v2__icon-btn users-v2__icon-btn--protected"
                   title="${isAdmin ? 'У администратора полный доступ всегда' : 'Нельзя редактировать главного администратора'}" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
           </button>`
        : `<button class="users-v2__icon-btn" data-edit-perms="${user.id}" title="Настроить доступные вкладки">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
           </button>`;

    // Кнопка «Модули операций» — только для unit-юзеров. У управлений таких
    // карточек нет (у них вкладки настраиваются обычным permissions).
    const modulesBtn = (isUnit && !isProtected)
        ? `<button class="users-v2__icon-btn" data-edit-modules="${user.id}"
                   title="Назначить модули операций (Форма 3-СВЯЗЬ, МНИ, проф. подготовка…)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
           </button>`
        : '';

    // Кнопка «Сбросить пароль» — для всех кроме защищённого main-admin.
    // Админ может назначать пароль любому пользователю принудительно
    // (на случай если юзер забыл его).
    const passwdBtn = isProtected
        ? ''
        : `<button class="users-v2__icon-btn" data-reset-password="${user.id}"
                   title="Сбросить пароль пользователю">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1"/></svg>
           </button>`;

    const delBtn = isProtected
        ? `<button class="users-v2__icon-btn users-v2__icon-btn--protected" title="Главный администратор — защищён от удаления" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
           </button>`
        : `<button class="users-v2__icon-btn users-v2__icon-btn--danger" data-delete-id="${user.id}" title="Удалить пользователя">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
           </button>`;

    return `
        <div class="users-v2__card ${cardMods}" data-user-id="${user.id}">
            <div class="users-v2__card-head">
                <div class="users-v2__avatar ${avatarClass}">${esc(_initials(formatRole(user.username)))}</div>
                <div class="users-v2__card-info">
                    <div class="users-v2__card-name">${esc(formatRole(user.username))}</div>
                    <div class="users-v2__card-login">@${esc(user.username)}${isInactive ? ' · деактивирован' : ''}</div>
                </div>
                <span class="users-v2__card-role ${roleClass}">
                    ${_roleBadge(user.role)}
                </span>
            </div>
            <div class="users-v2__card-perms">${_cardPermsHtml(user)}</div>
            ${isUnit ? `<div class="users-v2__card-modules">${_cardModulesHtml(user)}</div>` : ''}
            <div class="users-v2__card-actions">${editBtn}${modulesBtn}${passwdBtn}${delBtn}</div>
        </div>
    `;
}


// Карточные чипы с модулями отдела. Если ни одного — подсказка
// «модули не настроены», чтобы админ сразу видел юзеров требующих внимания.
const MODULE_LABELS = {
    comms:       { label: 'Форма 3-СВЯЗЬ',      icon: '📡' },
    media:       { label: 'Учёт МНИ',           icon: '💾' },
    procurement: { label: 'Гос. закупки',       icon: '📋' },
    training:    { label: 'Проф. подготовка',   icon: '🎓' },
};

function _cardModulesHtml(user) {
    const m = Array.isArray(user.modules) ? user.modules : [];
    if (m.length === 0) {
        return `<span class="users-v2__module-chip users-v2__module-chip--empty"
                       title="У отдела не настроены модули операций — карточек в «Операциях» не будет">
            модули не настроены
        </span>`;
    }
    return m.map(key => {
        const def = MODULE_LABELS[key];
        if (!def) return '';
        return `<span class="users-v2__module-chip" title="${esc(def.label)}">
            ${def.icon} ${esc(def.label)}
        </span>`;
    }).join('');
}

// Применяет текущие _usersFilter / _usersQuery к _usersCache и рендерит
function _renderUsersList() {
    const list  = document.getElementById('users-v2-list');
    const empty = document.getElementById('users-v2-empty');
    if (!list) return;

    const q = _usersQuery.toLowerCase();
    let items = _usersCache;

    if (_usersFilter !== 'all') {
        items = items.filter(u => u.role === _usersFilter);
    }
    if (q) {
        items = items.filter(u =>
            (u.username || '').toLowerCase().includes(q)
            || formatRole(u.username).toLowerCase().includes(q)
        );
    }

    if (items.length === 0) {
        list.innerHTML = '';
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');

    // Сортировка: admin → управления → отделы → остальные, внутри каждой группы
    // алфавитно по username.
    const roleRank = (r) => r === 'admin'      ? 0
                          : r === 'department' ? 1
                          : r === 'unit'       ? 2
                          :                      3;
    items = [...items].sort((a, b) => {
        const ra = roleRank(a.role), rb = roleRank(b.role);
        if (ra !== rb) return ra - rb;
        return (a.username || '').localeCompare(b.username || '', 'ru');
    });

    list.innerHTML = items.map(_renderUserCard).join('');

    // Делегирование: Настроить / Модули / Удалить
    list.querySelectorAll('[data-edit-perms]').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = parseInt(btn.dataset.editPerms, 10);
            const user   = _usersCache.find(u => u.id === userId);
            if (user) _openPermsModal(user);
        });
    });
    list.querySelectorAll('[data-edit-modules]').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = parseInt(btn.dataset.editModules, 10);
            const user   = _usersCache.find(u => u.id === userId);
            if (user) _openModulesModal(user);
        });
    });
    list.querySelectorAll('[data-reset-password]').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = parseInt(btn.dataset.resetPassword, 10);
            const user   = _usersCache.find(u => u.id === userId);
            if (user) _openPasswordResetModal(user);
        });
    });
    list.querySelectorAll('[data-delete-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = parseInt(btn.dataset.deleteId, 10);
            deleteUser(userId);
        });
    });
}


// Модалка «Сбросить пароль» — админ задаёт новый пароль любому юзеру.
// Старый пароль не требуется (это admin override). Юзеру улетит уведомление.
function _openPasswordResetModal(user) {
    document.getElementById('passwd-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'passwd-modal';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
        animation: users-v2-slide-in 0.15s ease-out;
    `;
    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:440px; width:100%; padding:22px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
                <div class="users-v2__avatar ${user.role === 'unit' ? 'users-v2__avatar--unit'
                                              : user.role === 'admin' ? 'users-v2__avatar--admin'
                                              : 'users-v2__avatar--dept'}"
                     style="width:36px; height:36px; font-size:0.82rem;">
                    ${esc(_initials(formatRole(user.username)))}
                </div>
                <div style="flex:1;">
                    <h3 style="margin:0; font-size:1.02rem; font-weight:600;">
                        Сбросить пароль
                    </h3>
                    <p style="margin:2px 0 0; font-size:0.78rem; color:var(--md-on-surface-hint);">
                        ${esc(formatRole(user.username))} · @${esc(user.username)}
                    </p>
                </div>
            </div>
            <p style="margin:12px 0 14px; font-size:0.84rem; color:var(--md-on-surface-variant); line-height:1.45;">
                Установите новый пароль. Минимум 10 символов, должен содержать
                букву и цифру. Пользователь получит уведомление о смене.
            </p>
            <div class="field" style="margin-bottom:10px;">
                <label class="field-label" for="passwd-modal-input">Новый пароль</label>
                <input type="password" id="passwd-modal-input" autocomplete="new-password"
                       placeholder="не менее 10 символов">
            </div>
            <div class="field" style="margin-bottom:14px;">
                <label class="field-label" for="passwd-modal-confirm">Повторите</label>
                <input type="password" id="passwd-modal-confirm" autocomplete="new-password">
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <label style="display:flex; align-items:center; gap:6px; font-size:0.82rem; color:var(--md-on-surface-variant); cursor:pointer;">
                    <input type="checkbox" id="passwd-modal-show"> Показать пароли
                </label>
                <div style="display:flex; gap:8px;">
                    <button id="passwd-modal-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                    <button id="passwd-modal-save"   class="btn btn-success  btn-sm" type="button">Сбросить</button>
                </div>
            </div>
            <div id="passwd-modal-error" style="display:none; margin-top:10px; padding:8px 10px;
                background:rgba(239,68,68,0.1); color:#dc2626; border-radius:6px;
                font-size:0.82rem;"></div>
        </div>
    `;
    document.body.appendChild(modal);

    const inp     = modal.querySelector('#passwd-modal-input');
    const confirm = modal.querySelector('#passwd-modal-confirm');
    const errEl   = modal.querySelector('#passwd-modal-error');
    inp.focus();

    modal.querySelector('#passwd-modal-show').addEventListener('change', (e) => {
        const t = e.target.checked ? 'text' : 'password';
        inp.type     = t;
        confirm.type = t;
    });

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#passwd-modal-cancel').addEventListener('click', () => modal.remove());

    modal.querySelector('#passwd-modal-save').addEventListener('click', async () => {
        errEl.style.display = 'none';
        const pwd  = inp.value;
        const conf = confirm.value;

        if (pwd.length < 10) {
            errEl.textContent = 'Пароль должен быть не менее 10 символов.';
            errEl.style.display = 'block'; return;
        }
        if (pwd !== conf) {
            errEl.textContent = 'Пароли не совпадают.';
            errEl.style.display = 'block'; return;
        }
        try {
            await api.put(`/admin/users/${user.id}/password`, { new_password: pwd });
            notify('Пароль сброшен');
            modal.remove();
        } catch (e) {
            errEl.textContent = e.message || 'Не удалось сменить пароль.';
            errEl.style.display = 'block';
        }
    });

    // Enter в любом из инпутов = save
    [inp, confirm].forEach(el => {
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') modal.querySelector('#passwd-modal-save').click();
        });
    });
}


// Модалка «Модули операций» — чек-боксы по AVAILABLE_MODULES.
// После сохранения юзеру уходит уведомление через WS «Перезайдите».
function _openModulesModal(user) {
    document.getElementById('modules-modal')?.remove();

    const current = new Set(Array.isArray(user.modules) ? user.modules : []);
    const modal = document.createElement('div');
    modal.id = 'modules-modal';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
        animation: users-v2-slide-in 0.15s ease-out;
    `;
    const items = Object.entries(MODULE_LABELS).map(([key, def]) => `
        <label class="users-v2__module-row">
            <input type="checkbox" data-mod="${key}" ${current.has(key) ? 'checked' : ''}>
            <span class="users-v2__module-row-icon">${def.icon}</span>
            <span class="users-v2__module-row-label">${esc(def.label)}</span>
        </label>
    `).join('');

    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:520px; width:100%; padding:22px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
                <div class="users-v2__avatar users-v2__avatar--unit"
                     style="width:36px; height:36px; font-size:0.82rem;">
                    ${esc(_initials(formatRole(user.username)))}
                </div>
                <div style="flex:1;">
                    <h3 style="margin:0; font-size:1.02rem; font-weight:600;">
                        Модули отдела «${esc(formatRole(user.username))}»
                    </h3>
                    <p style="margin:2px 0 0; font-size:0.76rem; color:var(--md-on-surface-hint);
                              font-family:var(--md-font-mono);">
                        @${esc(user.username)}
                    </p>
                </div>
            </div>
            <p style="margin:12px 0 14px; font-size:0.84rem; color:var(--md-on-surface-variant);">
                Отметьте модули операций, которые увидит этот отдел в разделе
                «Операции». Если не выбрано ничего — у отдела не будет ни одной
                карточки.
            </p>
            <div id="modules-modal-list" style="display:flex; flex-direction:column;
                                                gap:6px; margin-bottom:18px;">
                ${items}
            </div>
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button id="modules-modal-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                <button id="modules-modal-save"   class="btn btn-success  btn-sm" type="button">Сохранить</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.getElementById('modules-modal-cancel').addEventListener('click', () => modal.remove());

    document.getElementById('modules-modal-save').addEventListener('click', async () => {
        const modules = [...modal.querySelectorAll('[data-mod]:checked')]
            .map(cb => cb.dataset.mod);
        try {
            await api.put(`/admin/users/${user.id}/modules`, { modules });
            notify('Модули обновлены');
            modal.remove();
            await loadUsers();
        } catch (e) {
            console.error('save modules:', e);
            showError('Не удалось сохранить: ' + (e.message || 'ошибка'));
        }
    });
}

// Обновление статистики (5 мини-карточек в шапке).
// Отделы (role='unit') выносим отдельной колонкой рядом с управлениями.

function _renderUsersStats() {
    const total   = _usersCache.length;
    const admins  = _usersCache.filter(u => u.role === 'admin').length;
    const depts   = _usersCache.filter(u => u.role === 'department').length;
    const units   = _usersCache.filter(u => u.role === 'unit').length;
    const active  = _usersCache.filter(u => u.is_active).length;
    const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
    set('users-stat-total',  total);
    set('users-stat-admins', admins);
    set('users-stat-depts',  depts);
    set('users-stat-units',  units);
    set('users-stat-active', active);
}

export async function loadUsers() {
    try {
        const users = await api.get('/admin/users');

        // Список юзеров для выпадашки «Квота»: admin сверху, дальше — по алфавиту.
        // Так удобнее назначать строку лично админу (главные показатели и т.п.).
        availableDepartments = users
            .filter(u => u.is_active)
            .sort((a, b) => {
                if (a.role === 'admin' && b.role !== 'admin') return -1;
                if (b.role === 'admin' && a.role !== 'admin') return 1;
                return (a.username || '').localeCompare(b.username || '', 'ru');
            })
            .map(u => u.username);
        window.availableRoles  = users.map(u => u.username);

        _usersCache = users;
        _renderUsersStats();
        _renderUsersList();
    } catch (e) {
        console.error('loadUsers:', e);
        showError('Не удалось загрузить пользователей');
    }
}

// Модалка "Настроить доступ" — чипы permissions
function _openPermsModal(user) {
    const existing = document.getElementById('perms-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'perms-modal';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
        animation: users-v2-slide-in 0.15s ease-out;
    `;
    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:520px; width:100%; padding:22px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
                <div class="users-v2__avatar users-v2__avatar--dept"
                     style="width:36px; height:36px; font-size:0.82rem;">
                    ${esc(_initials(formatRole(user.username)))}
                </div>
                <div style="flex:1;">
                    <h3 style="margin:0; font-size:1.02rem; font-weight:600;">
                        ${esc(formatRole(user.username))}
                    </h3>
                    <p style="margin:2px 0 0; font-size:0.76rem; color:var(--md-on-surface-hint);
                              font-family:var(--md-font-mono);">
                        @${esc(user.username)}
                    </p>
                </div>
            </div>
            <p style="margin:12px 0 14px; font-size:0.84rem; color:var(--md-on-surface-variant);">
                Отметьте вкладки, доступные этому пользователю.
                Админ всегда видит всё.
            </p>
            <div id="perms-modal-list" class="users-v2__perms-chips"
                 style="margin-bottom:18px;"></div>
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div style="display:flex; gap:6px;">
                    <button id="perms-modal-all"  class="users-v2__perms-quick" type="button">Все</button>
                    <button id="perms-modal-none" class="users-v2__perms-quick" type="button">Ничего</button>
                </div>
                <div style="display:flex; gap:8px;">
                    <button id="perms-modal-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                    <button id="perms-modal-save"   class="btn btn-success  btn-sm" type="button">Сохранить</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    renderPermsCheckboxes(user.permissions || [], 'perms-modal-list');

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('perms-modal-cancel').addEventListener('click', () => modal.remove());

    document.getElementById('perms-modal-all').addEventListener('click', () => {
        renderPermsCheckboxes(ALL_PERMISSIONS.map(p => p.key), 'perms-modal-list');
    });
    document.getElementById('perms-modal-none').addEventListener('click', () => {
        renderPermsCheckboxes([], 'perms-modal-list');
    });

    document.getElementById('perms-modal-save').addEventListener('click', async () => {
        const perms = collectCheckedPerms('perms-modal-list');
        try {
            await api.put(`/admin/users/${user.id}/permissions`, { permissions: perms });
            notify('Доступ обновлён');
            modal.remove();
            await loadUsers();
        } catch (e) {
            console.error('save perms:', e);
            showError('Не удалось сохранить: ' + (e.message || 'ошибка'));
        }
    });
}

export async function handleCreateUser() {
    const username = el('new-username')?.value.trim();
    const password = el('new-password')?.value;
    const role     = el('new-role')?.value;
    if (!username || !password) return showError('Заполните логин и пароль');

    const payload = { username, password, role };
    if (role !== 'admin') {
        const perms = collectCheckedPerms();
        if (perms && perms.length === 0) {
            return showError('Выберите хотя бы одну вкладку для пользователя');
        }
        payload.permissions = perms;
    }

    try {
        await api.post('/admin/users', payload);
        el('new-username').value = '';
        el('new-password').value = '';
        renderPermsCheckboxes();            // сброс на "все"
        _hideCreateForm();
        notify(`Пользователь «${username}» создан`);
        await loadUsers();
    } catch (e) {
        console.error('handleCreateUser:', e);
        const msg = e.status === 409
            ? 'Пользователь с таким логином уже существует'
            : `Ошибка создания: ${e.message ?? e}`;
        showError(msg);
    }
}

export async function deleteUser(userId) {
    const user = _usersCache.find(u => u.id === userId);
    const label = user ? formatRole(user.username) : `#${userId}`;
    if (!confirm(`Удалить пользователя «${label}»?`)) return;
    try {
        await api.delete(`/admin/users/${userId}`);
        notify('Пользователь удалён');
        await loadUsers();
    } catch (e) {
        console.error('deleteUser:', e);
        showError(e.status === 403 ? (e.message ?? 'Удаление запрещено') : 'Ошибка удаления пользователя');
    }
}

// ─── Форма создания: показ / скрытие ──────────────────────────────────────────
function _showCreateForm() {
    document.getElementById('users-v2-create-form')?.classList.remove('hidden');
    setTimeout(() => el('new-username')?.focus(), 40);
}
function _hideCreateForm() {
    document.getElementById('users-v2-create-form')?.classList.add('hidden');
}

// ─── Init: вешаем обработчики поиска / фильтра / формы ───────────────────────
export function initUsersTab() {
    renderPermsCheckboxes();
    el('new-role')?.addEventListener('change', _togglePermsBlock);
    _togglePermsBlock();

    // Показ формы
    document.getElementById('users-v2-toggle-create')?.addEventListener('click', () => {
        const form = document.getElementById('users-v2-create-form');
        if (form?.classList.contains('hidden')) _showCreateForm(); else _hideCreateForm();
    });
    document.getElementById('users-v2-cancel-create')?.addEventListener('click', _hideCreateForm);

    // Быстрое «Все / Ничего» в форме создания
    document.getElementById('users-v2-perms-all')?.addEventListener('click', () => {
        renderPermsCheckboxes(ALL_PERMISSIONS.map(p => p.key), 'new-user-perms');
    });
    document.getElementById('users-v2-perms-none')?.addEventListener('click', () => {
        renderPermsCheckboxes([], 'new-user-perms');
    });

    // Поиск с debounce
    document.getElementById('users-search')?.addEventListener('input', (e) => {
        clearTimeout(_usersSearchTimer);
        _usersSearchTimer = setTimeout(() => {
            _usersQuery = e.target.value.trim();
            _renderUsersList();
        }, 220);
    });

    // Фильтр по роли
    document.querySelectorAll('[data-role-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-role-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _usersFilter = btn.dataset.roleFilter;
            _renderUsersList();
        });
    });
}

// ─── Дежурный ─────────────────────────────────────────────────────────────────

export async function loadDutyOfficer() {
    try {
        const s = await api.get('/settings');
        const rankEl = el('duty-rank'), nameEl = el('duty-name');
        if (rankEl) rankEl.value = s.duty_rank || '';
        if (nameEl) nameEl.value = s.duty_name || '';
    } catch (e) { console.error('loadDutyOfficer:', e); }
}

export async function saveDutyOfficer() {
    const rank = el('duty-rank')?.value.trim() ?? '';
    const name = el('duty-name')?.value.trim() ?? '';
    try {
        await api.patch('/settings', { duty_rank: rank, duty_name: name });
        notify(`Дежурный сохранён: ${rank} ${name}`.trim());
    } catch (e) { console.error('saveDutyOfficer:', e); showError('Ошибка сохранения дежурного'); }
}

// ─── Экспорт ──────────────────────────────────────────────────────────────────

export async function exportWord() {
    const eventId = el('export-event-id').value;
    if (!eventId) return showError('Выберите список для выгрузки');
    try {
        const blob = await api.download(`/export/events/${eventId}/export-word`);
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), { href: url, download: 'Список_выгрузка.docx' });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    } catch (e) { console.error('exportWord:', e); showError('Ошибка выгрузки в Word'); }
}

// ─── WS-обновления ───────────────────────────────────────────────────────────

export async function toggleEventStatus() {
    if (!currentEditorEventId) return;
    try {
        const res      = await api.patch(`/admin/events/${currentEditorEventId}/status`);
        const isActive = res.status === 'active';
        notify(isActive ? 'Список активирован — управления его видят' : 'Список деактивирован — скрыт от управлений');
        renderAdminEditor(currentEditorEventId, false);
    } catch (e) { console.error('toggleEventStatus:', e); showError(e.message ?? 'Ошибка изменения статуса'); }
}

export function listenForUpdates() {
    loadDutyOfficer();
    // Загружаем глобальные должности при старте
    loadAndRenderPositions();

    // Кнопка «Столбцы» статически в HTML — привязываем обработчик один раз здесь
    el('editor-columns-btn')?.addEventListener('click', openColumnEditor);

    // Поиск и фильтры в редакторе шаблонов
    _bindEditorFilterEvents();

    document.addEventListener('datachanged', ({ detail }) => {
        if (currentEditorEventId && currentEditorEventId == detail.eventId) {
            renderAdminEditor(currentEditorEventId, true);
        }
        if (!detail.eventId) loadEventsDropdowns();
    });

    el('master-tbody')?.addEventListener('click', (e) => {
        const groupDeleteBtn = e.target.closest('.group-delete-btn');
        if (groupDeleteBtn) {
            deleteGroup(groupDeleteBtn.dataset.groupId);
            return;
        }
        // Кнопки «+ Строку» в шапке группы — раньше были без обработчика.
        // Делегирование переживает rerender таблицы.
        const addRowBtn = e.target.closest('.group-add-row-btn');
        if (addRowBtn) {
            addBlankRow(addRowBtn.dataset.groupId);
            return;
        }
        // Toggle is_supplementary: перенос группы между основным/доп. списком.
        const toggleSuppBtn = e.target.closest('.group-toggle-supp-btn');
        if (toggleSuppBtn) {
            const makeSupp = toggleSuppBtn.dataset.makeSupp === '1';
            toggleGroupSupplementary(toggleSuppBtn.dataset.groupId, makeSupp);
            return;
        }
    });

    // Кнопка «+ Добавить группу» внизу редактора — handleAddGroup
    // экспортируется как обработчик, но раньше нигде не привязывалась.
    el('editor-add-group-btn')?.addEventListener('click', handleAddGroup);
    el('editor-new-group-name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleAddGroup();
        }
    });
}

// ─── Шаблоны ─────────────────────────────────────────────────────────────────

function getTargetDates() {
    const today     = new Date();
    const dayOfWeek = today.getDay();
    const addDays   = (days) => { const d = new Date(today); d.setDate(d.getDate() + days); return d; };
    const fmt       = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    return dayOfWeek === 5
        ? [fmt(addDays(1)), fmt(addDays(2)), fmt(addDays(3))]
        : [fmt(addDays(1))];
}

export async function handleInstantiateTemplate() {
    const templateId = el('template-select-id')?.value;
    if (!templateId) return showError('Выберите шаблон из списка');
    const dates    = getTargetDates();
    const WEEKDAYS = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dateStrings = dates.map(d => {
        const obj = new Date(d);
        return `${d.split('-').reverse().join('.')} (${WEEKDAYS[obj.getUTCDay()]})`;
    }).join('\n📅 ');
    if (!confirm(`Развернуть шаблон на следующие даты?\n\n📅 ${dateStrings}`)) return;
    try {
        await api.post(`/admin/events/${templateId}/instantiate`, { dates });
        notify('Списки успешно сгенерированы!');
        await loadEventsDropdowns();
    } catch (e) {
        console.error('handleInstantiateTemplate:', e);
        showError(e.status === 400 ? (e.message ?? 'Это не шаблон') : 'Ошибка генерации по шаблону');
    }
}

export async function toggleCurrentEventTemplate() {
    if (!currentEditorEventId) return;
    const isTemplate = el('editor-is-template-cb')?.checked;
    try {
        await api.patch(`/admin/events/${currentEditorEventId}/template`, { is_template: isTemplate });
        notify(`Список ${isTemplate ? 'помечен как шаблон' : 'снят с шаблонов'}`);
        await loadEventsDropdowns();
    } catch (e) {
        console.error('toggleCurrentEventTemplate:', e);
        showError('Ошибка изменения статуса');
        if (el('editor-is-template-cb')) el('editor-is-template-cb').checked = !isTemplate;
    }
}

// ─── Планировщик расписания ────────────────────────────────────────────────────

const SCHEDULE_KEY = 'weekly_schedule_v2';

const DAY_NAMES = [
    { key: 1, short: 'Пн', full: 'Понедельник' },
    { key: 2, short: 'Вт', full: 'Вторник'     },
    { key: 3, short: 'Ср', full: 'Среда'        },
    { key: 4, short: 'Чт', full: 'Четверг'      },
    { key: 5, short: 'Пт', full: 'Пятница'      },
    { key: 6, short: 'Сб', full: 'Суббота'      },
    { key: 0, short: 'Вс', full: 'Воскресенье'  },
];

let schedWeekOffset = 0;

function loadSchedule() {
    try {
        const raw = localStorage.getItem(SCHEDULE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        const result = {};
        for (const [k, v] of Object.entries(parsed)) result[k] = Array.isArray(v) ? v : (v ? [v] : []);
        return result;
    } catch { return {}; }
}

function saveScheduleToStorage(s) { localStorage.setItem(SCHEDULE_KEY, JSON.stringify(s)); }

function getWeekDates(offsetWeeks = 0) {
    const now = new Date();
    const day = now.getDay();
    const diffToMon = day === 0 ? -6 : 1 - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diffToMon + offsetWeeks * 7);
    return DAY_NAMES.map(({ key }) => {
        const diff = key === 0 ? 6 : key - 1;
        const date = new Date(monday);
        date.setDate(monday.getDate() + diff);
        return { dayKey: key, date };
    });
}

function fmtDate(d) {
    return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`;
}

function fmtIso(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// generatedTplIds — множество tpl-id которые уже сгенерированы на текущий день.
// Передаём в row чтобы пометить опции «уже создан» + дизейблить их.
// usedInOtherRows — tpl-id уже выбранные в соседних select'ах этого же дня
// (защита от выбора одного шаблона дважды в один день).
function buildTemplateRow(dayKey, selectedId, rowIdx, showRemove,
                          generatedTplIds = new Set(),
                          usedInOtherRows = new Set()) {
    const events    = getCachedEvents();
    const templates = events.filter(e => e.is_template);

    const opts = templates.map(t => {
        const isSelected  = String(t.id) === String(selectedId);
        const alreadyGen  = generatedTplIds.has(t.id);
        const usedInOther = usedInOtherRows.has(String(t.id)) && !isSelected;
        const disabled    = (alreadyGen || usedInOther) && !isSelected;
        const suffix      = alreadyGen  ? ' ✓ уже создан'
                          : usedInOther ? ' · уже выбран в этом дне'
                          : '';
        return `<option value="${t.id}"
                        ${isSelected ? 'selected' : ''}
                        ${disabled  ? 'disabled'  : ''}>${esc(t.title)}${suffix}</option>`;
    }).join('');

    // Подсвечиваем ряд если выбран шаблон который уже сгенерирован
    const rowClass = generatedTplIds.has(parseInt(selectedId))
        ? 'sched-tpl-row sched-tpl-row--already'
        : 'sched-tpl-row';

    return `
        <div class="${rowClass}" style="display:flex;gap:4px;align-items:center;margin-bottom:3px;">
            <select class="sched-day__select" style="flex:1;font-size:0.75rem;padding:3px 6px;">
                <option value="">— шаблон —</option>
                ${opts}
            </select>
            ${showRemove || rowIdx > 0
                ? `<button class="sched-tpl-remove btn btn-danger btn-xs" data-day-key="${dayKey}" data-row="${rowIdx}" title="Убрать">✕</button>`
                : ''}
        </div>`;
}

export function renderScheduleGrid() {
    const grid = document.getElementById('sched-grid');
    if (!grid) return;

    const schedule = loadSchedule();
    const dates    = getWeekDates(schedWeekOffset);
    const events   = getCachedEvents();
    const today    = new Date();
    today.setHours(0,0,0,0);

    const weekStart = dates[0].date;
    const weekEnd   = dates[6].date;
    const weekLabel = el('sched-week-label');
    if (weekLabel) weekLabel.textContent = `${fmtDate(weekStart)} — ${fmtDate(weekEnd)}.${weekEnd.getFullYear()}`;

    grid.innerHTML = dates.map(({ dayKey, date }) => {
        const dayInfo  = DAY_NAMES.find(d => d.key === dayKey);
        const dt       = new Date(date); dt.setHours(0,0,0,0);
        const today_   = new Date(today);
        const isToday  = dt.getTime() === today_.getTime();
        const past     = dt < today_;
        const weekend  = dayKey === 0 || dayKey === 6;

        const isoDate   = fmtIso(date);
        const generated = events.filter(e => !e.is_template && e.date === isoDate);

        // Set id шаблонов которые уже сгенерированы на эту дату
        const generatedTplIds = new Set(
            generated.map(e => e.source_template_id).filter(Boolean)
        );

        const generatedHtml = generated.length > 0
            ? `<div class="sched-generated-list">${generated.map(e => `
                <div class="sched-gen-item">
                    <span class="sched-gen-title">${esc(e.title)}</span>
                    <button class="sched-gen-del-btn btn btn-danger btn-xs" data-event-id="${e.id}" title="Удалить список">✕</button>
                </div>`).join('')}</div>`
            : '';

        const countBadge = generated.length > 0
            ? `<span class="sched-count-badge">${generated.length}</span>`
            : '';

        const assigned = schedule[dayKey] ?? [];
        // Уже выбранные в других строках этого дня — чтобы запретить выбор
        // того же шаблона дважды.
        const buildRows = (items) => {
            if (!items.length) {
                return buildTemplateRow(dayKey, '', 0, false, generatedTplIds, new Set());
            }
            return items.map((id, i) => {
                const otherIds = new Set(items.filter((_, j) => j !== i));
                return buildTemplateRow(dayKey, id, i, items.length > 1,
                                        generatedTplIds, otherIds);
            }).join('');
        };
        const rows = buildRows(assigned);

        const addBtn = `<button class="sched-add-tpl btn btn-outlined btn-xs" data-day-key="${dayKey}" style="margin-top:4px;width:100%;font-size:0.7rem;">+ шаблон</button>`;

        return `
            <div class="sched-day${isToday?' sched-day--today':''}${past?' sched-day--past':''}${weekend?' sched-day--weekend':''}"
                 data-day-key="${dayKey}"
                 data-gen-tpl-ids="${[...generatedTplIds].join(',')}">
                <div class="sched-day__head">
                    <span class="sched-day__short">${dayInfo.short}</span>
                    <span class="sched-day__date">${fmtDate(date)}</span>
                    ${isToday ? '<span class="sched-day__badge">сегодня</span>' : ''}
                    ${countBadge}
                </div>
                ${generatedHtml}
                <div class="sched-tpl-list" id="tpl-list-${dayKey}">${rows}</div>
                ${addBtn}
            </div>`;
    }).join('');

    _bindSchedGridEvents(grid);

    // Вешаем change-handler на select'ы — чтобы при выборе того же шаблона
    // дважды в одном дне подсветить ошибку сразу (не дожидаясь нажатия
    // «Сгенерировать»).
    document.getElementById('sched-grid')?.querySelectorAll('.sched-day__select')
        .forEach(sel => sel.addEventListener('change', _validateScheduleDay));
}

// Проверка на дубли шаблонов внутри одного дня — поместили выбор-дубль
// → красная рамка + tooltip. При генерации бэкенд всё равно отсекёт,
// но лучше показать пользователю проблему заранее.
function _validateScheduleDay(e) {
    const select = e.currentTarget;
    const list   = select.closest('.sched-tpl-list');
    if (!list) return;

    const selects = Array.from(list.querySelectorAll('.sched-day__select'));
    const values  = selects.map(s => s.value).filter(Boolean);
    const dupSet  = new Set();
    const seen    = new Set();
    for (const v of values) {
        if (seen.has(v)) dupSet.add(v);
        seen.add(v);
    }

    selects.forEach(s => {
        const isDup = s.value && dupSet.has(s.value);
        s.classList.toggle('sched-day__select--dup', isDup);
        s.title = isDup ? 'Этот шаблон уже выбран в этом дне' : '';
    });

    // Также помечаем select если выбрали шаблон уже сгенерированный
    const day = list.closest('.sched-day');
    const genIds = (day?.dataset.genTplIds || '').split(',').filter(Boolean);
    selects.forEach(s => {
        const isAlready = s.value && genIds.includes(s.value);
        s.classList.toggle('sched-day__select--already', isAlready);
        if (isAlready && !s.title) {
            s.title = 'Этот шаблон уже сгенерирован на эту дату — будет пропущен';
        }
    });
}

function _bindSchedGridEvents(grid) {
    const fresh = grid.cloneNode(true);
    grid.parentNode.replaceChild(fresh, grid);
    const g = document.getElementById('sched-grid');

    g.addEventListener('click', async (e) => {
        const addBtn    = e.target.closest('.sched-add-tpl');
        const removeBtn = e.target.closest('.sched-tpl-remove');
        const delGenBtn = e.target.closest('.sched-gen-del-btn');

        if (delGenBtn) {
            const eventId = delGenBtn.dataset.eventId;
            if (!confirm('Вы уверены, что хотите удалить этот список?\n\nВсе данные, уже заполненные управлениями на этот день, будут безвозвратно удалены!')) return;
            try {
                await api.delete(`/admin/events/${eventId}`);
                window.showSnackbar?.('Список успешно удалён', 'success');
                if (currentEditorEventId == eventId) {
                    currentEditorEventId = null;
                    document.getElementById('editor-container')?.classList.add('hidden');
                    document.getElementById('editor-empty')?.classList.remove('hidden');
                }
                await loadEventsDropdowns();
                renderScheduleGrid();
            } catch (err) {
                console.error('Delete generated event:', err);
                window.showSnackbar?.('Ошибка при удалении списка', 'error');
            }
            return;
        }

        if (addBtn) {
            const dayKey = addBtn.dataset.dayKey;
            const list   = document.getElementById(`tpl-list-${dayKey}`);
            if (!list) return;
            const newRow = document.createElement('div');
            newRow.innerHTML = buildTemplateRow(dayKey, '', list.querySelectorAll('.sched-tpl-row').length, false);
            list.appendChild(newRow.firstElementChild);
        }

        if (removeBtn) {
            const dayKey = removeBtn.dataset.dayKey;
            const rowIdx = parseInt(removeBtn.dataset.row);
            const list   = document.getElementById(`tpl-list-${dayKey}`);
            const rows   = list?.querySelectorAll('.sched-tpl-row');
            if (!rows) return;
            if (rows.length <= 1) rows[0].querySelector('select').value = '';
            else rows[rowIdx]?.remove();
        }
    });
}

function readScheduleFromGrid() {
    const schedule = {};
    DAY_NAMES.forEach(({ key }) => {
        const list = document.getElementById(`tpl-list-${key}`);
        if (!list) return;
        schedule[key] = Array.from(list.querySelectorAll('.sched-day__select')).map(s => s.value).filter(Boolean);
    });
    return schedule;
}

export function initSchedule() {
    document.getElementById('sched-prev-week') ?.addEventListener('click',  () => { schedWeekOffset--; renderScheduleGrid(); });
    document.getElementById('sched-next-week') ?.addEventListener('click',  () => { schedWeekOffset++; renderScheduleGrid(); });
    document.getElementById('sched-today-week')?.addEventListener('click',  () => { schedWeekOffset = 0; renderScheduleGrid(); });

    document.getElementById('sched-save-btn')?.addEventListener('click', () => {
        saveScheduleToStorage(readScheduleFromGrid());
        window.showSnackbar?.('Расписание сохранено', 'success');
        renderScheduleGrid();
    });

    document.getElementById('sched-generate-btn')?.addEventListener('click', async () => {
        const current = readScheduleFromGrid();
        const dates   = getWeekDates(schedWeekOffset);

        const jobs = {};
        dates.forEach(({ dayKey, date }) => {
            (current[dayKey] ?? []).filter(Boolean).forEach(tplId => {
                if (!jobs[tplId]) jobs[tplId] = [];
                jobs[tplId].push(fmtIso(date));
            });
        });

        if (Object.keys(jobs).length === 0) { window.showSnackbar?.('Нет дней с назначенными шаблонами', 'error'); return; }

        const previewLines = dates.map(({ dayKey, date }, i) => {
            const tplIds = (current[dayKey] ?? []).filter(Boolean);
            if (!tplIds.length) return null;
            const names = tplIds.map(id => document.querySelector(`#template-select-id option[value="${id}"]`)?.text ?? `#${id}`);
            return `${DAY_NAMES[i].full} ${fmtDate(date)}: ${names.join(', ')}`;
        }).filter(Boolean).join('\n');

        const totalLists = Object.values(jobs).reduce((sum, arr) => sum + arr.length, 0);
        if (!confirm(`Создать ${totalLists} ${totalLists===1?'список':totalLists<5?'списка':'списков'}?\n\n${previewLines}`)) return;

        let successCount = 0;
        const skippedByTpl = [];
        for (const [tplId, tplDates] of Object.entries(jobs)) {
            try {
                // Backend теперь возвращает { created_ids, skipped_dates, message }
                // и сам пропускает дубли. Мы показываем итоговую сводку.
                const res = await api.post(`/admin/events/${tplId}/instantiate`,
                                           { dates: tplDates });
                successCount += (res.created_ids || []).length;
                if (res.skipped_dates && res.skipped_dates.length) {
                    const name = document.querySelector(`#template-select-id option[value="${tplId}"]`)?.text ?? `#${tplId}`;
                    skippedByTpl.push({ name, dates: res.skipped_dates });
                }
            } catch (e) {
                console.error(`instantiate template ${tplId}:`, e);
                const name = document.querySelector(`#template-select-id option[value="${tplId}"]`)?.text ?? `#${tplId}`;
                window.showSnackbar?.(`«${name}»: ${e.message ?? 'ошибка'}`, 'error');
            }
        }

        if (successCount > 0) {
            const w = successCount === 1 ? 'список' : successCount < 5 ? 'списка' : 'списков';
            let msg = `Создано ${successCount} ${w}`;
            if (skippedByTpl.length) {
                const skipTotal = skippedByTpl.reduce((s, x) => s + x.dates.length, 0);
                msg += `. Пропущено дублей: ${skipTotal}`;
            }
            window.showSnackbar?.(msg, 'success');
        } else if (skippedByTpl.length) {
            const names = skippedByTpl.map(x => `«${x.name}» (${x.dates.length})`).join(', ');
            window.showSnackbar?.(`Ничего не создано — всё уже сгенерировано: ${names}`, 'error');
        }

        await loadEventsDropdowns();
        renderScheduleGrid();
    });
}