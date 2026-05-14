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
        const btn = document.getElementById('my-certs-download-agent');
        btn?.addEventListener('click', downloadAgent);
    }
    await loadMyKeys();
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
    const validTo  = formatDate(k.valid_to);
    const cn       = escapeHtml(k.subject_cn || '—');
    const issuer   = escapeHtml(k.issuer_cn || '—');
    const status   = statusLabel(k.status, k.valid_to);
    const inn      = k.subject_inn
        ? `<div>ИНН: <code>${escapeHtml(k.subject_inn)}</code></div>` : '';
    const note     = k.note
        ? `<div>Комментарий: ${escapeHtml(k.note)}</div>` : '';

    return `
        <div class="my-certs-card">
            <div class="my-certs-card__top">
                <div class="my-certs-card__name">
                    ${escapeHtml(k.container_name)}
                </div>
                ${status}
            </div>
            <div class="my-certs-card__details">
                <div>Владелец сертификата: <b>${cn}</b></div>
                <div>Издатель: ${issuer}</div>
                <div>Действителен до: <b>${validTo}</b></div>
                ${inn}
                ${note}
            </div>
        </div>`;
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


async function downloadAgent() {
    const btn = document.getElementById('my-certs-download-agent');
    if (!btn) return;

    const oldLabel = btn.innerHTML;
    btn.disabled  = true;
    btn.innerHTML = 'Готовим архив…';

    try {
        // Запрашиваем имя машины — попадёт в description токена для аудита
        // (админ потом видит в списке агентов «PC-IVANOV — последний пинг ...»).
        const hint    = (window.currentUser?.username || '').toUpperCase();
        const machine = prompt(
            'Опишите этот ПК (попадёт в журнал у администратора):\n\n' +
            'Например: «PC-' + hint + '» или «Ноутбук бухгалтерии»',
            'PC-' + hint,
        );
        if (machine === null) {
            // Юзер отменил — выходим без запроса.
            return;
        }

        const fd = new FormData();
        fd.append('description', machine || '');

        // api.upload не подходит: он ожидает JSON-ответ, а здесь возвращается ZIP.
        // Делаем fetch вручную с тем же токеном из localStorage.
        const token    = localStorage.getItem('token');
        const headers  = token ? { 'Authorization': `Bearer ${token}` } : {};
        const response = await fetch('/api/v1/certs/agent/install-package', {
            method:  'POST',
            headers,
            body:    fd,
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({ detail: 'ошибка ' + response.status }));
            throw new ApiError(err.detail || ('HTTP ' + response.status), response.status);
        }

        const blob = await response.blob();
        // Имя файла — из Content-Disposition если есть, иначе сами строим.
        const disp = response.headers.get('Content-Disposition') || '';
        const match = /filename=["']?([^"']+)["']?/i.exec(disp);
        const fname = match ? match[1]
                            : `pods2-agent-${window.currentUser?.username || 'user'}.zip`;

        // Принудительный download через временную ссылку.
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        window.showSnackbar?.(
            'Архив скачан. Распакуйте и запустите install.bat от Администратора.',
            'success', 8000,
        );
    } catch (err) {
        window.showError?.('Не удалось скачать агента: ' + err.message);
    } finally {
        btn.disabled  = false;
        btn.innerHTML = oldLabel;
    }
}


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
