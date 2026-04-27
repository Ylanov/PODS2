// static/js/change_password.js
//
// Модалка «Изменить свой пароль». Открывается из кнопки в шапке для
// любого залогиненного пользователя. Старый пароль обязателен.

import { api } from './api.js';

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function initChangePasswordButton() {
    const btn = document.getElementById('change-password-btn');
    if (!btn) return;
    if (!window.currentUser) {
        btn.classList.add('hidden');
        return;
    }
    btn.classList.remove('hidden');
    btn.addEventListener('click', openChangePasswordModal);
}

function openChangePasswordModal() {
    document.getElementById('cp-modal')?.remove();
    const m = document.createElement('div');
    m.id = 'cp-modal';
    m.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
    `;
    m.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:440px; width:100%; padding:22px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <h3 style="margin:0 0 6px; font-size:1.05rem; font-weight:600;">
                Изменить свой пароль
            </h3>
            <p style="margin:0 0 16px; font-size:0.82rem; color:var(--md-on-surface-hint);">
                Пользователь <b>@${esc(window.currentUser?.username || '')}</b>.
                Минимум 10 символов, должен содержать букву и цифру.
            </p>
            <div class="field" style="margin-bottom:10px;">
                <label class="field-label" for="cp-current">Текущий пароль</label>
                <input type="password" id="cp-current" autocomplete="current-password">
            </div>
            <div class="field" style="margin-bottom:10px;">
                <label class="field-label" for="cp-new">Новый пароль</label>
                <input type="password" id="cp-new" autocomplete="new-password"
                       placeholder="не менее 10 символов">
            </div>
            <div class="field" style="margin-bottom:14px;">
                <label class="field-label" for="cp-confirm">Повторите новый</label>
                <input type="password" id="cp-confirm" autocomplete="new-password">
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <label style="display:flex; align-items:center; gap:6px; font-size:0.82rem;
                              color:var(--md-on-surface-variant); cursor:pointer;">
                    <input type="checkbox" id="cp-show"> Показать
                </label>
                <div style="display:flex; gap:8px;">
                    <button id="cp-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                    <button id="cp-save"   class="btn btn-success  btn-sm" type="button">Сохранить</button>
                </div>
            </div>
            <div id="cp-error" style="display:none; margin-top:10px; padding:8px 10px;
                background:rgba(239,68,68,0.1); color:#dc2626; border-radius:6px;
                font-size:0.82rem;"></div>
            <div id="cp-success" style="display:none; margin-top:10px; padding:8px 10px;
                background:rgba(46,125,50,0.1); color:#2e7d32; border-radius:6px;
                font-size:0.82rem;"></div>
        </div>
    `;
    document.body.appendChild(m);

    const curEl  = m.querySelector('#cp-current');
    const newEl  = m.querySelector('#cp-new');
    const confEl = m.querySelector('#cp-confirm');
    const errEl  = m.querySelector('#cp-error');
    const okEl   = m.querySelector('#cp-success');
    curEl.focus();

    m.querySelector('#cp-show').addEventListener('change', (e) => {
        const t = e.target.checked ? 'text' : 'password';
        curEl.type = t; newEl.type = t; confEl.type = t;
    });

    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    m.querySelector('#cp-cancel').addEventListener('click', () => m.remove());

    m.querySelector('#cp-save').addEventListener('click', async () => {
        errEl.style.display = 'none';
        okEl.style.display  = 'none';

        if (!curEl.value) {
            errEl.textContent = 'Введите текущий пароль.';
            errEl.style.display = 'block'; return;
        }
        if (newEl.value.length < 10) {
            errEl.textContent = 'Новый пароль должен быть не менее 10 символов.';
            errEl.style.display = 'block'; return;
        }
        if (newEl.value !== confEl.value) {
            errEl.textContent = 'Новый пароль и повтор не совпадают.';
            errEl.style.display = 'block'; return;
        }
        if (newEl.value === curEl.value) {
            errEl.textContent = 'Новый пароль совпадает с текущим.';
            errEl.style.display = 'block'; return;
        }

        try {
            await api.put('/auth/me/password', {
                current_password: curEl.value,
                new_password:     newEl.value,
            });
            okEl.textContent = 'Пароль изменён успешно.';
            okEl.style.display = 'block';
            setTimeout(() => m.remove(), 1500);
        } catch (e) {
            errEl.textContent = e.message || 'Не удалось изменить пароль.';
            errEl.style.display = 'block';
        }
    });

    // Enter сохраняет
    [curEl, newEl, confEl].forEach(el => {
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') m.querySelector('#cp-save').click();
        });
    });
}
