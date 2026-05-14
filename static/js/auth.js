// static/js/auth.js

import { api } from './api.js';
import { showView, formatRole, loadEventsDropdowns, setUserDisplay, showError } from './ui.js';
import { initWebSocket, closeWebSocket } from './websockets.js';

let isInitializing = false;

// ─── Логин ────────────────────────────────────────────────────────────────────

export async function handleLogin(event) {
    event.preventDefault();

    const username     = document.getElementById('username').value;
    const password     = document.getElementById('password').value;
    const loginErrorEl = document.getElementById('login-error');

    loginErrorEl.innerText = '';

    const formData = new URLSearchParams();
    formData.append('username', username);
    formData.append('password', password);

    try {
        const response = await api.login(formData);

        if (!response.ok) {
            loginErrorEl.innerText = response.status === 401
                ? 'Неверный логин или пароль'
                : `Ошибка сервера (${response.status})`;
            return;
        }

        const data = await response.json();
        localStorage.setItem('token', data.access_token);
        await initializeUserSession();

    } catch {
        loginErrorEl.innerText = 'Ошибка соединения с сервером';
    }
}

// ─── Инициализация сессии ─────────────────────────────────────────────────────

export async function initializeUserSession() {
    if (isInitializing) return;
    isInitializing = true;

    try {
        await _doInitSession();
    } finally {
        isInitializing = false;
    }
}

async function _doInitSession() {
    const token = localStorage.getItem('token');
    if (!token) {
        showView('login-view');
        return;
    }

    let user;
    try {
        user = await api.get('/auth/me');
    } catch (error) {
        const status = error?.status ?? 0;

        if (status === 401 || status === 403) {
            logout();
        } else {
            showView('login-view');
            const loginError = document.getElementById('login-error');
            if (loginError) {
                loginError.innerText = 'Не удалось подключиться к серверу. Попробуйте ещё раз.';
            }
        }
        return;
    }

    // Сохраняем роль и данные пользователя глобально
    window.currentUserRole = user.role;
    window.currentUser     = user;   // включая permissions для проверок в JS

    setUserDisplay(user.username);
    initWebSocket();

    // Центр уведомлений — загрузить ленту и запустить periodic-poll
    // (WS-push всё равно срабатывает первым, poll — fallback).
    import('./notifications.js').then(m => m.initNotifications()).catch(() => {});

    // Кнопка «Расхождения» в шапке — для админа. Сама проверит роль и
    // спрячет себя если юзер не admin. Безопасно вызывать всегда.
    import('./person_conflicts.js').then(m => m.initConflictsBadge()).catch(() => {});

    // Кнопка «🔑 Пароль» в шапке — для всех залогиненных юзеров.
    import('./change_password.js').then(m => m.initChangePasswordButton()).catch(() => {});

    // Показываем колокольчик в header сразу после успешного логина.
    // Изначально hidden чтобы не светиться на экране логина.
    document.getElementById('notif-header-btn')?.classList.remove('hidden');

    // Скрываем недоступные вкладки управления по user.permissions.
    // Вызываем немедленно (до showView), чтобы пользователь не увидел вспышку
    // запрещённых кнопок перед их скрытием. Для admin permissions = все вкладки.
    if (typeof window._applyPermissionsToTabs === 'function') {
        window._applyPermissionsToTabs(user.permissions || []);
    }
    // Показываем «Операции» только отделам (role='unit').
    if (typeof window._applyOperationsTabVisibility === 'function') {
        window._applyOperationsTabVisibility(user.role);
    }

    const dataPromises = [loadEventsDropdowns()];

    // ─── ЛОГИКА ДЛЯ АДМИНИСТРАТОРА ───────────────────────────────────────────
    if (user.role === 'admin') {
        showView('admin-view');

        // 1. Динамический импорт: загружаем модули "на лету"
        const admin      = await import('./admin.js');
        const department = await import('./department.js');
        const combatCalc = await import('./combat_calc.js');
        const dashboard  = await import('./dashboard.js');

        // Добавляем специфичный для админа запрос в пул загрузки
        dataPromises.push(admin.loadUsers());

        // 2. Ждем выполнения всех сетевых запросов и обрабатываем ошибки
        const results = await Promise.allSettled(dataPromises);
        results.forEach((result, i) => {
            if (result.status === 'rejected') {
                console.error(`Ошибка инициализации (задача ${i}):`, result.reason);
                showError('Сетевая ошибка при загрузке данных. Обновите страницу.');
            }
        });

        // 3. Запускаем слушатели WS и рендер
        admin.listenForUpdates();
        department.listenForUpdates(); // Админу нужны оба обработчика WS

        // Инициализируем данные Боевого Расчёта и Дашборд
        combatCalc.initCombatCalc(true);
        dashboard.initDashboard();

        // Кнопка «Почта · СЭД» — для админа всегда видна, для остальных
        // только если есть permission 'sed_inbox' (проверка внутри модуля).
        import('./sed_inbox.js').then(m => m.initSedInbox?.()).catch(() => {});

    // ─── ЛОГИКА ДЛЯ УПРАВЛЕНИЯ ───────────────────────────────────────────────
    } else {
        showView('department-view');

        // 1. Динамический импорт: качаем только модули управления
        const department = await import('./department.js');
        const deptDuty   = await import('./dept_duty.js');
        const combatCalc = await import('./combat_calc.js');

        // 2. Ждем выполнения общих запросов (списки)
        const results = await Promise.allSettled(dataPromises);
        results.forEach((result, i) => {
            if (result.status === 'rejected') {
                console.error(`Ошибка инициализации (задача ${i}):`, result.reason);
                showError('Сетевая ошибка при загрузке данных. Обновите страницу.');
            }
        });

        // 3. Запускаем слушатели и инициализацию.
        //    Combat и duty инициализируем только если пользователь имеет доступ —
        //    иначе бэк вернёт 403 и в консоли будет шум.
        const perms = new Set(user.permissions || []);
        department.listenForUpdates();
        if (perms.has('combat')) combatCalc.initCombatCalc(false);
        if (perms.has('duty'))   await deptDuty.loadDeptDutyData();

        // Кнопка «Почта · СЭД» — модуль сам решит, показывать ли (зависит
        // от permission). Для управления это обычно не нужно, но если
        // конкретный username получил sed_inbox — увидит.
        if (perms.has('sed_inbox')) {
            import('./sed_inbox.js').then(m => m.initSedInbox?.()).catch(() => {});
        }
    }
}

// ─── Выход ────────────────────────────────────────────────────────────────────

export function logout() {
    isInitializing = false;
    localStorage.removeItem('token');
    closeWebSocket();
    window.currentUserRole = null;
    window.currentUser     = null;

    // Скрываем колокольчик и dropdown уведомлений
    document.getElementById('notif-header-btn')?.classList.add('hidden');
    document.getElementById('notif-header-dropdown')?.classList.add('hidden');

    // Останавливаем автообновление дашборда если оно было запущено
    import('./dashboard.js')
        .then(m => m.stopDashboard?.())
        .catch(() => { /* игнорируем */ });

    // Останавливаем баннер «Окно подачи» на странице графиков управления
    import('./dept_duty.js')
        .then(m => m.stopDeptDutyWindowBanner?.())
        .catch(() => { /* игнорируем */ });

    // Прячем кнопку «Почта · СЭД» и сбрасываем кеш снимка
    import('./sed_inbox.js')
        .then(m => m.stopSedInbox?.())
        .catch(() => { /* игнорируем */ });

    showView('login-view');
}