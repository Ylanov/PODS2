// static/js/global_replace.js
//
// Модалка «Глобальная замена человека».
//
// Сценарий: админу позвонили — «Иванов заболел, поставь сегодня везде
// Петрова». Раньше админ открывал каждый список, искал слот, менял руками.
// Здесь — одна модалка по кнопке 🔍 в шапке (admin only):
//   1) Найти кого ищем (ФИО через общий fio_autocomplete → person_id).
//   2) Выбрать период (сегодня / неделя / месяц / диапазон).
//   3) Получаем все слоты этого человека в этом окне (бэк фильтрует
//      по func.lower(Slot.full_name) и Event.is_template=False).
//      Чек-боксами выбираем какие реально менять (по умолчанию все).
//   4) Найти на кого меняем (тот же autocomplete → person_id).
//   5) Apply → POST /admin/global-search/replace → бэк делает batched
//      UPDATE c audit'ом + WS broadcast'ит каждый затронутый Event.
//
// Бэк: app/api/v1/routers/global_search.py
// Кнопка в HTML: #global-search-btn (видна только админу — auth.js)
// Контейнер модалки: #global-search-modal-root (см. index.html)

import { api } from './api.js';
import { attach as attachFio } from './fio_autocomplete.js';

const MOUNT_ID = 'global-search-modal-root';

// State модалки. Очищается при каждом открытии.
const _state = {
    searchPerson:      null,   // {id, full_name, rank, ...} — кого ищем
    replacementPerson: null,   // {id, full_name, rank, ...} — на кого меняем
    period:            'today',// 'today' | 'week' | 'month' | 'range'
    customFrom:        '',     // YYYY-MM-DD (когда period='range')
    customTo:          '',
    foundSlots:        [],     // SlotMatchOut[]
    selectedSlotIds:   new Set(),
    searchAc:          null,
    replaceAc:         null,
};


// ─── Public API ──────────────────────────────────────────────────────────────

export function initGlobalReplace() {
    // Делегируем клик, чтобы работало даже если кнопка скрыта/показана
    // динамически после логина (auth.js).
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('#global-search-btn');
        if (btn) {
            e.preventDefault();
            open();
        }
    });
}

/**
 * Показать кнопку в шапке если пользователь — админ.
 * Вызывается из auth.js admin-ветки.
 */
export function showGlobalReplaceButtonForAdmin(role) {
    const btn = document.getElementById('global-search-btn');
    if (!btn) return;
    if (role === 'admin') btn.classList.remove('hidden');
    else                  btn.classList.add('hidden');
}


// ─── Modal lifecycle ─────────────────────────────────────────────────────────

function open() {
    _resetState();
    _build();
    // Фокусируемся на первом инпуте — UX «начни печатать сразу».
    setTimeout(() => {
        document.getElementById('grpl-search-input')?.focus();
    }, 50);
}

function close() {
    // Снимаем автокомплиты перед удалением узлов, чтобы не остались
    // обработчики document.click.
    try { _state.searchAc?.destroy();  } catch (_) {}
    try { _state.replaceAc?.destroy(); } catch (_) {}
    const root = document.getElementById(MOUNT_ID);
    if (root) root.innerHTML = '';
    _resetState();
}

function _resetState() {
    _state.searchPerson      = null;
    _state.replacementPerson = null;
    _state.period            = 'today';
    _state.customFrom        = '';
    _state.customTo          = '';
    _state.foundSlots        = [];
    _state.selectedSlotIds   = new Set();
    _state.searchAc          = null;
    _state.replaceAc         = null;
}


function _build() {
    const root = document.getElementById(MOUNT_ID);
    if (!root) {
        console.error('[global_replace] mount root not found');
        return;
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const weekIso  = _addDaysIso(todayIso, 6);

    root.innerHTML = `
        <div class="grpl-overlay" role="dialog" aria-label="Глобальная замена человека">
            <div class="grpl-dialog">
                <div class="grpl-header">
                    <div class="grpl-title">
                        🔍 Глобальная замена человека в списках
                    </div>
                    <button class="grpl-close" type="button" aria-label="Закрыть">✕</button>
                </div>

                <div class="grpl-body">
                    <!-- Шаг 1: кого ищем -->
                    <div class="grpl-step">
                        <div class="grpl-step__title">1. Кого заменяем</div>
                        <div class="grpl-field grpl-field--ac">
                            <input id="grpl-search-input" type="text" class="grpl-input"
                                   placeholder="Начните печатать ФИО…">
                            <div id="grpl-search-chosen" class="grpl-chosen hidden"></div>
                        </div>
                    </div>

                    <!-- Шаг 2: период -->
                    <div class="grpl-step">
                        <div class="grpl-step__title">2. Период</div>
                        <div class="grpl-period">
                            <label><input type="radio" name="grpl-period" value="today" checked> Сегодня</label>
                            <label><input type="radio" name="grpl-period" value="week">  Неделя (7 дней)</label>
                            <label><input type="radio" name="grpl-period" value="month"> Месяц (30 дней)</label>
                            <label><input type="radio" name="grpl-period" value="range"> Диапазон</label>
                        </div>
                        <div id="grpl-range" class="grpl-range hidden">
                            <label>С <input type="date" id="grpl-from" value="${todayIso}"></label>
                            <label>По <input type="date" id="grpl-to"   value="${weekIso}"></label>
                        </div>
                        <button id="grpl-find-btn" class="grpl-btn grpl-btn--primary" type="button" disabled>
                            Найти слоты
                        </button>
                    </div>

                    <!-- Шаг 3: что нашли -->
                    <div class="grpl-step">
                        <div class="grpl-step__title">
                            3. Найденные слоты
                            <span id="grpl-found-count" class="grpl-count"></span>
                        </div>
                        <div id="grpl-results" class="grpl-results">
                            <div class="grpl-empty">Выберите человека и нажмите «Найти слоты».</div>
                        </div>
                    </div>

                    <!-- Шаг 4: на кого меняем -->
                    <div class="grpl-step">
                        <div class="grpl-step__title">4. На кого заменить</div>
                        <div class="grpl-field grpl-field--ac">
                            <input id="grpl-replace-input" type="text" class="grpl-input"
                                   placeholder="ФИО замены…">
                            <div id="grpl-replace-chosen" class="grpl-chosen hidden"></div>
                        </div>
                    </div>
                </div>

                <div class="grpl-footer">
                    <button id="grpl-cancel" class="grpl-btn" type="button">Отмена</button>
                    <button id="grpl-apply"  class="grpl-btn grpl-btn--primary" type="button" disabled>
                        Применить замену
                    </button>
                </div>
            </div>
        </div>
    `;

    // ─── Закрытие ─────────────────────────────────────────────────────────────
    root.querySelector('.grpl-overlay').addEventListener('click', (e) => {
        // Клик по фону (не по диалогу) — закрытие.
        if (e.target.classList.contains('grpl-overlay')) close();
    });
    root.querySelector('.grpl-close').addEventListener('click', close);
    root.querySelector('#grpl-cancel').addEventListener('click', close);
    document.addEventListener('keydown', _onEsc);

    // ─── Автокомплит «кого ищем» ──────────────────────────────────────────────
    const searchInput = root.querySelector('#grpl-search-input');
    _state.searchAc = attachFio(searchInput, {
        emptyHint: 'Не найдено в базе людей',
        onSelect: (person) => {
            _state.searchPerson = person;
            const chosen = root.querySelector('#grpl-search-chosen');
            chosen.classList.remove('hidden');
            chosen.innerHTML = `
                <span class="grpl-chosen__name">${_esc(person.full_name)}</span>
                ${person.rank ? `<span class="grpl-chosen__meta">${_esc(person.rank)}</span>` : ''}
                ${person.department ? `<span class="grpl-chosen__meta">· ${_esc(person.department)}</span>` : ''}
                <button class="grpl-chosen__clear" type="button" aria-label="Очистить">✕</button>
            `;
            chosen.querySelector('.grpl-chosen__clear').addEventListener('click', () => {
                _state.searchPerson = null;
                chosen.classList.add('hidden');
                chosen.innerHTML = '';
                searchInput.value = '';
                _state.foundSlots = [];
                _state.selectedSlotIds.clear();
                _renderResults();
                _updateButtons();
                searchInput.focus();
            });
            searchInput.value = person.full_name;
            _updateButtons();
        },
    });

    // ─── Period radios ────────────────────────────────────────────────────────
    root.querySelectorAll('input[name="grpl-period"]').forEach(r => {
        r.addEventListener('change', () => {
            _state.period = r.value;
            root.querySelector('#grpl-range').classList.toggle('hidden', r.value !== 'range');
        });
    });

    // ─── Find button ──────────────────────────────────────────────────────────
    root.querySelector('#grpl-find-btn').addEventListener('click', _findSlots);

    // ─── Автокомплит «на кого меняем» ─────────────────────────────────────────
    const replaceInput = root.querySelector('#grpl-replace-input');
    _state.replaceAc = attachFio(replaceInput, {
        emptyHint: 'Не найдено в базе людей',
        onSelect: (person) => {
            if (person.fired_at) {
                window.showSnackbar?.('Этот человек уволен — замена невозможна.', 'error');
                return;
            }
            _state.replacementPerson = person;
            const chosen = root.querySelector('#grpl-replace-chosen');
            chosen.classList.remove('hidden');
            chosen.innerHTML = `
                <span class="grpl-chosen__name">${_esc(person.full_name)}</span>
                ${person.rank ? `<span class="grpl-chosen__meta">${_esc(person.rank)}</span>` : ''}
                ${person.department ? `<span class="grpl-chosen__meta">· ${_esc(person.department)}</span>` : ''}
                <button class="grpl-chosen__clear" type="button" aria-label="Очистить">✕</button>
            `;
            chosen.querySelector('.grpl-chosen__clear').addEventListener('click', () => {
                _state.replacementPerson = null;
                chosen.classList.add('hidden');
                chosen.innerHTML = '';
                replaceInput.value = '';
                _updateButtons();
                replaceInput.focus();
            });
            replaceInput.value = person.full_name;
            _updateButtons();
        },
    });

    // ─── Apply ────────────────────────────────────────────────────────────────
    root.querySelector('#grpl-apply').addEventListener('click', _apply);

    _updateButtons();
}


function _onEsc(e) {
    if (e.key === 'Escape') {
        // Закрываем только если действительно открыта (и не fio-dropdown
        // — у того есть свой Escape-handler).
        if (document.querySelector('.grpl-overlay')) {
            close();
            document.removeEventListener('keydown', _onEsc);
        }
    }
}


// ─── Период → {date_from, date_to} ───────────────────────────────────────────

function _currentPeriod() {
    const today = new Date().toISOString().slice(0, 10);
    switch (_state.period) {
        case 'today': return { from: today, to: today };
        case 'week':  return { from: today, to: _addDaysIso(today, 6) };
        case 'month': return { from: today, to: _addDaysIso(today, 30) };
        case 'range': {
            const from = document.getElementById('grpl-from')?.value || today;
            const to   = document.getElementById('grpl-to')?.value   || today;
            return { from, to };
        }
        default: return { from: today, to: today };
    }
}

function _addDaysIso(iso, days) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}


// ─── Поиск слотов ────────────────────────────────────────────────────────────

async function _findSlots() {
    if (!_state.searchPerson) {
        window.showSnackbar?.('Выберите кого ищем.', 'error');
        return;
    }
    const { from, to } = _currentPeriod();
    if (from > to) {
        window.showSnackbar?.('Дата «с» позже даты «по».', 'error');
        return;
    }

    const btn = document.getElementById('grpl-find-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Ищем…';
    }

    try {
        const params = new URLSearchParams({
            person_id: String(_state.searchPerson.id),
            date_from: from,
            date_to:   to,
        });
        const slots = await api.get(`/admin/global-search/slots?${params.toString()}`);
        _state.foundSlots = Array.isArray(slots) ? slots : [];
        // По умолчанию все найденные отмечены — типовой сценарий «заменить везде».
        _state.selectedSlotIds = new Set(_state.foundSlots.map(s => s.slot_id));
        _renderResults();
        _updateButtons();
    } catch (err) {
        console.error('[global_replace] find failed:', err);
        window.showSnackbar?.(`Ошибка поиска: ${err.message || err}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Найти слоты';
        }
    }
}


function _renderResults() {
    const box   = document.getElementById('grpl-results');
    const count = document.getElementById('grpl-found-count');
    if (!box) return;

    const slots = _state.foundSlots;
    if (count) count.textContent = slots.length ? `(${slots.length})` : '';

    if (!_state.searchPerson) {
        box.innerHTML = '<div class="grpl-empty">Выберите человека и нажмите «Найти слоты».</div>';
        return;
    }
    if (!slots.length) {
        box.innerHTML = '<div class="grpl-empty">В этом периоде слотов с указанным ФИО не найдено.</div>';
        return;
    }

    // Header с «отметить все / снять все» + сами строки.
    box.innerHTML = `
        <div class="grpl-results__toolbar">
            <label class="grpl-all">
                <input type="checkbox" id="grpl-toggle-all" checked> Все
            </label>
            <span class="grpl-selected-count" id="grpl-selected-count">${slots.length} из ${slots.length}</span>
        </div>
        <div class="grpl-rows">
            ${slots.map(s => `
                <label class="grpl-row" data-sid="${s.slot_id}">
                    <input type="checkbox" class="grpl-row__cb" data-sid="${s.slot_id}" checked>
                    <span class="grpl-row__date">${_fmtDate(s.event_date)}</span>
                    <span class="grpl-row__event">${_esc(s.event_title || '—')}</span>
                    <span class="grpl-row__group">${_esc(s.group_name || '')}</span>
                    ${s.position_name ? `<span class="grpl-row__pos">${_esc(s.position_name)}</span>` : ''}
                    <span class="grpl-row__dept">${_esc(s.department || '')}</span>
                </label>
            `).join('')}
        </div>
    `;

    box.querySelector('#grpl-toggle-all').addEventListener('change', (e) => {
        const on = e.target.checked;
        box.querySelectorAll('.grpl-row__cb').forEach(cb => {
            cb.checked = on;
            const sid = parseInt(cb.dataset.sid, 10);
            if (on) _state.selectedSlotIds.add(sid);
            else    _state.selectedSlotIds.delete(sid);
        });
        _updateSelectedCount();
        _updateButtons();
    });

    box.querySelectorAll('.grpl-row__cb').forEach(cb => {
        cb.addEventListener('change', () => {
            const sid = parseInt(cb.dataset.sid, 10);
            if (cb.checked) _state.selectedSlotIds.add(sid);
            else            _state.selectedSlotIds.delete(sid);
            _updateSelectedCount();
            _updateButtons();
        });
    });
}


function _updateSelectedCount() {
    const total    = _state.foundSlots.length;
    const selected = _state.selectedSlotIds.size;
    const el = document.getElementById('grpl-selected-count');
    if (el) el.textContent = `${selected} из ${total}`;
    const toggleAll = document.getElementById('grpl-toggle-all');
    if (toggleAll) toggleAll.checked = (selected === total && total > 0);
}


function _updateButtons() {
    const findBtn  = document.getElementById('grpl-find-btn');
    const applyBtn = document.getElementById('grpl-apply');
    if (findBtn)  findBtn.disabled  = !_state.searchPerson;
    if (applyBtn) {
        applyBtn.disabled =
            !_state.replacementPerson ||
            _state.selectedSlotIds.size === 0;
    }
}


// ─── Apply ───────────────────────────────────────────────────────────────────

async function _apply() {
    if (!_state.replacementPerson || _state.selectedSlotIds.size === 0) return;

    const count = _state.selectedSlotIds.size;
    const who   = _state.searchPerson?.full_name || '?';
    const to    = _state.replacementPerson.full_name;
    if (!confirm(`Заменить «${who}» на «${to}» в ${count} слот(ах)?\nДействие можно откатить через журнал изменений.`)) {
        return;
    }

    const applyBtn = document.getElementById('grpl-apply');
    if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.textContent = 'Применяем…';
    }

    try {
        const res = await api.post('/admin/global-search/replace', {
            slot_ids:      Array.from(_state.selectedSlotIds),
            new_person_id: _state.replacementPerson.id,
        });
        const n = res?.replaced_count ?? 0;
        window.showSnackbar?.(`Заменено: ${n} слот(ов).`, 'success');
        close();
    } catch (err) {
        console.error('[global_replace] apply failed:', err);
        window.showSnackbar?.(`Ошибка замены: ${err.message || err}`, 'error');
        if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.textContent = 'Применить замену';
        }
    }
}


// ─── Утилиты ─────────────────────────────────────────────────────────────────

function _fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}`;
}

function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
