// static/js/ui.js
import { api } from './api.js';
import { attach as attachFio } from './fio_autocomplete.js';

// ─── View switching ───────────────────────────────────────────────────────────

export function showView(viewId) {
    // Скрываем все view
    document.querySelectorAll(
        '#login-view, #admin-view, #department-view'
    ).forEach(el => el.classList.add('hidden'));

    // Показываем нужный
    document.getElementById(viewId)?.classList.remove('hidden');

    // Navbar: скрыт только на логин-экране
    const navbar   = document.getElementById('navbar');
    const userChip = document.getElementById('user-chip');
    if (viewId === 'login-view') {
        navbar?.classList.add('hidden');
    } else {
        navbar?.classList.remove('hidden');
        userChip && (userChip.style.display = 'flex');
    }
}

// ─── Error / notification ─────────────────────────────────────────────────────

export function showError(message) {
    if (typeof window.showSnackbar === 'function') {
        window.showSnackbar(message, 'error');
    } else {
        alert(message);
    }
}

export function showSuccess(message) {
    if (typeof window.showSnackbar === 'function') {
        window.showSnackbar(message, 'success');
    }
}

// ─── Role formatter ───────────────────────────────────────────────────────────

// Форматирование username'а пользователя в читаемую подпись.
// Семантика username:
//   admin   → «Администратор»
//   upr_N   → «N Управление»  (управление номер N)
//   *       → «Отдел <label>» для юзеров с role='unit' (отдел задаётся логином)
// Для известных названий отделов даём красивую подпись, остальные
// выводим как есть с префиксом «Отдел».
const _UNIT_LABELS = {
    'gsm':   'ГСМ',
    'comms': 'связи',
    'svyaz': 'связи',
};

export function formatRole(role) {
    if (!role) return '';
    if (role === 'admin') return 'Администратор';
    if (role.startsWith('upr_')) return role.replace('upr_', '') + ' Управление';

    // Отделы: username — произвольное имя отдела (gsm, comms, svyaz, …).
    // Для известных даём словарную подпись, для остальных — «Отдел: <login>».
    const known = _UNIT_LABELS[role.toLowerCase()];
    if (known) return `Отдел ${known}`;
    // username вида "unit_xyz" — отбросим префикс
    if (role.startsWith('unit_')) {
        const tail = role.slice('unit_'.length);
        return _UNIT_LABELS[tail.toLowerCase()]
            ? `Отдел ${_UNIT_LABELS[tail.toLowerCase()]}`
            : `Отдел ${tail}`;
    }
    return role;
}

// ─── User display ─────────────────────────────────────────────────────────────

export function setUserDisplay(username) {
    const displayEl = document.getElementById('user-display');
    const avatarEl  = document.getElementById('user-avatar');

    const formatted = formatRole(username);
    if (displayEl) displayEl.textContent = formatted;

    // Инициал для аватара — первая буква имени (или первая цифра для upr_N)
    if (avatarEl) {
        const initial = username === 'admin'
            ? 'А'
            : (username.replace('upr_', '') || username)[0].toUpperCase();
        avatarEl.textContent = initial;
    }
}

// ─── Admin tabs ───────────────────────────────────────────────────────────────
//
// Порядок вкладок (индексы кнопок .tab-btn):
//   0 → dashboard    (Дашборд)
//   1 → editor       (Редактор шаблонов)
//   2 → history      (История — рабочие списки по датам)
//   3 → users        (Пользователи)
//   4 → persons      (База людей)
//   0 → dashboard (Дашборд)
//   1 → editor    (Редактор шаблонов)
//   2 → duty      (Графики наряда — внутри кнопка «История утверждений»)
//   3 → combat    (Боевой расчёт)
//   4 → operations (аккордеон: История / Пользователи / База людей / Календарь)

// Вкладки верхнего уровня (5 шт.) — Dashboard, Editor, Duty, Combat, Operations.
// Остальные панели (История, Пользователи, База людей, Календарь) живут внутри
// Operations-аккордеона. Duty-History переехал в Графики наряда (переключается
// кнопкой «История утверждений» внутри .duty-sidebar). См. app.js:consolidateOperations.
export function switchAdminTab(tab) {
    const tabDashboard   = document.getElementById('tab-dashboard');
    const tabEditor      = document.getElementById('tab-editor');
    const tabDuty        = document.getElementById('tab-duty');
    const tabCombat      = document.getElementById('tab-combat');
    const tabOperations  = document.getElementById('tab-operations');
    const tabBtns        = document.querySelectorAll('.tab-btn');

    // Скрываем все вкладки верхнего уровня
    tabDashboard?.classList.add('hidden');
    tabEditor?.classList.add('hidden');
    tabDuty?.classList.add('hidden');
    tabCombat?.classList.add('hidden');
    tabOperations?.classList.add('hidden');
    tabBtns.forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
    });

    const activate = (idx) => {
        tabBtns[idx]?.classList.add('active');
        tabBtns[idx]?.setAttribute('aria-selected', 'true');
    };

    if (tab === 'dashboard') {
        tabDashboard?.classList.remove('hidden');
        activate(0);
        import('./dashboard.js').then(m => m.loadDashboard()).catch(() => {});

    } else if (tab === 'editor') {
        tabEditor?.classList.remove('hidden');
        activate(1);
        // Монтируем левый сайдбар со списком шаблонов (ленивая загрузка).
        import('./editor_sidebar.js')
            .then(m => m.mountEditorSidebar())
            .catch(err => console.error('editor sidebar mount:', err));

    } else if (tab === 'duty') {
        tabDuty?.classList.remove('hidden');
        activate(2);
        import('./duty.js').then(m => m.loadSchedules());

    } else if (tab === 'combat') {
        tabCombat?.classList.remove('hidden');
        activate(3);
        import('./combat_calc.js').then(m => m.initCombatCalc(true));

    } else if (tab === 'operations') {
        tabOperations?.classList.remove('hidden');
        activate(4);
        // Внутренние секции подгружаются лениво при раскрытии карточки —
        // логика в app.js:consolidateOperations. Здесь просто показываем хост.
    }
}

/**
 * Открывает внутреннюю секцию аккордеона Операций (история / пользователи /
 * база людей / календарь) — используется например для "jump to section" из
 * других мест UI. Вызывает switchAdminTab('operations') + раскрытие нужной
 * карточки. Принимает id внутренней панели ('tab-history' и т.п.).
 */
export function openOperationsSection(innerTabId) {
    switchAdminTab('operations');
    // Дадим кадру отрисоваться, потом эмитим event — ловит ops-accordion
    // в app.js и раскрывает карточку программно.
    requestAnimationFrame(() => {
        document.dispatchEvent(new CustomEvent('ops-open-section', { detail: innerTabId }));
    });
}

// ─── Events dropdowns ─────────────────────────────────────────────────────────

// Кэш всех событий — обновляется при каждом loadEventsDropdowns()
// Используется scheduleGrid в admin.js чтобы показывать уже созданные списки
let _cachedEvents = [];

export function getCachedEvents() {
    return _cachedEvents;
}

export async function loadEventsDropdowns() {
    try {
        const events = await api.get('/slots/events');
        _cachedEvents = events;

        // Разделяем списки и шаблоны
        const templates = events.filter(e => e.is_template);
        const regular   = events.filter(e => !e.is_template);

        // ── Опции для РЕДАКТОРА списков — ТОЛЬКО ШАБЛОНЫ ─────────────────────
        // В редакторе работаем только с шаблонами. Рабочие списки генерируются
        // из шаблонов через расписание и отправляются в "Историю" после даты.
        let templateOnlyOptions = '<option value="" disabled selected>— Выберите шаблон —</option>';
        if (templates.length === 0) {
            templateOnlyOptions += '<option disabled>Нет шаблонов — создайте первый</option>';
        } else {
            templateOnlyOptions += templates
                .map(e => `<option value="${e.id}">${e.title}</option>`)
                .join('');
        }

        // 'group-event-id' убран — выбор шаблона для добавления группы теперь
        // всегда = текущий открытый шаблон (editor-event-id).
        [
            'editor-event-id',
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = templateOnlyOptions;
        });

        // ── Опции для выгрузки .docx — шаблоны + рабочие списки ─────────────
        // Экспорт может быть полезен и для текущих, и для шаблонных списков.
        let exportOptions = '<option value="" disabled selected>— Выберите список —</option>';
        if (regular.length > 0) {
            exportOptions += '<optgroup label="Рабочие списки (по датам)">';
            exportOptions += regular
                .map(e => `<option value="${e.id}">${e.title}</option>`)
                .join('');
            exportOptions += '</optgroup>';
        }
        if (templates.length > 0) {
            exportOptions += '<optgroup label="Шаблоны">';
            exportOptions += templates
                .map(e => `<option value="${e.id}">[Шаблон] ${e.title}</option>`)
                .join('');
            exportOptions += '</optgroup>';
        }

        const exportSelect = document.getElementById('export-event-id');
        if (exportSelect) exportSelect.innerHTML = exportOptions;

        // Dept select — все рабочие списки для управлений
        const deptSelect = document.getElementById('dept-event-id');
        if (deptSelect) {
            let deptOpts = '<option value="" disabled selected>— Выберите список —</option>';
            deptOpts += regular.map(e => `<option value="${e.id}">${e.title}</option>`).join('');
            deptSelect.innerHTML = deptOpts;
        }

        // Карточки для department view
        renderDeptEventCards(regular);

        // Только шаблоны (для генерации расписания)
        const templateSelect = document.getElementById('template-select-id');
        if (templateSelect) {
            let tplOptions = '<option value="" disabled selected>— Выберите шаблон —</option>';

            if (templates.length === 0) {
                tplOptions += '<option disabled>Нет сохраненных шаблонов</option>';
            } else {
                tplOptions += templates
                    .map(e => `<option value="${e.id}">${e.title}</option>`)
                    .join('');
            }

            templateSelect.innerHTML = tplOptions;
        }

    } catch (error) {
        console.error('loadEventsDropdowns:', error);
        if (typeof window.showSnackbar === 'function') {
            window.showSnackbar('Ошибка загрузки списков', 'error');
        }
    }
}

// ─── Department: карточки списков ─────────────────────────────────────────────

const WEEKDAY_NAMES_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const WEEKDAY_FULL_RU  = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function getDayLabel(isoDate) {
    if (!isoDate) return null;
    const today    = new Date(); today.setHours(0,0,0,0);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const d        = new Date(isoDate + 'T00:00:00');

    if (d.getTime() === today.getTime())    return { text: 'Сегодня', accent: true };
    if (d.getTime() === tomorrow.getTime()) return { text: 'Завтра',  accent: false };

    // Если в пределах текущей недели — показываем день недели
    const diff = Math.round((d - today) / 86400000);
    if (diff > 1 && diff <= 6)  return { text: WEEKDAY_FULL_RU[d.getDay()], accent: false };
    if (diff < 0 && diff >= -2) return { text: 'Прошедший', accent: false, muted: true };

    return null;
}

function formatDisplayDate(isoDate) {
    if (!isoDate) return '';
    const d  = new Date(isoDate + 'T00:00:00');
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const wd = WEEKDAY_NAMES_RU[d.getDay()];
    return `${wd}, ${dd}.${mm}`;
}

export function renderDeptEventCards(events) {
    const grid = document.getElementById('dept-event-cards');
    if (!grid) return;

    if (!events || events.length === 0) {
        grid.innerHTML = `
            <div class="dept-empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
                </svg>
                <p>Нет активных списков</p>
                <span>Администратор ещё не выпустил списки для заполнения</span>
            </div>`;
        return;
    }

    grid.innerHTML = events.map((event, i) => {
        const dayLabel = getDayLabel(event.date);
        const dateStr  = formatDisplayDate(event.date);

        const labelHtml = dayLabel
            ? `<span class="dept-event-card__day-label${dayLabel.accent ? ' dept-event-card__day-label--today' : dayLabel.muted ? ' dept-event-card__day-label--muted' : ''}">${dayLabel.text}</span>`
            : '';

        const dateHtml = dateStr
            ? `<span class="dept-event-card__date">${dateStr}</span>`
            : '';

        return `
        <button class="dept-event-card${dayLabel?.accent ? ' dept-event-card--today' : ''}" data-event-id="${event.id}" data-event-title="${event.title}" type="button">
            <div class="dept-event-card__num">${i + 1}</div>
            <div class="dept-event-card__body">
                <div class="dept-event-card__top">
                    ${labelHtml}
                    ${dateHtml}
                </div>
                <span class="dept-event-card__title">${event.title}</span>
                <div class="dept-event-card__progress-wrap">
                    <div class="dept-event-card__progress-bar">
                        <div class="dept-event-card__progress-fill" id="progress-fill-${event.id}" style="width:0%"></div>
                    </div>
                    <span class="dept-event-card__progress-label" id="progress-label-${event.id}">—</span>
                </div>
            </div>
            <svg class="dept-event-card__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 18l6-6-6-6"/>
            </svg>
        </button>`;
    }).join('');
}

export function updateDeptCardProgress(eventId, slots) {
    const fill  = document.getElementById(`progress-fill-${eventId}`);
    const label = document.getElementById(`progress-label-${eventId}`);
    if (!fill || !label) return;

    const total   = slots.length;
    const filled  = slots.filter(s => s.full_name && s.full_name.trim() !== '').length;
    const percent = total > 0 ? Math.round((filled / total) * 100) : 0;

    fill.style.width = `${percent}%`;
    fill.className   = 'dept-event-card__progress-fill' + (percent === 100 ? ' done' : percent > 0 ? ' partial' : '');
    label.textContent = total > 0 ? `${filled} из ${total}` : 'Пусто';
}

// ─── База людей (admin: вкладка «База людей») ─────────────────────────────────

let _personsData   = [];
let _personsFiltered = [];
let _editingId     = null;
let _transferringId = null;   // id строки в режиме быстрого перевода
let _searchTimeout = null;
let _personsDeptFilter = ''; // активный фильтр по управлению (admin only)
let _personsIncludeFired = false; // чекбокс «Показать уволенных» (admin only)

export async function loadPersons(searchQuery = '') {
    const tbody = document.getElementById('persons-tbody');
    const empty = document.getElementById('persons-empty');
    if (!tbody) return;

    // --- ИСПРАВЛЕНИЕ: Раскрываем колонки администратора здесь ---
    // (на этот момент мы уже точно знаем, что пользователь - админ)
    const isAdmin = window.currentUserRole === 'admin';
    if (isAdmin) {
        document.getElementById('persons-dept-col')?.classList.remove('hidden');
        // Раскрываем ВСЕ admin-only поля (селект в форме + фильтр в тулбаре)
        document.querySelectorAll('.admin-only-field').forEach(el => el.classList.remove('hidden'));
        const statsBar = document.getElementById('persons-stats');
        if (statsBar) {
            statsBar.classList.remove('hidden');
            statsBar.style.display = 'flex';
        }

        // Заполняем выпадающий список управлений в форме добавления
        const deptSelect = document.getElementById('person-dept');
        if (deptSelect && deptSelect.options.length <= 1 && window.availableRoles) {
            window.availableRoles.forEach(r => {
                const opt = document.createElement('option');
                opt.value = r;
                opt.textContent = formatRole(r);
                deptSelect.appendChild(opt);
            });
        }

        // Заполняем фильтр по управлению теми же значениями
        const filterDept = document.getElementById('persons-filter-dept');
        if (filterDept && filterDept.options.length <= 1 && window.availableRoles) {
            window.availableRoles.forEach(r => {
                const opt = document.createElement('option');
                opt.value = r;
                opt.textContent = formatRole(r);
                filterDept.appendChild(opt);
            });
        }
    }
    // -----------------------------------------------------------

    try {
        const qs = new URLSearchParams();
        qs.set('limit', '500');
        if (searchQuery) qs.set('q', searchQuery);
        if (isAdmin && _personsIncludeFired) qs.set('include_fired', 'true');
        _personsData = await api.get(`/persons?${qs.toString()}`);
        _applyPersonsFilters();
        empty?.classList.toggle('hidden', _personsData.length > 0);
    } catch (err) {
        console.error('loadPersons:', err);
        if (typeof window.showSnackbar === 'function') {
            window.showSnackbar('Ошибка загрузки базы людей', 'error');
        }
    }
}

function _applyPersonsFilters() {
    if (_personsDeptFilter) {
        _personsFiltered = _personsData.filter(p => (p.department || '') === _personsDeptFilter);
    } else {
        _personsFiltered = _personsData;
    }
    renderPersonsTable(_personsFiltered);
    _updatePersonsStats();
}

function _updatePersonsStats() {
    const total     = _personsData.length;
    const visible   = _personsFiltered.length;
    const depts     = new Set(_personsData.map(p => p.department).filter(Boolean)).size;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('persons-stat-total',   total);
    set('persons-stat-visible', visible);
    set('persons-stat-depts',   depts);
}

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPersonsTable(persons) {
    const tbody   = document.getElementById('persons-tbody');
    if (!tbody) return;
    const isAdmin = window.currentUserRole === 'admin';

    if (persons.length === 0) {
        tbody.innerHTML = '';
        return;
    }

    // Вспомогательная функция для красивого формата даты
    const formatDate = (isoDate) => {
        if (!isoDate) return '—';
        const [y, m, d] = isoDate.split('-');
        return `${d}.${m}.${y}`;
    };

    tbody.innerHTML = persons.map(p => {
        const deptBadge = isAdmin
            ? `<td><span style="font-size:0.7rem;padding:2px 7px;border-radius:10px;background:var(--md-primary-light);color:var(--md-primary-dark);border:1px solid #c5ddd8;white-space:nowrap;">${esc(formatRole(p.department || '—'))}</span></td>`
            : '';

        // РЕЖИМ РЕДАКТИРОВАНИЯ (с правильными CSS классами .person-inline-input)
        if (_editingId === p.id) {
            const deptEditCell = isAdmin
                ? `<td><select id="edit-dept-${p.id}" class="person-inline-input" style="padding:0 4px !important;">
                        <option value="">— без упр. —</option>
                        ${(window.availableRoles || []).map(r => `<option value="${r}" ${r === p.department ? 'selected' : ''}>${esc(formatRole(r))}</option>`).join('')}
                   </select></td>`
                : '';

            return `
                <tr data-person-id="${p.id}" id="person-row-${p.id}" style="background:var(--md-primary-light);">
                    <td style="color:var(--md-on-surface-hint);font-family:var(--md-font-mono);font-size:0.72rem;">${p.id}</td>
                    <td><input id="edit-name-${p.id}"  value="${esc(p.full_name)}" class="person-inline-input"></td>
                    <td><input id="edit-rank-${p.id}"  value="${esc(p.rank||'')}" class="person-inline-input"></td>
                    <td><input id="edit-doc-${p.id}"   value="${esc(p.doc_number||'')}" class="person-inline-input"></td>
                    ${deptEditCell}
                    <td><input id="edit-pos-${p.id}"   value="${esc(p.position_title||'')}" class="person-inline-input"></td>
                    <td><input id="edit-birth-${p.id}" value="${esc(p.birth_date||'')}" type="date" class="person-inline-input" style="padding:0 4px !important;"></td>
                    <td><input id="edit-phone-${p.id}" value="${esc(p.phone||'')}" class="person-inline-input"></td>
                    <td><input id="edit-notes-${p.id}" value="${esc(p.notes||'')}" class="person-inline-input"></td>
                    <td>
                        <div style="display:flex;gap:4px;">
                            <button class="btn btn-filled btn-xs person-save-edit-btn" data-person-id="${p.id}" type="button" title="Сохранить">✓</button>
                            <button class="btn btn-outlined btn-xs person-cancel-edit-btn" type="button" title="Отмена">✕</button>
                        </div>
                    </td>
                </tr>`;
        }

        // РЕЖИМ ПРОСМОТРА
        const isFired   = !!p.fired_at;
        const rowStyle  = isFired
            ? ' style="opacity:0.55; background:var(--md-surface-variant);"'
            : '';
        const firedDate = isFired ? formatDate(p.fired_at.slice(0, 10)) : '';
        const nameCell  = isFired
            ? `<span style="font-weight:500;">${esc(p.full_name)}</span>
               <span class="fio-badge fio-badge-fired" title="Уволен ${firedDate}"
                     style="margin-left:6px; font-size:0.7em; padding:2px 7px; border-radius:10px; background:#b71c1c; color:#fff; white-space:nowrap;">
                 Уволен ${firedDate}
               </span>`
            : `<span style="font-weight:500;">${esc(p.full_name)}</span>`;
        // Inline режим быстрого перевода: показываем только select + ✓ / ✕
        let actionBtns;
        if (!isFired && _transferringId === p.id && isAdmin) {
            const roleOpts = (window.availableRoles || []).map(r =>
                `<option value="${r}" ${r === p.department ? 'selected' : ''}>${esc(formatRole(r))}</option>`
            ).join('');
            actionBtns = `
                <select id="transfer-dept-${p.id}" class="person-inline-input"
                        style="padding:0 4px !important; min-width:140px;">
                    <option value="">— в общий пул —</option>
                    ${roleOpts}
                </select>
                <button class="btn btn-filled btn-xs person-transfer-save-btn"
                        data-person-id="${p.id}" type="button" title="Подтвердить перевод">✓</button>
                <button class="btn btn-outlined btn-xs person-transfer-cancel-btn"
                        type="button" title="Отмена">✕</button>
            `;
        } else if (isFired) {
            actionBtns = `<button class="btn btn-success btn-xs person-unfire-btn"
                       data-person-id="${p.id}" type="button" title="Вернуть в активные">↺ Вернуть</button>`;
        } else {
            const transferBtn = isAdmin
                ? `<button class="btn btn-outlined btn-xs person-transfer-btn"
                           data-person-id="${p.id}" type="button"
                           title="Быстро перевести в другое управление">→</button>`
                : '';
            actionBtns = `
                <button class="btn btn-outlined btn-xs person-edit-btn"
                        data-person-id="${p.id}" type="button" title="Редактировать">✎</button>
                ${transferBtn}
                <button class="btn btn-danger btn-xs person-fire-btn"
                        data-person-id="${p.id}" type="button" title="Уволить (с сохранением в истории)">⊘ Уволить</button>
            `;
        }

        return `
            <tr data-person-id="${p.id}" id="person-row-${p.id}"${rowStyle}>
                <td style="color:var(--md-on-surface-hint);font-family:var(--md-font-mono);font-size:0.72rem;">${p.id}</td>
                <td class="person-cell-name">${nameCell}</td>
                <td class="person-cell-rank">${esc(p.rank || '—')}</td>
                <td class="person-cell-doc">${esc(p.doc_number || '—')}</td>
                ${deptBadge}
                <td><span style="font-size:0.8rem;color:var(--md-on-surface-variant);">${esc(p.position_title || '—')}</span></td>
                <td style="font-size:0.8rem;white-space:nowrap;">${formatDate(p.birth_date)}</td>
                <td style="font-size:0.8rem;white-space:nowrap;">${esc(p.phone || '—')}</td>
                <td><span style="font-size:0.75rem;color:var(--md-on-surface-hint);">${esc(p.notes || '—')}</span></td>
                <td>
                    <div style="display:flex;gap:4px;">
                        ${actionBtns}
                    </div>
                </td>
            </tr>`;
    }).join('');
}

function startEditRow(personId) {
    if (_editingId && _editingId !== personId) cancelEditRow();
    _editingId = personId;
    renderPersonsTable(_personsFiltered);
    setTimeout(() => document.getElementById(`edit-name-${personId}`)?.focus(), 50);
}

function cancelEditRow() {
    _editingId = null;
    renderPersonsTable(_personsFiltered);
}

async function saveEditRow(personId) {
    const name  = document.getElementById(`edit-name-${personId}`)?.value?.trim();
    const rank  = document.getElementById(`edit-rank-${personId}`)?.value?.trim();
    const doc   = document.getElementById(`edit-doc-${personId}`)?.value?.trim();
    const pos   = document.getElementById(`edit-pos-${personId}`)?.value?.trim();
    const birth = document.getElementById(`edit-birth-${personId}`)?.value?.trim();
    const phone = document.getElementById(`edit-phone-${personId}`)?.value?.trim();
    const notes = document.getElementById(`edit-notes-${personId}`)?.value?.trim();
    const dept  = document.getElementById(`edit-dept-${personId}`)?.value ?? undefined;

    if (!name) { window.showSnackbar?.('ФИО не может быть пустым', 'error'); return; }

    try {
        const payload = {
            full_name: name,
            rank: rank || null,
            doc_number: doc || null,
            position_title: pos || null,
            birth_date: birth || null,
            phone: phone || null,
            notes: notes || null
        };
        if (dept !== undefined) payload.department = dept || null;

        const updated = await api.put(`/persons/${personId}`, payload);
        const idx = _personsData.findIndex(p => p.id === personId);
        if (idx !== -1) _personsData[idx] = updated;
        _editingId = null;
        _applyPersonsFilters();
        window.showSnackbar?.('Сохранено', 'success');
    } catch (err) {
        window.showSnackbar?.('Ошибка сохранения', 'error');
    }
}

async function deletePerson(personId) {
    if (!confirm('Удалить из базы? Это не затронет уже заполненные списки.')) return;
    try {
        await api.delete(`/persons/${personId}`);
        _personsData = _personsData.filter(p => p.id !== personId);
        _applyPersonsFilters();
        document.getElementById('persons-empty')?.classList.toggle('hidden', _personsData.length > 0);
        window.showSnackbar?.('Удалено', 'success');
    } catch (err) {
        window.showSnackbar?.('Ошибка удаления', 'error');
    }
}

async function firePerson(personId) {
    const person = _personsData.find(p => p.id === personId);
    const name   = person?.full_name || 'этого человека';
    if (!confirm(
        `Уволить «${name}»?\n\n` +
        `Он будет удалён из активных графиков наряда.\n` +
        `Запись останется в базе для истории (duty_marks и списки ` +
        `сохранятся). Позже можно вернуть через «↺ Вернуть».`
    )) return;
    try {
        const updated = await api.post(`/persons/${personId}/fire`);
        const idx = _personsData.findIndex(p => p.id === personId);
        if (idx >= 0) {
            if (_personsIncludeFired) {
                _personsData[idx] = updated;
            } else {
                _personsData.splice(idx, 1);
            }
        }
        _applyPersonsFilters();
        window.showSnackbar?.(`«${name}» уволен`, 'success');
    } catch (err) {
        window.showSnackbar?.(
            err?.status === 409 ? 'Уже уволен' : 'Ошибка увольнения',
            'error',
        );
    }
}

function startTransferRow(personId) {
    if (_editingId)     cancelEditRow();
    _transferringId = personId;
    renderPersonsTable(_personsFiltered);
    setTimeout(() => document.getElementById(`transfer-dept-${personId}`)?.focus(), 50);
}

function cancelTransferRow() {
    _transferringId = null;
    renderPersonsTable(_personsFiltered);
}

async function saveTransferRow(personId) {
    const sel = document.getElementById(`transfer-dept-${personId}`);
    if (!sel) return;
    const newDept = sel.value || null; // '' → NULL (общий пул)

    const person = _personsData.find(p => p.id === personId);
    const oldDept = person?.department ?? null;
    if (newDept === oldDept) {
        // Нет смысла дёргать сервер
        cancelTransferRow();
        return;
    }

    try {
        const updated = await api.put(`/persons/${personId}`, { department: newDept });
        const idx = _personsData.findIndex(p => p.id === personId);
        if (idx >= 0) _personsData[idx] = updated;
        _transferringId = null;
        _applyPersonsFilters();
        const label = newDept ? formatRole(newDept) : '— общий пул —';
        window.showSnackbar?.(`«${updated.full_name}» → ${label}`, 'success');
    } catch (err) {
        window.showSnackbar?.('Ошибка перевода', 'error');
    }
}

async function unfirePerson(personId) {
    const person = _personsData.find(p => p.id === personId);
    const name   = person?.full_name || 'этого человека';
    try {
        const updated = await api.post(`/persons/${personId}/unfire`);
        const idx = _personsData.findIndex(p => p.id === personId);
        if (idx >= 0) _personsData[idx] = updated;
        _applyPersonsFilters();
        window.showSnackbar?.(`«${name}» возвращён в активные`, 'success');
    } catch (err) {
        window.showSnackbar?.(
            err?.status === 409 ? 'Уже активен' : 'Ошибка восстановления',
            'error',
        );
    }
}

export function initPersonsTab() {
    const isAdmin = window.currentUserRole === 'admin';

    // Поиск с дебаунсом
    document.getElementById('persons-search')?.addEventListener('input', (e) => {
        clearTimeout(_searchTimeout);
        _searchTimeout = setTimeout(() => loadPersons(e.target.value.trim()), 300);
    });

    // Фильтр по управлению (только для админа)
    document.getElementById('persons-filter-dept')?.addEventListener('change', (e) => {
        _personsDeptFilter = e.target.value || '';
        _applyPersonsFilters();
    });

    // Экспорт видимых записей в Excel
    document.getElementById('persons-export-btn')?.addEventListener('click', () => {
        _exportPersonsToExcel(_personsFiltered);
    });

    // Импорт Excel
    const importBtn   = document.getElementById('persons-import-btn');
    const importInput = document.getElementById('persons-import-input');
    const templateBtn = document.getElementById('persons-template-btn');

    // Скачать шаблон
    if (templateBtn) {
        templateBtn.addEventListener('click', async () => {
            try {
                const blob = await api.download('/persons/import/template');
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = 'persons_template.xlsx';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (err) {
                window.showSnackbar?.('Не удалось скачать шаблон', 'error');
            }
        });
    }



    if (importBtn && importInput) {
        importBtn.addEventListener('click', () => importInput.click());

        importInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
                window.showSnackbar?.('Пожалуйста, выберите файл .xlsx', 'error');
                importInput.value = '';
                return;
            }

            const formData = new FormData();
            formData.append('file', file);

            const orig = importBtn.innerHTML;
            importBtn.innerHTML = '⏳ Загрузка...';
            importBtn.disabled  = true;

            try {
                const res = await api.upload('/persons/import', formData);

                // Обновляем таблицу
                await loadPersons(document.getElementById('persons-search')?.value?.trim() || '');

                // Основное уведомление
                const mainMsg = `✅ Добавлено: ${res.added} | Обновлено: ${res.updated} | Пропущено: ${res.skipped}`;
                window.showSnackbar?.(mainMsg, 'success', 8000);

                // Если есть ошибки — показываем модальное окно с детализацией
                if (res.errors && res.errors.length > 0) {
                    showImportErrorsModal(res.errors, res);
                }

            } catch (err) {
                window.showSnackbar?.(err.message || 'Ошибка при импорте файла', 'error');
            } finally {
                importBtn.innerHTML = orig;
                importBtn.disabled  = false;
                importInput.value   = '';
            }
        });
    }

    // Показать/скрыть форму добавления
    document.getElementById('persons-add-btn')?.addEventListener('click', () => {
        const form = document.getElementById('persons-add-form');
        if (form) {
            form.classList.toggle('hidden');
            form.style.display = form.classList.contains('hidden') ? 'none' : 'flex';
            if (!form.classList.contains('hidden')) document.getElementById('person-fullname')?.focus();
        }
    });

    // Автодополнение ФИО в форме добавления в ОБЩУЮ базу (admin).
    // При выборе из списка — подставляем все поля, что есть у этого человека
    // (звание, №, должность, дата рождения, телефон). Админ видит бейдж
    // «уже в базе» если совпадение точное — так защищаемся от дублей.
    const personFioInput = document.getElementById('person-fullname');
    if (personFioInput && !personFioInput.__fioAc) {
        attachFio(personFioInput, {
            container: personFioInput.parentElement, // .field
            onSelect: (person) => {
                const set = (id, val) => {
                    const el = document.getElementById(id);
                    if (el && val != null) el.value = val;
                };
                set('person-fullname', person.full_name);
                set('person-rank',     person.rank);
                set('person-doc',      person.doc_number);
                set('person-pos',      person.position_title);
                set('person-birth',    person.birth_date);
                set('person-phone',    person.phone);
                set('person-notes',    person.notes);
                // Управление подставляем только если админу — иначе поле скрыто
                if (isAdmin && person.department) {
                    const deptSel = document.getElementById('person-dept');
                    if (deptSel) deptSel.value = person.department;
                }
                if (person.is_exact) {
                    window.showSnackbar?.(
                        `«${person.full_name}» уже в общей базе — проверьте, не дубликат ли`,
                        'info',
                    );
                }
            },
        });
    }

    document.getElementById('persons-cancel-btn')?.addEventListener('click', () => {
        const form = document.getElementById('persons-add-form');
        form?.classList.add('hidden');
        if (form) form.style.display = 'none';
        ['person-fullname', 'person-rank', 'person-doc', 'person-pos', 'person-birth', 'person-phone', 'person-notes'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
    });

    // Сохранить новую запись
    document.getElementById('persons-save-btn')?.addEventListener('click', async () => {
        const name  = document.getElementById('person-fullname')?.value?.trim();
        const rank  = document.getElementById('person-rank')?.value?.trim();
        const doc   = document.getElementById('person-doc')?.value?.trim();
        const pos   = document.getElementById('person-pos')?.value?.trim();
        const birth = document.getElementById('person-birth')?.value?.trim();
        const phone = document.getElementById('person-phone')?.value?.trim();
        const notes = document.getElementById('person-notes')?.value?.trim();
        const dept  = isAdmin ? (document.getElementById('person-dept')?.value || null) : null;

        if (!name) { window.showSnackbar?.('Введите ФИО', 'error'); return; }

        try {
            await api.post('/persons', {
                full_name:  name,
                rank:       rank || null,
                doc_number: doc  || null,
                position_title: pos || null,
                birth_date: birth || null,
                phone:      phone || null,
                notes:      notes || null,
                department: dept,
            });

            // Очищаем все поля
            ['person-fullname', 'person-rank', 'person-doc', 'person-pos', 'person-birth', 'person-phone', 'person-notes'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });

            const form = document.getElementById('persons-add-form');
            form?.classList.add('hidden');
            if (form) form.style.display = 'none';
            await loadPersons(document.getElementById('persons-search')?.value?.trim() || '');
            window.showSnackbar?.('Добавлено в базу', 'success');
        } catch (err) {
            window.showSnackbar?.(err.status === 409 ? 'Человек с таким ФИО уже есть' : 'Ошибка добавления', 'error');
        }
    });

    // Делегирование событий — таблица людей
    document.getElementById('persons-tbody')?.addEventListener('click', (e) => {
        const editBtn    = e.target.closest('.person-edit-btn');
        const fireBtn    = e.target.closest('.person-fire-btn');
        const unfireBtn  = e.target.closest('.person-unfire-btn');
        const transferBtn    = e.target.closest('.person-transfer-btn');
        const transferSave   = e.target.closest('.person-transfer-save-btn');
        const transferCancel = e.target.closest('.person-transfer-cancel-btn');
        const saveEdit   = e.target.closest('.person-save-edit-btn');
        const cancelEdit = e.target.closest('.person-cancel-edit-btn');

        if (editBtn)         startEditRow(parseInt(editBtn.dataset.personId));
        if (fireBtn)         firePerson(parseInt(fireBtn.dataset.personId));
        if (unfireBtn)       unfirePerson(parseInt(unfireBtn.dataset.personId));
        if (transferBtn)     startTransferRow(parseInt(transferBtn.dataset.personId));
        if (transferSave)    saveTransferRow(parseInt(transferSave.dataset.personId));
        if (transferCancel)  cancelTransferRow();
        if (saveEdit)        saveEditRow(parseInt(saveEdit.dataset.personId));
        if (cancelEdit)      cancelEditRow();
    });

    // Чекбокс «Показать уволенных» (admin-only)
    document.getElementById('persons-show-fired')?.addEventListener('change', (e) => {
        _personsIncludeFired = !!e.target.checked;
        loadPersons(document.getElementById('persons-search')?.value?.trim() || '');
    });
}

// ─── Экспорт базы людей в CSV (открывается в Excel) ──────────────────────────

function _exportPersonsToExcel(persons) {
    if (!persons || persons.length === 0) {
        window.showSnackbar?.('Нет записей для экспорта', 'error');
        return;
    }

    const isAdmin = window.currentUserRole === 'admin';
    const headers = ['ФИО', 'Звание', '№ Документа'];
    if (isAdmin) headers.push('Управление');
    headers.push('Должность', 'Дата рождения', 'Телефон', 'Примечание');

    const escapeCSV = (v) => {
        if (v == null) return '';
        const s = String(v);
        if (s.includes(';') || s.includes('"') || s.includes('\n')) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    };

    const rows = persons.map(p => {
        const cols = [p.full_name, p.rank || '', p.doc_number || ''];
        if (isAdmin) cols.push(p.department ? formatRole(p.department) : '');
        cols.push(p.position_title || '', p.birth_date || '', p.phone || '', p.notes || '');
        return cols.map(escapeCSV).join(';');
    });

    // BOM для корректной кодировки в Excel
    const csv = '\uFEFF' + headers.join(';') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const now  = new Date();
    const fname = `База_людей_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}.csv`;
    const a = Object.assign(document.createElement('a'), { href: url, download: fname });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    window.showSnackbar?.(`Экспортировано ${persons.length} записей`, 'success');
}

// ─── Модальное окно с ошибками импорта ───────────────────────────────────────

function showImportErrorsModal(errors, result) {
    // Удаляем предыдущий модал если был
    document.getElementById('import-errors-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'import-errors-modal';
    modal.style.cssText = `
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,.45);
        display: flex; align-items: center; justify-content: center;
        padding: 16px;
    `;

    const errorsHtml = errors.map(e =>
        `<div style="padding:6px 10px; border-left:3px solid var(--md-error,#E24B4A);
                     margin-bottom:6px; background:var(--md-surface-variant);
                     border-radius:0 4px 4px 0; font-size:0.83rem; color:var(--md-on-surface);">
            <strong>Стр. ${e.row}:</strong> ${e.message}
         </div>`
    ).join('');

    modal.innerHTML = `
        <div style="background:var(--md-surface); border-radius:var(--md-radius-lg,12px);
                    box-shadow:0 8px 32px rgba(0,0,0,.25); max-width:560px; width:100%;
                    max-height:80vh; display:flex; flex-direction:column; overflow:hidden;">
            <div style="padding:18px 20px; border-bottom:1px solid var(--md-outline-variant);
                        display:flex; align-items:center; gap:10px;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                     stroke="var(--md-error,#E24B4A)" stroke-width="2.2"
                     stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span style="font-weight:600; font-size:1rem; color:var(--md-on-surface);">
                    Импорт завершён с замечаниями
                </span>
            </div>
            <div style="padding:14px 20px; display:flex; gap:20px; font-size:0.85rem;
                        background:var(--md-surface-container,#f5f5f5);
                        border-bottom:1px solid var(--md-outline-variant);">
                <span>✅ Добавлено: <strong>${result.added}</strong></span>
                <span>🔄 Обновлено: <strong>${result.updated}</strong></span>
                <span>⏭ Пропущено: <strong>${result.skipped}</strong></span>
                <span style="color:var(--md-error,#E24B4A);">⚠ Ошибок: <strong>${errors.length}</strong></span>
            </div>
            <div style="overflow-y:auto; flex:1; padding:14px 20px;">
                <p style="font-size:0.82rem; color:var(--md-on-surface-hint); margin-bottom:10px;">
                    Следующие строки не были импортированы:
                </p>
                ${errorsHtml}
            </div>
            <div style="padding:14px 20px; border-top:1px solid var(--md-outline-variant);
                        display:flex; justify-content:flex-end; gap:8px;">
                <button id="import-errors-copy" class="btn btn-outlined btn-sm" type="button">
                    📋 Скопировать список ошибок
                </button>
                <button id="import-errors-close" class="btn btn-primary btn-sm" type="button">
                    Закрыть
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#import-errors-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    modal.querySelector('#import-errors-copy').addEventListener('click', () => {
        const text = errors.map(e => `Строка ${e.row}: ${e.message}`).join('\n');
        navigator.clipboard.writeText(text).then(() => {
            window.showSnackbar?.('Скопировано в буфер обмена', 'success');
        });
    });
}

// ─── Автодополнение ФИО ───────────────────────────────────────────────────────
// Работает поверх единого fio_autocomplete-компонента.
//
// Делегируем на «focusin» в #master-tbody (admin-редактор расписания):
// при первом фокусе в input[id^="name-"] подвязываем компонент лениво.
// Последующие keystrokes обрабатывает сам компонент.
//
// #slots-tbody (dept-редактор) здесь НЕ трогаем — department.js подвязывает
// fio_autocomplete сам при рендере таблицы (чтобы dropdown корректно
// отрисовывался внутри td с position:relative).

export function initAutocomplete() {
    const attachOnFocus = (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement)) return;
        if (!input.id?.startsWith('name-')) return;
        if (input.__fioAc) return;

        const slotId = input.id.slice('name-'.length);

        attachFio(input, {
            container: input.parentElement,
            getExtraParams: () => ({
                rank:       document.getElementById(`rank-${slotId}`)?.value.trim() || '',
                doc_number: document.getElementById(`doc-${slotId}`)?.value.trim()  || '',
            }),
            onSelect: (person) => {
                const nameEl = document.getElementById(`name-${slotId}`);
                const rankEl = document.getElementById(`rank-${slotId}`);
                const docEl  = document.getElementById(`doc-${slotId}`);
                if (nameEl && person.full_name)  nameEl.value = person.full_name;
                if (rankEl && person.rank)       rankEl.value = person.rank;
                if (docEl  && person.doc_number) docEl.value  = person.doc_number;

                // Лёгкий фидбек что данные подставились
                [nameEl, rankEl, docEl].forEach(el => {
                    if (!el || !el.value) return;
                    el.classList.add('ac-filled');
                    setTimeout(() => el.classList.remove('ac-filled'), 600);
                });

                // Триггерим change → admin.js сохраняет слот
                nameEl?.dispatchEvent(new Event('change', { bubbles: true }));
            },
        });
    };

    document.getElementById('master-tbody')?.addEventListener('focusin', attachOnFocus);
}