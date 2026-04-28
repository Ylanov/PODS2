// static/js/global_search.js
//
// Глобальный поиск (Ctrl+K) — оверлей со строкой поиска по людям общей
// базы. По выбору результата выводит карточку с информацией и кнопкой
// «Открыть в базе людей» (для admin) — переключается на вкладку Операции
// → База людей и фокусируется на найденном.
//
// MVP: только люди (через /persons/suggest). Расширения: события, графики
// нарядов — добавятся в этот же overlay.

import { api } from './api.js';

const OVERLAY_ID = 'global-search-overlay';

let _overlay = null;
let _input   = null;
let _results = null;
let _items   = [];
let _active  = -1;
let _timer   = null;
let _reqSeq  = 0;


export function initGlobalSearch() {
    // Хоткей: Ctrl+K (Cmd+K на macOS) открывает оверлей. Не перехватываем
    // когда уже открыт инпут с фокусом — даём пользователю печатать в нём.
    document.addEventListener('keydown', (e) => {
        const isCmd = e.ctrlKey || e.metaKey;
        if (isCmd && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openOverlay();
        }
    });
}


function openOverlay() {
    if (_overlay) {
        _input?.focus();
        _input?.select();
        return;
    }
    _overlay = document.createElement('div');
    _overlay.id = OVERLAY_ID;
    _overlay.className = 'gs-overlay';
    _overlay.innerHTML = `
        <div class="gs-dialog" role="dialog" aria-label="Глобальный поиск">
            <div class="gs-header">
                <input type="text" class="gs-input" placeholder="Поиск по ФИО…"
                       autocomplete="off" autocorrect="off" spellcheck="false">
                <kbd class="gs-kbd">Esc</kbd>
            </div>
            <div class="gs-results" role="listbox"></div>
            <div class="gs-footer">
                <span><kbd class="gs-kbd">↑↓</kbd> навигация</span>
                <span><kbd class="gs-kbd">Enter</kbd> открыть</span>
                <span><kbd class="gs-kbd">Esc</kbd> закрыть</span>
            </div>
        </div>
    `;
    document.body.appendChild(_overlay);

    _input   = _overlay.querySelector('.gs-input');
    _results = _overlay.querySelector('.gs-results');

    _input.addEventListener('input',   _onInput);
    _input.addEventListener('keydown', _onKeyDown);
    _overlay.addEventListener('click', (e) => {
        if (e.target === _overlay) closeOverlay();
    });

    _input.focus();
}


function closeOverlay() {
    if (!_overlay) return;
    _overlay.remove();
    _overlay = _input = _results = null;
    _items = [];
    _active = -1;
    clearTimeout(_timer);
}


function _onInput() {
    clearTimeout(_timer);
    _timer = setTimeout(_runSearch, 220);
}


async function _runSearch() {
    const q = _input.value.trim();
    if (q.length < 2) {
        _renderEmpty('Введите минимум 2 символа…');
        _items = [];
        _active = -1;
        return;
    }
    const mySeq = ++_reqSeq;
    try {
        const data = await api.get(`/persons/suggest?full_name=${encodeURIComponent(q)}&limit=10`);
        if (mySeq !== _reqSeq) return;   // устарел
        _items = Array.isArray(data) ? data : [];
        _active = _items.length ? 0 : -1;
        if (!_items.length) {
            _renderEmpty('Ничего не найдено.');
            return;
        }
        _results.innerHTML = _items.map((p, i) => `
            <div class="gs-item ${i === _active ? 'gs-item--active' : ''}"
                 data-idx="${i}" role="option">
                <div class="gs-item__main">
                    ${p.rank ? `<span class="gs-item__rank">${_esc(p.rank)}</span>` : ''}
                    <span class="gs-item__name">${_esc(p.full_name)}</span>
                </div>
                <div class="gs-item__meta">
                    ${p.department ? `<span>${_esc(p.department)}</span>` : '<span class="gs-item__muted">— нераспределён</span>'}
                    ${p.position_title ? `<span>· ${_esc(p.position_title)}</span>` : ''}
                </div>
            </div>
        `).join('');
        _results.querySelectorAll('.gs-item').forEach(el => {
            el.addEventListener('click', () => _select(parseInt(el.dataset.idx, 10)));
        });
    } catch (err) {
        if (mySeq !== _reqSeq) return;
        console.warn('[global_search] suggest failed:', err);
        _renderEmpty('Ошибка поиска.');
    }
}


function _renderEmpty(msg) {
    _results.innerHTML = `<div class="gs-empty">${_esc(msg)}</div>`;
}


function _onKeyDown(e) {
    if (e.key === 'Escape') {
        closeOverlay();
        return;
    }
    if (!_items.length) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _setActive((_active + 1) % _items.length);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _setActive(_active <= 0 ? _items.length - 1 : _active - 1);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_active >= 0) _select(_active);
    }
}


function _setActive(idx) {
    _active = idx;
    _results.querySelectorAll('.gs-item').forEach((el, i) => {
        el.classList.toggle('gs-item--active', i === idx);
        if (i === idx) el.scrollIntoView({ block: 'nearest' });
    });
}


function _select(idx) {
    const p = _items[idx];
    if (!p) return;
    closeOverlay();

    // Admin: открыть базу людей и подсветить найденного.
    // Не-admin: показать снэк со звания/ФИО — он не имеет вкладки база людей,
    // навигация ему не поможет.
    if (window.currentUser?.role === 'admin') {
        _openInPersonsBase(p);
    } else {
        const txt = `${p.rank ? p.rank + ' ' : ''}${p.full_name}`
                  + (p.department ? ` · ${p.department}` : '');
        window.showSnackbar?.(txt, 'info');
    }
}


function _openInPersonsBase(person) {
    // Переключаемся на вкладку «Операции» → «База людей» и фильтруем по ФИО.
    // Структура tab-нав в проекте: глобальные кнопки в .tab-bar, далее
    // подвкладки внутри #tab-operations. Переключаем вручную.
    const opsTab = document.querySelector('[data-tab="operations"], #operations-tab-btn');
    opsTab?.click();
    setTimeout(() => {
        const personsBtn = document.getElementById('btn-persons-base')
            || document.querySelector('[data-ops="persons"]');
        personsBtn?.click();
        setTimeout(() => {
            const search = document.getElementById('persons-search');
            if (search) {
                search.value = person.full_name;
                search.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, 100);
    }, 100);
}


function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
