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
export function attachPersonSearch({ inputId, emptyHint, onSelect }) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.__fioAc?.destroy();
    attachFio(input, {
        container: input.parentElement,
        emptyHint,
        onSelect,
    });
}


// Массовое снятие отпусков за указанный месяц. Один SQL DELETE на бэке
// вместо N toggle-запросов. apiPath — `/admin/schedules/{id}/marks` или
// `/dept/schedules/{id}/marks` в зависимости от роли вызывающего.
export async function clearVacations({ scheduleId, year, month, apiPath, isReadOnly, reload }) {
    if (!scheduleId) return;
    if (isReadOnly && isReadOnly()) {
        window.showSnackbar?.('График утверждён. Сначала разблокируйте.', 'error');
        return;
    }
    const mm = month.toString().padStart(2, '0');
    if (!confirm(`Снять все отпуска за ${mm}.${year}?`)) return;
    try {
        await api.delete(`${apiPath}?mark_type=V&year=${year}&month=${month}`);
        window.showSnackbar?.('Отпуска очищены', 'success');
        await reload();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}
