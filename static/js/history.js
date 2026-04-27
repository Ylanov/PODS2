// static/js/history.js
//
// Вкладка «История» — календарный вид.
//
// Левая часть: большая сетка месяца 7×N. В каждой клетке дня:
//   • число;
//   • пилюли-миниатюры для событий (максимум 3, далее "+N ещё");
//   • badge-счётчик audit-изменений за день.
// Правая часть: sticky-панель с деталями выбранного дня — списки этого
// дня (карточки) + таймлайн audit-записей.
//
// Режим "Список" оставлен как fallback — та же таблица что была раньше.
//
// Экспортирует loadHistory (вызывается из ui.js:switchAdminTab) и
// openEventReadonly (используется из dashboard для клика по списку).

import { api } from './api.js';
import { formatRole } from './ui.js';

// ─── Состояние модуля ────────────────────────────────────────────────────
const _state = {
    year:        null,   // просматриваемый месяц
    month:       null,   // 0-11
    events:      [],     // все рабочие списки (is_template=false) с датами
    dayCounts:   {},     // "YYYY-MM-DD" → число audit-записей за день
    selectedDay: null,   // "YYYY-MM-DD" или null
    selectedDayAudit: [], // кеш audit-записей для selectedDay
    mode:        'month',// 'month' | 'list'
    searchQuery: '',
    loading:     false,
    inited:      false,
};

const MONTHS_GENITIVE = [
    'января', 'февраля', 'марта',    'апреля', 'мая',     'июня',
    'июля',   'августа', 'сентября', 'октября','ноября',  'декабря',
];
const MONTHS_NOM = [
    'Январь', 'Февраль', 'Март',     'Апрель', 'Май',     'Июнь',
    'Июль',   'Август',  'Сентябрь', 'Октябрь','Ноябрь',  'Декабрь',
];
const WEEKDAYS_FULL = [
    'Воскресенье', 'Понедельник', 'Вторник', 'Среда',
    'Четверг', 'Пятница', 'Суббота',
];

// ─── Утилиты ─────────────────────────────────────────────────────────────
function _esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _pad(n) { return String(n).padStart(2, '0'); }

function _iso(y, m0, d) {
    return `${y}-${_pad(m0 + 1)}-${_pad(d)}`;
}

function _todayIso() {
    const n = new Date();
    return _iso(n.getFullYear(), n.getMonth(), n.getDate());
}

function _fmtFullDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS_GENITIVE[m - 1]} ${y}`;
}

function _weekdayOf(iso) {
    const d = new Date(iso + 'T00:00:00');
    return WEEKDAYS_FULL[d.getDay()];
}

function _fmtTime(isoTs) {
    try {
        const d = new Date(isoTs);
        return `${_pad(d.getHours())}:${_pad(d.getMinutes())}`;
    } catch { return ''; }
}

// ─── Загрузка / инициализация ────────────────────────────────────────────
export async function loadHistory() {
    _bindEventsOnce();

    // Первый вход — ставим текущий месяц
    if (_state.year == null) {
        const now = new Date();
        _state.year  = now.getFullYear();
        _state.month = now.getMonth();
    }

    await _fetchMonth();
    _render();
}

function _bindEventsOnce() {
    if (_state.inited) return;
    _state.inited = true;

    document.getElementById('hist-cal-prev')?.addEventListener('click', () => _shiftMonth(-1));
    document.getElementById('hist-cal-next')?.addEventListener('click', () => _shiftMonth(+1));
    document.getElementById('hist-cal-today')?.addEventListener('click', () => {
        const n = new Date();
        _state.year  = n.getFullYear();
        _state.month = n.getMonth();
        _state.selectedDay = _todayIso();
        _fetchMonth().then(_render);
    });

    document.querySelectorAll('[data-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _state.mode = btn.dataset.mode;
            _render();
        });
    });

    const search = document.getElementById('history-search-input');
    if (search) {
        let t = null;
        search.addEventListener('input', (e) => {
            clearTimeout(t);
            t = setTimeout(() => {
                _state.searchQuery = (e.target.value || '').trim().toLowerCase();
                _render();
            }, 220);
        });
    }

    // Делегирование клика по клеткам календаря
    document.getElementById('hist-cal-grid')?.addEventListener('click', (e) => {
        const cell = e.target.closest('[data-day]');
        if (!cell) return;
        _selectDay(cell.dataset.day);
    });

    // Fallback: таблица режима "Список"
    document.getElementById('history-tbody')?.addEventListener('click', async (e) => {
        const viewBtn   = e.target.closest('.history-view-btn');
        const exportBtn = e.target.closest('.history-export-btn');
        const delBtn    = e.target.closest('.history-del-btn');
        if (viewBtn)   openEventReadonly(parseInt(viewBtn.dataset.eventId, 10));
        if (exportBtn) _exportEvent(parseInt(exportBtn.dataset.eventId, 10));
        if (delBtn)    _deleteEvent(parseInt(delBtn.dataset.eventId, 10));
    });
}

function _shiftMonth(delta) {
    let y = _state.year;
    let m = _state.month + delta;
    if (m < 0)   { m = 11; y -= 1; }
    if (m > 11) { m = 0;  y += 1; }
    _state.year  = y;
    _state.month = m;
    _state.selectedDay = null;     // при смене месяца снимаем выбор
    _state.selectedDayAudit = [];
    _fetchMonth().then(_render);
}

// ─── Загрузка данных месяца ──────────────────────────────────────────────
async function _fetchMonth() {
    if (_state.loading) return;
    _state.loading = true;

    try {
        const y = _state.year;
        const m = _state.month;
        const firstOfMonth = _iso(y, m, 1);
        const daysInMonth  = new Date(y, m + 1, 0).getDate();
        const lastOfMonth  = _iso(y, m, daysInMonth);

        // События: грузим все, фильтруем на клиенте по месяцу.
        // Кешируем в _state.events чтобы не дёргать при переключении режима.
        if (_state.events.length === 0) {
            try {
                const all = await api.get('/admin/events');
                _state.events = (all || []).filter(e => !e.is_template && e.date);
            } catch (err) {
                console.error('[history] events:', err);
                _state.events = [];
            }
        }

        // Audit day-counts — только для текущего месяца
        try {
            _state.dayCounts = await api.get(
                `/admin/audit-log/day-counts?date_from=${firstOfMonth}&date_to=${lastOfMonth}`
            );
        } catch (err) {
            // Не-админу эндпоинт закрыт, значит просто нет счётчиков. Не критично.
            _state.dayCounts = {};
        }
    } finally {
        _state.loading = false;
    }
}

// ─── Выбор дня ───────────────────────────────────────────────────────────
async function _selectDay(iso) {
    _state.selectedDay = iso;

    // Подтягиваем детальный audit-лог за этот день.
    // date_from=date_to=iso → сервер сделает один день через timestamp<iso+1d.
    try {
        const res = await api.get(
            `/admin/audit-log?date_from=${iso}&date_to=${iso}&limit=200`
        );
        _state.selectedDayAudit = res.items || [];
    } catch {
        _state.selectedDayAudit = [];
    }

    _render();
}

// ─── Рендер ──────────────────────────────────────────────────────────────
function _render() {
    // Ярлык месяца
    const label = document.getElementById('hist-cal-month-label');
    if (label) label.textContent = `${MONTHS_NOM[_state.month]} ${_state.year}`;

    _renderSummary();

    if (_state.mode === 'month') {
        document.querySelector('.hist-cal__layout')?.classList.remove('hidden');
        document.getElementById('hist-cal-list-view')?.classList.add('hidden');
        _renderGrid();
        _renderDayPanel();
    } else {
        document.querySelector('.hist-cal__layout')?.classList.add('hidden');
        document.getElementById('hist-cal-list-view')?.classList.remove('hidden');
        _renderListFallback();
    }
}

// ─── Сводка месяца ──────────────────────────────────────────────────────
function _renderSummary() {
    const y = _state.year, m = _state.month;
    const inMonth = _state.events.filter(e => {
        const [ey, em] = e.date.split('-').map(Number);
        return ey === y && em - 1 === m;
    });

    const today = _todayIso();
    const past     = inMonth.filter(e => e.date <  today).length;
    const upcoming = inMonth.filter(e => e.date >  today).length;

    // Сумма audit-изменений за месяц
    const auditTotal = Object.values(_state.dayCounts).reduce((a, b) => a + b, 0);

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('hist-cal-sum-events',   inMonth.length);
    set('hist-cal-sum-past',     past);
    set('hist-cal-sum-upcoming', upcoming);
    set('hist-cal-sum-audit',    auditTotal);
}

// ─── Сетка месяца ────────────────────────────────────────────────────────
function _renderGrid() {
    const grid = document.getElementById('hist-cal-grid');
    if (!grid) return;

    const y = _state.year, m = _state.month;
    const today       = _todayIso();
    const firstDow    = new Date(y, m, 1).getDay();      // 0=вс
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    // Начинаем сетку с понедельника (ru-формат)
    const daysInPrev = new Date(y, m, 0).getDate();
    const leadEmpty  = (firstDow + 6) % 7;              // вс=0 → 6 пустых,   пн=1 → 0

    // Строим 6×7=42 клетки (максимум нужно для любого месяца)
    const cells = [];
    for (let i = 0; i < leadEmpty; i++) {
        const d = daysInPrev - leadEmpty + 1 + i;
        cells.push({ y, m: m - 1, d, outside: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
        cells.push({ y, m, d, outside: false });
    }
    // Добавляем хвост до кратности 7; дорисовываем до 42 только если нужна 6-я строка
    while (cells.length % 7 !== 0 || cells.length < 35) {
        const last = cells[cells.length - 1];
        const nxt  = new Date(last.y, last.m, last.d + 1);
        cells.push({
            y: nxt.getFullYear(),
            m: nxt.getMonth(),
            d: nxt.getDate(),
            outside: true,
        });
        if (cells.length >= 42) break;
    }

    // Группируем события по дате для быстрого lookup'а
    const eventsByDate = {};
    _state.events.forEach(e => {
        if (!eventsByDate[e.date]) eventsByDate[e.date] = [];
        eventsByDate[e.date].push(e);
    });

    grid.innerHTML = cells.map(c => {
        // На клетках соседних месяцев тоже показываем данные — чтобы user
        // видел что там были события, и клик работал (сервер смещается на месяц).
        const iso    = _iso(c.y, c.m, c.d);
        const dow    = new Date(c.y, c.m, c.d).getDay();
        const isWk   = dow === 0 || dow === 6;
        const isTdy  = iso === today;
        const isSel  = iso === _state.selectedDay;

        const dayEvents = (eventsByDate[iso] || [])
            .filter(e => !_state.searchQuery ||
                         (e.title || '').toLowerCase().includes(_state.searchQuery));
        const auditN    = _state.dayCounts[iso] || 0;

        const eventPills = dayEvents.slice(0, 3).map(e => {
            const when = e.date < today ? 'past' : e.date === today ? 'today' : 'future';
            return `<div class="hist-cal__event-pill hist-cal__event-pill--${when}"
                         title="${_esc(e.title)}">${_esc(e.title)}</div>`;
        }).join('');
        const moreN  = dayEvents.length - 3;
        const more   = moreN > 0
            ? `<div class="hist-cal__event-more">+${moreN} ещё</div>`
            : '';

        const auditBadge = auditN > 0
            ? `<span class="hist-cal__audit-badge" title="Изменений за день: ${auditN}">
                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                       <circle cx="12" cy="12" r="10"/>
                       <polyline points="12 6 12 12 16 14"/>
                   </svg>
                   ${auditN}
               </span>`
            : '';

        const classes = [
            'hist-cal__cell',
            c.outside   ? 'hist-cal__cell--outside'  : '',
            isWk        ? 'hist-cal__cell--weekend'  : '',
            isTdy       ? 'hist-cal__cell--today'    : '',
            isSel       ? 'hist-cal__cell--selected' : '',
        ].filter(Boolean).join(' ');

        return `
            <div class="${classes}" data-day="${iso}">
                <div class="hist-cal__day-head">
                    <span class="hist-cal__day-num">${c.d}</span>
                    ${auditBadge}
                </div>
                <div class="hist-cal__events">
                    ${eventPills}
                    ${more}
                </div>
            </div>
        `;
    }).join('');
}

// ─── Правая панель дня ───────────────────────────────────────────────────
function _renderDayPanel() {
    const panel = document.getElementById('hist-cal-day-panel');
    if (!panel) return;

    const iso = _state.selectedDay;
    if (!iso) {
        panel.innerHTML = `
            <div class="hist-cal__day-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8"  y1="2" x2="8" y2="6"/>
                    <line x1="3"  y1="10" x2="21" y2="10"/>
                </svg>
                <p>Выберите день</p>
                <span>Кликните по дню в календаре, чтобы посмотреть списки и историю изменений</span>
            </div>`;
        return;
    }

    const dayEvents = _state.events.filter(e => e.date === iso);
    const today     = _todayIso();

    const eventsHtml = dayEvents.length === 0
        ? `<div class="hist-cal__events-empty">В этот день списков не было</div>`
        : dayEvents.map(e => {
            const when = e.date < today ? 'past' : e.date === today ? 'today' : 'future';
            const statusClass = `hist-cal__event-status--${_esc(e.status || 'draft')}`;
            const statusLbl = e.status === 'active' ? 'Активен'
                            : e.status === 'closed' ? 'Закрыт' : 'Черновик';
            return `
                <div class="hist-cal__day-event hist-cal__day-event--${when}"
                     data-event-id="${e.id}">
                    <div class="hist-cal__event-info">
                        <div class="hist-cal__event-name">${_esc(e.title)}</div>
                        <div class="hist-cal__event-meta">
                            #${e.id} · ${_esc(_weekdayOf(iso))}
                        </div>
                    </div>
                    <span class="hist-cal__event-status ${statusClass}">${statusLbl}</span>
                </div>
            `;
          }).join('');

    const audit = _state.selectedDayAudit;
    const auditHtml = audit.length === 0
        ? `<div class="hist-cal__audit-empty">В этот день изменений не зафиксировано</div>`
        : audit.map(a => {
            const fieldsChanged = Object.keys(a.new_values || a.old_values || {});
            const fieldsText = fieldsChanged.length > 0
                ? `Поля: ${fieldsChanged.slice(0, 4).join(', ')}${fieldsChanged.length > 4 ? '…' : ''}`
                : '';
            return `
                <div class="hist-cal__audit-item">
                    <div class="hist-cal__audit-head">
                        <span class="hist-cal__audit-action hist-cal__audit-action--${_esc(a.action)}">
                            ${_esc(a.action)}
                        </span>
                        <span class="hist-cal__audit-entity">${_esc(a.entity_type)}${a.entity_id ? '#'+a.entity_id : ''}</span>
                        <span class="hist-cal__audit-user">${_esc(a.username || '—')}</span>
                        <span class="hist-cal__audit-time">${_fmtTime(a.timestamp)}</span>
                    </div>
                    ${fieldsText ? `<div class="hist-cal__audit-fields">${_esc(fieldsText)}</div>` : ''}
                </div>
            `;
          }).join('');

    panel.innerHTML = `
        <div class="hist-cal__day-header">
            <div>
                <div class="hist-cal__day-title">${_esc(_fmtFullDate(iso))}</div>
                <div class="hist-cal__day-subtitle">${_esc(_weekdayOf(iso).toLowerCase())}</div>
            </div>
            <button class="hist-cal__day-close" id="hist-cal-day-close" type="button" title="Закрыть">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6"  y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>
        <div class="hist-cal__day-body">
            <div class="hist-cal__day-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8"  y1="2" x2="8" y2="6"/>
                    <line x1="3"  y1="10" x2="21" y2="10"/>
                </svg>
                Списки
                <span class="hist-cal__day-section-count">${dayEvents.length}</span>
            </div>
            ${eventsHtml}

            <div class="hist-cal__day-section-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                </svg>
                Изменения
                <span class="hist-cal__day-section-count">${audit.length}</span>
            </div>
            ${auditHtml}
        </div>
    `;

    // Обработчики
    document.getElementById('hist-cal-day-close')?.addEventListener('click', () => {
        _state.selectedDay = null;
        _state.selectedDayAudit = [];
        _render();
    });
    panel.querySelectorAll('[data-event-id]').forEach(row => {
        row.addEventListener('click', () => {
            const eid = parseInt(row.dataset.eventId, 10);
            // admin → editable; dept не видит вкладку История, но на всякий случай
            if (window.currentUserRole === 'admin' && window.openEventEditor) {
                window.openEventEditor(eid);
            } else {
                openEventReadonly(eid);
            }
        });
    });
}

// ─── Fallback "Список" ───────────────────────────────────────────────────
function _renderListFallback() {
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;

    const today = _todayIso();
    const q     = _state.searchQuery;

    const rows = _state.events
        .filter(e => !q || (e.title || '').toLowerCase().includes(q))
        .sort((a, b) => {
            if (a.date !== b.date) return a.date > b.date ? -1 : 1;
            return b.id - a.id;
        });

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:24px; color:var(--md-on-surface-hint);">Нет списков</td></tr>`;
        return;
    }

    const STATUS = { draft: 'Черновик', active: 'Активен', closed: 'Закрыт' };
    tbody.innerHTML = rows.map(ev => {
        const isPast  = ev.date < today;
        const isToday = ev.date === today;
        const badge   = isToday
            ? `<span style="font-size:0.7rem; padding:2px 7px; border-radius:10px; background:#fef3c7; color:#92400e; margin-left:6px;">Сегодня</span>`
            : '';
        return `
            <tr data-event-id="${ev.id}" style="${isPast ? 'opacity:0.72;' : ''}">
                <td style="color:var(--md-on-surface-hint); font-family:var(--md-font-mono); font-size:0.72rem;">${ev.id}</td>
                <td style="font-weight:500;">${_esc(ev.title)}</td>
                <td style="white-space:nowrap;">${_esc(ev.date.split('-').reverse().join('.'))}${badge}</td>
                <td style="color:var(--md-on-surface-variant);">${_esc(_weekdayOf(ev.date))}</td>
                <td>${_esc(STATUS[ev.status] || ev.status)}</td>
                <td>—</td>
                <td>
                    <div style="display:flex; gap:4px; flex-wrap:wrap;">
                        <button class="btn btn-outlined btn-xs history-view-btn" data-event-id="${ev.id}" type="button">👁 Просмотр</button>
                        <button class="btn btn-outlined btn-xs history-export-btn" data-event-id="${ev.id}" type="button">⬇ .docx</button>
                        <button class="btn btn-danger btn-xs history-del-btn" data-event-id="${ev.id}" type="button">✕</button>
                    </div>
                </td>
            </tr>`;
    }).join('');
}

// ─── Actions ─────────────────────────────────────────────────────────────

/**
 * Публичная функция — открывает список в режиме просмотра (модалка с таблицей).
 * Используется:
 *   - из календаря истории (клик по карточке события)
 *   - из dashboard'а (клик по карточке списка)
 *   - из таблицы fallback-режима "Список"
 */
export async function openEventReadonly(eventId) {
    try {
        const data = await api.get(`/admin/events/${eventId}/full`);
        _showReadonlyModal(data);
    } catch (err) {
        console.error('[history] open readonly:', err);
        window.showSnackbar?.('Не удалось открыть список', 'error');
    }
}

function _showReadonlyModal(data) {
    document.getElementById('history-readonly-modal')?.remove();

    const ev   = data.event;
    const cols = (data.columns || []).filter(c => c.visible !== false).sort((a, b) => a.order - b.order);

    const slotRow = (slot, idx) => {
        const cells = cols.map(c => {
            let val = '';
            if      (c.type === 'select_position') val = slot.position_name || '—';
            else if (c.type === 'select_dept')     val = slot.department ? formatRole(slot.department) : '—';
            else if (c.key in slot)                val = slot[c.key] ?? '';
            else if (slot.extra_data && slot.extra_data[c.key] != null) val = slot.extra_data[c.key];
            return `<td style="padding:4px 8px; border-bottom:1px solid var(--md-outline-variant); font-size:0.82rem;">${_esc(val || '—')}</td>`;
        }).join('');
        return `<tr><td style="padding:4px 8px; text-align:center; color:var(--md-on-surface-hint); font-size:0.75rem;">${idx}</td>${cells}</tr>`;
    };

    let globalIdx = 1;
    const groupsHtml = (data.groups || []).map(g => {
        const rows = (g.slots || []).map(s => slotRow(s, globalIdx++)).join('');
        return `
            <tr class="group-header"><td colspan="${cols.length + 1}" style="background:var(--md-surface-variant); padding:6px 10px; font-weight:600; font-size:0.85rem;">${_esc(g.name)}</td></tr>
            ${rows}`;
    }).join('');

    const modal = document.createElement('div');
    modal.id = 'history-readonly-modal';
    modal.style.cssText = 'position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; padding:20px;';
    modal.innerHTML = `
        <div style="background:var(--md-surface); border-radius:var(--md-radius-lg, 12px); box-shadow:0 10px 40px rgba(0,0,0,0.25); max-width:1100px; width:100%; max-height:90vh; display:flex; flex-direction:column; overflow:hidden;">
            <div style="padding:16px 20px; border-bottom:1px solid var(--md-outline-variant); display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
                <div>
                    <div style="font-weight:600; font-size:1rem;">${_esc(ev.title)}</div>
                    <div style="font-size:0.78rem; color:var(--md-on-surface-hint); margin-top:2px;">
                        ${_esc(_fmtFullDate(ev.date))} · ${_esc(_weekdayOf(ev.date))} · ${_esc(ev.status)}
                    </div>
                </div>
                <button class="btn btn-text btn-sm" id="history-modal-close" type="button">Закрыть</button>
            </div>

            <div style="padding:12px 20px; background:var(--md-surface-variant); border-bottom:1px solid var(--md-outline-variant); display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap;">
                <div style="flex:1 1 auto; min-width:260px;">
                    <div style="font-size:0.72rem; font-weight:600; color:var(--md-on-surface-variant); margin-bottom:6px; text-transform:uppercase; letter-spacing:0.3px;">
                        Дежурный (подпись в документе)
                    </div>
                    <div style="display:flex; gap:8px; flex-wrap:wrap;">
                        <div class="field" style="min-width:130px; flex:0 0 150px;">
                            <label class="field-label" for="history-duty-rank" style="font-size:0.7rem;">Звание</label>
                            <input type="text" id="history-duty-rank" placeholder="подполковник" autocomplete="off"
                                   style="padding:5px 8px; font-size:0.82rem; border:1px solid var(--md-outline); border-radius:var(--md-radius-sm); background:var(--md-surface); color:var(--md-on-surface); width:100%; outline:none;">
                        </div>
                        <div class="field" style="flex:1; min-width:180px;">
                            <label class="field-label" for="history-duty-name" style="font-size:0.7rem;">ФИО</label>
                            <input type="text" id="history-duty-name" placeholder="А.П. Ярощук" autocomplete="off"
                                   style="padding:5px 8px; font-size:0.82rem; border:1px solid var(--md-outline); border-radius:var(--md-radius-sm); background:var(--md-surface); color:var(--md-on-surface); width:100%; outline:none;">
                        </div>
                        <button id="history-duty-save" class="btn btn-outlined btn-sm" type="button"
                                style="flex-shrink:0; align-self:flex-end;">
                            Сохранить
                        </button>
                    </div>
                </div>
                <button class="btn btn-filled btn-sm history-export-btn" data-event-id="${ev.id}" type="button"
                        style="flex-shrink:0; align-self:flex-end;">
                    ⬇ Скачать .docx
                </button>
            </div>

            <div style="overflow:auto; flex:1;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead style="position:sticky; top:0; background:var(--md-surface); z-index:1;">
                        <tr>
                            <th style="padding:6px 8px; text-align:center; border-bottom:2px solid var(--md-outline); font-size:0.75rem;">№</th>
                            ${cols.map(c => `<th style="padding:6px 8px; text-align:left; border-bottom:2px solid var(--md-outline); font-size:0.75rem;">${_esc(c.label)}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>${groupsHtml}</tbody>
                </table>
            </div>
        </div>`;

    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('history-modal-close')?.addEventListener('click', () => modal.remove());

    _loadDutyIntoModal();
    document.getElementById('history-duty-save')?.addEventListener('click', _saveDutyFromModal);
    modal.querySelector('.history-export-btn')?.addEventListener('click', async () => {
        await _saveDutyFromModal({ silent: true });
        _exportEvent(ev.id);
    });
}

async function _loadDutyIntoModal() {
    try {
        const s = await api.get('/settings');
        const rankEl = document.getElementById('history-duty-rank');
        const nameEl = document.getElementById('history-duty-name');
        if (rankEl) rankEl.value = s.duty_rank || '';
        if (nameEl) nameEl.value = s.duty_name || '';
    } catch (err) { console.error('[history] load duty:', err); }
}

async function _saveDutyFromModal(opts = {}) {
    const silent = opts && opts.silent === true;
    const rank = document.getElementById('history-duty-rank')?.value?.trim() ?? '';
    const name = document.getElementById('history-duty-name')?.value?.trim() ?? '';
    try {
        await api.patch('/settings', { duty_rank: rank, duty_name: name });
        if (!silent) {
            const label = `${rank} ${name}`.trim();
            window.showSnackbar?.(label ? `Дежурный сохранён: ${label}` : 'Дежурный очищен', 'success');
        }
    } catch (err) {
        console.error('[history] save duty:', err);
        if (!silent) window.showSnackbar?.('Ошибка сохранения дежурного', 'error');
    }
}

async function _exportEvent(eventId) {
    try {
        const blob = await api.download(`/export/events/${eventId}/export-word`);
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), { href: url, download: `Список_${eventId}.docx` });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('[history] export:', err);
        window.showSnackbar?.('Ошибка выгрузки', 'error');
    }
}

async function _deleteEvent(eventId) {
    const ev = _state.events.find(e => e.id === eventId);
    const label = ev ? `«${ev.title}»` : `#${eventId}`;
    if (!confirm(`Удалить список ${label}?\n\nВсе заполненные данные будут безвозвратно удалены.`)) return;
    try {
        await api.delete(`/admin/events/${eventId}`);
        window.showSnackbar?.('Список удалён', 'success');
        _state.events = [];                 // сбросить кеш чтобы перезагрузить
        await loadHistory();
    } catch (err) {
        console.error('[history] delete:', err);
        window.showSnackbar?.('Ошибка удаления', 'error');
    }
}
