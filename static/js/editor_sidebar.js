// static/js/editor_sidebar.js
//
// Сайдбар со списком всех шаблонов слева от редактора.
// Заменяет унылый <select id="editor-event-id"> — теперь все шаблоны
// видны одновременно, поиск мгновенный, клик открывает в редакторе.
//
// Shape контейнера в HTML (создаётся при первом mount'е если его нет):
//   #editor-sidebar > { ov-search, .es-list > .es-card*, .es-create }
//
// Источник данных: getCachedEvents() из ui.js — тот же кеш что у dropdown'а.
// При mountEditorSidebar() сайдбар читает кеш и рендерит — никаких лишних
// API-запросов, всё уже есть.

import { getCachedEvents, loadEventsDropdowns } from './ui.js';
import { api }         from './api.js';

let _searchQuery     = '';
let _root            = null;
let _mounted         = false;
let _presetsCache    = null;   // кеш /admin/template-presets — грузим один раз
let _presetsLoading  = false;

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Render ──────────────────────────────────────────────────────────────────

function _render() {
    if (!_root) return;

    const events    = getCachedEvents();
    const templates = events.filter(e => e.is_template);

    const q = _searchQuery.trim().toLowerCase();
    const filtered = q
        ? templates.filter(t => (t.title || '').toLowerCase().includes(q))
        : templates;

    const activeId = _getActiveTemplateId();

    const cards = filtered.map(t => {
        const isActive = String(t.id) === String(activeId);
        return `
            <button type="button"
                    class="es-card${isActive ? ' es-card--active' : ''}"
                    data-event-id="${t.id}"
                    title="Открыть «${esc(t.title)}»">
                <span class="es-card__title">${esc(t.title)}</span>
            </button>`;
    }).join('');

    const emptyState = templates.length === 0
        ? `<div class="es-empty">
               Пока нет шаблонов.<br>Создайте первый ↓
           </div>`
        : (filtered.length === 0
            ? `<div class="es-empty">Ничего не найдено.</div>`
            : '');

    _root.innerHTML = `
        <div class="es-head">
            <span class="es-head__title">Шаблоны</span>
            <span class="es-head__count">${templates.length}</span>
        </div>
        <div class="es-search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <path d="M21 21l-4.35-4.35"/>
            </svg>
            <input type="text" class="es-search__input"
                   placeholder="Поиск по названию..."
                   value="${esc(_searchQuery)}"
                   autocomplete="off">
        </div>
        <div class="es-list">${cards}${emptyState}</div>
        <div class="es-create">
            <input type="text" class="es-create__input"
                   placeholder="Название нового шаблона..."
                   maxlength="300"
                   autocomplete="off">
            <button type="button" class="es-create__btn" title="Создать пустой шаблон">
                + Создать
            </button>
        </div>
        <button type="button" class="es-preset-btn" title="Создать шаблон по готовой заготовке (АМГ, Аэрозоль, ГРОЗА…)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="7" height="7"/>
                <rect x="14" y="3" width="7" height="7"/>
                <rect x="3" y="14" width="7" height="7"/>
                <rect x="14" y="14" width="7" height="7"/>
            </svg>
            <span>Из пресета…</span>
        </button>
    `;

    _bindLocalEvents();
}

function _bindLocalEvents() {
    if (!_root) return;

    // Поиск: дебаунс через requestAnimationFrame (лёгкий, не таймер).
    const searchInput = _root.querySelector('.es-search__input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            _searchQuery = e.target.value;
            // Перерисовываем только список — input оставляем на месте
            // чтобы фокус не терялся.
            _rerenderListOnly();
        });
    }

    // Клик по карточке — открыть шаблон в редакторе.
    _root.onclick = async (e) => {
        const card = e.target.closest('.es-card');
        if (card) {
            const id = parseInt(card.dataset.eventId, 10);
            if (id) {
                const m = await import('./admin.js');
                m.openEventInEditor(id);
                // Обновляем активную карточку визуально без полной перерисовки
                _root.querySelectorAll('.es-card').forEach(c =>
                    c.classList.toggle('es-card--active',
                        String(c.dataset.eventId) === String(id)));
            }
            return;
        }

        const createBtn = e.target.closest('.es-create__btn');
        if (createBtn) {
            await _createNew();
            return;
        }

        const presetBtn = e.target.closest('.es-preset-btn');
        if (presetBtn) {
            await _openPresetPicker();
            return;
        }
    };

    // Enter в поле ввода «новый шаблон» — создать
    const createInput = _root.querySelector('.es-create__input');
    if (createInput) {
        createInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                await _createNew();
            }
        });
    }
}

// Точечный ре-рендер только списка карточек — чтобы инпут поиска
// не пересоздавался и не терялся фокус/каретка при каждом нажатии.
function _rerenderListOnly() {
    if (!_root) return;
    const events    = getCachedEvents();
    const templates = events.filter(e => e.is_template);
    const q = _searchQuery.trim().toLowerCase();
    const filtered = q
        ? templates.filter(t => (t.title || '').toLowerCase().includes(q))
        : templates;

    const activeId = _getActiveTemplateId();

    const list = _root.querySelector('.es-list');
    if (!list) return;

    if (filtered.length === 0) {
        list.innerHTML = `<div class="es-empty">${templates.length === 0
            ? 'Пока нет шаблонов.<br>Создайте первый ↓'
            : 'Ничего не найдено.'}</div>`;
        return;
    }

    list.innerHTML = filtered.map(t => {
        const isActive = String(t.id) === String(activeId);
        return `
            <button type="button"
                    class="es-card${isActive ? ' es-card--active' : ''}"
                    data-event-id="${t.id}"
                    title="Открыть «${esc(t.title)}»">
                <span class="es-card__title">${esc(t.title)}</span>
            </button>`;
    }).join('');
}

// ─── Создание нового шаблона ─────────────────────────────────────────────────

async function _createNew() {
    if (!_root) return;
    const input = _root.querySelector('.es-create__input');
    const title = (input?.value || '').trim();
    if (!title) {
        input?.focus();
        window.showSnackbar?.('Введите название шаблона', 'error');
        return;
    }
    try {
        const created = await api.post('/admin/events', {
            title,
            date:        null,
            is_template: true,
        });
        window.showSnackbar?.('Шаблон создан', 'success');
        if (input) input.value = '';

        // Перезагружаем кеш событий, чтобы новый шаблон появился и в dropdown'ах,
        // и в сайдбаре. loadEventsDropdowns перезальёт _cachedEvents и UI-селекты.
        await loadEventsDropdowns();
        _render();

        // Сразу открываем редактор на созданном шаблоне — админ не хочет
        // кликать в сайдбаре ещё раз после создания.
        if (created?.id) {
            const m = await import('./admin.js');
            m.openEventInEditor(created.id);
        }
    } catch (err) {
        console.error('[sidebar] create:', err);
        window.showSnackbar?.(err?.message || 'Ошибка создания', 'error');
    }
}

// ─── Пресеты (готовые заготовки) ────────────────────────────────────────────
//
// UX: клик «Из пресета…» → модалка со списком. Клик по карточке пресета →
// инпут с предзаполненным названием (из preset.name) → подтверждение →
// POST /admin/template-presets/{id}/instantiate → открываем в редакторе.

async function _loadPresets() {
    if (_presetsCache) return _presetsCache;
    if (_presetsLoading) {
        // второй параллельный вызов — ждём первый
        while (_presetsLoading) await new Promise(r => setTimeout(r, 50));
        return _presetsCache || [];
    }
    _presetsLoading = true;
    try {
        _presetsCache = await api.get('/admin/template-presets');
    } catch (err) {
        console.error('[sidebar] presets load:', err);
        window.showSnackbar?.('Не удалось загрузить пресеты', 'error');
        _presetsCache = [];
    } finally {
        _presetsLoading = false;
    }
    return _presetsCache;
}

async function _openPresetPicker() {
    const presets = await _loadPresets();
    if (!presets.length) return;

    const overlay = document.createElement('div');
    overlay.className = 'preset-picker__overlay';
    overlay.innerHTML = `
        <div class="preset-picker" role="dialog" aria-label="Выбор пресета шаблона">
            <div class="preset-picker__head">
                <h3 class="preset-picker__title">Создать шаблон из пресета</h3>
                <button type="button" class="preset-picker__close" aria-label="Закрыть">✕</button>
            </div>
            <p class="preset-picker__hint">
                Выберите готовую заготовку — группы и типовые должности создадутся
                автоматически. ФИО, документы и квоты заполните в редакторе.
            </p>
            <div class="preset-picker__grid">
                ${presets.map(p => `
                    <button type="button" class="preset-card" data-preset-id="${esc(p.id)}">
                        <div class="preset-card__name">${esc(p.name)}</div>
                        <div class="preset-card__desc">${esc(p.description)}</div>
                        <div class="preset-card__stats">
                            <span title="Количество групп">📋 ${p.groups_count} групп</span>
                            <span title="Количество слотов">👥 ${p.slots_count} слотов</span>
                        </div>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    overlay.querySelector('.preset-picker__close').addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') {
            close();
            document.removeEventListener('keydown', esc);
        }
    });

    overlay.querySelectorAll('.preset-card').forEach(card => {
        card.addEventListener('click', async () => {
            const presetId = card.dataset.presetId;
            const preset = presets.find(p => p.id === presetId);
            if (!preset) return;

            const title = window.prompt(
                `Название нового шаблона (по пресету «${preset.name}»):`,
                preset.name
            );
            if (!title || !title.trim()) return;

            close();
            await _createFromPreset(presetId, title.trim());
        });
    });
}

async function _createFromPreset(presetId, title) {
    try {
        const created = await api.post(
            `/admin/template-presets/${encodeURIComponent(presetId)}/instantiate`,
            { title }
        );
        window.showSnackbar?.('Шаблон создан из пресета', 'success');
        await loadEventsDropdowns();
        _render();
        if (created?.id) {
            const m = await import('./admin.js');
            m.openEventInEditor(created.id);
        }
    } catch (err) {
        console.error('[sidebar] preset instantiate:', err);
        window.showSnackbar?.(err?.message || 'Ошибка создания', 'error');
    }
}


// ─── Утилиты ─────────────────────────────────────────────────────────────────

function _getActiveTemplateId() {
    // Активный шаблон: что сейчас выбрано в dropdown'е редактора.
    // Dropdown живёт в tab-editor и обновляется при openEventInEditor.
    const select = document.getElementById('editor-event-id');
    return select?.value || null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Монтирует сайдбар в контейнер #editor-sidebar (если его нет — создаёт
 * и кладёт в tab-editor). Безопасно вызывать повторно: перерисуется.
 */
export async function mountEditorSidebar() {
    // Контейнер уже должен быть в HTML. Если по какой-то причине его нет —
    // создаём динамически первым child'ом tab-editor (в начале, до tools-bar).
    _root = document.getElementById('editor-sidebar');
    if (!_root) {
        const tabEditor = document.getElementById('tab-editor');
        if (!tabEditor) return;
        _root = document.createElement('aside');
        _root.id = 'editor-sidebar';
        tabEditor.insertBefore(_root, tabEditor.firstChild);
    }

    // Если кеш событий ещё пуст (первый заход) — ждём загрузки.
    if (getCachedEvents().length === 0) {
        try { await loadEventsDropdowns(); } catch { /* отрисуем пустое состояние */ }
    }

    _render();

    // При каждой перезагрузке /slots/events через loadEventsDropdowns
    // сайдбар должен обновляться. Слушаем WS-событие 'update' — тот же
    // сигнал что и у combat_calc/dashboard.
    if (!_mounted) {
        _mounted = true;
        document.addEventListener('datachanged', (e) => {
            const tabEditor = document.getElementById('tab-editor');
            if (!tabEditor || tabEditor.classList.contains('hidden')) return;
            // Перезагружаем кеш и перерисовываем сайдбар.
            loadEventsDropdowns().then(_render).catch(() => {});
        });
    }
}

/** Пере-рендер активной карточки после смены шаблона через dropdown. */
export function refreshSidebarActive() {
    if (!_root) return;
    const activeId = _getActiveTemplateId();
    _root.querySelectorAll('.es-card').forEach(c =>
        c.classList.toggle('es-card--active',
            String(c.dataset.eventId) === String(activeId)));
}
