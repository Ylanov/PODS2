// static/js/tasks.js
//
// Календарь задач — личные планы пользователей.
//   • Департамент видит только свои задачи.
//   • Админ видит задачи всех пользователей; может фильтровать по владельцу
//     и видит агрегированную сводку.
//
// Три режима: Месяц / Неделя / День + Список.
// Кэширует задачи по диапазону, перезапрашивает только при смене диапазона
// или после create/update/delete.

import { api } from './api.js';
import { formatRole } from './ui.js';

// ─── Состояние ────────────────────────────────────────────────────────────────

const _state = {
    root:           null,          // корневой DOM-узел (#tasks-root / #tasks-root-dept)
    isAdmin:        false,
    view:           'month',       // month | week | day | list
    anchor:         _today(),      // опорная дата вида
    tasks:          [],            // загруженные задачи в активном диапазоне
    ownerFilter:    '',            // для админа: id или '' (все)
    statusFilter:   '',            // '' | pending | in_progress | done
    searchQuery:    '',
    users:          [],            // для админа — список department-юзеров
    summary:        [],            // админ: сводка
    loaded:         false,
    rangeFrom:      null,          // YYYY-MM-DD
    rangeTo:        null,
};

const MONTHS_RU = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                   'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTHS_RU_GEN = ['января','февраля','марта','апреля','мая','июня',
                       'июля','августа','сентября','октября','ноября','декабря'];
const DOW = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

const PRIO_COLORS = {
    low:     '#7FB59E',
    normal:  '#4A7C6F',
    high:    '#E08E45',
    urgent:  '#D8594F',
};
const PRIO_LABEL = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочно' };
const STATUS_LABEL = { pending: 'Ожидает', in_progress: 'В работе', done: 'Готово' };
const STATUS_BG = {
    pending:     '#F0F0F0',
    in_progress: '#E6F0F6',
    done:        '#E6F4EC',
};

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function _today() { return _isoDate(new Date()); }

function _isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _parseIso(iso) {
    if (!iso) return null;
    const [y,m,d] = iso.split('-').map(Number);
    return new Date(y, m-1, d);
}

function _addDays(iso, n) {
    const d = _parseIso(iso);
    d.setDate(d.getDate() + n);
    return _isoDate(d);
}

function _startOfWeek(iso) {
    const d = _parseIso(iso);
    const dow = (d.getDay() + 6) % 7; // Пн=0
    d.setDate(d.getDate() - dow);
    return _isoDate(d);
}

function _startOfMonth(iso) {
    const d = _parseIso(iso);
    d.setDate(1);
    return _isoDate(d);
}

function _endOfMonth(iso) {
    const d = _parseIso(iso);
    d.setMonth(d.getMonth() + 1);
    d.setDate(0);
    return _isoDate(d);
}

function _esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _fmtDateNice(iso) {
    if (!iso) return '';
    const d = _parseIso(iso);
    return `${d.getDate()} ${MONTHS_RU_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

function _isOverdue(task) {
    return task.status !== 'done' && task.due_date < _today();
}

// ─── Публичный API ────────────────────────────────────────────────────────────

/**
 * Инициализация календаря задач.
 * @param {string} rootId  — id корневого контейнера
 * @param {boolean} isAdmin
 */
export function initTasks(rootId, isAdmin) {
    const root = document.getElementById(rootId);
    if (!root) return;

    _state.root    = root;
    _state.isAdmin = !!isAdmin;

    _renderShell();

    // Для админа загрузим список пользователей (для фильтра)
    if (_state.isAdmin) _loadUsers();

    _reload();
}

export async function reloadTasks() {
    await _reload();
}

// ─── Шеллы и рендер ───────────────────────────────────────────────────────────

function _renderShell() {
    const root = _state.root;
    root.innerHTML = `
        <div style="background:var(--md-surface); border-radius:var(--md-radius-lg, 12px);
                    box-shadow:var(--md-elevation-1, 0 1px 3px rgba(0,0,0,0.08));
                    overflow:hidden; display:flex; flex-direction:column;">

            <!-- Тулбар -->
            <div id="tasks-toolbar" style="padding:14px 18px; border-bottom:1px solid var(--md-outline-variant);
                        display:flex; align-items:center; justify-content:space-between;
                        gap:12px; flex-wrap:wrap;">
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <button id="tasks-prev"  class="btn btn-outlined btn-xs" type="button">←</button>
                    <button id="tasks-today" class="btn btn-text btn-xs"     type="button">Сегодня</button>
                    <button id="tasks-next"  class="btn btn-outlined btn-xs" type="button">→</button>
                    <span id="tasks-range-label" style="font-weight:600; font-size:0.92rem; margin:0 8px; min-width:160px;"></span>
                </div>

                <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                    <div style="display:flex; gap:2px; background:var(--md-surface-variant);
                                border-radius:var(--md-radius-sm); padding:2px;">
                        <button data-view="month" class="tasks-view-btn btn btn-text btn-xs" type="button">Месяц</button>
                        <button data-view="week"  class="tasks-view-btn btn btn-text btn-xs" type="button">Неделя</button>
                        <button data-view="day"   class="tasks-view-btn btn btn-text btn-xs" type="button">День</button>
                        <button data-view="list"  class="tasks-view-btn btn btn-text btn-xs" type="button">Список</button>
                    </div>
                    <button id="tasks-add-btn" class="btn btn-success btn-sm" type="button">
                        + Новая задача
                    </button>
                </div>
            </div>

            <!-- Фильтры -->
            <div style="padding:8px 18px; background:var(--md-surface-variant);
                        border-bottom:1px solid var(--md-outline-variant);
                        display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:0.82rem;">
                <div style="display:flex; align-items:center; gap:6px; flex:1; min-width:200px; max-width:340px;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                         style="color:var(--md-on-surface-hint); flex-shrink:0;">
                        <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                    </svg>
                    <input type="text" id="tasks-search" placeholder="Поиск по названию / категории…"
                           autocomplete="off"
                           style="flex:1; border:1px solid var(--md-outline-variant);
                                  background:var(--md-surface); padding:4px 8px;
                                  border-radius:var(--md-radius-sm); font-size:0.8rem;
                                  color:var(--md-on-surface); outline:none;">
                </div>

                <select id="tasks-filter-status" title="Фильтр по статусу"
                        style="padding:4px 8px; font-size:0.8rem; border:1px solid var(--md-outline-variant);
                               background:var(--md-surface); color:var(--md-on-surface);
                               border-radius:var(--md-radius-sm); outline:none;">
                    <option value="">Все статусы</option>
                    <option value="pending">Ожидает</option>
                    <option value="in_progress">В работе</option>
                    <option value="done">Готово</option>
                </select>

                ${_state.isAdmin ? `
                    <select id="tasks-filter-owner" title="Фильтр по пользователю"
                            style="padding:4px 8px; font-size:0.8rem; border:1px solid var(--md-outline-variant);
                                   background:var(--md-surface); color:var(--md-on-surface);
                                   border-radius:var(--md-radius-sm); outline:none; min-width:180px;">
                        <option value="">Все пользователи</option>
                    </select>
                    <button id="tasks-summary-btn" class="btn btn-outlined btn-xs" type="button"
                            style="margin-left:auto;">📊 Сводка</button>
                ` : ''}
            </div>

            <!-- Контент -->
            <div id="tasks-content" style="padding:16px 18px; min-height:400px;"></div>
        </div>
    `;

    // Биндим обработчики (один раз, т.к. renderShell вызывается один раз в init)
    root.querySelector('#tasks-prev')?.addEventListener('click',  () => _navigate(-1));
    root.querySelector('#tasks-next')?.addEventListener('click',  () => _navigate(1));
    root.querySelector('#tasks-today')?.addEventListener('click', () => { _state.anchor = _today(); _reload(); });
    root.querySelector('#tasks-add-btn')?.addEventListener('click', () => _openEditor(null));

    root.querySelectorAll('.tasks-view-btn').forEach(btn => {
        btn.addEventListener('click', () => _setView(btn.dataset.view));
    });

    let st = null;
    root.querySelector('#tasks-search')?.addEventListener('input', (e) => {
        clearTimeout(st);
        st = setTimeout(() => {
            _state.searchQuery = (e.target.value || '').trim().toLowerCase();
            _renderContent();
        }, 200);
    });

    root.querySelector('#tasks-filter-status')?.addEventListener('change', (e) => {
        _state.statusFilter = e.target.value;
        _renderContent();
    });

    if (_state.isAdmin) {
        root.querySelector('#tasks-filter-owner')?.addEventListener('change', (e) => {
            _state.ownerFilter = e.target.value;
            _reload();
        });
        root.querySelector('#tasks-summary-btn')?.addEventListener('click', _openSummaryModal);
    }

    _highlightViewButton();
}

function _highlightViewButton() {
    _state.root.querySelectorAll('.tasks-view-btn').forEach(btn => {
        const active = btn.dataset.view === _state.view;
        btn.classList.toggle('btn-filled', active);
        btn.classList.toggle('btn-text',   !active);
    });
}

function _setView(view) {
    if (!['month','week','day','list'].includes(view)) return;
    _state.view = view;
    _highlightViewButton();
    _reload();
}

function _navigate(dir) {
    if (_state.view === 'month') {
        const d = _parseIso(_state.anchor);
        d.setMonth(d.getMonth() + dir);
        d.setDate(1);
        _state.anchor = _isoDate(d);
    } else if (_state.view === 'week' || _state.view === 'list') {
        _state.anchor = _addDays(_state.anchor, dir * 7);
    } else if (_state.view === 'day') {
        _state.anchor = _addDays(_state.anchor, dir);
    }
    _reload();
}

// ─── Загрузка ────────────────────────────────────────────────────────────────

function _getRange() {
    if (_state.view === 'month') {
        return { from: _startOfMonth(_state.anchor), to: _endOfMonth(_state.anchor) };
    }
    if (_state.view === 'week') {
        const from = _startOfWeek(_state.anchor);
        return { from, to: _addDays(from, 6) };
    }
    if (_state.view === 'day') {
        return { from: _state.anchor, to: _state.anchor };
    }
    // list — ближайший месяц
    return { from: _state.anchor, to: _addDays(_state.anchor, 30) };
}

async function _reload() {
    const range = _getRange();
    _state.rangeFrom = range.from;
    _state.rangeTo   = range.to;

    const params = new URLSearchParams();
    params.set('date_from', range.from);
    params.set('date_to',   range.to);
    if (_state.isAdmin && _state.ownerFilter) params.set('owner_id', _state.ownerFilter);

    const container = _state.root.querySelector('#tasks-content');
    if (container) container.innerHTML = `<p style="text-align:center; padding:40px; color:var(--md-on-surface-hint);">Загрузка…</p>`;

    try {
        _state.tasks = await api.get(`/tasks?${params.toString()}`);
    } catch (err) {
        console.error('[tasks] load:', err);
        _state.tasks = [];
        window.showSnackbar?.('Ошибка загрузки задач', 'error');
    }

    _updateRangeLabel();
    _renderContent();
}

async function _loadUsers() {
    try {
        const users = await api.get('/admin/users');
        _state.users = users.filter(u => u.is_active);
        const sel = _state.root.querySelector('#tasks-filter-owner');
        if (sel) {
            const opts = ['<option value="">Все пользователи</option>']
                .concat(_state.users.map(u =>
                    `<option value="${u.id}">${_esc(formatRole(u.username))}</option>`));
            sel.innerHTML = opts.join('');
        }
    } catch { /* админ может быть без прав в момент загрузки */ }
}

function _updateRangeLabel() {
    const el = _state.root.querySelector('#tasks-range-label');
    if (!el) return;
    const a = _parseIso(_state.anchor);

    if (_state.view === 'month') {
        el.textContent = `${MONTHS_RU[a.getMonth()]} ${a.getFullYear()}`;
    } else if (_state.view === 'week') {
        const from = _parseIso(_state.rangeFrom);
        const to   = _parseIso(_state.rangeTo);
        el.textContent = `${from.getDate()} ${MONTHS_RU_GEN[from.getMonth()].slice(0,3)} — ${to.getDate()} ${MONTHS_RU_GEN[to.getMonth()].slice(0,3)} ${to.getFullYear()}`;
    } else if (_state.view === 'day') {
        el.textContent = _fmtDateNice(_state.anchor);
    } else {
        el.textContent = `c ${_fmtDateNice(_state.rangeFrom)}`;
    }
}

// ─── Фильтрация ───────────────────────────────────────────────────────────────

function _filteredTasks() {
    const q = _state.searchQuery;
    return _state.tasks.filter(t => {
        if (_state.statusFilter && t.status !== _state.statusFilter) return false;
        if (q) {
            const hay = [
                t.title, t.description, t.category,
                t.owner_username ? formatRole(t.owner_username) : '',
            ].filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
}

// ─── Рендер контента ─────────────────────────────────────────────────────────

function _renderContent() {
    const container = _state.root.querySelector('#tasks-content');
    if (!container) return;

    const tasks = _filteredTasks();

    if (_state.view === 'month') _renderMonth(container, tasks);
    else if (_state.view === 'week')  _renderWeek(container, tasks);
    else if (_state.view === 'day')   _renderDay(container, tasks);
    else                              _renderList(container, tasks);
}

// ── Месяц (сетка) ─────────────────────────────────────────────────────────────

function _renderMonth(container, tasks) {
    const anchor = _parseIso(_state.anchor);
    const year   = anchor.getFullYear();
    const month  = anchor.getMonth();

    const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month+1, 0).getDate();
    const today = _today();

    // Группируем задачи по дате
    const byDate = {};
    tasks.forEach(t => {
        if (!byDate[t.due_date]) byDate[t.due_date] = [];
        byDate[t.due_date].push(t);
    });

    let html = `<div style="display:grid; grid-template-columns:repeat(7, 1fr); gap:4px;">`;
    DOW.forEach(d => {
        html += `<div style="text-align:center; font-size:0.72rem; font-weight:600; color:var(--md-on-surface-hint); padding:6px 0;">${d}</div>`;
    });

    for (let i = 0; i < firstDow; i++) {
        html += `<div style="min-height:90px;"></div>`;
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const iso  = _isoDate(new Date(year, month, d));
        const list = byDate[iso] || [];
        const isToday = iso === today;
        const dow = (new Date(year, month, d).getDay() + 6) % 7;
        const weekend = dow >= 5;

        const head = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <span style="font-size:0.78rem; font-weight:${isToday?'700':'500'}; color:${isToday?'var(--md-primary)':weekend?'var(--md-on-surface-hint)':'var(--md-on-surface)'};">${d}</span>
                ${list.length > 3 ? `<span style="font-size:0.66rem; color:var(--md-on-surface-hint);">+${list.length-3}</span>` : ''}
            </div>`;

        const items = list.slice(0, 3).map(t => _renderMonthChip(t)).join('');

        html += `
            <div class="tasks-day-cell" data-date="${iso}"
                 style="min-height:100px; padding:6px 6px 4px;
                        border:1px solid ${isToday?'var(--md-primary)':'var(--md-outline-variant)'};
                        border-radius:var(--md-radius-sm); cursor:pointer;
                        background:${isToday?'var(--md-primary-light, #E8F0EE)':'var(--md-surface)'};
                        display:flex; flex-direction:column; overflow:hidden;">
                ${head}
                <div style="display:flex; flex-direction:column; gap:2px;">${items}</div>
            </div>`;
    }
    html += `</div>`;
    container.innerHTML = html;

    // Клики — по дню открыть день, по задаче — редактор
    container.querySelectorAll('.tasks-day-cell').forEach(cell => {
        cell.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-task-id]');
            if (chip) {
                e.stopPropagation();
                _openEditor(parseInt(chip.dataset.taskId, 10));
                return;
            }
            _state.anchor = cell.dataset.date;
            _setView('day');
        });
    });
}

function _renderMonthChip(t) {
    const color = t.color || PRIO_COLORS[t.priority] || PRIO_COLORS.normal;
    const over  = _isOverdue(t);
    const strike = t.status === 'done' ? 'text-decoration:line-through; opacity:0.6;' : '';
    const timePrefix = t.time_from ? `${_esc(t.time_from)} · ` : '';
    const ownerBadge = (_state.isAdmin && t.owner_username)
        ? `<span style="font-size:0.6rem; color:var(--md-on-surface-hint); margin-left:4px;">[${_esc(formatRole(t.owner_username))}]</span>`
        : '';

    return `
        <div data-task-id="${t.id}" title="${_esc(t.title)}"
             style="font-size:0.7rem; line-height:1.25; padding:2px 5px; border-radius:3px;
                    background:${color}; color:white; cursor:pointer;
                    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; ${strike}
                    ${over?'box-shadow:inset 0 0 0 1px var(--md-error, #E24B4A);':''}">
            ${timePrefix}${_esc(t.title)}${ownerBadge}
        </div>`;
}

// ── Неделя ────────────────────────────────────────────────────────────────────

function _renderWeek(container, tasks) {
    const from = _parseIso(_state.rangeFrom);
    const today = _today();
    const byDate = {};
    tasks.forEach(t => {
        if (!byDate[t.due_date]) byDate[t.due_date] = [];
        byDate[t.due_date].push(t);
    });

    let html = `<div style="display:grid; grid-template-columns:repeat(7, 1fr); gap:8px;">`;
    for (let i = 0; i < 7; i++) {
        const d = new Date(from);
        d.setDate(d.getDate() + i);
        const iso = _isoDate(d);
        const list = byDate[iso] || [];
        const isToday = iso === today;
        const weekend = (d.getDay() % 6) === 0;

        html += `
            <div class="tasks-week-col" data-date="${iso}"
                 style="min-height:240px; padding:10px; border:1px solid ${isToday?'var(--md-primary)':'var(--md-outline-variant)'};
                        border-radius:var(--md-radius-sm); display:flex; flex-direction:column; gap:6px;
                        background:${weekend ? 'var(--md-surface-variant)' : 'var(--md-surface)'};">
                <div style="display:flex; justify-content:space-between; align-items:baseline;
                            padding-bottom:6px; border-bottom:1px solid var(--md-outline-variant);">
                    <div>
                        <div style="font-size:0.72rem; color:var(--md-on-surface-hint);">${DOW[i]}</div>
                        <div style="font-size:1rem; font-weight:${isToday?'700':'600'}; color:${isToday?'var(--md-primary)':'var(--md-on-surface)'};">${d.getDate()}</div>
                    </div>
                    <button class="tasks-add-day btn btn-text btn-xs" data-date="${iso}" type="button"
                            style="padding:2px 6px; font-size:0.68rem;">+</button>
                </div>
                <div style="display:flex; flex-direction:column; gap:4px; overflow-y:auto;">
                    ${list.map(t => _renderTaskCard(t, 'compact')).join('') || '<span style="font-size:0.7rem; color:var(--md-on-surface-hint); text-align:center; padding:8px;">Пусто</span>'}
                </div>
            </div>`;
    }
    html += `</div>`;
    container.innerHTML = html;
    _bindTaskCardEvents(container);
    container.querySelectorAll('.tasks-add-day').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            _openEditor(null, btn.dataset.date);
        });
    });
}

// ── День ──────────────────────────────────────────────────────────────────────

function _renderDay(container, tasks) {
    const list = tasks.filter(t => t.due_date === _state.anchor);

    if (list.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:40px; color:var(--md-on-surface-hint);">
                <p style="font-size:0.95rem; margin-bottom:8px;">На этот день задач нет</p>
                <button class="btn btn-outlined btn-sm" id="tasks-day-add" type="button">+ Добавить задачу</button>
            </div>`;
        container.querySelector('#tasks-day-add')?.addEventListener('click', () => _openEditor(null, _state.anchor));
        return;
    }

    // Сортировка: сначала с временем, потом без — приоритет→время
    list.sort((a,b) => {
        const ta = a.time_from || '99:99';
        const tb = b.time_from || '99:99';
        return ta.localeCompare(tb);
    });

    let html = `<div style="display:flex; flex-direction:column; gap:10px; max-width:760px; margin:0 auto;">`;
    list.forEach(t => { html += _renderTaskCard(t, 'full'); });
    html += `</div>`;
    container.innerHTML = html;
    _bindTaskCardEvents(container);
}

// ── Список ────────────────────────────────────────────────────────────────────

function _renderList(container, tasks) {
    if (tasks.length === 0) {
        container.innerHTML = `<p style="text-align:center; padding:40px; color:var(--md-on-surface-hint);">Задач нет</p>`;
        return;
    }

    // Группировка по дате
    const byDate = {};
    tasks.forEach(t => {
        if (!byDate[t.due_date]) byDate[t.due_date] = [];
        byDate[t.due_date].push(t);
    });
    const sortedDates = Object.keys(byDate).sort();

    let html = `<div style="display:flex; flex-direction:column; gap:16px;">`;
    sortedDates.forEach(date => {
        const d = _parseIso(date);
        const today = _today();
        const label = date === today ? 'Сегодня' : date === _addDays(today,1) ? 'Завтра' : date < today ? 'Прошло' : '';
        const labelEl = label ? `<span style="font-size:0.72rem; padding:2px 7px; border-radius:10px; background:${label==='Прошло'?'var(--md-error-light, #FADCDB)':'var(--md-primary-light)'}; color:${label==='Прошло'?'var(--md-error, #E24B4A)':'var(--md-primary-dark)'}; margin-left:8px;">${label}</span>` : '';

        html += `
            <div>
                <div style="font-weight:600; font-size:0.88rem; padding:6px 0; border-bottom:1px solid var(--md-outline-variant); margin-bottom:6px;">
                    ${_fmtDateNice(date)}, ${DOW[(d.getDay()+6)%7]}
                    ${labelEl}
                </div>
                <div style="display:flex; flex-direction:column; gap:6px;">
                    ${byDate[date].map(t => _renderTaskCard(t, 'row')).join('')}
                </div>
            </div>`;
    });
    html += `</div>`;
    container.innerHTML = html;
    _bindTaskCardEvents(container);
}

// ── Карточка задачи ──────────────────────────────────────────────────────────

function _renderTaskCard(t, variant) {
    const color   = t.color || PRIO_COLORS[t.priority] || PRIO_COLORS.normal;
    const over    = _isOverdue(t);
    const strike  = t.status === 'done' ? 'text-decoration:line-through; opacity:0.6;' : '';
    const stBg    = STATUS_BG[t.status] || '#F0F0F0';

    const ownerBadge = (_state.isAdmin && t.owner_username)
        ? `<span style="font-size:0.7rem; padding:2px 6px; border-radius:10px; background:var(--md-primary-light); color:var(--md-primary-dark); margin-right:6px;">${_esc(formatRole(t.owner_username))}</span>`
        : '';

    const timeRange = t.time_from
        ? `${_esc(t.time_from)}${t.time_to ? '—' + _esc(t.time_to) : ''}`
        : '';

    const overdueBadge = over
        ? `<span style="font-size:0.68rem; padding:1px 6px; border-radius:10px; background:#FADCDB; color:#E24B4A; font-weight:500; margin-left:6px;">Просрочено</span>`
        : '';

    if (variant === 'compact') {
        // Для сетки недели — узкая карточка
        return `
            <div data-task-id="${t.id}"
                 style="border-left:3px solid ${color}; padding:4px 6px;
                        background:${stBg}; border-radius:3px; cursor:pointer;
                        ${strike} font-size:0.72rem; line-height:1.3;">
                ${timeRange ? `<div style="font-size:0.65rem; color:var(--md-on-surface-hint); font-weight:500;">${timeRange}</div>` : ''}
                <div style="font-weight:500; color:var(--md-on-surface); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${_esc(t.title)}</div>
                ${ownerBadge ? `<div style="margin-top:2px;">${ownerBadge}</div>` : ''}
            </div>`;
    }

    if (variant === 'row') {
        return `
            <div data-task-id="${t.id}"
                 style="display:flex; align-items:center; gap:10px; padding:8px 10px;
                        border:1px solid var(--md-outline-variant); border-left:4px solid ${color};
                        border-radius:var(--md-radius-sm); background:var(--md-surface);
                        cursor:pointer; ${strike}">
                <div style="width:52px; flex-shrink:0; text-align:center;">
                    ${timeRange
                        ? `<span style="font-size:0.74rem; font-weight:600; color:var(--md-on-surface);">${timeRange.split('—')[0]}</span>`
                        : `<span style="font-size:0.7rem; color:var(--md-on-surface-hint);">—</span>`}
                </div>
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:500; font-size:0.9rem; color:var(--md-on-surface);">
                        ${ownerBadge}${_esc(t.title)}${overdueBadge}
                    </div>
                    ${t.category || t.description ? `
                        <div style="font-size:0.73rem; color:var(--md-on-surface-hint); margin-top:2px; display:flex; gap:8px; flex-wrap:wrap;">
                            ${t.category ? `<span>📁 ${_esc(t.category)}</span>` : ''}
                            ${t.description ? `<span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${_esc(t.description)}</span>` : ''}
                        </div>` : ''}
                </div>
                <span style="font-size:0.7rem; padding:2px 8px; border-radius:10px; background:${stBg}; color:var(--md-on-surface-variant); flex-shrink:0;">
                    ${STATUS_LABEL[t.status]}
                </span>
            </div>`;
    }

    // full — подробная карточка (режим День)
    return `
        <div data-task-id="${t.id}"
             style="border:1px solid var(--md-outline-variant); border-left:4px solid ${color};
                    border-radius:var(--md-radius-md, 8px); padding:12px 14px; cursor:pointer;
                    background:var(--md-surface); display:flex; gap:12px; align-items:flex-start; ${strike}">
            <div style="width:60px; flex-shrink:0;">
                ${timeRange
                    ? `<div style="font-size:0.78rem; font-weight:600;">${timeRange}</div>`
                    : `<div style="font-size:0.7rem; color:var(--md-on-surface-hint);">Весь день</div>`}
            </div>
            <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                    <strong style="font-size:0.94rem;">${_esc(t.title)}</strong>
                    <span style="font-size:0.68rem; padding:1px 7px; border-radius:10px; background:${color}; color:white;">
                        ${PRIO_LABEL[t.priority]||t.priority}
                    </span>
                    <span style="font-size:0.7rem; padding:2px 8px; border-radius:10px; background:${stBg}; color:var(--md-on-surface-variant);">
                        ${STATUS_LABEL[t.status]}
                    </span>
                    ${overdueBadge}
                    ${ownerBadge ? `<span style="margin-left:auto;">${ownerBadge}</span>` : ''}
                </div>
                ${t.category ? `<div style="font-size:0.76rem; color:var(--md-on-surface-hint); margin-top:4px;">📁 ${_esc(t.category)}</div>` : ''}
                ${t.description ? `<div style="font-size:0.82rem; color:var(--md-on-surface-variant); margin-top:6px; line-height:1.5; white-space:pre-wrap;">${_esc(t.description)}</div>` : ''}
            </div>
        </div>`;
}

function _bindTaskCardEvents(container) {
    container.querySelectorAll('[data-task-id]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            _openEditor(parseInt(el.dataset.taskId, 10));
        });
    });
}

// ─── Редактор задачи (модалка) ───────────────────────────────────────────────

function _openEditor(taskId, defaultDate) {
    const isEdit = !!taskId;
    const task = isEdit ? _state.tasks.find(t => t.id === taskId) : null;
    // Если это админ редактирует чужую задачу, которой нет в кэше — запросим
    if (isEdit && !task) {
        api.get(`/tasks/${taskId}`).then(t => _renderEditor(t, true)).catch(() => {
            window.showSnackbar?.('Не удалось открыть задачу', 'error');
        });
        return;
    }
    _renderEditor(task, isEdit, defaultDate);
}

function _renderEditor(task, isEdit, defaultDate) {
    document.getElementById('tasks-editor-modal')?.remove();

    const date = (task?.due_date) || defaultDate || _state.anchor;

    const modal = document.createElement('div');
    modal.id = 'tasks-editor-modal';
    modal.style.cssText = 'position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:20px;';

    const ownerInfo = (_state.isAdmin && task?.owner_username)
        ? `<div style="font-size:0.75rem; color:var(--md-on-surface-hint); margin-top:2px;">
               Владелец: <b>${_esc(formatRole(task.owner_username))}</b></div>`
        : '';

    modal.innerHTML = `
        <div style="background:var(--md-surface); border-radius:var(--md-radius-lg, 12px);
                    box-shadow:0 10px 40px rgba(0,0,0,0.25); max-width:560px; width:100%;
                    max-height:90vh; display:flex; flex-direction:column; overflow:hidden;">
            <div style="padding:16px 20px; border-bottom:1px solid var(--md-outline-variant);
                        display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-weight:600; font-size:1rem;">
                        ${isEdit ? 'Редактирование задачи' : 'Новая задача'}
                    </div>
                    ${ownerInfo}
                </div>
                <button id="tasks-editor-close" class="btn btn-text btn-sm" type="button">✕</button>
            </div>
            <div style="padding:18px 20px; overflow-y:auto; flex:1; display:flex; flex-direction:column; gap:12px;">
                <div class="field">
                    <label class="field-label" for="tf-title">Название *</label>
                    <input type="text" id="tf-title" maxlength="300" value="${_esc(task?.title || '')}" placeholder="Что нужно сделать?" autocomplete="off">
                </div>

                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <div class="field" style="flex:1; min-width:140px;">
                        <label class="field-label" for="tf-date">Дата</label>
                        <input type="date" id="tf-date" value="${date}">
                    </div>
                    <div class="field" style="flex:0 0 110px;">
                        <label class="field-label" for="tf-time-from">С</label>
                        <input type="time" id="tf-time-from" value="${_esc(task?.time_from || '')}">
                    </div>
                    <div class="field" style="flex:0 0 110px;">
                        <label class="field-label" for="tf-time-to">До</label>
                        <input type="time" id="tf-time-to" value="${_esc(task?.time_to || '')}">
                    </div>
                </div>

                <div style="display:flex; gap:10px; flex-wrap:wrap;">
                    <div class="field" style="flex:1; min-width:130px;">
                        <label class="field-label" for="tf-priority">Приоритет</label>
                        <select id="tf-priority">
                            ${['low','normal','high','urgent'].map(p =>
                                `<option value="${p}" ${task?.priority===p||(!task&&p==='normal')?'selected':''}>${PRIO_LABEL[p]}</option>`).join('')}
                        </select>
                    </div>
                    <div class="field" style="flex:1; min-width:130px;">
                        <label class="field-label" for="tf-status">Статус</label>
                        <select id="tf-status">
                            ${['pending','in_progress','done'].map(s =>
                                `<option value="${s}" ${task?.status===s||(!task&&s==='pending')?'selected':''}>${STATUS_LABEL[s]}</option>`).join('')}
                        </select>
                    </div>
                    <div class="field" style="flex:1; min-width:130px;">
                        <label class="field-label" for="tf-category">Категория</label>
                        <input type="text" id="tf-category" maxlength="100" value="${_esc(task?.category || '')}" placeholder="Работа / Учёба…" autocomplete="off">
                    </div>
                </div>

                <div class="field">
                    <label class="field-label" for="tf-color">Цвет (опционально)</label>
                    <input type="color" id="tf-color" value="${task?.color || PRIO_COLORS[task?.priority || 'normal']}"
                           style="width:60px; height:32px; padding:0; border:1px solid var(--md-outline); border-radius:var(--md-radius-sm); cursor:pointer;">
                </div>

                <div class="field">
                    <label class="field-label" for="tf-description">Описание</label>
                    <textarea id="tf-description" rows="4" maxlength="5000"
                              style="width:100%; padding:8px 10px; border:1px solid var(--md-outline);
                                     border-radius:var(--md-radius-sm); font-size:0.85rem;
                                     color:var(--md-on-surface); background:var(--md-surface);
                                     outline:none; resize:vertical; font-family:inherit;"
                              placeholder="Детали, подзадачи, ссылки…">${_esc(task?.description || '')}</textarea>
                </div>
            </div>
            <div style="padding:14px 20px; border-top:1px solid var(--md-outline-variant);
                        display:flex; gap:8px; justify-content:space-between; align-items:center;">
                ${isEdit
                    ? `<button id="tasks-editor-delete" class="btn btn-danger btn-sm" type="button">🗑 Удалить</button>`
                    : '<span></span>'}
                <div style="display:flex; gap:8px;">
                    <button id="tasks-editor-cancel" class="btn btn-text btn-sm" type="button">Отмена</button>
                    <button id="tasks-editor-save"   class="btn btn-filled btn-sm" type="button">${isEdit ? 'Сохранить' : 'Создать'}</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.getElementById('tasks-editor-close')?.addEventListener('click', () => modal.remove());
    document.getElementById('tasks-editor-cancel')?.addEventListener('click', () => modal.remove());
    document.getElementById('tasks-editor-save')?.addEventListener('click', () => _saveFromEditor(task?.id));
    if (isEdit) {
        document.getElementById('tasks-editor-delete')?.addEventListener('click', () => _deleteTask(task.id));
    }

    setTimeout(() => document.getElementById('tf-title')?.focus(), 50);
}

async function _saveFromEditor(taskId) {
    const title     = document.getElementById('tf-title')?.value?.trim();
    const due_date  = document.getElementById('tf-date')?.value;
    const time_from = document.getElementById('tf-time-from')?.value || null;
    const time_to   = document.getElementById('tf-time-to')?.value   || null;
    const priority  = document.getElementById('tf-priority')?.value || 'normal';
    const statusV   = document.getElementById('tf-status')?.value   || 'pending';
    const category  = document.getElementById('tf-category')?.value?.trim() || null;
    const color     = document.getElementById('tf-color')?.value   || null;
    const description = document.getElementById('tf-description')?.value?.trim() || null;

    if (!title)    { window.showSnackbar?.('Введите название', 'error'); return; }
    if (!due_date) { window.showSnackbar?.('Укажите дату',     'error'); return; }

    const payload = { title, due_date, time_from, time_to, priority, status: statusV, category, color, description };

    try {
        if (taskId) {
            await api.patch(`/tasks/${taskId}`, payload);
            window.showSnackbar?.('Задача обновлена', 'success');
        } else {
            await api.post('/tasks', payload);
            window.showSnackbar?.('Задача создана', 'success');
        }
        document.getElementById('tasks-editor-modal')?.remove();
        _reload();
    } catch (err) {
        console.error('[tasks] save:', err);
        window.showSnackbar?.('Ошибка сохранения задачи', 'error');
    }
}

async function _deleteTask(taskId) {
    if (!confirm('Удалить эту задачу?')) return;
    try {
        await api.delete(`/tasks/${taskId}`);
        document.getElementById('tasks-editor-modal')?.remove();
        window.showSnackbar?.('Задача удалена', 'success');
        _reload();
    } catch (err) {
        console.error('[tasks] delete:', err);
        window.showSnackbar?.('Ошибка удаления', 'error');
    }
}

// ─── Админ: сводка по пользователям ──────────────────────────────────────────

async function _openSummaryModal() {
    try {
        _state.summary = await api.get('/tasks/admin/summary');
    } catch (err) {
        window.showSnackbar?.('Не удалось загрузить сводку', 'error');
        return;
    }

    document.getElementById('tasks-summary-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'tasks-summary-modal';
    modal.style.cssText = 'position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:20px;';

    const rows = _state.summary.map(s => `
        <tr style="cursor:pointer;" data-owner-id="${s.owner_id}">
            <td style="padding:8px 12px; border-bottom:1px solid var(--md-outline-variant); font-weight:500;">${_esc(formatRole(s.owner_username))}</td>
            <td style="padding:8px; text-align:center; border-bottom:1px solid var(--md-outline-variant);">${s.total}</td>
            <td style="padding:8px; text-align:center; border-bottom:1px solid var(--md-outline-variant); color:var(--md-on-surface-hint);">${s.pending}</td>
            <td style="padding:8px; text-align:center; border-bottom:1px solid var(--md-outline-variant); color:var(--md-primary);">${s.in_progress}</td>
            <td style="padding:8px; text-align:center; border-bottom:1px solid var(--md-outline-variant); color:var(--md-success, #1D9E75);">${s.done}</td>
            <td style="padding:8px; text-align:center; border-bottom:1px solid var(--md-outline-variant); color:var(--md-error, #E24B4A); font-weight:600;">${s.overdue || ''}</td>
            <td style="padding:8px; text-align:center; border-bottom:1px solid var(--md-outline-variant); color:var(--md-warning, #BA7517);">${s.upcoming_7d}</td>
        </tr>`).join('');

    modal.innerHTML = `
        <div style="background:var(--md-surface); border-radius:var(--md-radius-lg, 12px);
                    box-shadow:0 10px 40px rgba(0,0,0,0.25); max-width:780px; width:100%;
                    max-height:90vh; display:flex; flex-direction:column; overflow:hidden;">
            <div style="padding:14px 18px; border-bottom:1px solid var(--md-outline-variant);
                        display:flex; justify-content:space-between; align-items:center;">
                <div style="font-weight:600; font-size:1rem;">📊 Сводка по пользователям</div>
                <button id="tasks-summary-close" class="btn btn-text btn-sm" type="button">✕</button>
            </div>
            <div style="overflow:auto; flex:1;">
                <table style="width:100%; border-collapse:collapse; font-size:0.85rem;">
                    <thead style="background:var(--md-surface-variant); position:sticky; top:0;">
                        <tr>
                            <th style="padding:8px 12px; text-align:left; font-size:0.75rem; border-bottom:2px solid var(--md-outline);">Пользователь</th>
                            <th style="padding:8px; text-align:center; font-size:0.75rem; border-bottom:2px solid var(--md-outline);">Всего</th>
                            <th style="padding:8px; text-align:center; font-size:0.75rem; border-bottom:2px solid var(--md-outline);">Ожид.</th>
                            <th style="padding:8px; text-align:center; font-size:0.75rem; border-bottom:2px solid var(--md-outline);">В работе</th>
                            <th style="padding:8px; text-align:center; font-size:0.75rem; border-bottom:2px solid var(--md-outline);">Готово</th>
                            <th style="padding:8px; text-align:center; font-size:0.75rem; border-bottom:2px solid var(--md-outline);">Просроч.</th>
                            <th style="padding:8px; text-align:center; font-size:0.75rem; border-bottom:2px solid var(--md-outline);">Бл. 7 дн.</th>
                        </tr>
                    </thead>
                    <tbody>${rows || `<tr><td colspan="7" style="padding:30px; text-align:center; color:var(--md-on-surface-hint);">Задач ни у кого нет</td></tr>`}</tbody>
                </table>
            </div>
            <div style="padding:10px 18px; border-top:1px solid var(--md-outline-variant);
                        font-size:0.72rem; color:var(--md-on-surface-hint);">
                Клик по строке — открыть задачи этого пользователя в календаре.
            </div>
        </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.getElementById('tasks-summary-close')?.addEventListener('click', () => modal.remove());
    modal.querySelectorAll('tr[data-owner-id]').forEach(tr => {
        tr.addEventListener('click', () => {
            _state.ownerFilter = tr.dataset.ownerId;
            const sel = _state.root.querySelector('#tasks-filter-owner');
            if (sel) sel.value = _state.ownerFilter;
            modal.remove();
            _reload();
        });
    });
}
