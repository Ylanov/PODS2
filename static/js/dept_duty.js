// static/js/dept_duty.js
/**
 * Графики наряда для управлений.
 * Аналог duty.js, но работает с /api/v1/dept/schedules
 * и показывает только графики текущего управления.
 */

import { api }         from './api.js';
import { attach as attachFio } from './fio_autocomplete.js';
import {
    MARK_DUTY, MARK_LEAVE, MARK_VACATION, MARK_LETTER, MARK_LABEL,
    getHolidaysMap, hoursForDate,
    groupMarks, computeSummary, extractVacationRanges,
} from './duty_calc.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ─── Состояние ────────────────────────────────────────────────────────────────

let _schedules   = [];
let _currentId   = null;
let _persons     = [];
let _marks       = [];   // массив {person_id, duty_date, mark_type}
let _positions   = [];
let _viewYear    = new Date().getFullYear();
let _viewMonth   = new Date().getMonth() + 1;
let _holidays    = new Map();
let _currentMode = MARK_DUTY;
let _vacationStart = null;
// Статус утверждения текущего (_currentId, _viewYear, _viewMonth):
//   null                                   — ещё не загружен
//   { status: 'draft',    approved_at:null, approved_by:null }
//   { status: 'approved', approved_at:iso,  approved_by:'upr_3' }
let _approval = null;

// Есть ли сейчас активный draft в этой вкладке — используется app.js
// для блокировки переключения вкладок управления. Экспортируется как
// window.__deptDutyHasDraft чтобы app.js не импортировал весь модуль.
function _publishDraftFlag() {
    window.__deptDutyHasDraft = (
        _currentId !== null && _approval !== null && _approval.status === 'draft'
    );
}

// ─── Инициализация ────────────────────────────────────────────────────────────

// Только привязка событий — без API-вызовов (безопасно до авторизации)
export function bindDeptDutyEvents() {
    _bindUI();
}

// Загрузка данных — только после авторизации
export async function loadDeptDutyData() {
    await _loadPositions();
    await loadDeptSchedules();
}

// Оставлено для обратной совместимости, если где-то вызывается
export function initDeptDuty() {
    _bindUI();
}

function _bindUI() {
    document.getElementById('dept-duty-add-schedule-btn')
        ?.addEventListener('click', _showCreateForm);
    document.getElementById('dept-duty-create-save')
        ?.addEventListener('click', _handleCreate);
    document.getElementById('dept-duty-create-cancel')
        ?.addEventListener('click', _hideCreateForm);
    document.getElementById('dept-duty-create-position')
        ?.addEventListener('change', _suggestTitle);

    document.getElementById('dept-duty-prev-month')
        ?.addEventListener('click', () => { _changeMonth(-1); });
    document.getElementById('dept-duty-next-month')
        ?.addEventListener('click', () => { _changeMonth(1); });
    document.getElementById('dept-duty-today-month')
        ?.addEventListener('click', () => {
            const now = new Date();
            _viewYear  = now.getFullYear();
            _viewMonth = now.getMonth() + 1;
            if (_currentId) _loadMarksAndRender();
        });

    document.getElementById('dept-duty-add-person-btn')
        ?.addEventListener('click', _showPersonSearch);

    _attachPersonSearch();

    document.getElementById('dept-duty-approve-btn')
        ?.addEventListener('click', _approveCurrentMonth);
    document.getElementById('dept-duty-unapprove-btn')
        ?.addEventListener('click', _unapproveCurrentMonth);
}

// ─── Должности (для формы создания) ──────────────────────────────────────────

async function _loadPositions() {
    try {
        // Роутер dept смонтирован с префиксом /api/v1/dept — полный путь /api/v1/dept/positions
        _positions = await api.get('/dept/positions');
    } catch {
        _positions = [];
    }
}

// ─── Форма создания ───────────────────────────────────────────────────────────

function _showCreateForm() {
    const sel = document.getElementById('dept-duty-create-position');
    if (sel) {
        sel.innerHTML = '<option value="">— без привязки к должности —</option>'
            + _positions.map(p =>
                `<option value="${p.id}" data-name="${esc(p.name)}">${esc(p.name)}</option>`
            ).join('');
    }
    const inp = document.getElementById('dept-duty-create-title');
    if (inp) inp.value = '';
    document.getElementById('dept-duty-create-form')?.classList.remove('hidden');
}

function _hideCreateForm() {
    document.getElementById('dept-duty-create-form')?.classList.add('hidden');
}

function _suggestTitle() {
    const sel  = document.getElementById('dept-duty-create-position');
    const inp  = document.getElementById('dept-duty-create-title');
    if (!sel || !inp) return;
    const name = sel.selectedOptions[0]?.dataset?.name || '';
    inp.value = name ? `График ${name.toLowerCase()}ов` : '';
}

async function _handleCreate() {
    const title  = document.getElementById('dept-duty-create-title')?.value.trim();
    const sel    = document.getElementById('dept-duty-create-position');
    const posId  = sel?.value ? parseInt(sel.value) : null;
    const posName = sel?.selectedOptions[0]?.dataset?.name || null;

    if (!title) { window.showSnackbar?.('Введите название графика', 'error'); return; }

    try {
        await api.post('/dept/schedules', {
            title,
            position_id:   posId,
            position_name: posName,
        });
        _hideCreateForm();
        window.showSnackbar?.('График создан', 'success');
        await loadDeptSchedules();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}

// ─── Список графиков ──────────────────────────────────────────────────────────

export async function loadDeptSchedules() {
    try {
        _schedules = await api.get('/dept/schedules');
    } catch {
        _schedules = [];
    }
    _renderScheduleList();
}

function _renderScheduleList() {
    const container = document.getElementById('dept-duty-schedules-list');
    if (!container) return;

    if (_schedules.length === 0) {
        container.innerHTML = '<p class="hint" style="padding:12px 0;">Нет графиков — создайте первый</p>';
        return;
    }

    container.innerHTML = _schedules.map(s => `
        <div class="duty-sched-item${s.id === _currentId ? ' duty-sched-item--active' : ''}"
             data-sched-id="${s.id}">
            <div class="duty-sched-item__title">${esc(s.title)}</div>
            ${s.position_name ? `<div class="duty-sched-item__sub">${esc(s.position_name)}</div>` : ''}
            <button class="duty-sched-item__del btn btn-danger btn-xs"
                    data-sched-id="${s.id}" type="button">✕</button>
        </div>
    `).join('');

    container.querySelectorAll('.duty-sched-item').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('.duty-sched-item__del')) return;
            _selectSchedule(parseInt(el.dataset.schedId));
        });
    });

    container.querySelectorAll('.duty-sched-item__del').forEach(btn => {
        btn.addEventListener('click', () => _deleteSchedule(parseInt(btn.dataset.schedId)));
    });
}

async function _selectSchedule(id) {
    _currentId = id;
    const now = new Date();
    _viewYear  = now.getFullYear();
    _viewMonth = now.getMonth() + 1;

    _renderScheduleList();
    document.getElementById('dept-duty-grid-empty')?.classList.add('hidden');
    document.getElementById('dept-duty-grid-container')?.classList.remove('hidden');

    await _loadPersonsAndMarks();
}

async function _deleteSchedule(id) {
    if (!confirm('Удалить этот график?')) return;
    try {
        await api.delete(`/dept/schedules/${id}`);
        if (_currentId === id) {
            _currentId = null;
            document.getElementById('dept-duty-grid-empty')?.classList.remove('hidden');
            document.getElementById('dept-duty-grid-container')?.classList.add('hidden');
        }
        await loadDeptSchedules();
    } catch (err) {
        window.showSnackbar?.(`Ошибка удаления: ${err?.message || err}`, 'error');
    }
}

// ─── Люди в графике ───────────────────────────────────────────────────────────

async function _loadPersonsAndMarks() {
    // ПОСЛЕДОВАТЕЛЬНО: сначала persons, потом marks+render.
    // Раньше было Promise.all: при первом заходе _renderGrid стартовал
    // с пустым _persons (persons грузились параллельно) и таблица
    // рисовалась без людей. Требовался F5 чтобы всё показалось.
    await _loadPersons();
    await _loadApproval();          // до рендера — чтобы UI сразу отразил режим
    await _loadMarksAndRender();
}

async function _loadApproval() {
    if (!_currentId) { _approval = null; _publishDraftFlag(); return; }
    try {
        _approval = await api.get(
            `/dept/schedules/${_currentId}/approval?year=${_viewYear}&month=${_viewMonth}`
        );
    } catch {
        _approval = { status: 'draft', approved_at: null, approved_by: null };
    }
    _publishDraftFlag();
}

function _isReadOnly() {
    return _approval && _approval.status === 'approved';
}

function _renderApprovalUI() {
    const badge       = document.getElementById('dept-duty-approval-badge');
    const approveBtn  = document.getElementById('dept-duty-approve-btn');
    const unapproveBtn= document.getElementById('dept-duty-unapprove-btn');
    const addPersonBtn= document.getElementById('dept-duty-add-person-btn');
    if (!badge) return;

    if (!_approval) {
        badge.style.display = 'none';
        if (approveBtn)   approveBtn.style.display   = 'none';
        if (unapproveBtn) unapproveBtn.style.display = 'none';
        return;
    }

    if (_approval.status === 'approved') {
        const when = _approval.approved_at
            ? new Date(_approval.approved_at).toLocaleDateString('ru-RU')
            : '';
        badge.textContent = `✓ Утверждён ${when}`;
        badge.style.display    = 'inline-block';
        badge.style.background = '#1D9E75';
        badge.style.color      = '#fff';
        if (approveBtn)   approveBtn.style.display   = 'none';
        if (unapproveBtn) unapproveBtn.style.display = 'inline-flex';
        if (addPersonBtn) addPersonBtn.style.display = 'none';
    } else {
        badge.textContent = '✎ Черновик';
        badge.style.display    = 'inline-block';
        badge.style.background = '#FFC107';
        badge.style.color      = '#5B4200';
        if (approveBtn)   approveBtn.style.display   = 'inline-flex';
        if (unapproveBtn) unapproveBtn.style.display = 'none';
        if (addPersonBtn) addPersonBtn.style.display = '';
    }
}

async function _approveCurrentMonth() {
    if (!_currentId) return;
    if (!confirm(
        'Утвердить график за этот месяц?\n\n' +
        'После утверждения будет зафиксирован текущий состав и все ' +
        'проставленные отметки. Изменить график можно будет через ' +
        'кнопку «✎ Редактировать» — это снимет утверждение.'
    )) return;
    try {
        _approval = await api.post(
            `/dept/schedules/${_currentId}/approval?year=${_viewYear}&month=${_viewMonth}`
        );
        _publishDraftFlag();
        _renderApprovalUI();
        _renderGrid();
        window.showSnackbar?.('График утверждён', 'success');
    } catch (err) {
        window.showSnackbar?.(`Ошибка утверждения: ${err?.message || err}`, 'error');
    }
}

async function _unapproveCurrentMonth() {
    if (!_currentId) return;
    if (!confirm(
        'Вернуть в режим редактирования?\n\n' +
        'Snapshot утверждённого месяца будет удалён. После изменений ' +
        'нажмите «📌 Утвердить» заново.'
    )) return;
    try {
        await api.delete(
            `/dept/schedules/${_currentId}/approval?year=${_viewYear}&month=${_viewMonth}`
        );
        _approval = { status: 'draft', approved_at: null, approved_by: null };
        _publishDraftFlag();
        _renderApprovalUI();
        _renderGrid();
        window.showSnackbar?.('Вы в режиме редактирования', 'info');
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}

async function _loadPersons() {
    if (!_currentId) return;
    try {
        _persons = await api.get(`/dept/schedules/${_currentId}/persons`);
    } catch {
        _persons = [];
    }
}

// Вынесено отдельной функцией: вызываем и при инициализации UI, и каждый
// раз при показе формы поиска. Если DOM-нода input'а где-то пересоздавалась
// (например, при перерисовке графика), листенеры теряются вместе со старым
// элементом — destroy+attach гарантирует, что подсказки будут работать.
function _attachPersonSearch() {
    const input = document.getElementById('dept-duty-person-search-input');
    if (!input) return;
    input.__fioAc?.destroy();
    attachFio(input, {
        container: input.parentElement, // .duty-person-search wrap
        emptyHint: 'Не найдено в базе управления',
        onSelect: (person) => {
            _addPerson(person.id);
        },
    });
}

function _showPersonSearch() {
    const wrap  = document.getElementById('dept-duty-person-search-wrap');
    const input = document.getElementById('dept-duty-person-search-input');
    wrap?.classList.remove('hidden');
    if (input) input.value = '';
    _attachPersonSearch();
    input?.focus();
}

async function _addPerson(personId) {
    if (!_currentId) return;
    if (_isReadOnly()) {
        window.showSnackbar?.('График утверждён. Нажмите «✎ Редактировать» чтобы изменить.', 'error');
        return;
    }
    try {
        await api.post(`/dept/schedules/${_currentId}/persons`, { person_id: personId });
        window.showSnackbar?.('Человек добавлен в график', 'success');
        const input = document.getElementById('dept-duty-person-search-input');
        if (input) input.value = '';
        document.getElementById('dept-duty-person-search-wrap')?.classList.add('hidden');
        await _loadPersonsAndMarks();
    } catch (err) {
        const msg = err?.status === 409 ? 'Уже в графике' : `Ошибка: ${err?.message || err}`;
        window.showSnackbar?.(msg, 'error');
    }
}

async function _removePerson(personId) {
    if (!_currentId) return;
    try {
        await api.delete(`/dept/schedules/${_currentId}/persons/${personId}`);
        await _loadPersonsAndMarks();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}

// ─── Сетка (marks) ───────────────────────────────────────────────────────────

function _changeMonth(delta) {
    _viewMonth += delta;
    if (_viewMonth > 12) { _viewMonth = 1; _viewYear++; }
    if (_viewMonth < 1)  { _viewMonth = 12; _viewYear--; }
    if (_currentId) _loadApprovalAndRender();
}

async function _loadApprovalAndRender() {
    await _loadApproval();
    await _loadMarksAndRender();
}

async function _loadMarksAndRender() {
    if (!_currentId) return;
    try {
        const [raw, holidays] = await Promise.all([
            api.get(`/dept/schedules/${_currentId}/marks?year=${_viewYear}&month=${_viewMonth}`),
            getHolidaysMap(_viewYear),
        ]);
        _marks    = raw || [];
        _holidays = holidays;
    } catch {
        _marks = [];
        _holidays = new Map();
    }
    _renderGrid();
}

function _renderGrid() {
    const label = document.getElementById('dept-duty-month-label');
    const table = document.getElementById('dept-duty-grid-table');
    if (!label || !table) return;

    _renderApprovalUI();
    _renderModeSwitcher();
    const readOnly = _isReadOnly();
    // Режим-переключатель N/U/V нужен только для редактирования
    const modeGroup = document.querySelector('#dept-duty-grid-container .duty-mode-group');
    if (modeGroup) modeGroup.style.display = readOnly ? 'none' : '';

    const monthNames = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                        'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    label.textContent = `${monthNames[_viewMonth - 1]} ${_viewYear}`;

    const daysInMonth = new Date(_viewYear, _viewMonth, 0).getDate();
    const today = new Date().toISOString().slice(0, 10);
    const monthDays = Array.from({ length: daysInMonth }, (_, i) => {
        const d = String(i + 1).padStart(2, '0');
        const m = String(_viewMonth).padStart(2, '0');
        return `${_viewYear}-${m}-${d}`;
    });

    const DAY_ABBR = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const marksByPerson = groupMarks(_marks);

    // Заголовок
    const thead = `<thead><tr>
        <th class="duty-grid__name-hdr" style="min-width:180px; text-align:left;">Сотрудник</th>
        ${monthDays.map(iso => {
            const day = parseInt(iso.slice(8));
            const dow = new Date(iso + 'T00:00:00').getDay();
            const isWk = dow === 0 || dow === 6;
            const holi = _holidays.get(iso);
            const isToday = iso === today;
            const cls = [
                isWk    ? 'duty-col--weekend' : '',
                holi    ? 'duty-col--holiday' : '',
                isToday ? 'duty-grid__day-hdr--today' : '',
            ].filter(Boolean).join(' ');
            const ttl = holi ? `${DAY_ABBR[dow]} — ${esc(holi.title)}` : DAY_ABBR[dow];
            return `<th class="${cls}" title="${ttl}" style="min-width:32px; text-align:center; padding:4px 2px; font-size:0.72rem;">
                ${day}<span class="duty-dow">${DAY_ABBR[dow]}</span>
            </th>`;
        }).join('')}
        <th class="duty-summary-th" title="Кол-во нарядов">Н</th>
        <th class="duty-summary-th" title="Часы переработки">Часы</th>
        <th class="duty-summary-th" title="Увольнения/Отпуск">У/О</th>
        <th style="width:32px;"></th>
    </tr></thead>`;

    // Строки
    const tbody = `<tbody>${_persons.map(p => {
        const personMarks = marksByPerson.get(p.person_id) || new Map();
        const vacRanges   = extractVacationRanges(personMarks, monthDays);
        const vacMap = new Map();
        for (const r of vacRanges) {
            const s = monthDays.indexOf(r.start_iso);
            const e = monthDays.indexOf(r.end_iso);
            for (let i = s; i <= e; i++) {
                vacMap.set(monthDays[i], { isFirst: i === s, length: r.days });
            }
        }

        const cells = monthDays.map(iso => {
            const dow = new Date(iso + 'T00:00:00').getDay();
            const isWk = dow === 0 || dow === 6;
            const holi = _holidays.get(iso);
            const isToday = iso === today;
            const mark = personMarks.get(iso);
            const vac  = vacMap.get(iso);
            const cls = [
                'duty-grid__cell',
                isWk ? 'duty-col--weekend' : '',
                holi ? 'duty-col--holiday' : '',
                isToday ? 'duty-grid__cell--today' : '',
                vac  ? 'duty-cell--in-vacation' : '',
            ].filter(Boolean).join(' ');

            let inner = '';
            if (vac) {
                if (vac.isFirst) {
                    inner = `<div class="duty-vacation-bar"
                                  style="width: calc(${vac.length * 100}% + ${vac.length - 1}px);"
                                  title="Отпуск: ${vac.length} дн.">ОТПУСК</div>`;
                }
            } else if (mark) {
                inner = `<span class="duty-mark duty-mark--${mark.mark_type}"
                               title="${MARK_LABEL[mark.mark_type] || ''}">${MARK_LETTER[mark.mark_type] || ''}</span>`;
            }

            return `<td class="${cls}" data-date="${iso}" data-pid="${p.person_id}"
                        style="text-align:center; padding:2px; position:relative;">
                ${inner}
            </td>`;
        }).join('');

        const sum = computeSummary(personMarks, _holidays);

        return `<tr>
            <td class="duty-name-td" style="font-size:0.82rem; padding:4px 8px; white-space:nowrap;">
                ${esc(p.full_name)}
                ${p.rank ? `<span style="color:var(--md-on-surface-hint); font-size:0.7rem;"> ${esc(p.rank)}</span>` : ''}
            </td>
            ${cells}
            <td class="duty-summary-td"><span class="duty-summary-td__num duty-summary-td__num--duty">${sum.duty}</span></td>
            <td class="duty-summary-td"><span class="duty-summary-td__num duty-summary-td__num--hours">${sum.overtime}</span></td>
            <td class="duty-summary-td"><span class="duty-summary-td__num">${sum.leave}/${sum.vacation}</span></td>
            <td style="text-align:center;">
                ${readOnly ? '' :
                    `<button class="btn btn-danger btn-xs dept-duty-remove-person"
                             data-pid="${p.person_id}" type="button" title="Убрать из графика">✕</button>`}
            </td>
        </tr>`;
    }).join('')}
    ${_persons.length === 0 ? `<tr><td colspan="${daysInMonth + 5}" style="padding:24px; text-align:center; color:var(--md-on-surface-hint); font-size:0.85rem;">
        Добавьте сотрудников через кнопку «+ Добавить человека»
    </td></tr>` : ''}
    </tbody>`;

    table.innerHTML = thead + tbody;
    table.className = 'duty-grid';

    if (!readOnly) {
        table.querySelectorAll('.duty-grid__cell').forEach(cell => {
            cell.addEventListener('click', () => {
                _onCellClick(cell.dataset.date, parseInt(cell.dataset.pid), cell);
            });
        });
    }
    table.querySelectorAll('.dept-duty-remove-person').forEach(btn => {
        btn.addEventListener('click', () => _removePerson(parseInt(btn.dataset.pid)));
    });
}

function _renderModeSwitcher() {
    const toolbar = document.querySelector('#dept-duty-grid-container .duty-grid-toolbar');
    if (!toolbar) return;
    if (toolbar.querySelector('.duty-mode-group')) return;
    const group = document.createElement('div');
    group.className = 'duty-mode-group';
    group.innerHTML = `
        <button class="duty-mode-btn ${_currentMode === MARK_DUTY     ? 'active' : ''}" data-mark="N" type="button">
            <span class="duty-mode-btn__letter" data-letter="Н"></span>Наряд
        </button>
        <button class="duty-mode-btn ${_currentMode === MARK_LEAVE    ? 'active' : ''}" data-mark="U" type="button">
            <span class="duty-mode-btn__letter" data-letter="У"></span>Увольнение
        </button>
        <button class="duty-mode-btn ${_currentMode === MARK_VACATION ? 'active' : ''}" data-mark="V" type="button">
            <span class="duty-mode-btn__letter" data-letter="О"></span>Отпуск
        </button>
    `;
    group.addEventListener('click', (e) => {
        const b = e.target.closest('[data-mark]');
        if (!b) return;
        _currentMode   = b.dataset.mark;
        _vacationStart = null;
        group.querySelectorAll('.duty-mode-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        if (_currentMode === MARK_VACATION) {
            window.showSnackbar?.('Режим «Отпуск»: кликните первую и последнюю дату диапазона', 'info');
        }
    });
    toolbar.insertBefore(group, toolbar.firstChild);
}

async function _onCellClick(date, personId, cellEl) {
    if (_currentMode === MARK_VACATION) {
        if (_vacationStart && _vacationStart.personId === personId) {
            const startDate = _vacationStart.date <= date ? _vacationStart.date : date;
            const endDate   = _vacationStart.date <= date ? date : _vacationStart.date;
            _vacationStart = null;
            await _applyVacationRange(personId, startDate, endDate);
            return;
        }
        _vacationStart = { personId, date };
        cellEl.style.outline = '2px dashed #059669';
        window.showSnackbar?.(`Начало: ${date}. Кликните на конец диапазона.`, 'info');
        return;
    }
    await _toggleMark(date, personId, _currentMode);
}

async function _applyVacationRange(personId, startIso, endIso) {
    const s = new Date(startIso + 'T00:00:00');
    const e = new Date(endIso   + 'T00:00:00');
    const ops = [];
    const cur = new Date(s);
    while (cur <= e) {
        const iso = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
        const existing = _marks.find(m => m.person_id === personId && m.duty_date === iso);
        if (!existing || existing.mark_type !== MARK_VACATION) ops.push(iso);
        cur.setDate(cur.getDate() + 1);
    }
    try {
        for (const iso of ops) {
            await api.post(`/dept/schedules/${_currentId}/marks`, {
                person_id: personId, duty_date: iso, mark_type: MARK_VACATION,
            });
        }
        await _loadMarksAndRender();
        window.showSnackbar?.(`Отпуск поставлен (${ops.length} дн.)`, 'success');
    } catch (err) {
        window.showSnackbar?.('Ошибка постановки отпуска', 'error');
        await _loadMarksAndRender();
    }
}

async function _toggleMark(date, personId, markType = MARK_DUTY) {
    if (!_currentId) return;
    // Защита: нельзя ставить наряд на день отпуска. Сначала снять отпуск.
    if (markType === MARK_DUTY) {
        const existing = _marks.find(
            m => m.person_id === personId && m.duty_date === date
        );
        if (existing && existing.mark_type === MARK_VACATION) {
            window.showSnackbar?.(
                'На день отпуска нельзя ставить наряд. Сначала снимите отпуск.',
                'error',
            );
            return;
        }
    }
    try {
        const result = await api.post(`/dept/schedules/${_currentId}/marks`, {
            person_id: personId,
            duty_date: date,
            mark_type: markType,
        });
        // Обновляем локальный массив
        if (result.action === 'removed') {
            _marks = _marks.filter(m => !(m.person_id === personId && m.duty_date === date));
        } else if (result.action === 'changed') {
            const idx = _marks.findIndex(m => m.person_id === personId && m.duty_date === date);
            if (idx !== -1) _marks[idx].mark_type = result.mark_type || markType;
        } else {
            _marks.push({ person_id: personId, duty_date: date, mark_type: result.mark_type || markType });
        }
        if (result.filled_slots_count > 0) {
            window.showSnackbar?.(
                `Автозаполнено ${result.filled_slots_count} слот(ов)`, 'success');
        }
        _renderGrid();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}