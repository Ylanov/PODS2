// static/js/editor_overview.js
//
// Панель «Сводка списков» в верхней части вкладки «Редактор шаблонов»
// (tab-editor). Показывает админу списки:
//   - на СЕГОДНЯ (с прогрессом заполнения),
//   - на ЗАВТРА,
//   - в ближайшие 7 дней,
//   - были недавно (последняя неделя — свёрнуто).
//
// Клик по карточке списка — открывает его в редакторе ниже
// (окружающая функция openEventInEditor определена в admin.js).
//
// Почему отдельный модуль: admin.js уже 1700+ строк. Эта фича не связана
// с редактированием слотов/групп — у неё свой жизненный цикл и данные.
//
// Обновления: WS «update» → перезагружает сводку (в combat'е и duty уже
// такой же паттерн), так что прогресс в карточках меняется в реальном
// времени при заполнении департаментом.

import { api, ApiError } from './api.js';

const MONTHS_SHORT = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'];
const WEEKDAY_SHORT = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

let _mounted   = false;
let _container = null;
let _openInEditor = null;  // колбэк от admin.js — (eventId) → load editor
let _loading   = false;

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtDayLabel(iso) {
    // '2026-04-22' → '22 апр, Ср'
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    const dayNum   = d.getDate();
    const monName  = MONTHS_SHORT[d.getMonth()];
    const wdayName = WEEKDAY_SHORT[d.getDay()];
    return `${dayNum} ${monName}, ${wdayName}`;
}

function _statusBadge(status) {
    // Согласовано с бэкендом Event.status: 'draft' | 'active'
    if (status === 'active') {
        return `<span class="ov-badge ov-badge--active" title="Опубликован, видят управления">активен</span>`;
    }
    return `<span class="ov-badge ov-badge--draft" title="Черновик — управления не видят">черновик</span>`;
}

function _percentColor(pct) {
    if (pct >= 90) return 'var(--md-success, #1D9E75)';
    if (pct >= 50) return 'var(--md-warning, #BA7517)';
    if (pct > 0)   return 'var(--md-error,   #E24B4A)';
    return 'var(--md-on-surface-hint)';
}

function _renderCard(item) {
    // item: {id, title, date, status, groups_count, total_slots, filled_slots, assigned_slots, percent}
    const color = _percentColor(item.percent);
    const dateLabel = _fmtDayLabel(item.date);
    const barWidth  = Math.max(0, Math.min(100, item.percent));
    // assigned_slots < total_slots = есть неназначенные квоты — предупреждение
    const hasUnassigned = item.assigned_slots < item.total_slots;

    return `
        <button type="button"
                class="ov-card"
                data-event-id="${item.id}"
                title="Открыть в редакторе">
            <div class="ov-card__top">
                <span class="ov-card__date">${esc(dateLabel)}</span>
                ${_statusBadge(item.status)}
            </div>
            <div class="ov-card__title">${esc(item.title)}</div>
            <div class="ov-card__meta">
                ${item.groups_count} гр. · ${item.filled_slots}/${item.total_slots} строк
                ${hasUnassigned
                    ? `<span class="ov-card__warn" title="Есть строки без квоты">⚠ без квоты: ${item.total_slots - item.assigned_slots}</span>`
                    : ''}
            </div>
            <div class="ov-card__bar">
                <div class="ov-card__bar-fill"
                     style="width:${barWidth}%; background:${color};"></div>
            </div>
            <div class="ov-card__pct" style="color:${color};">${item.percent}%</div>
        </button>`;
}

function _renderSection(title, items, emptyHint, collapsible = false) {
    if (!items || items.length === 0) {
        if (!emptyHint) return '';
        return `
            <div class="ov-section ov-section--empty">
                <div class="ov-section__head">
                    <span class="ov-section__title">${esc(title)}</span>
                    <span class="ov-section__count">—</span>
                </div>
                <div class="ov-empty">${esc(emptyHint)}</div>
            </div>`;
    }

    const cards = items.map(_renderCard).join('');
    const collapsedAttr = collapsible ? ' data-collapsible="1"' : '';
    return `
        <div class="ov-section"${collapsedAttr}>
            <div class="ov-section__head">
                <span class="ov-section__title">${esc(title)}</span>
                <span class="ov-section__count">${items.length}</span>
                ${collapsible
                    ? `<button type="button" class="ov-section__toggle" title="Свернуть/развернуть">▾</button>`
                    : ''}
            </div>
            <div class="ov-section__grid">${cards}</div>
        </div>`;
}

async function _load() {
    if (_loading || !_container) return;
    _loading = true;
    try {
        const data = await api.get('/admin/events/overview?days_back=7&days_forward=14');
        _render(data);
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) return;   // logout уже запустился
        console.error('[overview] load:', err);
        _container.innerHTML = `
            <div class="ov-error">
                Не удалось загрузить сводку списков.
                <button type="button" class="ov-retry">Повторить</button>
            </div>`;
        _container.querySelector('.ov-retry')?.addEventListener('click', _load);
    } finally {
        _loading = false;
    }
}

function _render(data) {
    const b = data.buckets || {};
    const today    = b.today    || [];
    const tomorrow = b.tomorrow || [];
    const upcoming = b.upcoming || [];
    const past     = b.past     || [];

    const todayLabel    = _fmtDayLabel(data.today_iso);
    const tomorrowLabel = _fmtDayLabel(data.tomorrow_iso);

    const html = `
        <div class="ov-head">
            <div class="ov-head__title">Сводка списков</div>
            <div class="ov-head__hint">Клик по карточке — открыть в редакторе ниже</div>
            <button type="button" class="ov-refresh" title="Обновить">↻</button>
        </div>
        ${_renderSection(`На сегодня (${todayLabel})`, today,
            'Сегодня нет опубликованных списков. Сгенерируйте через «Расписание» ниже.')}
        ${_renderSection(`На завтра (${tomorrowLabel})`, tomorrow,
            'Завтра пока нет списков.')}
        ${_renderSection('В ближайшие дни',   upcoming,
            'На ближайшие две недели ничего не запланировано.')}
        ${_renderSection('Было недавно',       past,
            null, /* collapsible */ true)}
    `;
    _container.innerHTML = html;

    // Делегирование: клик по карточке → открыть в редакторе.
    // Не навешиваем на каждую кнопку, чтобы контейнер можно было
    // безопасно перерисовывать без утечек обработчиков.
    _container.onclick = (e) => {
        const refreshBtn = e.target.closest('.ov-refresh');
        if (refreshBtn) { _load(); return; }

        const toggleBtn = e.target.closest('.ov-section__toggle');
        if (toggleBtn) {
            toggleBtn.closest('.ov-section')?.classList.toggle('ov-section--collapsed');
            return;
        }

        const card = e.target.closest('.ov-card');
        if (card && _openInEditor) {
            const id = parseInt(card.dataset.eventId, 10);
            if (id) _openInEditor(id);
        }
    };

    // Свернём «Было недавно» по умолчанию — чтобы прошлые списки не
    // занимали верх экрана. Админ при желании развернёт.
    const pastSection = _container.querySelector('[data-collapsible="1"]');
    if (pastSection) pastSection.classList.add('ov-section--collapsed');
}

// ─── Публичный API ─────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} container — куда вставить панель.
 * @param {(eventId:number)=>void} onOpenInEditor — колбэк для клика по карточке.
 */
export function mountOverview(container, onOpenInEditor) {
    if (!container) return;
    _container = container;
    _openInEditor = onOpenInEditor;

    // Слушаем WS-обновления списков — прогресс в карточках автоматически обновится.
    // Делаем один раз; повторный mount() не навешивает обработчик заново.
    if (!_mounted) {
        document.addEventListener('datachanged', (e) => {
            // Обновляемся только если overview видим (tab-editor активен),
            // иначе лишние запросы в фоне.
            const tabEditor = document.getElementById('tab-editor');
            if (!tabEditor || tabEditor.classList.contains('hidden')) return;
            // Дебаунсим: при массовом обновлении (bulk-reassign) WS шлёт пачку
            // событий, не хотим N запросов подряд.
            clearTimeout(_refreshDebounce);
            _refreshDebounce = setTimeout(_load, 300);
        });
        _mounted = true;
    }

    _load();
}

let _refreshDebounce = null;

/**
 * Принудительное обновление — вызывается когда tab-editor становится
 * видим, чтобы цифры были свежими (а не из кэша прошлого открытия).
 */
export function refreshOverview() {
    if (!_container) return;
    _load();
}
