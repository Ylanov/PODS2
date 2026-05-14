// static/js/certs_user.js
//
// Раздел «Мои сертификаты» в кабинете юзера (department-view).
//
// Точка входа: initMyCerts() — вызывается из app.js при переключении на
// вкладку 'mycerts' (см. switchDeptTab).
//
// Делает две вещи:
//   1. Показывает список ключей пользователя через GET /api/v1/certs/me.
//   2. Скачивает агент-инсталлятор через POST /api/v1/certs/agent/install-package
//      — сервер генерирует уникальный токен и собирает ZIP с config.json
//      + install.bat. Юзер кладёт ZIP на свой ПК, распаковывает,
//      запускает install.bat от админа.

import { api, ApiError } from './api.js';


let _initialized = false;


export async function initMyCerts() {
    if (!_initialized) {
        _initialized = true;
        document.getElementById('my-certs-force-sync')?.addEventListener('click', forceSync);
    }
    await Promise.all([loadMyKeys(), loadStatus()]);
}


async function loadStatus() {
    const el = document.getElementById('my-certs-status');
    if (!el) return;
    try {
        const data = await api.get('/certs/me/agent-status');
        renderStatus(el, data);
    } catch (err) {
        el.innerHTML = `<div class="my-certs-status-card my-certs-status--unknown">Не удалось получить статус агента: ${escapeHtml(err.message)}</div>`;
    }
}


function renderStatus(el, data) {
    const { agents, overall } = data;

    if (overall === 'none') {
        // Никакого агента нет — главная кнопка установки.
        el.innerHTML = `
            <div class="my-certs-status-card my-certs-status--offline">
                <div class="my-certs-status-icon">●</div>
                <div class="my-certs-status-body">
                    <div class="my-certs-status-title">Агент ещё не установлен</div>
                    <div class="my-certs-status-desc">
                        Без агента сертификаты не появятся в КриптоПро.
                        Нажми кнопку ниже — скачается файл, открой его двойным кликом
                        и подтверди запрос Windows. Всё, готово через минуту.
                    </div>
                </div>
                <button id="my-certs-install-btn" class="btn btn-success btn-lg" type="button">
                    Установить агент
                </button>
            </div>`;
        document.getElementById('my-certs-install-btn')?.addEventListener('click', installAgent);
        return;
    }

    const labelMap = {
        online:       'работает',
        idle:         'молчит несколько минут',
        offline:      'давно не пинговал',
        never_pinged: 'не пинговал ни разу',
    };
    const cls = {
        online:       'my-certs-status--online',
        idle:         'my-certs-status--idle',
        offline:      'my-certs-status--offline',
        never_pinged: 'my-certs-status--idle',
    };

    const overallTitle = overall === 'online'
        ? 'Агент работает'
        : overall === 'idle'
            ? 'Агент устанавливается / молчит'
            : 'Агент не отвечает';

    const overallCls = cls[overall] || 'my-certs-status--offline';

    const agentsList = agents.map(a => `
        <li>
            <span class="my-certs-status-dot my-certs-status-dot--${a.state}"></span>
            <code>${escapeHtml(a.hostname || '?')}</code>
            ${a.last_seen_at ? `· последний пинг ${formatRelative(a.last_seen_at)}` : '· не пинговал'}
            <span style="color:var(--md-on-surface-hint);">— ${labelMap[a.state]}</span>
        </li>
    `).join('');

    el.innerHTML = `
        <div class="my-certs-status-card ${overallCls}">
            <div class="my-certs-status-icon">●</div>
            <div class="my-certs-status-body">
                <div class="my-certs-status-title">${overallTitle}</div>
                <ul class="my-certs-status-list">${agentsList}</ul>
            </div>
            <button id="my-certs-install-btn" class="btn btn-outlined btn-sm" type="button"
                    title="Установить агент на ещё один компьютер">
                + На другой ПК
            </button>
        </div>`;
    document.getElementById('my-certs-install-btn')?.addEventListener('click', installAgent);
}


function formatRelative(iso) {
    const diffSec = Math.max(0, Math.floor((new Date() - new Date(iso)) / 1000));
    if (diffSec < 60)       return `${diffSec} сек. назад`;
    if (diffSec < 3600)     return `${Math.floor(diffSec/60)} мин. назад`;
    if (diffSec < 86400)    return `${Math.floor(diffSec/3600)} ч. назад`;
    return `${Math.floor(diffSec/86400)} дн. назад`;
}


async function installAgent() {
    const btn = document.getElementById('my-certs-install-btn');
    if (!btn) return;

    const machine = prompt(
        'Установка агента на этот ПК.\n\n' +
        'Введи имя компьютера для аудита (видно админу):',
        'PC-' + (window.currentUser?.username || '').toUpperCase(),
    );
    if (machine === null) return;

    const oldLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Готовим файл…';

    try {
        const fd = new FormData();
        fd.append('description', machine || '');
        const token = localStorage.getItem('token');
        const response = await fetch('/api/v1/certs/me/install-script', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body:    fd,
        });
        if (!response.ok) {
            const e = await response.json().catch(() => ({ detail: 'HTTP ' + response.status }));
            throw new Error(e.detail || ('HTTP ' + response.status));
        }
        const blob = await response.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = 'pods2-agent-install.ps1';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Понятная инструкция дальнейших действий.
        alert(
            'Файл pods2-agent-install.ps1 скачался.\n\n' +
            'Что делать дальше:\n\n' +
            '1. Открой папку «Загрузки».\n' +
            '2. Правый клик по pods2-agent-install.ps1 → «Запустить с PowerShell».\n' +
            '3. Windows спросит разрешение администратора — нажми «Да».\n' +
            '4. Откроется окно с прогрессом. Дождись фразы «✓ Агент установлен».\n' +
            '5. Закрой окно.\n\n' +
            'Через минуту вернись на эту страницу — статус станет зелёным.',
        );
    } catch (err) {
        window.showError?.('Не удалось скачать установщик: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = oldLabel;
        // Обновим статус через 5 секунд (даём time админу установить)
        setTimeout(() => loadStatus(), 5000);
    }
}


async function forceSync() {
    const btn = document.getElementById('my-certs-force-sync');
    if (!btn) return;
    const oldLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = 'Отправляем команду…';
    try {
        await api.post('/certs/me/force-sync', {});
        window.showSnackbar?.(
            'Команда отправлена всем установленным агентам. Они подтянут изменения в течение минуты.',
            'success', 6000,
        );
    } catch (err) {
        const msg = (err instanceof ApiError) ? err.message : String(err);
        window.showError?.('Не удалось: ' + msg);
    } finally {
        btn.disabled = false;
        btn.innerHTML = oldLabel;
    }
}


async function loadMyKeys() {
    const list = document.getElementById('my-certs-list');
    if (!list) return;

    list.innerHTML = '<div class="my-certs-empty">Загрузка…</div>';
    try {
        const keys = await api.get('/certs/me');
        renderList(keys);
    } catch (err) {
        list.innerHTML =
            `<div class="my-certs-empty">Не удалось загрузить: ${escapeHtml(err.message)}</div>`;
    }
}


function renderList(keys) {
    const list = document.getElementById('my-certs-list');
    if (!list) return;

    if (!Array.isArray(keys) || keys.length === 0) {
        list.innerHTML = `
            <div class="my-certs-empty">
                У вас пока нет назначенных сертификатов.<br>
                Обратитесь к администратору, чтобы он загрузил ваш ключ и привязал его к учётке.
            </div>`;
        return;
    }

    list.innerHTML = keys.map(cardHtml).join('');
}


function cardHtml(k) {
    const validTo = formatDate(k.valid_to);
    const cn      = escapeHtml(k.subject_cn || '—');
    const issuer  = escapeHtml(k.issuer_cn || '—');
    const status  = statusLabel(k.status, k.valid_to);
    const inn     = k.subject_inn
        ? `<div>ИНН: <code>${escapeHtml(k.subject_inn)}</code></div>` : '';
    const note    = k.note
        ? `<div>Комментарий: ${escapeHtml(k.note)}</div>` : '';

    // Подсказка по сроку — главное что нужно юзеру знать.
    const exp     = expiryInfo(k.valid_to);
    const expLine = exp.kind === 'expired'
        ? `<div class="my-certs-card__alert my-certs-card__alert--expired">⚠ <b>Срок сертификата истёк.</b> Обратитесь к администратору для замены.</div>`
        : exp.kind === 'urgent'
            ? `<div class="my-certs-card__alert my-certs-card__alert--urgent">⚠ <b>Срок истекает через ${exp.days} ${plural(exp.days, ['день', 'дня', 'дней'])}.</b> Попросите администратора подготовить новый сертификат.</div>`
            : exp.kind === 'warn'
                ? `<div class="my-certs-card__alert my-certs-card__alert--warn">Срок истекает через ${exp.days} ${plural(exp.days, ['день', 'дня', 'дней'])}. Хорошее время позаботиться о замене.</div>`
                : '';

    return `
        <div class="my-certs-card my-certs-card--${exp.kind}">
            <div class="my-certs-card__top">
                <div class="my-certs-card__name">${escapeHtml(k.container_name)}</div>
                ${status}
            </div>
            <div class="my-certs-card__details">
                <div>Владелец сертификата: <b>${cn}</b></div>
                <div>Издатель: ${issuer}</div>
                <div>Действителен до: <b>${validTo}</b></div>
                ${inn}
                ${note}
            </div>
            ${expLine}
        </div>`;
}


function expiryInfo(validTo) {
    if (!validTo) return { kind: 'ok', days: null };
    const days = Math.ceil((new Date(validTo) - new Date()) / (1000 * 60 * 60 * 24));
    if (days <= 0)  return { kind: 'expired', days };
    if (days <= 14) return { kind: 'urgent',  days };
    if (days <= 30) return { kind: 'warn',    days };
    return                  { kind: 'ok',     days };
}


function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1  && b < 5)  return forms[1];
    if (b === 1)          return forms[0];
    return forms[2];
}


function statusLabel(status, validTo) {
    const expired = validTo && new Date(validTo) < new Date();
    if (expired && status === 'active') {
        return '<span class="certs-badge certs-badge--expired">Срок истёк</span>';
    }
    const map = {
        active:  '<span class="certs-badge certs-badge--active">Активн.</span>',
        revoked: '<span class="certs-badge certs-badge--revoked">Отозван</span>',
        expired: '<span class="certs-badge certs-badge--expired">Истёк</span>',
    };
    return map[status] || `<span class="certs-badge">${escapeHtml(status)}</span>`;
}


// downloadAgent (старый ZIP-flow) удалён — заменён installAgent выше,
// который скачивает один .ps1 файл с self-elevation. ZIP-endpoint
// /agent/install-package на бэке оставлен для совместимости со старыми
// инсталляциями (если кто-то скачал ZIP до апдейта).


// ─── Утилиты ────────────────────────────────────────────────────────────────

function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}


function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
