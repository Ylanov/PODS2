// static/js/dept_persons.js
//
// «База людей» для управления (department). Два режима:
//   mine       — люди, приписанные к этому управлению (department == username).
//                Здесь можно редактировать / удалять (пользователь — владелец).
//   unassigned — «Личный состав» без управления (department IS NULL).
//                Read-only — показывается как общий резерв, доступный всем.
//
// Переиспользует /persons c серверной пагинацией; для unassigned-режима бэк
// отдаёт записи с Person.department IS NULL (параметр ?unassigned=true).

import { api } from './api.js';
import { formatRole } from './ui.js';
import { attach as attachFio } from './fio_autocomplete.js';

// ─── Состояние ────────────────────────────────────────────────────────────────

const _state = {
    mode:        'mine',   // 'mine' | 'unassigned'
    page:        1,
    limit:       50,
    total:       0,
    pages:       1,
    q:           '',
    sort:        'full_name',
    order:       'asc',
    items:       [],
    editingId:   null,     // только для режима mine
    initedDom:   false,
    loading:     false,
};

let _searchTimer = null;

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function _esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
}

function _isReadonly() { return _state.mode === 'unassigned'; }

// ─── Публичный API ────────────────────────────────────────────────────────────

export async function initDeptPersons() {
    _renderShell();
    await loadDeptPersons();
}

export async function loadDeptPersons(opts = {}) {
    if (opts.mode  !== undefined) { _state.mode  = opts.mode; _state.page = 1; _state.editingId = null; }
    if (opts.page  !== undefined) _state.page  = opts.page;
    if (opts.limit !== undefined) _state.limit = opts.limit;
    if (opts.q     !== undefined) _state.q     = opts.q;
    if (opts.sort  !== undefined) _state.sort  = opts.sort;
    if (opts.order !== undefined) _state.order = opts.order;

    if (_state.loading) return;
    _state.loading = true;

    const tbody = document.getElementById('dept-persons-tbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:28px; color:var(--md-on-surface-hint);">Загрузка…</td></tr>`;

    try {
        const params = new URLSearchParams();
        params.set('page',  String(_state.page));
        params.set('limit', String(_state.limit));
        params.set('sort',  _state.sort);
        params.set('order', _state.order);
        if (_state.q) params.set('q', _state.q);
        // Режимы взаимоисключающие: бэк принимает один из двух флагов.
        // Без флага — "свои + общие" (fallback), но во вкладке "Мои люди"
        // нам нужен СТРОГО только свой management — отсюда mine=true.
        if (_state.mode === 'unassigned') {
            params.set('unassigned', 'true');
        } else if (_state.mode === 'mine') {
            params.set('mine', 'true');
        }

        const res = await api.get(`/persons?${params.toString()}`);
        _state.items = res.items || [];
        _state.total = res.total ?? 0;
        _state.pages = res.pages ?? 1;
        _state.page  = res.page  ?? _state.page;
        _state.limit = res.limit ?? _state.limit;

        _renderStats();
        _renderTable();
        _renderPagination();
    } catch (err) {
        console.error('[dept_persons] load:', err);
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:28px; color:var(--md-error, #E24B4A);">Ошибка загрузки</td></tr>`;
        window.showSnackbar?.('Не удалось загрузить базу людей', 'error');
    } finally {
        _state.loading = false;
    }
}

// ─── Shell (разметка тулбара и таблицы) ───────────────────────────────────────

function _renderShell() {
    const root = document.getElementById('dept-persons-root');
    if (!root) return;

    root.innerHTML = `
        <!-- Режимы: Мои люди / Личный состав -->
        <div style="padding:14px 18px; border-bottom:1px solid var(--md-outline-variant);
                    display:flex; align-items:center; justify-content:space-between;
                    gap:12px; flex-wrap:wrap;">
            <div style="display:inline-flex; background:var(--md-surface-variant);
                        border-radius:var(--md-radius-full, 999px); padding:3px; gap:2px;">
                <button class="dept-persons-mode-btn" data-mode="mine" type="button"
                        style="display:inline-flex; align-items:center; gap:6px; padding:6px 14px;
                               border:none; border-radius:var(--md-radius-full, 999px);
                               font-size:0.82rem; font-weight:500; cursor:pointer;
                               background:var(--md-primary); color:white;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                        <circle cx="9" cy="7" r="4"/>
                    </svg>
                    Мои люди
                </button>
                <button class="dept-persons-mode-btn" data-mode="unassigned" type="button"
                        style="display:inline-flex; align-items:center; gap:6px; padding:6px 14px;
                               border:none; border-radius:var(--md-radius-full, 999px);
                               font-size:0.82rem; font-weight:500; cursor:pointer;
                               background:transparent; color:var(--md-on-surface-variant);"
                        title="Люди без управления — общий резерв, доступный всем управлениям">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>
                        <circle cx="13" cy="7" r="4"/>
                        <path d="M3 11l2 2 4-4"/>
                    </svg>
                    Личный состав
                </button>
            </div>

            <!-- Поиск -->
            <div style="display:flex; align-items:center; gap:6px;
                        background:var(--md-surface-variant);
                        border-radius:var(--md-radius-sm); padding:4px 10px;
                        flex:1; min-width:220px; max-width:360px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     style="color:var(--md-on-surface-hint); flex-shrink:0;">
                    <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                </svg>
                <input type="text" id="dept-persons-search" placeholder="Поиск по ФИО…" autocomplete="off"
                       style="flex:1; border:none; background:transparent; outline:none;
                              font-size:0.82rem; color:var(--md-on-surface);">
            </div>

            <!-- Правая часть: + Добавить (только в режиме mine) -->
            <div style="display:flex; gap:8px; align-items:center;">
                <button id="dept-persons-add-btn" class="btn btn-success btn-sm" type="button">
                    + Добавить
                </button>
            </div>
        </div>

        <!-- Стат-строка -->
        <div id="dept-persons-stats"
             style="display:flex; gap:16px; padding:8px 20px;
                    background:var(--md-surface-variant);
                    border-bottom:1px solid var(--md-outline-variant);
                    font-size:0.78rem; color:var(--md-on-surface-variant); flex-wrap:wrap;">
            <span>Всего: <b id="dept-persons-stat-total">—</b></span>
            <span>Показано: <b id="dept-persons-stat-visible">—</b></span>
            <span id="dept-persons-mode-hint" style="color:var(--md-on-surface-hint);"></span>
        </div>

        <!-- Форма добавления (скрыта по умолчанию, только для mine) -->
        <div id="dept-persons-add-form" class="hidden"
             style="padding:14px 20px; border-bottom:1px solid var(--md-outline-variant);
                    background:var(--md-surface-variant);
                    display:none; flex-direction:column; gap:8px;">
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <div class="field" style="flex:2; min-width:200px;">
                    <label class="field-label" for="dp-fullname">ФИО</label>
                    <input type="text" id="dp-fullname" placeholder="Иванов Иван Иванович" autocomplete="off">
                </div>
                <div class="field" style="flex:1; min-width:130px;">
                    <label class="field-label" for="dp-rank">Звание</label>
                    <input type="text" id="dp-rank" placeholder="подполковник">
                </div>
                <div class="field" style="flex:1; min-width:130px;">
                    <label class="field-label" for="dp-doc">№ Документа</label>
                    <input type="text" id="dp-doc" placeholder="АБ123456">
                </div>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <div class="field" style="flex:1; min-width:140px;">
                    <label class="field-label" for="dp-pos">Должность</label>
                    <input type="text" id="dp-pos" placeholder="Начальник отдела">
                </div>
                <div class="field" style="flex:1; min-width:120px;">
                    <label class="field-label" for="dp-birth">Дата рожд.</label>
                    <input type="date" id="dp-birth">
                </div>
                <div class="field" style="flex:1; min-width:120px;">
                    <label class="field-label" for="dp-phone">Телефон</label>
                    <input type="text" id="dp-phone" placeholder="+7...">
                </div>
                <div class="field" style="flex:2; min-width:160px;">
                    <label class="field-label" for="dp-notes">Примечание</label>
                    <input type="text" id="dp-notes" placeholder="Доп. информация">
                </div>
                <div style="display:flex; gap:6px; align-items:flex-end;">
                    <button id="dept-persons-save-btn"   class="btn btn-filled btn-sm"   type="button">Сохранить</button>
                    <button id="dept-persons-cancel-btn" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                </div>
            </div>
        </div>

        <!-- Таблица -->
        <div class="data-table-wrap">
            <table id="dept-persons-table">
                <thead>
                    <tr>
                        <th style="width:44px;">ID</th>
                        <th style="min-width:200px; cursor:pointer;" class="dp-sort-th" data-sort="full_name">
                            ФИО <span class="dp-sort-ind" data-for="full_name"></span>
                        </th>
                        <th style="min-width:100px; cursor:pointer;" class="dp-sort-th" data-sort="rank">
                            Звание <span class="dp-sort-ind" data-for="rank"></span>
                        </th>
                        <th style="min-width:120px;">№ Документа</th>
                        <th style="min-width:140px;">Должность</th>
                        <th style="min-width:110px;">Телефон</th>
                        <th style="min-width:100px;">Действия</th>
                    </tr>
                </thead>
                <tbody id="dept-persons-tbody"></tbody>
            </table>
        </div>

        <!-- Пагинация -->
        <div id="dept-persons-pagination"></div>
    `;

    _bindShellEvents();
    _state.initedDom = true;
}

function _bindShellEvents() {
    // Переключение режимов
    document.querySelectorAll('.dept-persons-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            _updateModeButtons(mode);
            loadDeptPersons({ mode });
        });
    });

    // Поиск (debounce)
    document.getElementById('dept-persons-search')?.addEventListener('input', (e) => {
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(() => {
            loadDeptPersons({ q: (e.target.value || '').trim(), page: 1 });
        }, 280);
    });

    // Сортировка
    document.querySelectorAll('.dp-sort-th').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (!col) return;
            const nextOrder = (_state.sort === col && _state.order === 'asc') ? 'desc' : 'asc';
            loadDeptPersons({ sort: col, order: nextOrder, page: 1 });
        });
    });

    // Кнопка «+ Добавить» / показать форму
    document.getElementById('dept-persons-add-btn')?.addEventListener('click', () => {
        if (_state.mode === 'unassigned') {
            window.showSnackbar?.('В «Личный состав» новых людей добавляет администратор', 'error');
            return;
        }
        const f = document.getElementById('dept-persons-add-form');
        if (!f) return;
        const visible = !f.classList.contains('hidden');
        f.classList.toggle('hidden', visible);
        f.style.display = visible ? 'none' : 'flex';
        if (!visible) setTimeout(() => document.getElementById('dp-fullname')?.focus(), 40);
    });

    document.getElementById('dept-persons-cancel-btn')?.addEventListener('click', _hideAddForm);
    document.getElementById('dept-persons-save-btn')?.addEventListener('click', _saveNewPerson);

    // Автокомплит ФИО в форме добавления: при выборе подтягиваем всю
    // информацию из общей базы (звание, №, должность, дата рождения,
    // телефон) — пользователь видит, что такой человек уже есть, и
    // может нажать «Сохранить»: сервер ответит 409 (дубликат) и покажет
    // подсказку «такой уже есть, обратитесь к админу».
    const fioInput = document.getElementById('dp-fullname');
    if (fioInput) {
        attachFio(fioInput, {
            container: fioInput.parentElement, // .field
            onSelect: (person) => {
                const set = (id, val) => {
                    const el = document.getElementById(id);
                    if (el && val != null) el.value = val;
                };
                set('dp-fullname', person.full_name);
                set('dp-rank',     person.rank);
                set('dp-doc',      person.doc_number);
                set('dp-pos',      person.position_title);
                set('dp-birth',    person.birth_date);
                set('dp-phone',    person.phone);
                set('dp-notes',    person.notes);
                if (person.is_exact) {
                    window.showSnackbar?.(
                        person.department === null || person.department === undefined
                            ? `«${person.full_name}» уже в общей базе — обратитесь к админу для перевода`
                            : `«${person.full_name}» уже в вашей базе`,
                        'info',
                    );
                }
            },
        });
    }

    // Делегирование действий в таблице
    document.getElementById('dept-persons-tbody')?.addEventListener('click', (e) => {
        const editBtn   = e.target.closest('.dp-edit-btn');
        const delBtn    = e.target.closest('.dp-del-btn');
        const saveBtn   = e.target.closest('.dp-save-btn');
        const cancelBtn = e.target.closest('.dp-cancel-btn');

        if (editBtn)   _startEditRow(parseInt(editBtn.dataset.pid, 10));
        if (delBtn)    _deleteRow(parseInt(delBtn.dataset.pid, 10));
        if (saveBtn)   _saveEditRow(parseInt(saveBtn.dataset.pid, 10));
        if (cancelBtn) _cancelEditRow();
    });
}

function _updateModeButtons(mode) {
    _state.mode = mode;
    document.querySelectorAll('.dept-persons-mode-btn').forEach(btn => {
        const active = btn.dataset.mode === mode;
        btn.style.background = active ? 'var(--md-primary)' : 'transparent';
        btn.style.color      = active ? 'white'              : 'var(--md-on-surface-variant)';
    });
    // Для unassigned — прячем форму добавления и кнопку
    const addBtn = document.getElementById('dept-persons-add-btn');
    if (addBtn) addBtn.style.display = mode === 'unassigned' ? 'none' : '';
    _hideAddForm();
}

function _renderStats() {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('dept-persons-stat-total',   _state.total);
    set('dept-persons-stat-visible', _state.items.length);

    const hint = document.getElementById('dept-persons-mode-hint');
    if (hint) {
        hint.textContent = _state.mode === 'unassigned'
            ? '«Личный состав» — общий резерв без управления (только просмотр)'
            : 'Сотрудники вашего управления';
    }
}

// ─── Таблица ──────────────────────────────────────────────────────────────────

function _renderTable() {
    const tbody = document.getElementById('dept-persons-tbody');
    if (!tbody) return;

    _updateSortIndicators();

    if (_state.items.length === 0) {
        const msg = _state.mode === 'unassigned'
            ? 'Свободных людей (без управления) нет'
            : 'В вашем управлении пока нет сотрудников. Добавьте через кнопку «+ Добавить».';
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:32px; color:var(--md-on-surface-hint); font-size:0.85rem;">${msg}</td></tr>`;
        return;
    }

    const readonly = _isReadonly();

    tbody.innerHTML = _state.items.map(p => {
        // Режим редактирования
        if (_state.editingId === p.id && !readonly) {
            return `
                <tr data-pid="${p.id}" style="background:var(--md-primary-light);">
                    <td style="color:var(--md-on-surface-hint); font-family:var(--md-font-mono); font-size:0.72rem;">${p.id}</td>
                    <td><input id="dp-edit-name-${p.id}"  value="${_esc(p.full_name)}"      class="person-inline-input"></td>
                    <td><input id="dp-edit-rank-${p.id}"  value="${_esc(p.rank||'')}"       class="person-inline-input"></td>
                    <td><input id="dp-edit-doc-${p.id}"   value="${_esc(p.doc_number||'')}" class="person-inline-input"></td>
                    <td><input id="dp-edit-pos-${p.id}"   value="${_esc(p.position_title||'')}" class="person-inline-input"></td>
                    <td><input id="dp-edit-phone-${p.id}" value="${_esc(p.phone||'')}"      class="person-inline-input"></td>
                    <td>
                        <div style="display:flex; gap:4px;">
                            <button class="btn btn-filled btn-xs dp-save-btn"   data-pid="${p.id}" type="button" title="Сохранить">✓</button>
                            <button class="btn btn-outlined btn-xs dp-cancel-btn" type="button" title="Отмена">✕</button>
                        </div>
                    </td>
                </tr>`;
        }

        // Режим просмотра
        const actions = readonly
            ? `<span style="font-size:0.72rem; color:var(--md-on-surface-hint);">— общий —</span>`
            : `
                <div style="display:flex; gap:4px;">
                    <button class="btn btn-outlined btn-xs dp-edit-btn" data-pid="${p.id}" type="button" title="Редактировать">✎</button>
                    <button class="btn btn-danger   btn-xs dp-del-btn"  data-pid="${p.id}" type="button" title="Удалить">✕</button>
                </div>`;

        return `
            <tr data-pid="${p.id}">
                <td style="color:var(--md-on-surface-hint); font-family:var(--md-font-mono); font-size:0.72rem;">${p.id}</td>
                <td style="font-weight:500;">${_esc(p.full_name)}</td>
                <td>${_esc(p.rank || '—')}</td>
                <td>${_esc(p.doc_number || '—')}</td>
                <td><span style="font-size:0.8rem; color:var(--md-on-surface-variant);">${_esc(p.position_title || '—')}</span></td>
                <td style="font-size:0.8rem; white-space:nowrap;">${_esc(p.phone || '—')}</td>
                <td>${actions}</td>
            </tr>`;
    }).join('');
}

function _updateSortIndicators() {
    document.querySelectorAll('.dp-sort-ind').forEach(el => {
        const col    = el.dataset.for;
        const active = col === _state.sort;
        el.textContent = active ? (_state.order === 'asc' ? ' ▲' : ' ▼') : '';
        el.style.color = active ? 'var(--md-primary)' : 'var(--md-on-surface-hint)';
        el.style.fontSize = '0.72rem';
    });
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function _hideAddForm() {
    const f = document.getElementById('dept-persons-add-form');
    if (!f) return;
    f.classList.add('hidden');
    f.style.display = 'none';
    ['dp-fullname','dp-rank','dp-doc','dp-pos','dp-birth','dp-phone','dp-notes'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

async function _saveNewPerson() {
    const name  = document.getElementById('dp-fullname')?.value.trim();
    const rank  = document.getElementById('dp-rank')?.value.trim();
    const doc   = document.getElementById('dp-doc')?.value.trim();
    const pos   = document.getElementById('dp-pos')?.value.trim();
    const birth = document.getElementById('dp-birth')?.value;
    const phone = document.getElementById('dp-phone')?.value.trim();
    const notes = document.getElementById('dp-notes')?.value.trim();

    if (!name) { window.showSnackbar?.('Введите ФИО', 'error'); return; }

    try {
        // department автоматически подставит бэк — текущее управление
        await api.post('/persons', {
            full_name:      name,
            rank:           rank  || null,
            doc_number:     doc   || null,
            position_title: pos   || null,
            birth_date:     birth || null,
            phone:          phone || null,
            notes:          notes || null,
            department:     null,   // бэк сам подставит username для department-роли
        });
        window.showSnackbar?.('Добавлено в базу', 'success');
        _hideAddForm();
        await loadDeptPersons();
    } catch (err) {
        console.error('[dept_persons] create:', err);
        window.showSnackbar?.(
            err?.status === 409 ? 'Человек с таким ФИО уже есть' : 'Ошибка добавления',
            'error',
        );
    }
}

function _startEditRow(pid) {
    _state.editingId = pid;
    _renderTable();
    setTimeout(() => document.getElementById(`dp-edit-name-${pid}`)?.focus(), 40);
}

function _cancelEditRow() {
    _state.editingId = null;
    _renderTable();
}

async function _saveEditRow(pid) {
    const payload = {
        full_name:      document.getElementById(`dp-edit-name-${pid}`)?.value.trim(),
        rank:           document.getElementById(`dp-edit-rank-${pid}`)?.value.trim() || null,
        doc_number:     document.getElementById(`dp-edit-doc-${pid}`)?.value.trim()  || null,
        position_title: document.getElementById(`dp-edit-pos-${pid}`)?.value.trim()  || null,
        phone:          document.getElementById(`dp-edit-phone-${pid}`)?.value.trim()|| null,
    };
    if (!payload.full_name) { window.showSnackbar?.('ФИО не может быть пустым', 'error'); return; }

    try {
        const updated = await api.put(`/persons/${pid}`, payload);
        const idx = _state.items.findIndex(p => p.id === pid);
        if (idx !== -1) _state.items[idx] = updated;
        _state.editingId = null;
        _renderTable();
        window.showSnackbar?.('Сохранено', 'success');
    } catch (err) {
        console.error('[dept_persons] save edit:', err);
        window.showSnackbar?.('Ошибка сохранения', 'error');
    }
}

async function _deleteRow(pid) {
    const p = _state.items.find(x => x.id === pid);
    if (!confirm(`Удалить «${p?.full_name ?? pid}» из базы?\nЭто не затронет уже заполненные списки.`)) return;
    try {
        await api.delete(`/persons/${pid}`);
        window.showSnackbar?.('Удалено', 'success');
        await loadDeptPersons();
    } catch (err) {
        console.error('[dept_persons] delete:', err);
        window.showSnackbar?.('Ошибка удаления', 'error');
    }
}

// ─── Пагинация ────────────────────────────────────────────────────────────────

function _renderPagination() {
    const bar = document.getElementById('dept-persons-pagination');
    if (!bar) return;

    const { page, pages, total, limit } = _state;
    if (total === 0) { bar.innerHTML = ''; return; }

    const from = (page - 1) * limit + 1;
    const to   = Math.min(page * limit, total);

    const makeNums = () => {
        const set = new Set();
        [1, pages, page - 1, page, page + 1].forEach(p => {
            if (p >= 1 && p <= pages) set.add(p);
        });
        const sorted = [...set].sort((a, b) => a - b);
        const out = [];
        let last = 0;
        sorted.forEach(p => {
            if (p - last > 1) out.push('…');
            out.push(p);
            last = p;
        });
        return out;
    };

    const btn = (label, p, active = false, disabled = false, title = '') => `
        <button class="dp-page-btn" ${p ? `data-page="${p}"` : ''} type="button"
                ${disabled ? 'disabled' : ''} title="${title}"
                style="min-width:30px; height:26px; padding:0 7px;
                       border:1px solid ${active ? 'var(--md-primary)' : 'var(--md-outline-variant)'};
                       background:${active ? 'var(--md-primary)' : 'var(--md-surface)'};
                       color:${active ? 'white' : 'var(--md-on-surface)'};
                       border-radius:var(--md-radius-sm); font-size:0.78rem;
                       font-weight:${active ? '600' : '400'};
                       cursor:${disabled ? 'not-allowed' : 'pointer'};
                       opacity:${disabled ? '0.5' : '1'};">${label}</button>`;

    const nums = makeNums().map(p => {
        if (p === '…') return `<span style="padding:0 3px; color:var(--md-on-surface-hint);">…</span>`;
        return btn(String(p), p, p === page);
    }).join('');

    bar.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between;
                    gap:12px; padding:10px 18px; flex-wrap:wrap;
                    border-top:1px solid var(--md-outline-variant);
                    background:var(--md-surface-variant);">
            <div style="font-size:0.78rem; color:var(--md-on-surface-variant);">
                Показано <b>${from}–${to}</b> из <b>${total}</b>
            </div>
            <div style="display:flex; align-items:center; gap:3px; flex-wrap:wrap;">
                ${btn('‹', page - 1, false, page === 1, 'Предыдущая')}
                ${nums}
                ${btn('›', page + 1, false, page === pages, 'Следующая')}
            </div>
            <div style="display:flex; gap:6px; align-items:center; font-size:0.78rem;
                        color:var(--md-on-surface-variant);">
                <span>На странице:</span>
                <select id="dp-limit-select"
                        style="padding:3px 8px; font-size:0.78rem; cursor:pointer;
                               border:1px solid var(--md-outline-variant); border-radius:var(--md-radius-sm);
                               background:var(--md-surface); color:var(--md-on-surface); outline:none;">
                    ${[25, 50, 100, 200].map(n => `<option value="${n}" ${n === limit ? 'selected' : ''}>${n}</option>`).join('')}
                </select>
            </div>
        </div>`;

    bar.querySelectorAll('.dp-page-btn').forEach(b => {
        b.addEventListener('click', () => {
            const p = parseInt(b.dataset.page, 10);
            if (!p || p < 1 || p > pages || p === page) return;
            loadDeptPersons({ page: p });
        });
    });
    bar.querySelector('#dp-limit-select')?.addEventListener('change', (e) => {
        loadDeptPersons({ limit: parseInt(e.target.value, 10), page: 1 });
    });
}
