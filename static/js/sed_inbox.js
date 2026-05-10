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
    visible:        false,
    snapshot:       null,   // { taken_at, sections: [...], total }
    pollTimer:      null,
    bridgeReady:    false,  // расширение sed-bridge установлено и сигналит ready
    pendingDls:     new Map(),  // url → { resolve, timer } — ждём ответ от расширения
};

// Слушаем «привет» от content-script расширения и результаты загрузок.
// Этот блок выполняется при первом импорте модуля, а не в initSedInbox(),
// потому что расширение шлёт ready-сигнал на document_idle — может произойти
// до или после инициализации UI; не хотим зависеть от порядка.
window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'pods2-sed-bridge-ready') {
        STATE.bridgeReady = true;
        return;
    }
    if (msg.type === 'pods2-sed-download-result') {
        const pending = STATE.pendingDls.get(msg.url);
        if (!pending) return;
        clearTimeout(pending.timer);
        STATE.pendingDls.delete(msg.url);
        pending.resolve(msg);
    }
});

/**
 * Запросить у расширения скачивание файла по URL СЭД. Возвращает
 * {ok:true} если расширение успешно стартовало download, иначе
 * {ok:false, error:...}.
 *
 * Внимание: НЕ делает window.open в качестве фоллбэка. Если открывать
 * новую вкладку из async-callback'а (после await/setTimeout) —
 * Яндекс.Браузер видит отсутствие user-gesture'а и popup-блокатор
 * редиректит ТЕКУЩУЮ вкладку (pods2 уходит в СЭД). Поэтому фоллбэк
 * на «открыть в СЭД» делается на уровне DOM: сам элемент — это
 * <a target="_blank" href="...">, и если bridge не готов мы просто не
 * вызываем preventDefault — браузер штатно откроет новую вкладку.
 */
function _requestSedDownload(url, name) {
    return new Promise((resolve) => {
        if (STATE.pendingDls.has(url)) {
            return resolve({ ok: false, error: 'already-pending' });
        }
        const timer = setTimeout(() => {
            STATE.pendingDls.delete(url);
            resolve({ ok: false, error: 'extension-timeout' });
        }, 5000);
        STATE.pendingDls.set(url, { resolve, timer });
        window.postMessage({ type: 'pods2-sed-download', url, name: name || '' }, '*');
    });
}

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

    // Кнопка «Переустановить расширение» — висит всегда в footer'е, открывает
    // существующий onboarding-wizard (там скачать ZIP, скопировать токен/URL).
    // После удаления плагина в браузере pods2 сам не понимает что плагин
    // снесли (snapshot живой ещё 30 минут по TTL), поэтому даём явный путь.
    document.getElementById('sed-header-reinstall')?.addEventListener('click', (e) => {
        e.stopPropagation();
        drop.classList.add('hidden');
        openSedOnboarding();
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

// Если последняя синхронизация старше этого TTL — считаем что расширение
// больше не работает (удалили / отключили / умерла cookie-сессия в СЭД)
// и показываем юзеру onboarding обратно. Без этого после удаления плагина
// в UI висели бы старые письма как живые.
const STALE_TTL_MS = 30 * 60 * 1000;   // 30 минут

function _isSnapshotFresh(snap) {
    if (!snap || !snap.taken_at) return false;
    const ageMs = Date.now() - new Date(snap.taken_at).getTime();
    return ageMs < STALE_TTL_MS;
}

async function _fetchAndRender() {
    if (!STATE.visible) return;
    try {
        const snap = await api.get('/sed/snapshot');
        // Если snapshot старше 30 минут — расширение не активно, показываем
        // onboarding (как при первом запуске). Иначе UI висел бы со старыми
        // данными даже после удаления расширения.
        const fresh = _isSnapshotFresh(snap);
        STATE.snapshot = fresh ? snap : null;
        _renderBadge(fresh ? snap : null);
        _renderList(fresh ? snap : null);
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
    //
    // Открываем через requestAnimationFrame: текущий click event закончит
    // propagate ДО создания модалки в DOM. Без этого click bubbles up
    // через document, и затем модалка появляется во время того же тика —
    // в зависимости от других слушателей (poll, dropdown-close-on-outside)
    // модалка могла закрываться на том же тике («открывается на секунду
    // и резко закрывается»).
    list.querySelectorAll('.sed-item__title--btn').forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const nodeId = parseInt(btn.dataset.letterNodeId, 10);
            if (!nodeId) return;
            requestAnimationFrame(() => _openLetter(nodeId));
        };
    });

    list.querySelectorAll('.sed-file').forEach(a => {
        a.onclick = (e) => _onFileLinkClick(e, a);
    });
}

/**
 * Обработчик клика по ссылке файла. Если bridge готов — preventDefault
 * и скачивание через расширение. Если нет — НИЧЕГО не трогаем, браузер
 * штатно откроет URL в новой вкладке через target="_blank" (это
 * происходит синхронно в user-gesture'е, без popup-блокировки).
 */
function _onFileLinkClick(e, a) {
    if (!STATE.bridgeReady) return;   // нативный target=_blank
    e.preventDefault();
    e.stopPropagation();
    const url  = a.href;
    const name = a.dataset.sedFileName || '';
    _requestSedDownload(url, name).then(res => {
        if (res.ok) {
            window.showSnackbar?.('Файл скачивается…', 'success');
        } else if (res.error === 'extension-timeout') {
            // Bridge ready был, но расширение не ответило за 5с — возможно
            // повисла service worker'а. Откроем вкладку, но в новом
            // user-gesture'е это сделать нельзя из async-callback, так что
            // показываем снэкбар с просьбой кликнуть ещё раз.
            window.showSnackbar?.('Расширение не отвечает. Кликните ещё раз — откроем в СЭД.', 'warn');
            STATE.bridgeReady = false;   // следующий клик пойдёт нативом
        } else if (res.error && res.error !== 'already-pending') {
            window.showSnackbar?.(`Ошибка скачивания: ${res.error}`, 'error');
        }
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

    // Файлы: показываем максимум 5 в превью. Клик по файлу — расширение
    // (если установлено) перехватит preventDefault'ом и скачает через
    // chrome.downloads, минуя pdf-viewer СЭД. Если расширения нет —
    // браузер штатно откроет URL в новой вкладке через target="_blank".
    const filesHtml = (item.files || []).slice(0, 5).map(f => {
        if (!f || !f.url) return '';
        return `
            <a class="sed-file" href="${_esc(f.url)}"
               target="_blank" rel="noopener noreferrer"
               data-sed-file-name="${_esc(f.name || '')}"
               title="Скачать (через расширение — минуя pdf-viewer СЭД)">
                ⬇ ${_esc(f.name || 'Файл')}
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
    // Закрытие — только через крестик, Esc, или явный клик на overlay.
    // mousedown/click внутри карточки НЕ должны пузыриться выше модалки —
    // иначе document-level click handlers (например dropdown auto-close)
    // могут закрыть что-нибудь ещё, и интерактив внутри модалки сломается.
    const card = modal.querySelector('.sed-letter-modal__card');
    card.addEventListener('mousedown', e => e.stopPropagation());
    card.addEventListener('click',     e => e.stopPropagation());
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


// Подписи к meta-полям из METAFIELDMAP в parser.js
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

// Поля, которые показываем чипами вверху (короткие, категориальные).
const META_CHIP_KEYS = ['status', 'priority', 'doc_type'];
// Порядок остальных полей в «деталях».
const META_DETAIL_ORDER = [
    'internal_no', 'signer', 'addressee', 'executor',
    'sheets_count', 'attachments_cnt', 'with_signature',
];

// Цветовая схема чипов: ключевые слова → CSS-класс.
function _chipClass(key, value) {
    const v = (value || '').toLowerCase();
    if (key === 'priority') {
        if (/срочн|оперативн/.test(v)) return 'sed-chip--danger';
        return 'sed-chip--info';
    }
    if (key === 'status') {
        if (/подпис|согласован|исполн|закры/.test(v)) return 'sed-chip--success';
        if (/отклон|отказ|возврат/.test(v))           return 'sed-chip--danger';
        if (/рассмотрен|подготов|доработ/.test(v))    return 'sed-chip--warn';
        return 'sed-chip--neutral';
    }
    return 'sed-chip--info';
}

// Иконка по расширению файла.
function _fileIcon(name) {
    const ext = String(name || '').toLowerCase().split('.').pop();
    if (['pdf'].includes(ext))                       return '📕';
    if (['doc','docx','rtf','odt'].includes(ext))    return '📄';
    if (['xls','xlsx','csv','ods'].includes(ext))    return '📊';
    if (['ppt','pptx','odp'].includes(ext))          return '📽';
    if (['jpg','jpeg','png','gif','bmp','tiff','webp'].includes(ext)) return '🖼';
    if (['zip','rar','7z','tar','gz'].includes(ext)) return '🗜';
    if (['mp3','wav','ogg','m4a'].includes(ext))     return '🎵';
    if (['mp4','avi','mov','mkv','webm'].includes(ext)) return '🎬';
    return '📎';
}


function _renderLetter(modal, letter) {
    const meta = letter.meta || {};

    // ─── Чипы (status, priority, doc_type) ───────────────────────────────
    const chipsHtml = META_CHIP_KEYS
        .filter(k => meta[k])
        .map(k => `
            <span class="sed-chip ${_chipClass(k, meta[k])}"
                  title="${_esc(META_LABELS[k])}">${_esc(meta[k])}</span>
        `).join('');

    // ─── Детали (двухколоночная сетка) ───────────────────────────────────
    const detailsRows = META_DETAIL_ORDER
        .filter(k => meta[k])
        .map(k => `
            <div class="sed-detail">
                <div class="sed-detail__label">${_esc(META_LABELS[k])}</div>
                <div class="sed-detail__value">${_esc(meta[k])}</div>
            </div>
        `).join('');

    // ─── Содержание (отдельным блоком, оно длинное) ──────────────────────
    const summaryHtml = meta.summary
        ? `<div class="sed-summary">
               <div class="sed-summary__label">${_esc(META_LABELS.summary)}</div>
               <div class="sed-summary__value">${_esc(meta.summary)}</div>
           </div>`
        : '';

    // ─── Файлы (карточки с иконкой) ──────────────────────────────────────
    const files = letter.files || [];
    const filesHtml = files.map(f => `
        <a class="sed-letter-file" href="${_esc(f.url)}"
           target="_blank" rel="noopener noreferrer"
           data-sed-file-name="${_esc(f.name || '')}"
           title="Скачать (через расширение — минуя pdf-viewer СЭД)">
            <span class="sed-letter-file__icon">${_fileIcon(f.name)}</span>
            <span class="sed-letter-file__name">${_esc(f.name || 'Файл')}</span>
            ${f.size ? `<span class="sed-letter-file__size">${_fmtSize(f.size)}</span>` : ''}
            <span class="sed-letter-file__dl">⬇</span>
        </a>
    `).join('');

    // ─── Тело: переписываем относительные URL'ы (страховка) ──────────────
    const bodyFixed = (letter.body_html || '')
        .replace(/(\s(?:src|href)=)"\/(?!\/)/gi, '$1"https://sed.mchs.ru/')
        .replace(/(\s(?:src|href)=)'\/(?!\/)/gi, "$1'https://sed.mchs.ru/");
    const bodyTrimmed = bodyFixed.trim();

    const fetchedTime = letter.fetched_at
        ? new Date(letter.fetched_at).toLocaleString('ru-RU')
        : '';

    // ─── Шапка модалки: title + ссылка на СЭД ────────────────────────────
    const headStrong = modal.querySelector('.sed-letter-modal__head strong');
    headStrong.innerHTML = `
        ${_esc(letter.title || `Письмо #${letter.node_id}`)}
        <a class="sed-letter-modal__sed-link"
           href="https://sed.mchs.ru/node/${letter.node_id}"
           target="_blank" rel="noopener noreferrer"
           title="Открыть оригинал в СЭД">↗</a>
    `;

    modal.querySelector('.sed-letter-modal__body').innerHTML = `
        ${chipsHtml ? `<div class="sed-chips">${chipsHtml}</div>` : ''}

        ${detailsRows ? `<div class="sed-details">${detailsRows}</div>` : ''}

        ${summaryHtml}

        ${filesHtml ? `
            <section class="sed-section">
                <h4 class="sed-section__h">📎 Файлы (${files.length})</h4>
                <div class="sed-letter-files">${filesHtml}</div>
            </section>` : ''}

        ${bodyTrimmed ? `
            <section class="sed-section">
                <h4 class="sed-section__h">📄 Текст документа</h4>
                <div class="sed-letter-body">${bodyTrimmed}</div>
            </section>` : ''}

        ${fetchedTime
            ? `<p class="sed-letter-modal__fetched">Загружено в pods2: ${fetchedTime}</p>`
            : ''}
    `;

    modal.querySelectorAll('.sed-letter-file').forEach(a => {
        a.onclick = (e) => _onFileLinkClick(e, a);
    });
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
