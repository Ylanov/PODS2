// static/js/app.js

import * as auth       from './auth.js';
import * as ui         from './ui.js';
import * as admin      from './admin.js';
import * as department from './department.js';
import * as duty       from './duty.js';
import * as combatCalc from './combat_calc.js';
import * as deptDuty   from './dept_duty.js';
import * as dashboard  from './dashboard.js';
// Подключаем статически — модуль регистрирует window.openSlotHistory
// при импорте, чтобы inline-кнопка в таблице слотов его видела.
import './slot_history.js';
// Центр уведомлений — инициализируется через notifications.initNotifications()
// вызываемый в auth.js после логина (чтобы /notifications не дёргался до JWT).
import * as notifications from './notifications.js';
// Редактор списка для админа на дашборде — регистрирует window.openEventEditor
import './event_editor.js';
// Глобальный поиск Ctrl+K — слушатель ставится при импорте через initGlobalSearch().
import { initGlobalSearch } from './global_search.js';
initGlobalSearch();
// Тема (светлая/тёмная) — модуль сам применяет сохранённую при загрузке;
// отдельно вешаем кнопку-переключатель когда DOM шапки готов.
import { initThemeToggleButton } from './theme_toggle.js';
document.addEventListener('DOMContentLoaded', initThemeToggleButton);

window.app = {
    deleteUser:      admin.deleteUser,
    // Вызывается из auth.js после подтверждения роли admin
    initDashboard:   () => dashboard.initDashboard(),
};

// ─── Permissions → видимость вкладок управления ──────────────────────────────
//
// Вызывается из auth.js после получения /auth/me: скрывает кнопки-вкладок,
// которых нет в user.permissions. Admin всегда получает полный набор
// (бэкенд так возвращает), поэтому для него ничего не скрывается.
//
// ВАЖНО: это только UI-фильтр. Бэкенд параллельно отклоняет API-вызовы
// через require_permission, поэтому обход через devtools не сработает —
// будет 403.
const PERM_TAB_MAP = {
    'lists':   'dept-main-tab-btn',
    'duty':    'dept-duty-tab-btn',
    'combat':  'cc-dept-tab-btn',
    'tasks':   'dept-tasks-tab-btn',
    'persons': 'dept-persons-tab-btn',
};

export function applyPermissionsToTabs(permissions) {
    const perms = new Set(Array.isArray(permissions) ? permissions : []);
    Object.entries(PERM_TAB_MAP).forEach(([perm, btnId]) => {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.style.display = perms.has(perm) ? '' : 'none';
    });

    // Если текущая активная вкладка скрыта (например админ только что
    // убрал доступ) — переключаемся на первую доступную. Так пользователь
    // не застревает на 404/403.
    const firstAvailable = Object.keys(PERM_TAB_MAP).find(p => perms.has(p));
    if (firstAvailable) {
        const firstBtn = document.getElementById(PERM_TAB_MAP[firstAvailable]);
        const activeHidden = Object.values(PERM_TAB_MAP).some(id => {
            const b = document.getElementById(id);
            return b && b.classList.contains('btn-filled') && b.style.display === 'none';
        });
        if (activeHidden && firstBtn) firstBtn.click();
    }
}

// Делаем доступным без циклического импорта между auth.js и app.js
window._applyPermissionsToTabs = applyPermissionsToTabs;

// ─── Переключение вкладок управления (Department View) ───────────────────────

let _tasksDeptInited   = false;
let _deptPersonsInited = false;

function switchDeptTab(tab) {
    // Если сейчас на вкладке "Графики наряда" и текущий месяц в draft —
    // блокируем уход, пока не будет утверждён. Флаг выставляет dept_duty.js.
    const dutyPanel = document.getElementById('dept-duty-panel');
    const dutyVisible = dutyPanel && !dutyPanel.classList.contains('hidden');
    if (dutyVisible && tab !== 'duty' && window.__deptDutyHasDraft) {
        alert(
            'Вы в режиме редактирования графика наряда.\n\n' +
            'Сначала нажмите «📌 Утвердить», чтобы зафиксировать месяц, ' +
            'или «✎ Редактировать» если хотите оставить в черновике — ' +
            'а затем переключайтесь на другую вкладку.'
        );
        return;
    }

    document.getElementById('dept-event-cards')?.classList.add('hidden');
    document.getElementById('dept-content')?.classList.add('hidden');
    document.getElementById('dept-combat-calc')?.classList.add('hidden');
    document.getElementById('dept-duty-panel')?.classList.add('hidden');
    document.getElementById('dept-tasks-panel')?.classList.add('hidden');
    document.getElementById('dept-persons-panel')?.classList.add('hidden');
    document.getElementById('dept-ops-panel')?.classList.add('hidden');

    // Сбрасываем активный стиль у всех кнопок управления
    const resetBtn = (id) => {
        const b = document.getElementById(id);
        if (!b) return;
        b.classList.remove('btn-filled');
        b.classList.add('btn-outlined');
    };
    ['dept-main-tab-btn', 'cc-dept-tab-btn', 'dept-duty-tab-btn',
     'dept-tasks-tab-btn', 'dept-persons-tab-btn', 'dept-ops-tab-btn'].forEach(resetBtn);

    const activateBtn = (id) => {
        const b = document.getElementById(id);
        if (!b) return;
        b.classList.remove('btn-outlined');
        b.classList.add('btn-filled');
    };

    if (tab === 'lists') {
        document.getElementById('dept-event-cards')?.classList.remove('hidden');
        activateBtn('dept-main-tab-btn');
    } else if (tab === 'combat') {
        document.getElementById('dept-combat-calc')?.classList.remove('hidden');
        activateBtn('cc-dept-tab-btn');
        combatCalc.loadCombatInstances();
    } else if (tab === 'duty') {
        document.getElementById('dept-duty-panel')?.classList.remove('hidden');
        activateBtn('dept-duty-tab-btn');
        deptDuty.loadDeptSchedules();
    } else if (tab === 'tasks') {
        document.getElementById('dept-tasks-panel')?.classList.remove('hidden');
        activateBtn('dept-tasks-tab-btn');
        import('./tasks.js').then(m => {
            if (!_tasksDeptInited) {
                m.initTasks('tasks-root-dept', false);
                _tasksDeptInited = true;
            } else {
                m.reloadTasks();
            }
        });
    } else if (tab === 'persons') {
        document.getElementById('dept-persons-panel')?.classList.remove('hidden');
        activateBtn('dept-persons-tab-btn');
        // Первый заход — рисуем разметку через _renderShell + грузим.
        // Следующие — только reload данных (сохраняется состояние mode/поиска).
        import('./dept_persons.js').then(m => {
            if (!_deptPersonsInited) {
                m.initDeptPersons();
                _deptPersonsInited = true;
            } else {
                m.loadDeptPersons();
            }
        });
    } else if (tab === 'ops') {
        document.getElementById('dept-ops-panel')?.classList.remove('hidden');
        activateBtn('dept-ops-tab-btn');
        import('./comms_report.js').then(m => m.mountOpsPanel());
    }
}

// Показывает/скрывает «Операции» в зависимости от роли. Вызывается из auth.js
// после инициализации сессии (когда уже известна user.role).
window._applyOperationsTabVisibility = function(role) {
    const btn = document.getElementById('dept-ops-tab-btn');
    if (!btn) return;
    btn.classList.toggle('hidden', role !== 'unit');
};

// ─── Привязка событий ─────────────────────────────────────────────────────────

function bindEvents() {

    // Auth
    document.getElementById('login-form')?.addEventListener('submit', auth.handleLogin);
    document.getElementById('logout-btn')?.addEventListener('click', auth.logout);

    // Admin Mode Switcher (кнопка переключения вид админа ↔ вид управления)
    document.getElementById('admin-mode-btn')?.addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (btn.dataset.currentView === 'admin') {
            ui.showView('department-view');
            btn.dataset.currentView = 'dept';
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                    <polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                <span>В панель админа</span>
            `;
            switchDeptTab('lists');
            if (document.getElementById('dept-event-id')?.value) {
                department.loadMySlots();
            }
        } else {
            ui.showView('admin-view');
            btn.dataset.currentView = 'admin';
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                <span>Режим заполнения</span>
            `;
        }
    });

    // ── Вкладки панели Администратора ────────────────────────────────────────
    // Порядок соответствует кнопкам .tab-btn в index.html.
    // Остальные разделы (история, пользователи, база людей, календарь, история
    // утверждений) живут в аккордеоне tab-operations / внутри tab-duty.
    const tabMap = [
        'dashboard', 'editor', 'duty', 'combat', 'operations', 'analytics',
    ];
    document.querySelectorAll('.tab-btn').forEach((btn, index) => {
        const tabKey = tabMap[index] ?? 'dashboard';
        btn.addEventListener('click', () => {
            ui.switchAdminTab(tabKey);
            // Аналитика — lazy: грузим модуль и данные только при первом
            // клике на вкладку, чтобы не дёргать /admin/analytics у админов
            // которые ни разу её не открывают.
            if (tabKey === 'analytics') {
                import('./analytics.js')
                    .then(m => m.loadAnalytics())
                    .catch(err => console.warn('analytics import:', err));
            }
        });
    });

    // Собираем аккордеон «Операции» и переключатель истории утверждений
    // в графиках наряда. Запускаем после того как DOM админ-вкладки готов,
    // но до первого switchAdminTab — чтобы панели уже были на своих местах.
    consolidateOperations();

    // ── Действия Администратора ───────────────────────────────────────────────
    document.getElementById('create-event-btn')?.addEventListener('click', admin.handleCreateEvent);
    document.getElementById('instantiate-template-btn')?.addEventListener('click', admin.handleInstantiateTemplate);
    document.getElementById('editor-is-template-cb')?.addEventListener('change', admin.toggleCurrentEventTemplate);
    // Новая кнопка «+ Добавить группу» внутри editor-container (снизу таблицы).
    // Старый add-group-btn жил в tools-bar panel-group, теперь группы
    // добавляются прямо в контексте открытого шаблона.
    document.getElementById('editor-add-group-btn')?.addEventListener('click', admin.handleAddGroup);
    document.getElementById('editor-new-group-name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); admin.handleAddGroup(); }
    });
    document.getElementById('load-editor-btn')?.addEventListener('click', admin.loadAdminEditor);
    // Автозагрузка при выборе шаблона в выпадающем списке
    document.getElementById('editor-event-id')?.addEventListener('change', admin.autoLoadEditorOnChange);
    document.getElementById('editor-toggle-status-btn')?.addEventListener('click', admin.toggleEventStatus);
    document.getElementById('editor-delete-event-btn')?.addEventListener('click', admin.handleDeleteEvent);
    document.getElementById('create-user-btn')?.addEventListener('click', admin.handleCreateUser);
    // Единая кнопка «⬇ Скачать .docx» — бэк сам определяет формат
    // (ГРОЗА-555, КОМАНДА-333, стандартный) по структуре события.
    document.getElementById('export-btn')?.addEventListener('click', admin.exportWord);
    document.getElementById('duty-save-btn')?.addEventListener('click', admin.saveDutyOfficer);

    // Должности
    document.getElementById('add-position-btn')?.addEventListener('click', admin.handleAddPosition);
    document.getElementById('position-event-id')?.addEventListener('change', admin.loadAndRenderPositions);
    document.getElementById('positions-list')?.addEventListener('click', (e) => {
        const delPosId = e.target.dataset.delPosId;
        if (delPosId) admin.handleDeletePosition(delPosId);
    });

    // Делегирование событий для таблицы админа
    const masterTbody = document.getElementById('master-tbody');
    masterTbody?.addEventListener('change', (e) => {
        const slotId = e.target.closest('tr')?.dataset.slotId;
        if (slotId) admin.updateAdminSlot(slotId);
    });
    masterTbody?.addEventListener('click', (e) => {
        // Удаление слота — кнопки в строках слотов с data-delete-id.
        const deleteId = e.target.dataset.deleteId;
        if (deleteId) admin.deleteSlot(deleteId);
        // Кнопки группы (+ Строку / ✕ Группу) обрабатываются в
        // admin.listenForUpdates() через классы .group-add-row-btn /
        // .group-delete-btn — раньше тут был дублирующий handler по
        // data-group-id, который ловил ОБЕ кнопки и при клике на удаление
        // ошибочно добавлял строку.
    });

    // ── Действия управления (Department) ─────────────────────────────────────
    document.getElementById('load-slots-btn')?.addEventListener('click', department.loadMySlots);
    const slotsTbody = document.getElementById('slots-tbody');
    slotsTbody?.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            const slotId = e.target.closest('tr')?.dataset.slotId;
            if (slotId) department.saveSlot(slotId);
        }
    });

    // Вкладки управления (Списки / Графики / Боевой расчёт / Календарь / База людей)
    document.getElementById('dept-main-tab-btn')?.addEventListener('click',    () => switchDeptTab('lists'));
    document.getElementById('cc-dept-tab-btn')?.addEventListener('click',      () => switchDeptTab('combat'));
    document.getElementById('dept-duty-tab-btn')?.addEventListener('click',    () => switchDeptTab('duty'));
    document.getElementById('dept-tasks-tab-btn')?.addEventListener('click',   () => switchDeptTab('tasks'));
    document.getElementById('dept-persons-tab-btn')?.addEventListener('click', () => switchDeptTab('persons'));
    document.getElementById('dept-ops-tab-btn')?.addEventListener('click',     () => switchDeptTab('ops'));

    // ── Инициализация UI-компонентов (без API-вызовов) ────────────────────────
    ui.initPersonsTab();
    ui.initAutocomplete();
    admin.initSchedule();
    admin.initUsersTab();   // чекбоксы permissions в форме «+ Добавить пользователя»

    // Графики наряда (Администратор) — только привязка событий
    duty.initDuty();

    // Рендерим сетку расписания когда панель открывается
    document.querySelectorAll('.tool-trigger').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.panel === 'panel-schedule') {
                setTimeout(() => admin.renderScheduleGrid(), 50);
            }
        });
    });

    // Графики нарядов (Управление) — только привязка событий, без API
    deptDuty.bindDeptDutyEvents();

    // ВАЖНО: combatCalc.initCombatCalc(false) и dashboard.initDashboard()
    // вызываются в auth.js -> _doInitSession() ПОСЛЕ подтверждения токена,
    // чтобы не провоцировать 401 до авторизации.
}


// ─── Консолидация редких разделов в tab-operations (аккордеон) ───────────────
//
// Вызывается один раз при старте админ-панели. Переносит существующие DOM-узлы
// вкладок tab-history / tab-users / tab-persons / tab-calendar внутрь
// карточек аккордеона на tab-operations. Это сохраняет все id/event-handlers —
// JS-модули этих разделов продолжают работать без изменений. Также вешает
// кнопку-переключатель «История утверждений» в сайдбар tab-duty, которая
// показывает/скрывает переехавший tab-duty-history прямо под графиком.
//
// Дизайн: клик по ops-card → плавное раскрытие, только одна секция открыта
// одновременно (accordion). При первом раскрытии вызываем модуль-загрузчик
// (history.loadHistory, loadPersons, tasks.initTasks) — чтобы не тратить
// API-запросы на разделы, которые админ так и не открыл.

const OPS_SECTIONS = [
    {
        target: 'tab-history',
        title:  'История',
        desc:   'Архив списков по датам с календарём и графиками готовности.',
        icon:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
        onOpen: () => import('./history.js').then(m => m.loadHistory()).catch(() => {}),
    },
    {
        target: 'tab-users',
        title:  'Пользователи',
        desc:   'Учётные записи управлений и администраторов.',
        icon:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
        onOpen: () => {},
    },
    {
        target: 'tab-persons',
        title:  'База людей',
        desc:   'Общий справочник сотрудников: ФИО, звания, документы, контакты.',
        icon:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6M22 15h-6M22 19h-6"/></svg>',
        onOpen: () => ui.loadPersons && ui.loadPersons(),
    },
    {
        target: 'tab-calendar',
        title:  'Календарь',
        desc:   'Задачи и напоминания по всем управлениям.',
        icon:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
        onOpen: () => import('./tasks.js').then(m => {
            if (!window._tasksAdminInited) {
                m.initTasks('tasks-root', true);
                window._tasksAdminInited = true;
            } else {
                m.reloadTasks();
            }
        }),
    },
];

function consolidateOperations() {
    const accordion = document.getElementById('ops-accordion');
    if (!accordion) return;

    // Уже собран (HMR / двойной вызов) — выходим.
    if (accordion.dataset.consolidated === '1') return;

    const loaded = new Set();

    for (const spec of OPS_SECTIONS) {
        const sourcePanel = document.getElementById(spec.target);
        if (!sourcePanel) continue;

        // Строим карточку
        const section = document.createElement('section');
        section.className       = 'ops-section';
        section.dataset.opsTarget = spec.target;
        section.innerHTML = `
            <button class="ops-card" type="button" aria-expanded="false" aria-controls="${spec.target}">
                <span class="ops-card__icon">${spec.icon}</span>
                <span class="ops-card__body">
                    <span class="ops-card__title">${spec.title}</span>
                    <span class="ops-card__desc">${spec.desc}</span>
                </span>
                <svg class="ops-card__chevron" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
            <div class="ops-section__content"></div>
        `;
        // Переносим оригинальную панель в контент секции. Удаляем hidden —
        // видимость управляется на уровне ops-section, а не самой панели.
        const holder = section.querySelector('.ops-section__content');
        sourcePanel.classList.remove('hidden');
        holder.appendChild(sourcePanel);
        accordion.appendChild(section);
    }

    // Обработчик клика (accordion: только одна открыта)
    accordion.addEventListener('click', (e) => {
        const card = e.target.closest('.ops-card');
        if (!card) return;
        const section = card.closest('.ops-section');
        if (!section) return;

        const wasOpen = section.classList.contains('ops-section--open');

        // Закрываем все
        accordion.querySelectorAll('.ops-section--open').forEach(s => {
            s.classList.remove('ops-section--open');
            s.querySelector('.ops-card')?.setAttribute('aria-expanded', 'false');
        });

        if (!wasOpen) {
            section.classList.add('ops-section--open');
            card.setAttribute('aria-expanded', 'true');
            const target = section.dataset.opsTarget;
            if (!loaded.has(target)) {
                loaded.add(target);
                const spec = OPS_SECTIONS.find(s => s.target === target);
                try { spec?.onOpen?.(); } catch (err) { console.error('[ops] onOpen', err); }
            }
        }
    });

    // Программное открытие секции (из ui.openOperationsSection)
    document.addEventListener('ops-open-section', (e) => {
        const target = e.detail;
        const card = accordion.querySelector(`.ops-section[data-ops-target="${target}"] .ops-card`);
        if (card && !card.closest('.ops-section--open')) card.click();
    });

    accordion.dataset.consolidated = '1';

    // ── Кнопка «История утверждений» внутри tab-duty ────────────────────────
    const historyToggle = document.getElementById('duty-history-toggle');
    const dutyHistory   = document.getElementById('tab-duty-history');
    const tabDuty       = document.getElementById('tab-duty');

    if (historyToggle && dutyHistory && tabDuty) {
        // Перемещаем tab-duty-history в конец tab-duty, чтобы он рисовался
        // под графиком и не торчал как отдельная вкладка.
        tabDuty.appendChild(dutyHistory);
        dutyHistory.classList.add('hidden');

        let dhInited = false;
        historyToggle.addEventListener('click', () => {
            const isHidden = dutyHistory.classList.contains('hidden');
            dutyHistory.classList.toggle('hidden');
            historyToggle.setAttribute('aria-expanded', String(isHidden));
            historyToggle.classList.toggle('active', isHidden);
            if (isHidden && !dhInited) {
                dhInited = true;
                import('./duty_history.js').then(m => m.initDutyHistory())
                    .catch(err => console.error('duty_history load:', err));
            }
            if (isHidden) {
                dutyHistory.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    auth.initializeUserSession();
});
