// static/js/duty_ui.js
//
// Общие UI-утилиты для двух графиков наряда — admin (duty.js) и
// dept (dept_duty.js). Раньше в обоих модулях лежали идентичные
// реализации `_renderSummaryBlock`, `_attachPersonSearch`,
// `_clearVacations` — отличались только префиксами id и API-путями.
// Здесь они параметризованы.

import { api }                 from './api.js';
import { attach as attachFio } from './fio_autocomplete.js';
import { computeSummary }      from './duty_calc.js';

function _esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}


// POST на endpoint /marks с автоматической обработкой 409 от валидатора
// интервала (см. app/core/duty_validation.py):
//   • code: duty_too_close_strict → показать ошибку, не повторять.
//   • code: duty_too_close_warn   → confirm у пользователя; если «да» —
//     повторить запрос с force=true. Возвращает null если отказался.
// Все остальные ошибки пробрасываются дальше.
export async function postDutyMark(apiPath, body) {
    try {
        return await api.post(apiPath, body);
    } catch (err) {
        const detail = err?.detail;
        if (err?.status === 409 && detail && typeof detail === 'object') {
            if (detail.code === 'duty_too_close_strict') {
                window.showSnackbar?.(detail.message, 'error');
                return null;
            }
            if (detail.code === 'duty_too_close_warn') {
                if (!confirm(detail.message)) return null;
                return await api.post(apiPath, { ...body, force: true });
            }
        }
        throw err;
    }
}


// Заполняет шаблон шапки печати (#duty-print-cover / #dept-duty-print-cover):
// название графика, месяц/год для подзаголовка и для строки УТВЕРЖДАЮ.
// Вся вёрстка лежит в index.html, JS только подставляет данные.
const _MONTHS_RU = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль',   'Август',  'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

// Кэш настроек печати — один запрос на сессию. Админ может менять текст
// УТВЕРЖДАЮ/подписи через PATCH /settings; для подхвата изменений
// достаточно перезагрузить страницу (Ctrl+Shift+R).
let _settingsCache   = null;
let _settingsPromise = null;

async function _loadSettings() {
    if (_settingsCache) return _settingsCache;
    if (_settingsPromise) return _settingsPromise;
    _settingsPromise = api.get('/settings').then(s => {
        _settingsCache = s || {};
        return _settingsCache;
    }).catch(err => {
        console.warn('[duty_ui] settings load failed:', err);
        _settingsCache = {};
        return _settingsCache;
    });
    return _settingsPromise;
}

// Сбросить кэш — вызывать после успешного PATCH /settings, чтобы
// следующий рендер графика подхватил новые тексты УТВЕРЖДАЮ/подписи.
export function invalidatePrintSettingsCache() {
    _settingsCache = null;
    _settingsPromise = null;
}

function _setText(root, selector, value) {
    root.querySelectorAll(selector).forEach(el => { el.textContent = value || ''; });
}

export async function updatePrintCover(coverId, scheduleTitle, year, month) {
    const cover = document.getElementById(coverId);
    if (!cover) return;
    const monthName = _MONTHS_RU[month - 1] || '';
    const mm = String(month).padStart(2, '0');
    const s = await _loadSettings();

    _setText(cover, '.duty-print-cover__schedule-title', scheduleTitle);
    _setText(cover, '.duty-print-cover__full-month',     `${monthName} ${year}`);
    _setText(cover, '.duty-print-cover__month-year',     `${mm}.${year}`);
    _setText(cover, '.duty-print-cover__approve-pos',    s.print_approve_position);
    _setText(cover, '.duty-print-cover__approve-rank',   s.print_approve_rank);

    // approve-name — со склейкой даты + ФИО, поэтому собираем вручную.
    const dateText = `«____» ${mm}.${year} г.`;
    const nameText = s.print_approve_name || '';
    cover.querySelectorAll('.duty-print-cover__approve-name').forEach(el => {
        el.textContent = `${dateText}    ${nameText}`.trim();
    });

    // Подвал лежит как sibling — ищем рядом, не внутри cover.
    const wrap = cover.parentElement;
    if (wrap) {
        _setText(wrap, '.duty-print-cover__footer-pos',  s.print_footer_position);
        _setText(wrap, '.duty-print-cover__footer-rank', s.print_footer_rank);
        const footName = s.print_footer_name ? `_____________ ${s.print_footer_name}` : '';
        _setText(wrap, '.duty-print-cover__footer-name', footName);
    }
}


// Сводка по людям под графиком: chip'ы Н/Часы/У/О/Р для каждого ФИО.
// Вынесено из основной таблицы, чтобы дни занимали всю ширину окна.
export function renderSummaryBlock(blockId, sortedPersons, marksByPerson, holidaysMap) {
    const block = document.getElementById(blockId);
    if (!block) return;
    if (!sortedPersons.length) {
        block.innerHTML = '';
        return;
    }
    const rows = sortedPersons.map(p => {
        const personMarks = marksByPerson.get(p.person_id) || new Map();
        const sum = computeSummary(personMarks, holidaysMap);
        const rank = p.rank
            ? `<span class="duty-summary-card__rank">${_esc(p.rank)}</span>`
            : '';
        return `
            <div class="duty-summary-card">
                <div class="duty-summary-card__name">
                    ${rank}<span>${_esc(p.full_name)}</span>
                </div>
                <span class="duty-summary-card__chip duty-summary-card__chip--duty"  title="Нарядов">Н: ${sum.duty}</span>
                <span class="duty-summary-card__chip duty-summary-card__chip--hours" title="Часов переработки">Часы: ${sum.overtime}</span>
                <span class="duty-summary-card__chip" title="Увольнений / дней отпуска">У/О: ${sum.leave}/${sum.vacation}</span>
                <span class="duty-summary-card__chip duty-summary-card__chip--reserve" title="Резервов">Р: ${sum.reserve}</span>
            </div>
        `;
    }).join('');
    block.innerHTML = `
        <div class="duty-grid-summary__title">Сводка за месяц</div>
        ${rows}
    `;
}


// Подключаем автокомплит ФИО к input'у поиска. destroy+attach защищает
// от случая, когда DOM-нода input'а пересоздаётся при перерисовке графика —
// старые listener'ы теряются вместе с прежним элементом.
//
// keepOpenOnSelect:true — режим multi-add: после выбора форма поиска
// остаётся открытой, инпут очищается, фокус сохраняется. Удобно когда
// надо добавить N людей подряд (типичный сценарий создания нового графика).
export function attachPersonSearch({ inputId, emptyHint, onSelect, keepOpenOnSelect = false }) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.__fioAc?.destroy();
    attachFio(input, {
        container: input.parentElement,
        emptyHint,
        onSelect,
        keepOpenOnSelect,
    });
}


// Переключатель режимов «Наряд / Резерв / Увольнение / Отпуск» в toolbar'е
// графика. State (_currentMode/_vacationStart) остаётся в caller'е — сюда
// приходит начальный режим и callback `onModeChange(newMode)`, который
// caller вызывает, чтобы обновить свои переменные и реагировать (сбросить
// vacationStart, показать подсказку).
export function renderModeSwitcher({ toolbarSelector, currentMode, onModeChange }) {
    const toolbar = document.querySelector(toolbarSelector);
    if (!toolbar) return;
    if (toolbar.querySelector('.duty-mode-group')) return;   // уже отрисован

    const cls = (mark) => `duty-mode-btn ${currentMode === mark ? 'active' : ''}`;
    const group = document.createElement('div');
    group.className = 'duty-mode-group';
    group.innerHTML = `
        <button class="${cls('N')}" data-mark="N" type="button" title="Наряд">
            <span class="duty-mode-btn__letter" data-letter="Н"></span>Наряд
        </button>
        <button class="${cls('R')}" data-mark="R" type="button" title="Резерв">
            <span class="duty-mode-btn__letter" data-letter="РЗ"></span>Резерв
        </button>
        <button class="${cls('U')}" data-mark="U" type="button" title="Увольнение">
            <span class="duty-mode-btn__letter" data-letter="У"></span>Увольнение
        </button>
        <button class="${cls('V')}" data-mark="V" type="button" title="Отпуск — кликните по первой дате, затем по последней">
            <span class="duty-mode-btn__letter" data-letter="О"></span>Отпуск
        </button>
    `;
    group.addEventListener('click', (e) => {
        const b = e.target.closest('[data-mark]');
        if (!b) return;
        group.querySelectorAll('.duty-mode-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        onModeChange(b.dataset.mark);
    });
    toolbar.insertBefore(group, toolbar.firstChild);
}


// Добавить человека в график. По умолчанию закрывает форму поиска и
// показывает snackbar. apiPath отличается у admin/dept; isReadOnly
// опционален (admin не блокирует утверждённый график на этом шаге).
//
// keepFormOpen:true — multi-add: после успешного добавления форма НЕ
// закрывается (только инпут очищается), и пользователь может выбрать
// следующего человека.
export async function addPersonToSchedule({
    personId, scheduleId, apiPath,
    inputId, wrapId,
    reload, isReadOnly,
    keepFormOpen = false,
}) {
    if (!scheduleId) return;
    if (isReadOnly && isReadOnly()) {
        window.showSnackbar?.('График утверждён. Нажмите «✎ Редактировать» чтобы изменить.', 'error');
        return;
    }
    try {
        await api.post(apiPath, { person_id: personId });
        const input = document.getElementById(inputId);
        if (input) input.value = '';
        if (!keepFormOpen) {
            document.getElementById(wrapId)?.classList.add('hidden');
        }
        await reload();
        window.showSnackbar?.('Человек добавлен в график', 'success');
    } catch (err) {
        if (err?.status === 409) {
            window.showSnackbar?.('Этот человек уже в графике', 'error');
        } else {
            console.error('[duty_ui] addPersonToSchedule error:', err);
            window.showSnackbar?.(`Ошибка: ${err?.message || err?.status || err}`, 'error');
        }
    }
}


// Массовое снятие отметок одного типа за месяц. Один SQL DELETE на бэке
// вместо N toggle-запросов. markType: 'N' | 'R' | 'U' | 'V'.
const _MARK_LABEL_GENITIVE = {
    N: 'наряды',
    R: 'резервы',
    U: 'увольнения',
    V: 'отпуска',
};

export async function clearMarks({ scheduleId, markType, year, month, apiPath, isReadOnly, reload }) {
    if (!scheduleId) return;
    if (isReadOnly && isReadOnly()) {
        window.showSnackbar?.('График утверждён. Сначала разблокируйте.', 'error');
        return;
    }
    const label = _MARK_LABEL_GENITIVE[markType] || 'отметки';
    const mm = String(month).padStart(2, '0');
    if (!confirm(`Снять все ${label} за ${mm}.${year}?`)) return;
    try {
        await api.delete(`${apiPath}?mark_type=${markType}&year=${year}&month=${month}`);
        window.showSnackbar?.(`${label[0].toUpperCase() + label.slice(1)} очищены`, 'success');
        await reload();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}
