// static/js/alert_lists.js
//
// Списки оповещения (вкладка под permission='alert_lists').
//
// Два списка (id=1, id=2) сидируются миграцией. У каждого — N слотов
// (Начальник 1 упр / ЗНЦ / …), привязанных к Person из общей базы.
// На каждый день месяца ставится отметка: N (наряд), O (ответственный),
// V (отпуск). При V система ОТКРЫВАЕТ модалку выбора заместителя —
// автоматики нет, пользователь сам решает.
//
// Все данные общие: что один поставил — все видят.

import { api } from './api.js';

const ROLE_LABELS = {
    upr: 'Управление',
    otd: 'Отдел',
    cnc: 'Центр (ЗНЦ)',
};
const MARK_LABELS = {
    N: 'Наряд',
    O: 'Ответственный',
    V: 'Отпуск',
};
const MARK_COLORS = {
    N: 'var(--md-primary, #2e7d32)',
    O: 'var(--md-tertiary, #1976d2)',
    V: 'var(--md-error, #c62828)',
};

let _lists       = [];
let _activeList  = 1;
let _viewYear    = new Date().getFullYear();
let _viewMonth   = new Date().getMonth() + 1;
let _slots       = [];
let _marks       = new Map();   // key = `${slotId}:${YYYY-MM-DD}`
let _activeMode  = 'N';          // какую отметку поставит клик по ячейке


function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _markKey(slotId, dateStr) {
    return `${slotId}:${dateStr}`;
}

function _daysInMonth(y, m) {
    return new Date(y, m, 0).getDate();
}

function _dateStr(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}


// ─── Разметка ────────────────────────────────────────────────────────────

function _renderShell(root) {
    root.innerHTML = `
        <div class="al-toolbar">
            <div class="al-list-tabs" id="al-list-tabs"></div>
            <div class="al-month-nav">
                <button id="al-prev"  class="btn btn-text btn-sm" type="button">‹</button>
                <span   id="al-month-label" class="al-month-label"></span>
                <button id="al-next"  class="btn btn-text btn-sm" type="button">›</button>
                <button id="al-today" class="btn btn-text btn-sm" type="button">сегодня</button>
            </div>
            <div class="al-mode-switch">
                <span class="al-mode-label">Режим клика:</span>
                <button class="al-mode-btn" data-mode="N" type="button">Наряд</button>
                <button class="al-mode-btn" data-mode="O" type="button">Ответств.</button>
                <button class="al-mode-btn" data-mode="V" type="button">Отпуск</button>
                <button class="al-mode-btn" data-mode="clear" type="button">— снять</button>
            </div>
            <button id="al-add-slot" class="btn btn-outlined btn-sm" type="button">+ позиция</button>
        </div>
        <div id="al-grid-wrap" class="al-grid-wrap"></div>
    `;
}


function _renderListTabs() {
    const box = document.getElementById('al-list-tabs');
    if (!box) return;
    box.innerHTML = _lists.map(l => `
        <button class="al-list-tab ${l.id === _activeList ? 'al-list-tab--active' : ''}"
                data-list-id="${l.id}" type="button">${_esc(l.name)}</button>
    `).join('');
    box.querySelectorAll('.al-list-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            _activeList = parseInt(btn.dataset.listId, 10);
            _renderListTabs();
            _loadAndRender();
        });
    });
}


function _renderMonthLabel() {
    const names = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                   'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    document.getElementById('al-month-label').textContent =
        `${names[_viewMonth - 1]} ${_viewYear}`;
}


function _renderModeSwitch() {
    document.querySelectorAll('.al-mode-btn').forEach(b => {
        const isActive = b.dataset.mode === _activeMode;
        b.classList.toggle('al-mode-btn--active', isActive);
    });
}


function _renderGrid() {
    const wrap = document.getElementById('al-grid-wrap');
    if (!wrap) return;
    if (_slots.length === 0) {
        wrap.innerHTML = `<div class="al-empty">В этом списке ещё нет позиций. Добавьте первую через «+ позиция».</div>`;
        return;
    }
    const days = _daysInMonth(_viewYear, _viewMonth);

    // Шапка: пустая угловая ячейка + по одной колонке на день месяца
    let html = '<table class="al-grid"><thead><tr><th class="al-corner">Позиция</th>';
    for (let d = 1; d <= days; d++) {
        const dt = new Date(_viewYear, _viewMonth - 1, d);
        const dow = dt.getDay();   // 0=вс, 6=сб
        const cls = (dow === 0 || dow === 6) ? 'al-day al-day--weekend' : 'al-day';
        html += `<th class="${cls}">${d}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (const slot of _slots) {
        const primary = slot.primary_person;
        const titleHtml = primary
            ? `${_esc(slot.title)}<br><small>${_esc(primary.full_name)}</small>`
            : `${_esc(slot.title)}<br><small style="color:var(--md-on-surface-hint); font-style:italic;">— не назначен</small>`;
        html += `<tr data-slot-id="${slot.id}">
            <td class="al-slot-title" data-slot-edit="${slot.id}" title="Кликните чтобы изменить">
                ${titleHtml}
            </td>`;
        for (let d = 1; d <= days; d++) {
            const dateStr = _dateStr(_viewYear, _viewMonth, d);
            const m = _marks.get(_markKey(slot.id, dateStr));
            html += _renderCell(slot, dateStr, m);
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;

    // События
    wrap.querySelectorAll('[data-slot-edit]').forEach(el => {
        el.addEventListener('click', () => _openSlotEditor(parseInt(el.dataset.slotEdit, 10)));
    });
    wrap.querySelectorAll('.al-cell').forEach(cell => {
        cell.addEventListener('click', () => _onCellClick(
            parseInt(cell.dataset.slotId, 10),
            cell.dataset.date,
        ));
    });
}


function _renderCell(slot, dateStr, mark) {
    if (!mark) {
        return `<td class="al-cell" data-slot-id="${slot.id}" data-date="${dateStr}"></td>`;
    }
    const t = mark.mark_type;
    let label = t;
    let inner = `<span class="al-mark al-mark--${t}" title="${MARK_LABELS[t] || t}">${label}</span>`;
    if (t === 'V' && mark.substitute_person) {
        inner += `<span class="al-cell-sub" title="Замещает: ${_esc(mark.substitute_person.full_name)}">↳ ${_esc(mark.substitute_person.full_name)}</span>`;
    }
    return `<td class="al-cell al-cell--marked" data-slot-id="${slot.id}" data-date="${dateStr}">${inner}</td>`;
}


// ─── Загрузка данных ─────────────────────────────────────────────────────

async function _loadLists() {
    try {
        _lists = await api.get('/alert-lists/');
    } catch (err) {
        window.showSnackbar?.(`Не удалось загрузить списки: ${err?.message || err}`, 'error');
        _lists = [];
    }
    if (_lists.length > 0 && !_lists.some(l => l.id === _activeList)) {
        _activeList = _lists[0].id;
    }
}


async function _loadAndRender() {
    await Promise.all([_loadSlots(), _loadMarks()]);
    _renderGrid();
}


async function _loadSlots() {
    try {
        _slots = await api.get(`/alert-lists/${_activeList}/slots`);
    } catch (err) {
        window.showSnackbar?.(`Слоты: ${err?.message || err}`, 'error');
        _slots = [];
    }
}


async function _loadMarks() {
    try {
        const rows = await api.get(`/alert-lists/${_activeList}/marks?year=${_viewYear}&month=${_viewMonth}`);
        _marks = new Map();
        for (const m of rows) {
            _marks.set(_markKey(m.slot_id, m.mark_date), m);
        }
    } catch (err) {
        _marks = new Map();
    }
}


// ─── Клик по ячейке: ставим/снимаем отметку ──────────────────────────────

async function _onCellClick(slotId, dateStr) {
    if (_activeMode === 'clear') {
        try {
            await api.delete(`/alert-lists/slots/${slotId}/marks/${dateStr}`);
            _marks.delete(_markKey(slotId, dateStr));
            _renderGrid();
        } catch (err) {
            window.showSnackbar?.(`Не удалось снять: ${err?.message || err}`, 'error');
        }
        return;
    }

    if (_activeMode === 'V') {
        // Отпуск — обязательно спрашиваем зама перед сохранением
        const slot = _slots.find(s => s.id === slotId);
        if (!slot) return;
        const sub = await _openSubstitutePicker(slot);
        if (!sub) return;   // отмена
        try {
            const m = await api.put(`/alert-lists/slots/${slotId}/marks/${dateStr}`, {
                mark_type: 'V',
                substitute_person_id: sub.id,
            });
            _marks.set(_markKey(slotId, dateStr), m);
            _renderGrid();
        } catch (err) {
            window.showSnackbar?.(`Не удалось: ${err?.message || err}`, 'error');
        }
        return;
    }

    // N или O — без зама
    try {
        const m = await api.put(`/alert-lists/slots/${slotId}/marks/${dateStr}`, {
            mark_type: _activeMode,
        });
        _marks.set(_markKey(slotId, dateStr), m);
        _renderGrid();
    } catch (err) {
        window.showSnackbar?.(`Не удалось: ${err?.message || err}`, 'error');
    }
}


// ─── Модалка «выбрать зама» ─────────────────────────────────────────────

function _openSubstitutePicker(slot) {
    return new Promise((resolve) => {
        document.getElementById('al-subst-modal')?.remove();

        // Фильтр для upr/otd: подбираем из позиции «корень» — то общее,
        // что отличает управление/отдел. Берём слова без «начальник»/«зам.»
        // — например, из «Начальник 5 упр» → «5 упр».
        let root = '';
        if (slot.role_kind === 'upr' || slot.role_kind === 'otd') {
            root = (slot.title || '')
                .replace(/начальник[аи]?/ig, '')
                .replace(/зам\.?/ig, '')
                .replace(/^\s+|\s+$/g, '')
                .replace(/\s+/g, ' ');
        }

        const modal = document.createElement('div');
        modal.id = 'al-subst-modal';
        modal.className = 'al-modal';
        modal.innerHTML = `
            <div class="al-modal-card">
                <h3 class="al-modal-title">Выбрать заместителя на день</h3>
                <p class="al-modal-hint">
                    Позиция: <b>${_esc(slot.title)}</b> · ${ROLE_LABELS[slot.role_kind] || slot.role_kind}
                    ${root ? `<br>Фильтр по должности: <code>${_esc(root)}</code>` : ''}
                </p>
                <input id="al-subst-search" type="text" placeholder="Поиск по ФИО…" />
                <div id="al-subst-list" class="al-subst-list"></div>
                <div class="al-modal-actions">
                    <button id="al-subst-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const listEl = modal.querySelector('#al-subst-list');
        const inputEl = modal.querySelector('#al-subst-search');

        async function _runSearch(q) {
            const params = new URLSearchParams();
            if (q) params.set('q', q);
            if (slot.role_kind) params.set('role', slot.role_kind);
            if (root) params.set('root', root);
            try {
                const items = await api.get(`/alert-lists/persons/search?${params.toString()}`);
                _renderList(items);
            } catch (err) {
                listEl.innerHTML = `<div class="al-empty">Ошибка: ${_esc(err?.message || err)}</div>`;
            }
        }

        function _renderList(items) {
            if (!items || items.length === 0) {
                listEl.innerHTML = '<div class="al-empty">Никого не найдено</div>';
                return;
            }
            listEl.innerHTML = items.map(p => `
                <div class="al-subst-row" data-person-id="${p.id}">
                    <div class="al-subst-row__name">${_esc(p.full_name)}</div>
                    <div class="al-subst-row__meta">
                        ${p.rank ? `<span>${_esc(p.rank)}</span>` : ''}
                        ${p.position_title ? `<span>${_esc(p.position_title)}</span>` : ''}
                    </div>
                </div>
            `).join('');
            listEl.querySelectorAll('.al-subst-row').forEach(row => {
                row.addEventListener('click', () => {
                    const idx = items.findIndex(p => p.id === parseInt(row.dataset.personId, 10));
                    close();
                    resolve(items[idx]);
                });
            });
        }

        const close = () => {
            modal.remove();
            document.removeEventListener('keydown', onKey);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { close(); resolve(null); }
        };
        modal.querySelector('#al-subst-cancel').addEventListener('click', () => { close(); resolve(null); });
        modal.addEventListener('click', e => { if (e.target === modal) { close(); resolve(null); } });
        document.addEventListener('keydown', onKey);

        // debounced поиск
        let timer = null;
        inputEl.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => _runSearch(inputEl.value.trim()), 200);
        });

        _runSearch('');
        inputEl.focus();
    });
}


// ─── Редактор слота: title/role/primary ─────────────────────────────────

async function _openSlotEditor(slotId) {
    const slot = _slots.find(s => s.id === slotId);
    if (!slot) return;
    document.getElementById('al-slot-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'al-slot-modal';
    modal.className = 'al-modal';
    modal.innerHTML = `
        <div class="al-modal-card">
            <h3 class="al-modal-title">Редактирование позиции</h3>
            <label class="al-field">
                Название
                <input id="al-slot-title" type="text" value="${_esc(slot.title)}" />
            </label>
            <label class="al-field">
                Тип
                <select id="al-slot-role">
                    <option value="upr" ${slot.role_kind === 'upr' ? 'selected' : ''}>Управление</option>
                    <option value="otd" ${slot.role_kind === 'otd' ? 'selected' : ''}>Отдел</option>
                    <option value="cnc" ${slot.role_kind === 'cnc' ? 'selected' : ''}>Центр (ЗНЦ)</option>
                </select>
            </label>
            <label class="al-field">
                Основной (primary)
                <div class="al-primary-pick">
                    <span id="al-primary-current">${slot.primary_person
                        ? _esc(slot.primary_person.full_name)
                        : '— не назначен —'}</span>
                    <button id="al-primary-edit" class="btn btn-text btn-sm" type="button">изменить</button>
                    ${slot.primary_person
                        ? '<button id="al-primary-clear" class="btn btn-text btn-sm" type="button">снять</button>'
                        : ''}
                </div>
            </label>
            <div class="al-modal-actions">
                <button id="al-slot-del"    class="btn btn-danger   btn-sm" type="button">Удалить позицию</button>
                <div style="flex:1"></div>
                <button id="al-slot-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                <button id="al-slot-save"   class="btn btn-success  btn-sm" type="button">Сохранить</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    let pickedPrimaryId = slot.primary_person_id ?? null;
    let primaryChanged  = false;

    const close = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelector('#al-slot-cancel').addEventListener('click', close);

    modal.querySelector('#al-primary-edit').addEventListener('click', async () => {
        const fakeSlot = {
            ...slot,
            role_kind: modal.querySelector('#al-slot-role').value,
            title:     modal.querySelector('#al-slot-title').value,
        };
        const p = await _openSubstitutePicker(fakeSlot);
        if (!p) return;
        pickedPrimaryId = p.id;
        primaryChanged  = true;
        modal.querySelector('#al-primary-current').textContent = p.full_name;
    });
    modal.querySelector('#al-primary-clear')?.addEventListener('click', () => {
        pickedPrimaryId = null;
        primaryChanged  = true;
        modal.querySelector('#al-primary-current').textContent = '— не назначен —';
    });

    modal.querySelector('#al-slot-del').addEventListener('click', async () => {
        if (!confirm(`Удалить позицию «${slot.title}»? Все её отметки тоже удалятся.`)) return;
        try {
            await api.delete(`/alert-lists/slots/${slot.id}`);
            close();
            await _loadAndRender();
        } catch (err) {
            window.showSnackbar?.(`Не удалось: ${err?.message || err}`, 'error');
        }
    });

    modal.querySelector('#al-slot-save').addEventListener('click', async () => {
        const payload = {
            title:     modal.querySelector('#al-slot-title').value.trim(),
            role_kind: modal.querySelector('#al-slot-role').value,
        };
        if (primaryChanged) {
            payload.primary_person_id     = pickedPrimaryId;
            payload.primary_person_id_set = true;
        }
        try {
            await api.patch(`/alert-lists/slots/${slot.id}`, payload);
            close();
            await _loadAndRender();
        } catch (err) {
            window.showSnackbar?.(`Не сохранено: ${err?.message || err}`, 'error');
        }
    });
}


async function _addSlot() {
    const title = prompt('Название новой позиции (например, «Начальник 5 управления»):');
    if (!title) return;
    const role = (prompt('Тип: upr (управление) / otd (отдел) / cnc (центр)? [upr]', 'upr') || 'upr').trim();
    if (!['upr', 'otd', 'cnc'].includes(role)) {
        window.showSnackbar?.('Тип должен быть upr / otd / cnc', 'error');
        return;
    }
    try {
        await api.post(`/alert-lists/${_activeList}/slots`, {
            title,
            role_kind: role,
            sort_order: _slots.length,
        });
        await _loadAndRender();
    } catch (err) {
        window.showSnackbar?.(`Не создано: ${err?.message || err}`, 'error');
    }
}


// ─── Public API ───────────────────────────────────────────────────────────

export async function initAlertLists(rootId) {
    const root = document.getElementById(rootId);
    if (!root) return;
    _renderShell(root);

    document.getElementById('al-prev').addEventListener('click', async () => {
        _viewMonth -= 1;
        if (_viewMonth < 1) { _viewMonth = 12; _viewYear -= 1; }
        _renderMonthLabel();
        await _loadMarks();
        _renderGrid();
    });
    document.getElementById('al-next').addEventListener('click', async () => {
        _viewMonth += 1;
        if (_viewMonth > 12) { _viewMonth = 1; _viewYear += 1; }
        _renderMonthLabel();
        await _loadMarks();
        _renderGrid();
    });
    document.getElementById('al-today').addEventListener('click', async () => {
        const now = new Date();
        _viewYear  = now.getFullYear();
        _viewMonth = now.getMonth() + 1;
        _renderMonthLabel();
        await _loadMarks();
        _renderGrid();
    });
    document.querySelectorAll('.al-mode-btn').forEach(b => {
        b.addEventListener('click', () => {
            _activeMode = b.dataset.mode;
            _renderModeSwitch();
        });
    });
    document.getElementById('al-add-slot').addEventListener('click', _addSlot);

    await _loadLists();
    _renderListTabs();
    _renderMonthLabel();
    _renderModeSwitch();
    await _loadAndRender();
}

export async function reloadAlertLists() {
    await _loadAndRender();
}
