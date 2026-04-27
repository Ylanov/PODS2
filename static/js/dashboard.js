// static/js/dashboard.js
/**
 * Дашборд готовности — главный экран администратора.
 * Показывает сводку заполнения всех списков за выбранную дату
 * с мини-календарём и прогресс-барами по управлениям.
 */

import { api } from './api.js';
import { formatRole } from './ui.js';

// ─── Состояние ────────────────────────────────────────────────────────────────

let _selectedDate = _todayISO();
let _calYear      = new Date().getFullYear();
let _calMonth     = new Date().getMonth() + 1;
let _calDots      = {};          // {"YYYY-MM-DD": count}
let _refreshTimer = null;

// ─── Публичный API ────────────────────────────────────────────────────────────

export function initDashboard() {
    _bindEvents();
    _renderCalendar();
    loadDashboard();
    _startAutoRefresh();
}

export async function loadDashboard() {
    // Защита: дашборд — только для админа. Если setInterval продолжает тикать
    // после смены пользователя на department, молча выходим и останавливаем таймер.
    if (window.currentUserRole !== 'admin') {
        stopDashboard();
        return;
    }

    const container = document.getElementById('db-content');
    if (!container) return;

    container.innerHTML = _skeletonHTML();

    try {
        const [data, calData] = await Promise.all([
            api.get(`/admin/dashboard/today?date=${_selectedDate}`),
            api.get(`/admin/dashboard/calendar?year=${_calYear}&month=${_calMonth}`),
        ]);

        // Обновляем точки календаря
        _calDots = {};
        calData.dates.forEach(d => { _calDots[d.date] = d.count; });
        _renderCalendar();

        _renderDashboard(data);
    } catch (err) {
        console.error('[dashboard] load error:', err);
        container.innerHTML = `
            <div style="text-align:center;padding:48px;color:var(--md-on-surface-hint);">
                <p>Ошибка загрузки дашборда</p>
            </div>`;
    }
}

// ─── Авто-обновление ─────────────────────────────────────────────────────────

function _startAutoRefresh() {
    clearInterval(_refreshTimer);
    // Обновляем каждые 30 секунд если вкладка открыта и мы админ
    _refreshTimer = setInterval(() => {
        if (window.currentUserRole !== 'admin') {
            stopDashboard();
            return;
        }
        const tab = document.getElementById('tab-dashboard');
        if (!tab?.classList.contains('hidden')) loadDashboard();
    }, 30_000);
}

// Останавливает автообновление дашборда — вызывается при logout/смене сессии
export function stopDashboard() {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
}

// Вызывать из websockets.js при событии update
export function onWsUpdate() {
    const tab = document.getElementById('tab-dashboard');
    if (!tab?.classList.contains('hidden')) loadDashboard();
}

// ─── Привязка событий ─────────────────────────────────────────────────────────

function _bindEvents() {
    document.getElementById('db-cal-prev')?.addEventListener('click', () => {
        _calMonth--;
        if (_calMonth < 1) { _calMonth = 12; _calYear--; }
        _loadCalendarDots().then(_renderCalendar);
    });

    document.getElementById('db-cal-next')?.addEventListener('click', () => {
        _calMonth++;
        if (_calMonth > 12) { _calMonth = 1; _calYear++; }
        _loadCalendarDots().then(_renderCalendar);
    });

    document.getElementById('db-today-btn')?.addEventListener('click', () => {
        const now = new Date();
        _calYear  = now.getFullYear();
        _calMonth = now.getMonth() + 1;
        _selectedDate = _todayISO();
        _loadCalendarDots().then(_renderCalendar);
        loadDashboard();
    });
}

async function _loadCalendarDots() {
    try {
        const data = await api.get(`/admin/dashboard/calendar?year=${_calYear}&month=${_calMonth}`);
        _calDots = {};
        data.dates.forEach(d => { _calDots[d.date] = d.count; });
    } catch { _calDots = {}; }
}

// ─── Мини-календарь ──────────────────────────────────────────────────────────

function _renderCalendar() {
    const grid  = document.getElementById('db-cal-grid');
    const label = document.getElementById('db-cal-label');
    if (!grid || !label) return;

    const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                    'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const DOW    = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

    label.textContent = `${MONTHS[_calMonth - 1]} ${_calYear}`;

    const daysInMonth = new Date(_calYear, _calMonth, 0).getDate();
    const firstDow    = (new Date(_calYear, _calMonth - 1, 1).getDay() + 6) % 7; // 0=Пн
    const today       = _todayISO();

    let html = DOW.map(d =>
        `<div class="db-cal__dow">${d}</div>`
    ).join('');

    // Пустые ячейки до первого дня
    for (let i = 0; i < firstDow; i++) {
        html += '<div class="db-cal__day db-cal__day--empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const iso     = `${_calYear}-${String(_calMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isToday = iso === today;
        const isSel   = iso === _selectedDate;
        const hasDot  = !!_calDots[iso];
        const dow     = (new Date(_calYear, _calMonth - 1, d).getDay() + 6) % 7;
        const isWknd  = dow >= 5;

        html += `<div class="db-cal__day${isToday ? ' db-cal__day--today' : ''}${isSel ? ' db-cal__day--sel' : ''}${isWknd ? ' db-cal__day--weekend' : ''}"
                      data-date="${iso}">
            ${d}
            ${hasDot ? '<span class="db-cal__dot"></span>' : ''}
        </div>`;
    }

    grid.innerHTML = html;

    grid.querySelectorAll('.db-cal__day[data-date]').forEach(el => {
        el.addEventListener('click', () => {
            _selectedDate = el.dataset.date;
            _renderCalendar();   // перерисуем без запроса — только активный день
            loadDashboard();
        });
    });
}

// ─── Рендер дашборда ──────────────────────────────────────────────────────────

function _renderDashboard(data) {
    const container = document.getElementById('db-content');
    if (!container) return;

    const dateLabel = _formatDateNice(_selectedDate);

    // Шапка с общим прогрессом
    const totalPct  = data.fill_pct;
    const ringColor = _pctColor(totalPct);

    let html = `
    <div class="db-header">
        <div class="db-header__date">${dateLabel}</div>
        <div class="db-header__summary">
            <div class="db-ring" style="--pct:${totalPct}; --clr:${ringColor};">
                <svg viewBox="0 0 44 44" class="db-ring__svg">
                    <circle class="db-ring__bg" cx="22" cy="22" r="18"/>
                    <circle class="db-ring__fg" cx="22" cy="22" r="18"
                        stroke-dasharray="${(totalPct / 100 * 113).toFixed(1)} 113"
                        stroke="${ringColor}"/>
                </svg>
                <span class="db-ring__label">${totalPct}%</span>
            </div>
            <div class="db-header__counts">
                <div class="db-header__count db-header__count--filled">
                    <span class="db-header__num">${data.filled_slots}</span>
                    <span class="db-header__sub">заполнено</span>
                </div>
                <div class="db-header__count db-header__count--empty">
                    <span class="db-header__num">${data.empty_slots}</span>
                    <span class="db-header__sub">пусто</span>
                </div>
                <div class="db-header__count">
                    <span class="db-header__num">${data.total_slots}</span>
                    <span class="db-header__sub">всего</span>
                </div>
            </div>
        </div>
    </div>`;

    if (data.events.length === 0 && data.events_without_date.length === 0) {
        html += `<div class="db-empty">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3">
                <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <p>На эту дату нет активных списков</p>
        </div>`;
    } else {
        const allEvents = [...data.events, ...data.events_without_date];
        html += `<div class="db-events">`;
        allEvents.forEach(ev => { html += _renderEventCard(ev); });
        html += `</div>`;
    }

    container.innerHTML = html;

    // Клик по карточке:
    //   admin   → открыть редактор (event_editor.js) — inline-правка с FIO suggest,
    //             realtime broadcast в dept через manager.broadcast.
    //   dept    → readonly-модалка (history.openEventReadonly).
    container.querySelectorAll('.db-event-card[data-event-id]').forEach(card => {
        card.addEventListener('click', () => {
            const eventId = parseInt(card.dataset.eventId, 10);
            if (window.currentUserRole === 'admin' && window.openEventEditor) {
                window.openEventEditor(eventId);
            } else {
                import('./history.js').then(m => m.openEventReadonly(eventId));
            }
        });
    });
}

function _renderEventCard(ev) {
    const pct   = ev.fill_pct;
    const color = _pctColor(pct);
    const statusLabel = ev.status === 'active' ? 'Активен' : ev.status === 'draft' ? 'Черновик' : ev.status;
    const statusCls   = ev.status === 'active' ? 'db-status--active' : 'db-status--draft';

    const deptsHtml = ev.departments.map(dept => {
        const dPct   = dept.fill_pct;
        const dColor = _pctColor(dPct);
        const emptyTip = dept.empty_positions.length
            ? `Не заполнено: ${dept.empty_positions.join(', ')}${dept.empty > dept.empty_positions.length ? '...' : ''}`
            : '';

        return `<div class="db-dept" title="${_esc(emptyTip)}">
            <div class="db-dept__head">
                <span class="db-dept__name">${_esc(formatRole(dept.name))}</span>
                <span class="db-dept__nums">${dept.filled}/${dept.total}</span>
            </div>
            <div class="db-dept__bar">
                <div class="db-dept__bar-fill" style="width:${dPct}%; background:${dColor};"></div>
            </div>
        </div>`;
    }).join('');

    return `
    <div class="db-event-card" data-event-id="${ev.id}" title="Открыть для просмотра (как в Истории)">
        <div class="db-event-card__top">
            <div class="db-event-card__title-row">
                <span class="db-event-card__title">${_esc(ev.title)}</span>
                <span class="db-status ${statusCls}">${statusLabel}</span>
            </div>
            <div class="db-event-card__progress-row">
                <div class="db-event-card__bar">
                    <div class="db-event-card__bar-fill" style="width:${pct}%;background:${color};"></div>
                </div>
                <span class="db-event-card__pct" style="color:${color};">${pct}%</span>
                <span class="db-event-card__counts">${ev.filled_slots}/${ev.total_slots} слотов</span>
            </div>
        </div>
        ${ev.departments.length > 0 ? `<div class="db-depts">${deptsHtml}</div>` : ''}
    </div>`;
}

// ─── Скелетон загрузки ────────────────────────────────────────────────────────

function _skeletonHTML() {
    return `<div class="db-skeleton">
        <div class="db-skel-row db-skel-row--wide"></div>
        ${[1,2,3].map(() => `
        <div class="db-event-card db-event-card--skel">
            <div class="db-skel-row"></div>
            <div class="db-skel-row db-skel-row--bar"></div>
            <div class="db-skel-row db-skel-row--short"></div>
        </div>`).join('')}
    </div>`;
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function _todayISO() {
    return new Date().toISOString().slice(0, 10);
}

function _pctColor(pct) {
    if (pct >= 90) return 'var(--md-success, #1D9E75)';
    if (pct >= 60) return 'var(--md-warning, #BA7517)';
    return 'var(--md-error, #E24B4A)';
}

function _formatDateNice(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    const today     = new Date(); today.setHours(0,0,0,0);
    const tomorrow  = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

    const same = (a, b) => a.toDateString() === b.toDateString();
    const weekdays = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
    const months   = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

    const dayStr = `${d.getDate()} ${months[d.getMonth()]}`;
    if (same(d, today))     return `Сегодня, ${dayStr}`;
    if (same(d, tomorrow))  return `Завтра, ${dayStr}`;
    if (same(d, yesterday)) return `Вчера, ${dayStr}`;
    return `${weekdays[d.getDay()]}, ${dayStr} ${d.getFullYear()}`;
}

function _esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}