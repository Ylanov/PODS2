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

    // Привязка клика по заголовку письма — открывает модалку просмотра
    // в pods2 вместо перехода в СЭД. Делегирование, потому что innerHTML
    // переписывается на каждый рефреш.
    list.querySelectorAll('.sed-item__title--btn').forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const nodeId = parseInt(btn.dataset.letterNodeId, 10);
            if (nodeId) _openLetter(nodeId);
        };
    });
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

    // Файлы: показываем максимум 5 в превью. По клику на письмо
    // (не на файл) откроется модалка с полным списком.
    const filesHtml = (item.files || []).slice(0, 5).map(f => {
        if (!f || !f.url) return '';
        return `
            <a class="sed-file" href="${_esc(f.url)}"
               target="_blank" rel="noopener noreferrer"
               title="Открыть вложение в СЭД (через cookie-сессию)">
                📎 ${_esc(f.name || 'Файл')}
            </a>`;
    }).join('');

    // Title — кликабельный, открывает модалку с телом (если она уже
    // загружена расширением). Без node_id — просто текст.
    const titleEl = nodeId
        ? `<button class="sed-item__title sed-item__title--btn" type="button"
                  data-letter-node-id="${nodeId}"
                  title="Открыть письмо в pods2 (без перехода в СЭД)">${_esc(item.title || '—')}</button>`
        : `<span class="sed-item__title">${_esc(item.title || '—')}</span>`;

    return `
        <div class="sed-item">
            ${titleEl}
            ${filesHtml ? `<div class="sed-item__files">${filesHtml}</div>` : ''}
        </div>`;
}


// ─── Модалка просмотра письма ────────────────────────────────────────────

async function _openLetter(nodeId) {
    document.getElementById('sed-letter-modal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'sed-letter-modal';
    modal.className = 'sed-letter-modal';
    modal.innerHTML = `
        <div class="sed-letter-modal__card">
            <div class="sed-letter-modal__head">
                <strong style="flex:1;">Письмо #${nodeId}</strong>
                <button class="sed-letter-modal__close" type="button" aria-label="Закрыть">✕</button>
            </div>
            <div class="sed-letter-modal__body">
                <p style="text-align:center; padding:30px; color:var(--md-on-surface-variant);">Загрузка…</p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.sed-letter-modal__close').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', function _onKey(e) {
        if (e.key === 'Escape') {
            close();
            document.removeEventListener('keydown', _onKey);
        }
    });

    let letter;
    try {
        letter = await api.get(`/sed/letter/${nodeId}`);
    } catch (err) {
        modal.querySelector('.sed-letter-modal__body').innerHTML = `
            <div class="sed-letter-modal__notfound">
                <p><b>Письмо ещё не загружено в pods2.</b></p>
                <p>Расширение СЭД-моста подтянет его при следующей синхронизации
                    (раз в 5 минут). Можно дождаться или нажать «Синхронизировать»
                    в popup-е расширения. До этого момента — открыть в самом СЭД:</p>
                <p><a href="https://sed.mchs.ru/node/${nodeId}" target="_blank" rel="noopener noreferrer">
                    https://sed.mchs.ru/node/${nodeId}</a></p>
            </div>
        `;
        return;
    }

    _renderLetter(modal, letter);
}


function _renderLetter(modal, letter) {
    const meta = letter.meta || {};
    // Маппинг ключей из META_FIELD_MAP (см. parser.js) в человеческие подписи
    const META_LABELS = {
        status:           'Состояние',
        doc_type:         'Вид документа',
        priority:         'Срочность',
        summary:          'Содержание',
        internal_no:      'Номер/дата',
        addressee:        'Адресат',
        executor:         'Исполнитель',
        signer:           'Подписант',
        with_signature:   'ЭП',
        sheets_count:     'Кол-во листов',
        attachments_cnt:  'Приложений',
    };
    const metaRows = Object.entries(META_LABELS)
        .filter(([k]) => meta[k])
        .map(([k, label]) => `
            <div class="sed-letter-meta-row">
                <span class="sed-letter-meta-row__label">${_esc(label)}:</span>
                <span class="sed-letter-meta-row__value">${_esc(meta[k])}</span>
            </div>
        `).join('');

    const filesHtml = (letter.files || []).map(f => `
        <a class="sed-letter-file" href="${_esc(f.url)}"
           target="_blank" rel="noopener noreferrer"
           title="Открыть в СЭД (через cookie-сессию)">
            📎 ${_esc(f.name || 'Файл')}
            ${f.size ? `<small>${_fmtSize(f.size)}</small>` : ''}
        </a>
    `).join('');

    const fetchedTime = letter.fetched_at
        ? new Date(letter.fetched_at).toLocaleString('ru-RU')
        : '';

    modal.querySelector('.sed-letter-modal__head strong').textContent = letter.title || `Письмо #${letter.node_id}`;
    modal.querySelector('.sed-letter-modal__body').innerHTML = `
        ${metaRows ? `<div class="sed-letter-meta">${metaRows}</div>` : ''}
        ${filesHtml ? `
            <div class="sed-letter-files">
                <h4 class="sed-letter-files__h">Файлы</h4>
                ${filesHtml}
            </div>` : ''}
        <div class="sed-letter-body">
            ${letter.body_html || '<p style="color:var(--md-on-surface-variant);"><i>Тело письма пустое.</i></p>'}
        </div>
        ${fetchedTime ? `<p class="sed-letter-modal__fetched">Загружено: ${fetchedTime}</p>` : ''}
    `;
}


function _fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
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
                        <button class="btn btn-success btn-sm" id="sed-onb-dl" type="button">
                            ⬇ Скачать sed-bridge.zip
                        </button>
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

    // Кнопка «Скачать sed-bridge.zip». Простой <a href> не подходит, потому
    // что endpoint защищён Bearer-токеном — браузер не передаёт его в
    // обычной навигации. Делаем fetch с заголовком, получаем blob,
    // создаём временный object-URL и открываем save-as.
    overlay.querySelector('#sed-onb-dl')?.addEventListener('click', async () => {
        const btn = overlay.querySelector('#sed-onb-dl');
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Скачиваем…';
        try {
            const resp = await fetch('/api/v1/sed/bridge.zip', {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` },
            });
            if (!resp.ok) {
                let detail = `HTTP ${resp.status}`;
                try {
                    const j = await resp.json();
                    if (j?.detail) detail = j.detail;
                } catch { /* not JSON */ }
                throw new Error(detail);
            }
            const blob = await resp.blob();
            const url  = URL.createObjectURL(blob);
            const a = Object.assign(document.createElement('a'), {
                href:     url,
                download: 'sed-bridge.zip',
            });
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            window.showSnackbar?.('Архив скачан. Распакуйте и загрузите как расширение.', 'success');
        } catch (err) {
            window.showSnackbar?.(`Не удалось скачать: ${err?.message || err}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = orig;
        }
    });

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
