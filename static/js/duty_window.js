// static/js/duty_window.js
/**
 * Виджет «Окно подачи графиков нарядов».
 * Показывает: открыто/закрыто сейчас + обратный отсчёт до ближайшей границы.
 * Работает каждый день 09:00–16:00 (МСК).
 *
 * Используется на дашборде (для админа) и как баннер на странице
 * графиков нарядов управления (для dept-пользователя).
 */

import { api } from './api.js';

const TICK_MS    = 1000;          // локальный пересчёт таймера
const REFRESH_MS = 60 * 1000;     // перезапрос статуса с сервера

/**
 * Монтирует виджет в указанный контейнер.
 * Возвращает объект с методом stop() — для очистки таймеров при размонтировании.
 *
 * variant: 'card' (вертикальная плашка для сайдбара дашборда)
 *        | 'banner' (горизонтальная полоса для страницы графиков управления)
 */
export function mountDutyWindow(container, { variant = 'card' } = {}) {
    if (!container) return { stop() {} };

    let status     = null;   // последний ответ /window-status
    let serverDelta = 0;     // server_time - Date.now() в ms (для коррекции часов клиента)
    let tickTimer  = null;
    let fetchTimer = null;

    container.innerHTML = _skeleton(variant);

    async function refresh() {
        try {
            const data = await api.get('/duty/window-status');
            status = data;
            const serverNow = new Date(data.server_time).getTime();
            serverDelta = serverNow - Date.now();
            _render();
        } catch (err) {
            console.error('[duty_window] status load error:', err);
            container.innerHTML = `<div class="duty-window duty-window--${variant} duty-window--err">Не удалось получить статус окна</div>`;
        }
    }

    function _render() {
        if (!status) return;
        const now = Date.now() + serverDelta;
        const closesAt = new Date(status.closes_at).getTime();
        const opensAt  = new Date(status.opens_at).getTime();

        const isOpen = status.is_open && now < closesAt;
        const targetMs = isOpen ? closesAt - now : opensAt - now;
        const cd = _countdown(Math.max(0, targetMs));

        const stateLabel = isOpen ? 'Открыто' : 'Закрыто';
        const stateMod   = isOpen ? 'duty-window--open' : 'duty-window--closed';
        const cdLabel    = isOpen ? 'до закрытия' : 'до открытия';
        const win        = `${status.window.start}–${status.window.end} (МСК)`;

        if (variant === 'banner') {
            container.innerHTML = `
                <div class="duty-window duty-window--banner ${stateMod}">
                    <span class="duty-window__dot"></span>
                    <span class="duty-window__state">${stateLabel}</span>
                    <span class="duty-window__sep">·</span>
                    <span class="duty-window__win">Окно подачи: ${win}</span>
                    <span class="duty-window__cd">${cdLabel} ${cd}</span>
                </div>`;
        } else {
            container.innerHTML = `
                <div class="duty-window duty-window--card ${stateMod}">
                    <div class="duty-window__head">
                        <span class="duty-window__dot"></span>
                        <span class="duty-window__title">Окно подачи</span>
                        <span class="duty-window__state">${stateLabel}</span>
                    </div>
                    <div class="duty-window__win">${win}</div>
                    <div class="duty-window__cd">
                        <span class="duty-window__cd-num">${cd}</span>
                        <span class="duty-window__cd-lbl">${cdLabel}</span>
                    </div>
                </div>`;
        }

        // Если граница пересечена локально — освежим состояние с сервера,
        // не дожидаясь следующего REFRESH_MS-тика.
        if (isOpen !== status.is_open) refresh();
    }

    function _countdown(ms) {
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}ч ${String(m).padStart(2,'0')}м`;
        if (m > 0) return `${m}м ${String(s).padStart(2,'0')}с`;
        return `${s}с`;
    }

    function _skeleton(v) {
        return v === 'banner'
            ? `<div class="duty-window duty-window--banner duty-window--skel">…</div>`
            : `<div class="duty-window duty-window--card duty-window--skel">…</div>`;
    }

    refresh();
    tickTimer  = setInterval(_render, TICK_MS);
    fetchTimer = setInterval(refresh, REFRESH_MS);

    return {
        stop() {
            clearInterval(tickTimer);
            clearInterval(fetchTimer);
        }
    };
}
