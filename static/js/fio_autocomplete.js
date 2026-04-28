// static/js/fio_autocomplete.js
//
// FioAutocomplete — единый компонент подбора ФИО из общей базы.
//
// Зачем: в проекте 5+ мест с поиском ФИО (admin-редактор слотов,
// dept-редактор слотов, графики нарядов admin/dept, боевой расчёт,
// форма добавления в базу управления). Раньше каждый делал по-своему:
// часть ходила в /persons/search (LIKE), часть в /persons/suggest (fuzzy),
// выдача и UX отличались. Этот модуль — единственная точка истины:
//   • всегда /persons/suggest (fuzzy + score)
//   • одинаковый dropdown .fio-suggest-box с badge и extra
//   • при выборе отдаёт целиком объект Person (включая birth_date/phone)
//     — потребитель сам решает какие поля куда подставить.
//
// Использование:
//   import { attach as attachFio } from './fio_autocomplete.js';
//   const ac = attachFio(inputEl, {
//       onSelect(person) { ... },
//       getExtraParams() { return { rank: '...', doc_number: '...' }; },  // optional
//       container:    parentEl,            // optional, default input.parentElement
//       minLength:    2,                   // optional
//       debounceMs:   280,                 // optional
//       emptyHint:    'Не найдено',        // optional, null → не показывать
//       limit:        8,                   // optional
//   });
//   ac.destroy();   // когда input убирается
//
// Контейнер должен иметь position: relative (компонент выставит сам если static).

import { api } from './api.js';

const CLS_BOX    = 'fio-suggest-box';
const CLS_ITEM   = 'fio-suggest-item';
const CLS_ACTIVE = 'fio-suggest-item--active';

function _esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _ensurePositioned(el) {
    const cs = window.getComputedStyle(el);
    if (cs.position === 'static') {
        el.style.position = 'relative';
    }
}

function _renderItems(box, items) {
    box.innerHTML = items.map((p, idx) => {
        const dept = p.department
            ? `<span class="fio-dept">(${_esc(p.department)})</span>`
            : '<span class="fio-dept">(общий)</span>';
        const score = p.is_exact
            ? '<span class="fio-badge fio-badge-exact">уже в базе</span>'
            : `<span class="fio-badge fio-badge-score">${p.match_score}%</span>`;
        const extra = [p.rank, p.doc_number, p.position_title]
            .filter(Boolean).map(_esc).join(' · ');
        return `
            <div class="${CLS_ITEM}" data-idx="${idx}" role="option">
                <div class="fio-suggest-line">
                    <span class="fio-name">${_esc(p.full_name)}</span>
                    ${score}${dept}
                </div>
                ${extra ? `<div class="fio-suggest-extra">${extra}</div>` : ''}
            </div>
        `;
    }).join('');
    box.classList.remove('hidden');
}

function _renderEmpty(box, hint) {
    box.innerHTML = `
        <div class="fio-suggest-extra" style="padding:8px 12px; color:var(--md-on-surface-hint);">
            ${_esc(hint)}
        </div>
    `;
    box.classList.remove('hidden');
}

export function attach(input, options) {
    if (!input) return null;
    if (input.__fioAc) return input.__fioAc;

    const opts = Object.assign({
        onSelect:        () => {},
        getExtraParams:  null,
        container:       input.parentElement,
        minLength:       2,
        debounceMs:      280,
        emptyHint:       null,
        limit:           8,
        // keepOpenOnSelect:true — после выбора кандидата dropdown НЕ
        // закрывается, инпут очищается, фокус остаётся. Для multi-add:
        // выбрал → выбрал → выбрал, без переоткрытия формы.
        keepOpenOnSelect: false,
    }, options || {});

    const container = opts.container || input.parentElement;
    if (!container) return null;
    _ensurePositioned(container);

    // Отключаем нативный автофилл браузера (особенно Яндекс/Chromium):
    // они игнорируют autocomplete="off" и показывают свой dropdown
    // с сохранённой историей ввода, который перекрывает наш. Рандомный
    // name + нестандартное autocomplete="nope" ломает им паттерн ФИО.
    input.setAttribute('autocomplete', 'nope');
    input.setAttribute('autocorrect',  'off');
    input.setAttribute('autocapitalize','off');
    input.setAttribute('spellcheck',   'false');
    if (!input.hasAttribute('name')) {
        input.setAttribute('name', `fio-ac-${Math.random().toString(36).slice(2, 8)}`);
    }

    const box = document.createElement('div');
    box.className = CLS_BOX + ' hidden';
    box.setAttribute('role', 'listbox');
    container.appendChild(box);

    let timer   = null;
    let lastQ   = '';
    let items   = [];
    let active  = -1;
    let reqSeq  = 0;

    function setActive(idx) {
        active = idx;
        box.querySelectorAll('.' + CLS_ITEM).forEach((el, i) => {
            el.classList.toggle(CLS_ACTIVE, i === idx);
            if (i === idx) el.scrollIntoView({ block: 'nearest' });
        });
    }

    function close() {
        box.classList.add('hidden');
        box.innerHTML = '';
        items = [];
        active = -1;
    }

    async function runSearch() {
        const q = input.value.trim();
        lastQ = q;

        if (q.length < opts.minLength) {
            close();
            return;
        }

        const mySeq = ++reqSeq;
        const params = new URLSearchParams({ full_name: q, limit: String(opts.limit) });
        if (typeof opts.getExtraParams === 'function') {
            try {
                const extra = opts.getExtraParams() || {};
                if (extra.rank)       params.append('rank',       extra.rank);
                if (extra.doc_number) params.append('doc_number', extra.doc_number);
            } catch (_) { /* ignore */ }
        }

        try {
            const data = await api.get(`/persons/suggest?${params.toString()}`);
            if (mySeq !== reqSeq) return; // устарел
            items = Array.isArray(data) ? data : [];
            if (items.length === 0) {
                if (opts.emptyHint) _renderEmpty(box, opts.emptyHint);
                else close();
                return;
            }
            _renderItems(box, items);
            active = -1;
        } catch (err) {
            if (mySeq !== reqSeq) return;
            console.warn('[fio_autocomplete] suggest failed:', err);
            close();
        }
    }

    function onInput() {
        clearTimeout(timer);
        timer = setTimeout(runSearch, opts.debounceMs);
    }

    function onKeyDown(e) {
        if (box.classList.contains('hidden') || items.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((active + 1) % items.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive(active <= 0 ? items.length - 1 : active - 1);
        } else if (e.key === 'Enter') {
            if (active >= 0 && active < items.length) {
                e.preventDefault();
                choose(active);
            }
        } else if (e.key === 'Escape') {
            close();
        }
    }

    function choose(idx) {
        const person = items[idx];
        if (!person) return;
        try {
            opts.onSelect(person);
        } catch (err) {
            console.error('[fio_autocomplete] onSelect threw:', err);
        }
        if (opts.keepOpenOnSelect) {
            // Multi-add: чистим инпут, оставляем форму открытой и фокус.
            // Сам dropdown скрываем (очередной список построится при вводе).
            input.value = '';
            box.classList.add('hidden');
            box.innerHTML = '';
            items = [];
            active = -1;
            input.focus();
        } else {
            close();
        }
    }

    function onBoxClick(e) {
        const it = e.target.closest('.' + CLS_ITEM);
        if (!it) return;
        const idx = parseInt(it.dataset.idx, 10);
        if (!isNaN(idx)) choose(idx);
    }

    function onDocClick(e) {
        if (e.target === input) return;
        if (box.contains(e.target)) return;
        close();
    }

    function onFocus() {
        if (input.value.trim().length >= opts.minLength && items.length > 0) {
            box.classList.remove('hidden');
        }
    }

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('focus', onFocus);
    // preventDefault на mousedown — чтобы клик по dropdown не забирал focus у input
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', onBoxClick);
    document.addEventListener('click', onDocClick);

    const instance = {
        close,
        destroy() {
            input.removeEventListener('input', onInput);
            input.removeEventListener('keydown', onKeyDown);
            input.removeEventListener('focus', onFocus);
            document.removeEventListener('click', onDocClick);
            box.remove();
            delete input.__fioAc;
        },
        refresh: runSearch,
    };
    input.__fioAc = instance;
    return instance;
}

export function attachAll(root, selector, options) {
    const nodes = (root || document).querySelectorAll(selector);
    const list = [];
    nodes.forEach(n => { list.push(attach(n, options)); });
    return list;
}
