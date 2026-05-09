// static/js/sed_inbox.js
/**
 * Кнопка «Почта · СЭД» в шапке pods2.
 *
 * Источник данных — снимок дайджеста, который браузерное расширение
 * пользователя POST'ит в /api/v1/sed/snapshot. UI читает /api/v1/sed/snapshot,
 * рисует бейдж с общим количеством непрочитанных и выпадающую панель со
 * списком разделов и заголовков писем. Файлы открываются в новой вкладке —
 * скачивает их браузер пользователя сам, когда тот в МЧС-сети.
 *
 * Видимость кнопки: role === 'admin' || permissions.includes('sed_inbox').
 *
 * Экспорт:
 *   initSedInbox()      — после логина: проверить permission, запросить снимок,
 *                          отрисовать; повесить обработчики.
 *   onSedWsUpdate()     — вызвать при WS-событии sed_snapshot_updated.
 *   stopSedInbox()      — на logout: спрятать, очистить таймеры.
 */

import { api } from './api.js';

const STATE = {
    visible:    false,
    snapshot:   null,   // { taken_at, sections: [...], total }
    pollTimer:  null,
};

const POLL_MS = 60_000;   // каждую минуту перепроверяем снимок (на случай WS-просадки)

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _hasAccess() {
    const u = window.currentUser;
    if (!u) return false;
    if (u.role === 'admin') return true;
    return Array.isArray(u.permissions) && u.permissions.includes('sed_inbox');
}

export async function initSedInbox() {
    const btn  = document.getElementById('sed-header-btn');
    const drop = document.getElementById('sed-header-dropdown');
    if (!btn || !drop) return;

    if (!_hasAccess()) {
        btn.classList.add('hidden');
        drop.classList.add('hidden');
        STATE.visible = false;
        return;
    }

    btn.classList.remove('hidden');
    STATE.visible = true;

    // Тоггл выпадайки. Закрываем при клике вне.
    btn.onclick = (e) => {
        e.stopPropagation();
        drop.classList.toggle('hidden');
        // При открытии — освежаем данные.
        if (!drop.classList.contains('hidden')) _fetchAndRender();
    };
    document.addEventListener('click', (e) => {
        if (drop.classList.contains('hidden')) return;
        if (!drop.contains(e.target) && !btn.contains(e.target)) {
            drop.classList.add('hidden');
        }
    });

    await _fetchAndRender();

    clearInterval(STATE.pollTimer);
    STATE.pollTimer = setInterval(_fetchAndRender, POLL_MS);
}

export function stopSedInbox() {
    clearInterval(STATE.pollTimer);
    STATE.pollTimer = null;
    STATE.snapshot  = null;
    STATE.visible   = false;
    document.getElementById('sed-header-btn')?.classList.add('hidden');
    document.getElementById('sed-header-dropdown')?.classList.add('hidden');
}

export function onSedWsUpdate() {
    if (STATE.visible) _fetchAndRender();
}

async function _fetchAndRender() {
    if (!STATE.visible) return;
    try {
        const snap = await api.get('/sed/snapshot');
        STATE.snapshot = snap;   // null если расширение ещё ничего не прислало
        _renderBadge(snap);
        _renderList(snap);
    } catch (err) {
        // 403 — у юзера сняли permission. Просто прячем кнопку.
        if (err && err.status === 403) {
            stopSedInbox();
            return;
        }
        console.warn('[sed_inbox] snapshot fetch:', err);
    }
}

function _renderBadge(snap) {
    const dot = document.getElementById('sed-header-dot');
    if (!dot) return;
    const total = snap?.total ?? 0;
    if (total > 0) {
        dot.textContent = total > 99 ? '99+' : String(total);
        dot.classList.remove('hidden');
    } else {
        dot.classList.add('hidden');
    }
}

function _renderList(snap) {
    const list = document.getElementById('sed-header-list');
    const meta = document.getElementById('sed-header-meta');
    if (!list) return;

    if (!snap || !snap.sections || snap.sections.length === 0) {
        list.innerHTML = `
            <div style="padding:18px 14px; text-align:center;
                        color:var(--md-on-surface-hint); font-size:0.82rem;
                        line-height:1.5;">
                Дайджест ещё не пришёл.<br>
                <button class="btn btn-success btn-sm" id="sed-onboarding-btn"
                        type="button" style="margin-top:10px;">
                    🛠 Подключить расширение
                </button>
            </div>`;
        // Кнопка открывает пошаговый wizard. По требованию open via attach
        // (innerHTML переписывается каждый рефреш).
        list.querySelector('#sed-onboarding-btn')?.addEventListener('click', () => {
            openSedOnboarding();
        });
        if (meta) meta.textContent = '';
        return;
    }

    const html = snap.sections.map(_renderSection).join('');
    list.innerHTML = html || `
        <div style="padding:18px 14px; text-align:center;
                    color:var(--md-on-surface-hint); font-size:0.82rem;">
            Сейчас ничего не ждёт рассмотрения.
        </div>`;

    if (meta) {
        const t = snap.taken_at ? new Date(snap.taken_at) : null;
        meta.textContent = t
            ? `Обновлено ${t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
            : '';
    }
}

function _renderSection(section) {
    const count = parseInt(section.count, 10) || 0;
    const items = Array.isArray(section.items) ? section.items : [];
    if (count === 0 && items.length === 0) return '';

    const sedUrl = section.url
        ? `https://sed.mchs.ru${section.url.startsWith('/') ? '' : '/'}${section.url}`
        : 'https://sed.mchs.ru/';

    const itemsHtml = items.slice(0, 8).map(it => _renderItem(it)).join('');

    return `
        <div class="sed-section">
            <div class="sed-section__head">
                <a class="sed-section__title" href="${_esc(sedUrl)}"
                   target="_blank" rel="noopener noreferrer"
                   title="Открыть в СЭД">
                    ${_esc(section.title || section.key || 'Раздел')}
                </a>
                ${count > 0 ? `<span class="sed-section__count">${count}</span>` : ''}
            </div>
            ${itemsHtml ? `<div class="sed-section__items">${itemsHtml}</div>` : ''}
        </div>`;
}

function _renderItem(item) {
    const nodeId  = parseInt(item.node_id, 10);
    const nodeUrl = nodeId ? `https://sed.mchs.ru/node/${nodeId}` : null;

    const filesHtml = (item.files || []).slice(0, 5).map(f => {
        if (!f || !f.url) return '';
        return `
            <a class="sed-file" href="${_esc(f.url)}"
               target="_blank" rel="noopener noreferrer"
               title="Скачать вложение">
                📎 ${_esc(f.name || 'Файл')}
            </a>`;
    }).join('');

    const titleEl = nodeUrl
        ? `<a class="sed-item__title" href="${_esc(nodeUrl)}"
              target="_blank" rel="noopener noreferrer">${_esc(item.title || '—')}</a>`
        : `<span class="sed-item__title">${_esc(item.title || '—')}</span>`;

    return `
        <div class="sed-item">
            ${titleEl}
            ${filesHtml ? `<div class="sed-item__files">${filesHtml}</div>` : ''}
        </div>`;
}


// ─── Onboarding wizard ───────────────────────────────────────────────────────
//
// Открывается из dropdown'а «Почта · СЭД» когда у пользователя ещё нет
// snapshot'а. Делает 3 вещи за пользователя:
//   1. Кнопка «Скачать расширение» → /api/v1/sed/bridge.zip
//   2. Показывает токен из localStorage с кнопкой «Скопировать»
//   3. Показывает URL pods2 (текущий window.location.origin) с кнопкой
//      «Скопировать»
//
// После — простая инструкция: распаковать ZIP, browser://extensions/,
// «Загрузить распакованное», открыть «Настройки», вставить URL+токен,
// зайти в sed.mchs.ru и нажать «Синхр. сейчас» в popup'е.

export function openSedOnboarding() {
    if (document.getElementById('sed-onboarding-overlay')) return;

    const token   = localStorage.getItem('token') || '';
    const pods2Url = window.location.origin;

    const overlay = document.createElement('div');
    overlay.id = 'sed-onboarding-overlay';
    overlay.className = 'gs-overlay';
    overlay.innerHTML = `
        <div class="gs-dialog sed-onb__dialog" role="dialog"
             aria-label="Подключение СЭД-моста">
            <div class="gs-header">
                <strong style="flex:1;">📬 Подключение СЭД-моста</strong>
                <button type="button" class="btn btn-text btn-sm" id="sed-onb-close">Закрыть</button>
            </div>

            <div class="sed-onb__body">

                <p class="sed-onb__intro">
                    Расширение работает в Яндекс.Браузере под уже залогиненной
                    сессией пользователя в СЭД. Никакие пароли никуда не уходят —
                    оно просто читает страницы СЭД и шлёт компактную сводку
                    в pods2.
                </p>

                <ol class="sed-onb__steps">
                    <li>
                        <h4>Скачайте расширение</h4>
                        <p>Получите ZIP с папкой расширения.</p>
                        <a class="btn btn-success btn-sm" id="sed-onb-dl"
                           href="/api/v1/sed/bridge.zip" download="sed-bridge.zip">
                            ⬇ Скачать sed-bridge.zip
                        </a>
                    </li>

                    <li>
                        <h4>Распакуйте и подключите в браузере</h4>
                        <p>
                            В Яндекс.Браузере откройте
                            <code>browser://extensions/</code>, включите
                            «Режим разработчика» (переключатель сверху справа),
                            нажмите <b>«Загрузить распакованное»</b> и выберите
                            папку <code>sed-bridge</code> из распакованного архива.
                        </p>
                    </li>

                    <li>
                        <h4>Скопируйте URL pods2 и токен</h4>
                        <p>В настройках расширения введите эти два значения:</p>

                        <div class="sed-onb__copy">
                            <label>URL pods2</label>
                            <div class="sed-onb__copy-row">
                                <input type="text" id="sed-onb-url" value="${pods2Url}" readonly>
                                <button class="btn btn-outlined btn-xs" id="sed-onb-copy-url"
                                        type="button">Скопировать</button>
                            </div>
                        </div>

                        <div class="sed-onb__copy">
                            <label>Токен (Bearer)</label>
                            <div class="sed-onb__copy-row">
                                <input type="text" id="sed-onb-token"
                                       value="${token ? token.slice(0, 20) + '…' : '(не найден)'}"
                                       readonly>
                                <button class="btn btn-outlined btn-xs" id="sed-onb-copy-token"
                                        type="button">Скопировать</button>
                            </div>
                            <p class="sed-onb__hint">
                                Токен — длинная строка, которая обновляется при каждом входе.
                                Если позже выйдете из pods2 и снова войдёте — токен
                                поменяется, нужно будет обновить его в расширении.
                            </p>
                        </div>
                    </li>

                    <li>
                        <h4>Залогиньтесь в СЭД</h4>
                        <p>
                            Откройте <a href="https://sed.mchs.ru/" target="_blank"
                                        rel="noopener noreferrer">sed.mchs.ru</a>
                            в этом же браузере, войдите как обычно своим логином
                            и паролем.
                        </p>
                    </li>

                    <li>
                        <h4>Проверьте</h4>
                        <p>
                            Кликните на иконку расширения (конверт) в шапке браузера
                            → <b>«Синхр. сейчас»</b>. В popup'е появится статус
                            «Дайджест отправлен. Всего непрочитанных: N». В этой
                            странице pods2 кнопка «Почта · СЭД» в шапке покажет
                            тот же счётчик.
                        </p>
                    </li>
                </ol>
            </div>

            <div class="sed-onb__footer">
                <button class="btn btn-success btn-sm" id="sed-onb-done"
                        type="button">Готово</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#sed-onb-close')?.addEventListener('click', () => overlay.remove());
    overlay.querySelector('#sed-onb-done')?.addEventListener('click',  () => overlay.remove());

    overlay.querySelector('#sed-onb-copy-url')?.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(pods2Url);
            window.showSnackbar?.('URL скопирован', 'success');
        } catch {
            window.showSnackbar?.('Не удалось скопировать — выделите вручную', 'error');
        }
    });

    overlay.querySelector('#sed-onb-copy-token')?.addEventListener('click', async () => {
        if (!token) {
            window.showSnackbar?.('Токен не найден. Перелогиньтесь в pods2.', 'error');
            return;
        }
        try {
            await navigator.clipboard.writeText(token);
            window.showSnackbar?.('Токен скопирован (хранить никому не давать!)', 'success');
        } catch {
            window.showSnackbar?.('Не удалось скопировать — выделите вручную', 'error');
        }
    });
}

// Делаем доступным из консоли — если пользователь хочет открыть wizard
// напрямую без empty-state.
window.openSedOnboarding = openSedOnboarding;
