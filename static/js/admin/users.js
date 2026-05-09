// static/js/admin/users.js
//
// Полностью изолированная вкладка «Пользователи»: список карточек,
// фильтр / поиск / роль, форма создания, модалки сброса пароля,
// модалка прав (permissions), модалка модулей операций.
//
// Зависимости извне:
//   - api          — fetch wrapper
//   - formatRole   — показ имени пользователя на русском
//   - showError    — toast об ошибке
//   - setAvailableDepartments — admin.js экспортирует setter, чтобы
//                    после loadUsers() editor видел свежий список
//                    управлений в выпадайке «Квота»
//
// Все *внутренние* helper'ы (esc, notify, _initials, рендеры карточек,
// модалки) живут только в этом файле.

import { api } from '../api.js';
import { formatRole, showError } from '../ui.js';
import { setAvailableDepartments } from '../admin.js';


// ─── Локальные helper'ы ──────────────────────────────────────────────────────

const el = (id) => document.getElementById(id);

function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function notify(message, type = 'success') {
    if (window.showSnackbar) window.showSnackbar(message, type);
}


// ─── Каталог permissions (вкладок) ──────────────────────────────────────────
// При добавлении новой вкладки: добавь сюда + в AVAILABLE_PERMISSIONS
// (app/models/user.py) + в app.js:PERM_TAB_MAP (скрытие у пользователя).

const ALL_PERMISSIONS = [
    {
        key: 'lists',   label: 'Списки',          hint: 'Рабочие списки слотов',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    },
    {
        key: 'duty',    label: 'Графики нарядов', hint: 'Личные графики суточного наряда',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    },
    {
        key: 'combat',  label: 'Боевой расчёт',   hint: 'Заполнение боевых расчётов',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    },
    {
        key: 'tasks',   label: 'Календарь',       hint: 'Личные задачи и планы',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M9 16l2 2 4-4"/></svg>',
    },
    {
        key: 'persons', label: 'База людей',      hint: 'Общий справочник людей',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>',
    },
    {
        key: 'sed_inbox', label: 'СЭД',
        hint: 'Кнопка «Почта · СЭД» в шапке: дайджест писем из sed.mchs.ru через расширение браузера',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    },
    {
        key: 'oper_map', label: 'Карта ОД',
        hint: 'Карта Москвы и МО для оперативного дежурного: адреса, маршруты от базы, зоны ответственности',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    },
];

const MODULE_LABELS = {
    comms:       { label: 'Форма 3-СВЯЗЬ',      icon: '📡' },
    media:       { label: 'Учёт МНИ',           icon: '💾' },
    procurement: { label: 'Гос. закупки',       icon: '📋' },
    training:    { label: 'Проф. подготовка',   icon: '🎓' },
};


// ─── Локальный кеш для клиент-сайд фильтрации ───────────────────────────────

let _usersCache       = [];
let _usersFilter      = 'all';   // 'all' | 'admin' | 'department'
let _usersQuery       = '';
let _usersSearchTimer = null;


// ─── Permissions UI ─────────────────────────────────────────────────────────

// Рендер чипов — и в форме создания, и в модалке редактирования.
// Если selected===null, все по умолчанию активны (для формы создания).
export function renderPermsCheckboxes(selected = null, containerId = 'new-user-perms') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const active = selected === null
        ? new Set(ALL_PERMISSIONS.map(p => p.key))
        : new Set(selected || []);

    container.innerHTML = ALL_PERMISSIONS.map(p => `
        <label class="users-v2__perm-chip ${active.has(p.key) ? 'active' : ''}"
               data-perm="${p.key}" title="${esc(p.hint)}">
            <input type="checkbox" class="perm-checkbox"
                   data-perm="${p.key}"
                   ${active.has(p.key) ? 'checked' : ''}>
            ${p.icon}
            ${esc(p.label)}
        </label>
    `).join('');

    // Toggle-поведение: клик по chip переключает состояние.
    // preventDefault — клик по label сам переключит input, но мы
    // управляем `active` классом вручную для мгновенного фидбека.
    container.querySelectorAll('.users-v2__perm-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
            e.preventDefault();
            const cb = chip.querySelector('.perm-checkbox');
            cb.checked = !cb.checked;
            chip.classList.toggle('active', cb.checked);
        });
    });
}

function collectCheckedPerms(containerId = 'new-user-perms') {
    const container = document.getElementById(containerId);
    if (!container) return null;
    return Array.from(container.querySelectorAll('.perm-checkbox'))
        .filter(cb => cb.checked)
        .map(cb => cb.dataset.perm);
}

// Для роли 'admin' permissions неактуальны → прячем весь блок.
function _togglePermsBlock() {
    const role  = el('new-role')?.value;
    const block = document.getElementById('new-user-perms-block');
    if (block) block.style.display = role === 'admin' ? 'none' : '';
}


// ─── Карточки пользователей ─────────────────────────────────────────────────

function _initials(name) {
    const parts = (name || '?').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2);
    return (parts[0][0] + parts[parts.length - 1][0]);
}

function _cardPermsHtml(user) {
    if (user.role === 'admin') {
        return `<span class="users-v2__perm-icon users-v2__perm-icon--admin-all" title="Полный доступ">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            все вкладки
        </span>`;
    }
    const p = Array.isArray(user.permissions) ? user.permissions : [];
    if (p.length === 0) {
        return `<span class="users-v2__perm-icon users-v2__perm-icon--none" title="Нет доступа ни к одной вкладке">
            нет доступа
        </span>`;
    }
    return p.map(key => {
        const def = ALL_PERMISSIONS.find(x => x.key === key);
        if (!def) return '';
        return `<span class="users-v2__perm-icon" title="${esc(def.hint)}">
            ${def.icon}${esc(def.label)}
        </span>`;
    }).join('');
}

function _roleBadge(role) {
    if (role === 'admin')      return 'Админ';
    if (role === 'unit')       return 'Отдел';
    if (role === 'department') return 'Управление';
    return role || '';
}

function _cardModulesHtml(user) {
    const m = Array.isArray(user.modules) ? user.modules : [];
    if (m.length === 0) {
        return `<span class="users-v2__module-chip users-v2__module-chip--empty"
                       title="У отдела не настроены модули операций — карточек в «Операциях» не будет">
            модули не настроены
        </span>`;
    }
    return m.map(key => {
        const def = MODULE_LABELS[key];
        if (!def) return '';
        return `<span class="users-v2__module-chip" title="${esc(def.label)}">
            ${def.icon} ${esc(def.label)}
        </span>`;
    }).join('');
}

function _renderUserCard(user) {
    const isAdmin     = user.role === 'admin';
    const isUnit      = user.role === 'unit';
    const isProtected = user.username === 'admin';
    const isInactive  = !user.is_active;

    const avatarClass = isAdmin ? 'users-v2__avatar--admin'
                       : isUnit ? 'users-v2__avatar--unit'
                       :          'users-v2__avatar--dept';
    const roleClass   = isAdmin ? 'users-v2__card-role--admin'
                       : isUnit ? 'users-v2__card-role--unit'
                       :          'users-v2__card-role--dept';
    const cardMods    = [
        isAdmin     ? 'users-v2__card--admin'    : '',
        isUnit      ? 'users-v2__card--unit'     : '',
        isInactive  ? 'users-v2__card--inactive' : '',
    ].filter(Boolean).join(' ');

    const editBtn = isProtected || isAdmin
        ? `<button class="users-v2__icon-btn users-v2__icon-btn--protected"
                   title="${isAdmin ? 'У администратора полный доступ всегда' : 'Нельзя редактировать главного администратора'}" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
           </button>`
        : `<button class="users-v2__icon-btn" data-edit-perms="${user.id}" title="Настроить доступные вкладки">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
           </button>`;

    // Кнопка «Модули операций» — только для unit-юзеров.
    const modulesBtn = (isUnit && !isProtected)
        ? `<button class="users-v2__icon-btn" data-edit-modules="${user.id}"
                   title="Назначить модули операций (Форма 3-СВЯЗЬ, МНИ, проф. подготовка…)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
           </button>`
        : '';

    // «Сбросить пароль» — для всех кроме защищённого main-admin.
    const passwdBtn = isProtected
        ? ''
        : `<button class="users-v2__icon-btn" data-reset-password="${user.id}"
                   title="Сбросить пароль пользователю">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="16" r="1"/></svg>
           </button>`;

    const delBtn = isProtected
        ? `<button class="users-v2__icon-btn users-v2__icon-btn--protected" title="Главный администратор — защищён от удаления" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
           </button>`
        : `<button class="users-v2__icon-btn users-v2__icon-btn--danger" data-delete-id="${user.id}" title="Удалить пользователя">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
           </button>`;

    return `
        <div class="users-v2__card ${cardMods}" data-user-id="${user.id}">
            <div class="users-v2__card-head">
                <div class="users-v2__avatar ${avatarClass}">${esc(_initials(formatRole(user.username)))}</div>
                <div class="users-v2__card-info">
                    <div class="users-v2__card-name">${esc(formatRole(user.username))}</div>
                    <div class="users-v2__card-login">@${esc(user.username)}${isInactive ? ' · деактивирован' : ''}</div>
                </div>
                <span class="users-v2__card-role ${roleClass}">
                    ${_roleBadge(user.role)}
                </span>
            </div>
            <div class="users-v2__card-perms">${_cardPermsHtml(user)}</div>
            ${isUnit ? `<div class="users-v2__card-modules">${_cardModulesHtml(user)}</div>` : ''}
            <div class="users-v2__card-actions">${editBtn}${modulesBtn}${passwdBtn}${delBtn}</div>
        </div>
    `;
}


// ─── Список пользователей ───────────────────────────────────────────────────

function _renderUsersList() {
    const list  = document.getElementById('users-v2-list');
    const empty = document.getElementById('users-v2-empty');
    if (!list) return;

    const q = _usersQuery.toLowerCase();
    let items = _usersCache;

    if (_usersFilter !== 'all') {
        items = items.filter(u => u.role === _usersFilter);
    }
    if (q) {
        items = items.filter(u =>
            (u.username || '').toLowerCase().includes(q)
            || formatRole(u.username).toLowerCase().includes(q)
        );
    }

    if (items.length === 0) {
        list.innerHTML = '';
        empty?.classList.remove('hidden');
        return;
    }
    empty?.classList.add('hidden');

    // Сортировка: admin → управления → отделы → остальные, внутри каждой группы
    // алфавитно по username.
    const roleRank = (r) => r === 'admin'      ? 0
                          : r === 'department' ? 1
                          : r === 'unit'       ? 2
                          :                      3;
    items = [...items].sort((a, b) => {
        const ra = roleRank(a.role), rb = roleRank(b.role);
        if (ra !== rb) return ra - rb;
        return (a.username || '').localeCompare(b.username || '', 'ru');
    });

    list.innerHTML = items.map(_renderUserCard).join('');

    // Делегирование: Настроить / Модули / Удалить
    list.querySelectorAll('[data-edit-perms]').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = parseInt(btn.dataset.editPerms, 10);
            const user   = _usersCache.find(u => u.id === userId);
            if (user) _openPermsModal(user);
        });
    });
    list.querySelectorAll('[data-edit-modules]').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = parseInt(btn.dataset.editModules, 10);
            const user   = _usersCache.find(u => u.id === userId);
            if (user) _openModulesModal(user);
        });
    });
    list.querySelectorAll('[data-reset-password]').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = parseInt(btn.dataset.resetPassword, 10);
            const user   = _usersCache.find(u => u.id === userId);
            if (user) _openPasswordResetModal(user);
        });
    });
    list.querySelectorAll('[data-delete-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            const userId = parseInt(btn.dataset.deleteId, 10);
            deleteUser(userId);
        });
    });
}


// ─── Модалки ────────────────────────────────────────────────────────────────

// Сброс пароля — админ задаёт новый пароль любому юзеру (admin override).
function _openPasswordResetModal(user) {
    document.getElementById('passwd-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'passwd-modal';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
        animation: users-v2-slide-in 0.15s ease-out;
    `;
    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:440px; width:100%; padding:22px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
                <div class="users-v2__avatar ${user.role === 'unit' ? 'users-v2__avatar--unit'
                                              : user.role === 'admin' ? 'users-v2__avatar--admin'
                                              : 'users-v2__avatar--dept'}"
                     style="width:36px; height:36px; font-size:0.82rem;">
                    ${esc(_initials(formatRole(user.username)))}
                </div>
                <div style="flex:1;">
                    <h3 style="margin:0; font-size:1.02rem; font-weight:600;">
                        Сбросить пароль
                    </h3>
                    <p style="margin:2px 0 0; font-size:0.78rem; color:var(--md-on-surface-hint);">
                        ${esc(formatRole(user.username))} · @${esc(user.username)}
                    </p>
                </div>
            </div>
            <p style="margin:12px 0 14px; font-size:0.84rem; color:var(--md-on-surface-variant); line-height:1.45;">
                Установите новый пароль. Минимум 10 символов, должен содержать
                букву и цифру. Пользователь получит уведомление о смене.
            </p>
            <div class="field" style="margin-bottom:10px;">
                <label class="field-label" for="passwd-modal-input">Новый пароль</label>
                <input type="password" id="passwd-modal-input" autocomplete="new-password"
                       placeholder="не менее 10 символов">
            </div>
            <div class="field" style="margin-bottom:14px;">
                <label class="field-label" for="passwd-modal-confirm">Повторите</label>
                <input type="password" id="passwd-modal-confirm" autocomplete="new-password">
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <label style="display:flex; align-items:center; gap:6px; font-size:0.82rem; color:var(--md-on-surface-variant); cursor:pointer;">
                    <input type="checkbox" id="passwd-modal-show"> Показать пароли
                </label>
                <div style="display:flex; gap:8px;">
                    <button id="passwd-modal-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                    <button id="passwd-modal-save"   class="btn btn-success  btn-sm" type="button">Сбросить</button>
                </div>
            </div>
            <div id="passwd-modal-error" style="display:none; margin-top:10px; padding:8px 10px;
                background:rgba(239,68,68,0.1); color:#dc2626; border-radius:6px;
                font-size:0.82rem;"></div>
        </div>
    `;
    document.body.appendChild(modal);

    const inp     = modal.querySelector('#passwd-modal-input');
    const confirm = modal.querySelector('#passwd-modal-confirm');
    const errEl   = modal.querySelector('#passwd-modal-error');
    inp.focus();

    modal.querySelector('#passwd-modal-show').addEventListener('change', (e) => {
        const t = e.target.checked ? 'text' : 'password';
        inp.type     = t;
        confirm.type = t;
    });

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#passwd-modal-cancel').addEventListener('click', () => modal.remove());

    modal.querySelector('#passwd-modal-save').addEventListener('click', async () => {
        errEl.style.display = 'none';
        const pwd  = inp.value;
        const conf = confirm.value;

        if (pwd.length < 10) {
            errEl.textContent = 'Пароль должен быть не менее 10 символов.';
            errEl.style.display = 'block'; return;
        }
        if (pwd !== conf) {
            errEl.textContent = 'Пароли не совпадают.';
            errEl.style.display = 'block'; return;
        }
        try {
            await api.put(`/admin/users/${user.id}/password`, { new_password: pwd });
            notify('Пароль сброшен');
            modal.remove();
        } catch (e) {
            errEl.textContent = e.message || 'Не удалось сменить пароль.';
            errEl.style.display = 'block';
        }
    });

    [inp, confirm].forEach(elx => {
        elx.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') modal.querySelector('#passwd-modal-save').click();
        });
    });
}


// Модули операций — чек-боксы по AVAILABLE_MODULES.
function _openModulesModal(user) {
    document.getElementById('modules-modal')?.remove();

    const current = new Set(Array.isArray(user.modules) ? user.modules : []);
    const modal = document.createElement('div');
    modal.id = 'modules-modal';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
        animation: users-v2-slide-in 0.15s ease-out;
    `;
    const items = Object.entries(MODULE_LABELS).map(([key, def]) => `
        <label class="users-v2__module-row">
            <input type="checkbox" data-mod="${key}" ${current.has(key) ? 'checked' : ''}>
            <span class="users-v2__module-row-icon">${def.icon}</span>
            <span class="users-v2__module-row-label">${esc(def.label)}</span>
        </label>
    `).join('');

    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:520px; width:100%; padding:22px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
                <div class="users-v2__avatar users-v2__avatar--unit"
                     style="width:36px; height:36px; font-size:0.82rem;">
                    ${esc(_initials(formatRole(user.username)))}
                </div>
                <div style="flex:1;">
                    <h3 style="margin:0; font-size:1.02rem; font-weight:600;">
                        Модули отдела «${esc(formatRole(user.username))}»
                    </h3>
                    <p style="margin:2px 0 0; font-size:0.76rem; color:var(--md-on-surface-hint);
                              font-family:var(--md-font-mono);">
                        @${esc(user.username)}
                    </p>
                </div>
            </div>
            <p style="margin:12px 0 14px; font-size:0.84rem; color:var(--md-on-surface-variant);">
                Отметьте модули операций, которые увидит этот отдел в разделе
                «Операции». Если не выбрано ничего — у отдела не будет ни одной
                карточки.
            </p>
            <div id="modules-modal-list" style="display:flex; flex-direction:column;
                                                gap:6px; margin-bottom:18px;">
                ${items}
            </div>
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button id="modules-modal-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                <button id="modules-modal-save"   class="btn btn-success  btn-sm" type="button">Сохранить</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.getElementById('modules-modal-cancel').addEventListener('click', () => modal.remove());

    document.getElementById('modules-modal-save').addEventListener('click', async () => {
        const modules = [...modal.querySelectorAll('[data-mod]:checked')]
            .map(cb => cb.dataset.mod);
        try {
            await api.put(`/admin/users/${user.id}/modules`, { modules });
            notify('Модули обновлены');
            modal.remove();
            await loadUsers();
        } catch (e) {
            console.error('save modules:', e);
            showError('Не удалось сохранить: ' + (e.message || 'ошибка'));
        }
    });
}


// Permissions для не-admin: чипы вкладок.
function _openPermsModal(user) {
    document.getElementById('perms-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'perms-modal';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
        animation: users-v2-slide-in 0.15s ease-out;
    `;
    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:520px; width:100%; padding:22px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
                <div class="users-v2__avatar users-v2__avatar--dept"
                     style="width:36px; height:36px; font-size:0.82rem;">
                    ${esc(_initials(formatRole(user.username)))}
                </div>
                <div style="flex:1;">
                    <h3 style="margin:0; font-size:1.02rem; font-weight:600;">
                        ${esc(formatRole(user.username))}
                    </h3>
                    <p style="margin:2px 0 0; font-size:0.76rem; color:var(--md-on-surface-hint);
                              font-family:var(--md-font-mono);">
                        @${esc(user.username)}
                    </p>
                </div>
            </div>
            <p style="margin:12px 0 14px; font-size:0.84rem; color:var(--md-on-surface-variant);">
                Отметьте вкладки, доступные этому пользователю.
                Админ всегда видит всё.
            </p>
            <div id="perms-modal-list" class="users-v2__perms-chips"
                 style="margin-bottom:18px;"></div>
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <div style="display:flex; gap:6px;">
                    <button id="perms-modal-all"  class="users-v2__perms-quick" type="button">Все</button>
                    <button id="perms-modal-none" class="users-v2__perms-quick" type="button">Ничего</button>
                </div>
                <div style="display:flex; gap:8px;">
                    <button id="perms-modal-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                    <button id="perms-modal-save"   class="btn btn-success  btn-sm" type="button">Сохранить</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    renderPermsCheckboxes(user.permissions || [], 'perms-modal-list');

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.getElementById('perms-modal-cancel').addEventListener('click', () => modal.remove());

    document.getElementById('perms-modal-all').addEventListener('click', () => {
        renderPermsCheckboxes(ALL_PERMISSIONS.map(p => p.key), 'perms-modal-list');
    });
    document.getElementById('perms-modal-none').addEventListener('click', () => {
        renderPermsCheckboxes([], 'perms-modal-list');
    });

    document.getElementById('perms-modal-save').addEventListener('click', async () => {
        const perms = collectCheckedPerms('perms-modal-list');
        try {
            await api.put(`/admin/users/${user.id}/permissions`, { permissions: perms });
            notify('Доступ обновлён');
            modal.remove();
            await loadUsers();
        } catch (e) {
            console.error('save perms:', e);
            showError('Не удалось сохранить: ' + (e.message || 'ошибка'));
        }
    });
}


// ─── Статистика ─────────────────────────────────────────────────────────────

function _renderUsersStats() {
    const total   = _usersCache.length;
    const admins  = _usersCache.filter(u => u.role === 'admin').length;
    const depts   = _usersCache.filter(u => u.role === 'department').length;
    const units   = _usersCache.filter(u => u.role === 'unit').length;
    const active  = _usersCache.filter(u => u.is_active).length;
    const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
    set('users-stat-total',  total);
    set('users-stat-admins', admins);
    set('users-stat-depts',  depts);
    set('users-stat-units',  units);
    set('users-stat-active', active);
}


// ─── Public API ─────────────────────────────────────────────────────────────

export async function loadUsers() {
    try {
        const users = await api.get('/admin/users');

        // Список юзеров для выпадайки «Квота» в редакторе списков:
        // admin сверху, дальше по алфавиту. Передаём в admin.js setter'ом.
        const sorted = users
            .filter(u => u.is_active)
            .sort((a, b) => {
                if (a.role === 'admin' && b.role !== 'admin') return -1;
                if (b.role === 'admin' && a.role !== 'admin') return 1;
                return (a.username || '').localeCompare(b.username || '', 'ru');
            })
            .map(u => u.username);
        setAvailableDepartments(sorted);
        window.availableRoles  = users.map(u => u.username);

        _usersCache = users;
        _renderUsersStats();
        _renderUsersList();
    } catch (e) {
        console.error('loadUsers:', e);
        showError('Не удалось загрузить пользователей');
    }
}


export async function handleCreateUser() {
    const username = el('new-username')?.value.trim();
    const password = el('new-password')?.value;
    const role     = el('new-role')?.value;
    if (!username || !password) return showError('Заполните логин и пароль');

    const payload = { username, password, role };
    if (role !== 'admin') {
        const perms = collectCheckedPerms();
        if (perms && perms.length === 0) {
            return showError('Выберите хотя бы одну вкладку для пользователя');
        }
        payload.permissions = perms;
    }

    try {
        await api.post('/admin/users', payload);
        el('new-username').value = '';
        el('new-password').value = '';
        renderPermsCheckboxes();            // сброс на «все»
        _hideCreateForm();
        notify(`Пользователь «${username}» создан`);
        await loadUsers();
    } catch (e) {
        console.error('handleCreateUser:', e);
        const msg = e.status === 409
            ? 'Пользователь с таким логином уже существует'
            : `Ошибка создания: ${e.message ?? e}`;
        showError(msg);
    }
}


export async function deleteUser(userId) {
    const user = _usersCache.find(u => u.id === userId);
    const label = user ? formatRole(user.username) : `#${userId}`;
    if (!confirm(`Удалить пользователя «${label}»?`)) return;
    try {
        await api.delete(`/admin/users/${userId}`);
        notify('Пользователь удалён');
        await loadUsers();
    } catch (e) {
        console.error('deleteUser:', e);
        showError(e.status === 403 ? (e.message ?? 'Удаление запрещено') : 'Ошибка удаления пользователя');
    }
}


// ─── Форма создания: показ / скрытие ────────────────────────────────────────

function _showCreateForm() {
    document.getElementById('users-v2-create-form')?.classList.remove('hidden');
    setTimeout(() => el('new-username')?.focus(), 40);
}
function _hideCreateForm() {
    document.getElementById('users-v2-create-form')?.classList.add('hidden');
}


// ─── Init: вешаем обработчики поиска / фильтра / формы ─────────────────────

export function initUsersTab() {
    renderPermsCheckboxes();
    el('new-role')?.addEventListener('change', _togglePermsBlock);
    _togglePermsBlock();

    document.getElementById('users-v2-toggle-create')?.addEventListener('click', () => {
        const form = document.getElementById('users-v2-create-form');
        if (form?.classList.contains('hidden')) _showCreateForm(); else _hideCreateForm();
    });
    document.getElementById('users-v2-cancel-create')?.addEventListener('click', _hideCreateForm);

    // Быстрое «Все / Ничего» в форме создания
    document.getElementById('users-v2-perms-all')?.addEventListener('click', () => {
        renderPermsCheckboxes(ALL_PERMISSIONS.map(p => p.key), 'new-user-perms');
    });
    document.getElementById('users-v2-perms-none')?.addEventListener('click', () => {
        renderPermsCheckboxes([], 'new-user-perms');
    });

    // Поиск с debounce
    document.getElementById('users-search')?.addEventListener('input', (e) => {
        clearTimeout(_usersSearchTimer);
        _usersSearchTimer = setTimeout(() => {
            _usersQuery = e.target.value.trim();
            _renderUsersList();
        }, 220);
    });

    // Фильтр по роли
    document.querySelectorAll('[data-role-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('[data-role-filter]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _usersFilter = btn.dataset.roleFilter;
            _renderUsersList();
        });
    });
}
