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

function _renderEmpty(box, hint, opts) {
    // Если включён inline-create (allowCreate) — добавляем зелёную кнопку
    // «+ Добавить в базу». Юзер видит её ровно тогда когда совпадений нет,
    // и одним кликом открывает мини-модалку. Создалось → автоматически
    // выбираем (как будто было предложение).
    const allowCreate = opts && opts.allowCreate;
    const createBtn   = allowCreate
        ? `<button type="button" class="fio-create-btn"
                   style="margin:6px 12px 8px; padding:8px 12px; background:var(--md-primary);
                          color:var(--md-on-primary); border:none; border-radius:6px;
                          cursor:pointer; font-size:0.85rem; width:calc(100% - 24px);">
               + Добавить в базу «${_esc(opts.currentQuery || '')}»
           </button>`
        : '';
    box.innerHTML = `
        <div class="fio-suggest-extra" style="padding:8px 12px; color:var(--md-on-surface-hint);">
            ${_esc(hint)}
        </div>
        ${createBtn}
    `;
    box.classList.remove('hidden');
}


/**
 * Открывает мини-модалку «Добавить нового человека в базу».
 * Поля: ФИО (предзаполнено), Звание, № документа, № загранпаспорта,
 * Кем выдан загран, Должность, Телефон.
 *
 * При успехе вызывает onCreated(person) — потребитель решает что с этим
 * делать (обычно: выбрать как будто из подсказок).
 */
function _openCreatePersonModal(prefilledName, onCreated) {
    if (document.getElementById('fio-create-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'fio-create-overlay';
    overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.45);
        display:flex; align-items:flex-start; justify-content:center;
        z-index:9999; padding:6vh 16px 16px; overflow-y:auto;
    `;
    overlay.innerHTML = `
        <div style="width:100%; max-width:560px; background:var(--md-surface);
                    border-radius:10px; box-shadow:0 20px 50px rgba(0,0,0,0.25);
                    overflow:hidden;">
            <div style="padding:14px 18px; border-bottom:1px solid var(--md-outline-variant);
                        display:flex; justify-content:space-between; align-items:center;
                        background:var(--md-surface-container);">
                <div style="font-weight:600; color:var(--md-on-surface);">
                    Новый человек в базу
                </div>
                <button id="fio-create-close" type="button" aria-label="Закрыть"
                        style="background:transparent; border:none; cursor:pointer;
                               font-size:1.1rem; color:var(--md-on-surface-hint);
                               width:28px; height:28px; border-radius:50%;">✕</button>
            </div>
            <div style="padding:14px 18px; display:flex; flex-direction:column; gap:10px;">
                <div style="font-size:0.82rem; color:var(--md-on-surface-hint);">
                    Этого человека нет в базе. Заполни данные — сохранится в общую
                    базу людей и подставится в текущую форму.
                </div>
                ${_createField('fc-name',     'ФИО',                prefilledName || '', 'Иванов Иван Иванович', true)}
                ${_createField('fc-rank',     'Звание',             '', 'подполковник',                          false)}
                ${_createField('fc-doc',      '№ документа',        '', 'АБ 123456',                             false)}
                <div style="display:flex; gap:10px;">
                    <div style="flex:1;">
                        ${_createField('fc-passport',    '№ загранпаспорта', '', '75 1234567',     false)}
                    </div>
                    <div style="flex:2;">
                        ${_createField('fc-passport-by', 'Кем выдан загран', '', 'МВД 77001',      false)}
                    </div>
                </div>
                <div style="font-size:0.7rem; color:var(--md-on-surface-hint); margin-top:-4px;">
                    Если загранника нет — оставь оба поля пустыми.
                </div>
                ${_createField('fc-pos',      'Должность',          '', 'Начальник отдела',                      false)}
                ${_createField('fc-phone',    'Телефон',            '', '+7 999 1234567',                        false)}
            </div>
            <div style="padding:12px 18px; border-top:1px solid var(--md-outline-variant);
                        display:flex; justify-content:flex-end; gap:10px;
                        background:var(--md-surface-container);">
                <button id="fio-create-cancel" type="button"
                        style="padding:8px 16px; background:var(--md-surface);
                               border:1px solid var(--md-outline-variant); border-radius:6px;
                               cursor:pointer; color:var(--md-on-surface);">Отмена</button>
                <button id="fio-create-save" type="button"
                        style="padding:8px 16px; background:var(--md-primary);
                               color:var(--md-on-primary); border:none; border-radius:6px;
                               cursor:pointer; font-weight:500;">Сохранить и подставить</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#fio-create-close').addEventListener('click', close);
    overlay.querySelector('#fio-create-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    setTimeout(() => document.getElementById('fc-name')?.focus(), 50);

    overlay.querySelector('#fio-create-save').addEventListener('click', async () => {
        const val = (id) => document.getElementById(id)?.value?.trim() || '';
        const name = val('fc-name');
        if (name.length < 2) {
            window.showSnackbar?.('ФИО обязательно (минимум 2 символа)', 'error');
            return;
        }
        const payload = {
            full_name:          name,
            rank:               val('fc-rank')        || null,
            doc_number:         val('fc-doc')         || null,
            passport_number:    val('fc-passport')    || null,
            passport_issued_by: val('fc-passport-by') || null,
            position_title:     val('fc-pos')         || null,
            phone:              val('fc-phone')      || null,
        };
        try {
            const created = await api.post('/persons', payload);
            window.showSnackbar?.(`Добавлен в базу: ${created.full_name}`, 'success');
            close();
            if (typeof onCreated === 'function') onCreated(created);
        } catch (err) {
            const msg = err?.message || String(err);
            if (msg.includes('403') || msg.toLowerCase().includes('доступ')) {
                window.showSnackbar?.('Нет прав на добавление в базу — обратитесь к админу.', 'error');
            } else {
                window.showSnackbar?.(`Не удалось добавить: ${msg}`, 'error');
            }
        }
    });
}


function _createField(id, label, value, placeholder, required) {
    return `
        <div style="display:flex; flex-direction:column; gap:3px;">
            <label for="${id}" style="font-size:0.78rem; color:var(--md-on-surface-hint);">
                ${_esc(label)}${required ? ' <span style="color:var(--md-error,#d33);">*</span>' : ''}
            </label>
            <input type="text" id="${id}" value="${_esc(value)}" placeholder="${_esc(placeholder)}"
                   style="padding:8px 10px; border:1px solid var(--md-outline-variant);
                          border-radius:6px; background:var(--md-surface); color:var(--md-on-surface);
                          font-size:0.9rem; outline:none;">
        </div>
    `;
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
        // allowCreate:true — в выдаче «не найдено» показывается кнопка
        // «+ Добавить в базу», открывающая мини-модалку POST /persons.
        // По умолчанию true — везде где FIO-автокомплит используется,
        // юзеру удобно сразу создать персону если её ещё нет.
        // Можно отключить точечно (например, в модалке global_replace
        // где смысл только «выбрать существующего»).
        allowCreate:      true,
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
                // Эмпти-стейт. Если allowCreate — показываем кнопку
                // «+ Добавить в базу», иначе либо подсказку, либо закрываем.
                if (opts.allowCreate || opts.emptyHint) {
                    _renderEmpty(box, opts.emptyHint || 'Не найдено в базе', {
                        allowCreate:  opts.allowCreate,
                        currentQuery: q,
                    });
                } else {
                    close();
                }
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
        // 1. Клик по кнопке «+ Добавить в базу» — открываем модалку.
        const createBtn = e.target.closest('.fio-create-btn');
        if (createBtn) {
            e.preventDefault();
            const prefilled = input.value.trim();
            _openCreatePersonModal(prefilled, (created) => {
                // После создания эмулируем выбор созданной персоны как
                // обычный suggestion — потребитель получит свой onSelect
                // и подставит все поля в форму.
                close();
                input.value = created.full_name;
                try {
                    opts.onSelect(created);
                } catch (err) {
                    console.error('[fio_autocomplete] onSelect threw on inline-create:', err);
                }
            });
            return;
        }
        // 2. Обычный клик по suggestion'у.
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
