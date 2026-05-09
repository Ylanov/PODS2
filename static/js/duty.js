// static/js/duty.js
/**
 * Редактор графиков наряда.
 */

import { api } from './api.js';
import {
    MARK_DUTY, MARK_LEAVE, MARK_VACATION, MARK_RESERVE,
    MARK_TRIP, MARK_HOSPITAL, ABSENT_MARK_TYPES,
    MARK_LETTER, MARK_LABEL,
    getHolidaysMap, hoursForDate, isWeekendOrHoliday,
    groupMarks, computeSummary, extractVacationRanges,
    sortByRank, computeDutyZones,
} from './duty_calc.js';
import {
    renderSummaryBlock,
    attachPersonSearch,
    clearMarks,
    renderModeSwitcher,
    addPersonToSchedule,
    updatePrintCover,
    postDutyMark,
} from './duty_ui.js';
import { openSubstitutionWizard } from './duty_substitution_wizard.js';

// ─── State ────────────────────────────────────────────────────────────────────

let _schedules      = [];
let _currentId      = null;
let _currentPersons = [];
let _currentMarks   = [];
let _year           = new Date().getFullYear();
let _month          = new Date().getMonth() + 1;   // 1-based
let _positions      = [];
let _holidays       = new Map();
let _currentMode    = MARK_DUTY;   // активный режим: N / U / V (vacation start)
let _vacationStart  = null;        // {personId, date, mode} — ждём вторую дату для диапазона V/T/H
// Статус утверждения (_currentId, _year, _month). null → ещё не загружен.
let _approval       = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initDuty() {
    document.getElementById('duty-add-schedule-btn')
        ?.addEventListener('click', () => _showCreateForm());

    document.getElementById('duty-create-cancel')
        ?.addEventListener('click', () => _hideCreateForm());

    document.getElementById('duty-create-save')
        ?.addEventListener('click', () => _handleCreate());

    document.getElementById('duty-prev-month')
        ?.addEventListener('click', () => _shiftMonth(-1));

    document.getElementById('duty-next-month')
        ?.addEventListener('click', () => _shiftMonth(+1));

    document.getElementById('duty-today-month')
        ?.addEventListener('click', () => {
            const now = new Date();
            _year  = now.getFullYear();
            _month = now.getMonth() + 1;
            _loadGrid();
        });

    document.getElementById('duty-add-person-btn')
        ?.addEventListener('click', () => {
            const wrap = document.getElementById('duty-person-search-wrap');
            wrap?.classList.toggle('hidden');
            if (!wrap?.classList.contains('hidden')) {
                _attachPersonSearch();
                document.getElementById('duty-person-search-input')?.focus();
            }
        });

    _attachPersonSearch();

    document.getElementById('duty-approve-btn')
        ?.addEventListener('click', _approveCurrentMonth);
    document.getElementById('duty-unapprove-btn')
        ?.addEventListener('click', _unapproveCurrentMonth);

    // Dropdown «🧹 Очистить...» — пункты с data-clear-mark вызывают
    // clearMarks с соответствующим типом (N/R/U/V). Все четыре в одной
    // кнопке вместо четырёх кнопок в toolbar — компактнее.
    document.querySelectorAll('#duty-clear-menu [data-clear-mark]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('duty-clear-menu')?.removeAttribute('open');
            clearMarks({
                scheduleId: _currentId,
                markType:   btn.dataset.clearMark,
                year:       _year,
                month:      _month,
                apiPath:    `/admin/schedules/${_currentId}/marks`,
                isReadOnly: _isReadOnly,
                reload:     _loadGrid,
            });
        });
    });

    document.getElementById('duty-create-position')
        ?.addEventListener('change', () => _suggestTitle());

    // Шапка/подпись печати графика — admin может править глобальные тексты.
    // Загружаем модуль динамически, чтобы не таскать его всем юзерам.
    document.getElementById('duty-print-settings-btn')
        ?.addEventListener('click', () => {
            import('./print_settings_dialog.js')
                .then(m => m.openPrintSettingsDialog())
                .catch(err => console.warn('print_settings_dialog import:', err));
        });

    document.getElementById('duty-export-docx-btn')
        ?.addEventListener('click', () => _exportDocx());
}

async function _exportDocx() {
    if (!_currentId) return;
    try {
        const blob = await api.download(
            `/admin/schedules/${_currentId}/export-docx?year=${_year}&month=${_month}`,
        );
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url;
        a.download = `Naryad_${_year}-${String(_month).padStart(2, '0')}.docx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        window.showSnackbar?.(`Ошибка экспорта: ${err?.message || err}`, 'error');
    }
}

// Тонкий обёрток над общим duty_ui.attachPersonSearch — только чтобы зафиксировать
// admin-специфичные параметры (id input'а, hint, callback).
// keepOpenOnSelect — multi-add: форма не закрывается после выбора одного,
// можно сразу выбирать следующего. Закрытие — Esc или клик вне формы.
function _attachPersonSearch() {
    attachPersonSearch({
        inputId:          'duty-person-search-input',
        emptyHint:        'Не найдено',
        keepOpenOnSelect: true,
        onSelect:         (person) => _addPersonToSchedule(person.id),
    });
}

// ─── Create form ──────────────────────────────────────────────────────────────

async function _showCreateForm() {
    // Загружаем должности для выпадающего списка
    try {
        _positions = await api.get('/admin/positions');
        console.log('[duty] Loaded positions:', _positions);
    } catch (err) {
        console.error('[duty] Failed to load positions:', err);
        _positions = [];
    }

    const sel = document.getElementById('duty-create-position');
    if (sel) {
        sel.innerHTML = '<option value="">— без привязки к должности —</option>'
            + _positions.map(p =>
                `<option value="${p.id}" data-name="${_esc(p.name)}">${_esc(p.name)}</option>`
              ).join('');
    }

    const titleInput = document.getElementById('duty-create-title');
    if (titleInput) titleInput.value = '';

    document.getElementById('duty-create-form')?.classList.remove('hidden');
}

function _hideCreateForm() {
    document.getElementById('duty-create-form')?.classList.add('hidden');
}

function _suggestTitle() {
    const sel  = document.getElementById('duty-create-position');
    const inp  = document.getElementById('duty-create-title');
    if (!sel || !inp) return;
    const opt  = sel.options[sel.selectedIndex];
    const name = opt?.dataset?.name || '';
    if (!name) { inp.value = ''; return; }
    // Автоподстановка: "Оператор" → "График операторов АМГ"
    inp.value = `График ${name.toLowerCase()}ов АМГ`;
}

async function _handleCreate() {
    const titleInput = document.getElementById('duty-create-title');
    const title      = titleInput?.value.trim();
    const sel        = document.getElementById('duty-create-position');
    const posIdStr   = sel?.value;
    const posId      = posIdStr ? parseInt(posIdStr) : null;
    const posName    = sel?.selectedOptions[0]?.dataset?.name || null;

    if (!title) {
        window.showSnackbar?.('Введите название графика', 'error');
        return;
    }

    console.log('[duty] Creating schedule:', { title, posId, posName });

    try {
        const result = await api.post('/admin/schedules', {
            title,
            position_id:   posId,
            position_name: posName,
        });
        console.log('[duty] Schedule created:', result);
        _hideCreateForm();
        window.showSnackbar?.('График создан', 'success');
        await loadSchedules();
    } catch (err) {
        // Логируем подробности — теперь видно в консоли что именно сломалось
        console.error('[duty] Create schedule error:', err);
        const detail = err?.message || `HTTP ${err?.status || '?'}`;
        window.showSnackbar?.(`Ошибка создания графика: ${detail}`, 'error');
    }
}

// ─── Schedules list ───────────────────────────────────────────────────────────

export async function loadSchedules() {
    try {
        _schedules = await api.get('/admin/schedules');
        console.log('[duty] Schedules:', _schedules);
    } catch (err) {
        console.error('[duty] loadSchedules error:', err);
        _schedules = [];
    }
    _renderScheduleList();
}

function _renderScheduleList() {
    const container = document.getElementById('duty-schedules-list');
    if (!container) return;

    if (_schedules.length === 0) {
        container.innerHTML = '<p class="hint" style="padding:12px 0;">Нет графиков — создайте первый</p>';
        return;
    }

    container.innerHTML = _schedules.map(s => {
        const tplCount = Array.isArray(s.applicable_template_ids) ? s.applicable_template_ids.length : 0;
        const scopeBadge = tplCount === 0
            ? '<span class="duty-sched-item__scope" title="Применяется ко всем спискам с такой должностью">все списки</span>'
            : `<span class="duty-sched-item__scope duty-sched-item__scope--bound"
                       title="Применяется только к ${tplCount} шаблон(у/ам)">${tplCount} шаблон.</span>`;
        const kind = s.kind || 'duty';
        const kindBadge = kind === 'amg_duty'
            ? `<span class="duty-sched-item__kind duty-sched-item__kind--amg"
                     title="Дежурство в АМГ — учётный график, в слоты не подставляет">АМГ</span>`
            : '';
        return `
        <div class="duty-sched-item${s.id === _currentId ? ' duty-sched-item--active' : ''}"
             data-sched-id="${s.id}">
            <div class="duty-sched-item__body">
                <span class="duty-sched-item__title">${_esc(s.title)}</span>
                ${s.position_name
                    ? `<span class="duty-sched-item__pos">${_esc(s.position_name)}</span>`
                    : ''}
            </div>
            ${kindBadge}
            ${scopeBadge}
            <div class="duty-sched-item__actions">
                <button class="duty-sched-item__kind-toggle btn btn-outlined btn-xs"
                        data-sched-kind="${s.id}" data-current-kind="${kind}" type="button"
                        title="Переключить тип графика (наряд / дежурство АМГ)">⇄</button>
                <button class="duty-sched-item__tpl btn btn-outlined btn-xs"
                        data-sched-tpl="${s.id}" type="button"
                        title="Применять только к выбранным шаблонам списков">🎯</button>
                <button class="duty-sched-item__del btn btn-danger btn-xs"
                        data-del-sched="${s.id}" type="button"
                        title="Удалить график">✕</button>
            </div>
        </div>`;
    }).join('');

    // Делегирование: один listener на контейнер. e.stopPropagation на
    // дочерних кнопках чтобы клик по строке (выбор графика) не срабатывал.
    container.onclick = async (e) => {
        const delBtn  = e.target.closest('[data-del-sched]');
        const tplBtn  = e.target.closest('[data-sched-tpl]');
        const kindBtn = e.target.closest('[data-sched-kind]');
        const item    = e.target.closest('[data-sched-id]');

        if (delBtn) {
            e.stopPropagation();
            await _deleteSchedule(parseInt(delBtn.dataset.delSched, 10));
            return;
        }
        if (tplBtn) {
            e.stopPropagation();
            await _openTemplateFilterModal(parseInt(tplBtn.dataset.schedTpl, 10));
            return;
        }
        if (kindBtn) {
            e.stopPropagation();
            await _toggleScheduleKind(
                parseInt(kindBtn.dataset.schedKind, 10),
                kindBtn.dataset.currentKind || 'duty',
            );
            return;
        }
        if (item) {
            await _selectSchedule(parseInt(item.dataset.schedId, 10));
        }
    };
}


// ─── kind / applicable_template_ids — admin зеркало dept-стороны ──────────

async function _toggleScheduleKind(scheduleId, currentKind) {
    const next = currentKind === 'amg_duty' ? 'duty' : 'amg_duty';
    const label = next === 'amg_duty' ? '«Дежурство в АМГ»' : '«Наряд»';
    if (!confirm(`Сменить тип графика на ${label}?`)) return;
    try {
        await api.patch(`/admin/schedules/${scheduleId}/kind`, { kind: next });
        window.showSnackbar?.(`Тип графика изменён на ${label}`, 'success');
        await loadSchedules();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}

// Модалка «Применять только к шаблонам». Шаблоны тащим через dept-эндпоинт
// /dept/templates — он защищён require_permission, но admin проходит всегда.
async function _openTemplateFilterModal(scheduleId) {
    const schedule = _schedules.find(s => s.id === scheduleId);
    if (!schedule) return;

    document.getElementById('duty-tpl-filter-modal')?.remove();

    let templates = [];
    try {
        templates = await api.get('/dept/templates');
    } catch (err) {
        window.showSnackbar?.(`Не удалось загрузить шаблоны: ${err?.message || err}`, 'error');
        return;
    }

    const selected = new Set(
        (schedule.applicable_template_ids || []).map(Number),
    );

    const modal = document.createElement('div');
    modal.id = 'duty-tpl-filter-modal';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center; padding:20px;
    `;
    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:520px; width:100%; padding:18px 20px; max-height:80vh;
                    display:flex; flex-direction:column;
                    box-shadow:0 20px 60px rgba(0,0,0,0.2);">
            <div style="margin-bottom:6px;">
                <h3 style="margin:0; font-size:1rem; font-weight:600;">Применять только к шаблонам</h3>
                <p style="margin:4px 0 0; font-size:0.8rem; color:var(--md-on-surface-variant); line-height:1.4;">
                    График «${_esc(schedule.title)}». Если ничего не отметить — он будет применяться ко всем
                    спискам с должностью «${_esc(schedule.position_name || '—')}». Отметив шаблоны,
                    вы ограничите автозаполнение только их инстансами.
                </p>
            </div>
            <div style="flex:1; overflow-y:auto; margin:10px 0; padding:6px;
                        border:1px solid var(--md-outline-variant); border-radius:6px;">
                ${templates.length === 0
                    ? '<p style="color:var(--md-on-surface-hint); font-size:0.85rem; padding:10px;">Шаблонов в системе пока нет.</p>'
                    : templates.map(t => `
                        <label class="duty-tpl-row" style="display:flex; align-items:center; gap:8px; padding:5px 8px; cursor:pointer; border-radius:4px;">
                            <input type="checkbox" value="${t.id}" ${selected.has(t.id) ? 'checked' : ''}>
                            <span style="flex:1; font-size:0.86rem;">${_esc(t.title)}</span>
                        </label>
                    `).join('')}
            </div>
            <div style="display:flex; justify-content:space-between; gap:8px;">
                <div>
                    <button id="duty-tpl-clear" class="btn btn-text btn-sm" type="button">Снять привязку</button>
                </div>
                <div style="display:flex; gap:8px;">
                    <button id="duty-tpl-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                    <button id="duty-tpl-save"   class="btn btn-success  btn-sm" type="button">Сохранить</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#duty-tpl-cancel').addEventListener('click', () => modal.remove());

    modal.querySelector('#duty-tpl-clear').addEventListener('click', async () => {
        await _applyTemplateFilter(scheduleId, []);
        modal.remove();
    });

    modal.querySelector('#duty-tpl-save').addEventListener('click', async () => {
        const ids = Array.from(modal.querySelectorAll('input[type=checkbox]:checked'))
            .map(cb => parseInt(cb.value, 10));
        await _applyTemplateFilter(scheduleId, ids);
        modal.remove();
    });
}

async function _applyTemplateFilter(scheduleId, templateIds) {
    try {
        await api.patch(`/admin/schedules/${scheduleId}/applicable-templates`, {
            template_ids: templateIds,
        });
        window.showSnackbar?.(
            templateIds.length === 0
                ? 'Привязка к шаблонам снята — график применяется ко всем'
                : `Привязка обновлена (${templateIds.length} шаблонов)`,
            'success',
        );
        await loadSchedules();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}

async function _deleteSchedule(id) {
    const s = _schedules.find(x => x.id === id);
    if (!confirm(`Удалить график «${s?.title}»?\nВсе отметки наряда будут удалены.`)) return;
    try {
        await api.delete(`/admin/schedules/${id}`);
        if (_currentId === id) {
            _currentId = null;
            _showGridEmpty();
        }
        await loadSchedules();
    } catch (err) {
        console.error('[duty] deleteSchedule error:', err);
        window.showSnackbar?.('Ошибка удаления', 'error');
    }
}

// ─── Grid ─────────────────────────────────────────────────────────────────────

async function _selectSchedule(id) {
    _currentId = id;
    _renderScheduleList();
    await _loadGrid();
}

async function _loadGrid() {
    if (!_currentId) return;

    document.getElementById('duty-grid-empty')?.classList.add('hidden');
    document.getElementById('duty-grid-container')?.classList.remove('hidden');
    document.getElementById('duty-grid-loading')?.classList.remove('hidden');
    document.getElementById('duty-person-search-wrap')?.classList.add('hidden');

    try {
        const [persons, marks, holidays, approval] = await Promise.all([
            api.get(`/admin/schedules/${_currentId}/persons`),
            api.get(`/admin/schedules/${_currentId}/marks?year=${_year}&month=${_month}`),
            getHolidaysMap(_year),
            api.get(`/admin/schedules/${_currentId}/approval?year=${_year}&month=${_month}`)
                .catch(() => ({ status: 'draft', approved_at: null, approved_by: null })),
        ]);
        _currentPersons = persons;
        _currentMarks   = marks;
        _holidays       = holidays;
        _approval       = approval;
        console.log('[duty] Grid loaded — persons:', _currentPersons.length,
                    'marks:', _currentMarks.length,
                    'holidays:', _holidays.size,
                    'approval:', _approval?.status);
    } catch (err) {
        console.error('[duty] _loadGrid error:', err);
        window.showSnackbar?.('Ошибка загрузки данных графика', 'error');
        document.getElementById('duty-grid-loading')?.classList.add('hidden');
        return;
    }

    _renderMonthLabel();
    _renderGrid();
    document.getElementById('duty-grid-loading')?.classList.add('hidden');
}

function _isReadOnly() {
    return _approval && _approval.status === 'approved';
}

function _renderApprovalUI() {
    const badge       = document.getElementById('duty-approval-badge');
    const approveBtn  = document.getElementById('duty-approve-btn');
    const unapproveBtn= document.getElementById('duty-unapprove-btn');
    const addPersonBtn= document.getElementById('duty-add-person-btn');
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
        const who = _approval.approved_by ? ` · ${_approval.approved_by}` : '';
        badge.textContent = `✓ Утверждён ${when}${who}`;
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
        'Будет зафиксирован текущий состав и все проставленные отметки. ' +
        'Чтобы изменить — нажмите «✎ Редактировать».'
    )) return;
    await _doApprove();
}

async function _doApprove() {
    try {
        _approval = await api.post(
            `/admin/schedules/${_currentId}/approval?year=${_year}&month=${_month}`
        );
        _renderApprovalUI();
        _renderGrid();
        window.showSnackbar?.('График утверждён', 'success');
    } catch (err) {
        // Pre-check на сервере: если есть нерешённые конфликты подмен —
        // открываем wizard. После сохранения он сам зовёт _doApprove повторно.
        if (err?.status === 409 && err?.detail?.code === 'duty_conflicts_unresolved') {
            openSubstitutionWizard({
                conflicts:  err.detail.conflicts || [],
                scheduleId: _currentId,
                apiPrefix:  '/admin',
                onResolved: _doApprove,
            });
            return;
        }
        window.showSnackbar?.(`Ошибка утверждения: ${err?.message || err}`, 'error');
    }
}

async function _unapproveCurrentMonth() {
    if (!_currentId) return;
    if (!confirm('Вернуть в режим редактирования? Snapshot будет удалён.')) return;
    try {
        await api.delete(
            `/admin/schedules/${_currentId}/approval?year=${_year}&month=${_month}`
        );
        _approval = { status: 'draft', approved_at: null, approved_by: null };
        _renderApprovalUI();
        _renderGrid();
        window.showSnackbar?.('Режим редактирования', 'info');
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}

function _renderMonthLabel() {
    const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь',
                    'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const el = document.getElementById('duty-month-label');
    if (el) el.textContent = `${MONTHS[_month - 1]} ${_year}`;
}

function _daysInMonth(y, m) {
    return new Date(y, m, 0).getDate();
}

function _renderGrid() {
    const table = document.getElementById('duty-grid-table');
    if (!table) return;

    _renderApprovalUI();
    _renderModeSwitcher();
    const readOnly = _isReadOnly();
    // В approved-режиме прячем переключатель N/У/О.
    // Селектор привязан к #duty-grid-container — иначе находили dept-toolbar
    // (он идёт раньше в DOM) и трогали dept вместо admin.
    const modeGroup = document.querySelector('#duty-grid-container .duty-mode-group');
    if (modeGroup) modeGroup.style.display = readOnly ? 'none' : '';

    const days  = _daysInMonth(_year, _month);
    const today = new Date();
    const todayD = today.getDate();
    const isThisMonth = today.getFullYear() === _year && today.getMonth() + 1 === _month;

    // Массив iso-дат месяца — для vacation-range и look-ups
    const monthDays = Array.from({ length: days }, (_, i) =>
        `${_year}-${String(_month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);

    const marksByPerson = groupMarks(_currentMarks);

    const DAY_ABBR = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

    // Шапка: номер дня + сокращённый день недели, выходные/праздники красным
    const dayHeaders = monthDays.map((iso, idx) => {
        const d     = idx + 1;
        const date  = new Date(_year, _month - 1, d);
        const dow   = date.getDay();
        const isWk  = dow === 0 || dow === 6;
        const holi  = _holidays.get(iso);
        const isTdy = isThisMonth && d === todayD;
        const classes = [
            'duty-grid__day-hdr',
            isWk   ? 'duty-col--weekend' : '',
            holi   ? 'duty-col--holiday' : '',
            isTdy  ? 'duty-grid__day-hdr--today' : '',
        ].filter(Boolean).join(' ');
        const title = holi ? `${DAY_ABBR[dow]} — ${_esc(holi.title)}` : DAY_ABBR[dow];
        return `<th class="${classes}" title="${title}">
                    ${d}
                    <span class="duty-dow">${DAY_ABBR[dow]}</span>
                </th>`;
    }).join('');

    // Строки с людьми. Сортируем по званию (от высшего к низшему), при
    // равных — по ФИО. Серверный order_num не используем: пользователь
    // хочет автосортировку, а не ручной порядок.
    const rows = sortByRank(_currentPersons).map(p => {
        const personMarks = marksByPerson.get(p.person_id) || new Map();
        const vacRanges   = extractVacationRanges(personMarks, monthDays);
        // Зоны рядом с N-нарядами (см. duty_validation.py): подсветка
        // соседних дней (strict) и «через сутки» (warn) в пустых ячейках.
        const dutyZones = computeDutyZones(personMarks, monthDays);

        // Map iso → range info (для V/T/H — отпуск/командировка/госпиталь)
        const vacMap = new Map();
        for (const r of vacRanges) {
            const s = monthDays.indexOf(r.start_iso);
            const e = monthDays.indexOf(r.end_iso);
            for (let i = s; i <= e; i++) {
                vacMap.set(monthDays[i], {
                    isFirst: i === s,
                    length:  r.days,
                    type:    r.mark_type,
                });
            }
        }

        const cells = monthDays.map((iso, idx) => {
            const d       = idx + 1;
            const dow     = new Date(_year, _month - 1, d).getDay();
            const isWk    = dow === 0 || dow === 6;
            const holi    = _holidays.get(iso);
            const isTdy   = isThisMonth && d === todayD;
            const mark    = personMarks.get(iso);
            const vac     = vacMap.get(iso);
            // zone не применяется к ячейкам с уже стоящими марками или
            // отпуском — там есть свой фон/контент.
            const zone    = (!mark && !vac) ? dutyZones.get(iso) : null;

            const classes = [
                'duty-grid__cell',
                isWk ? 'duty-col--weekend' : '',
                holi ? 'duty-col--holiday' : '',
                isTdy ? 'duty-grid__cell--today' : '',
                vac  ? 'duty-cell--in-vacation' : '',
                zone === 'strict' ? 'duty-cell--zone-strict' : '',
                zone === 'warn'   ? 'duty-cell--zone-warn'   : '',
            ].filter(Boolean).join(' ');

            let inner = '';
            if (vac) {
                // Полоса отсутствия (отпуск/командировка/госпиталь) рендерится
                // только в первой ячейке диапазона; цвет и подпись — по типу.
                if (vac.isFirst) {
                    const labels = { V: 'ОТПУСК', T: 'КОМАНДИРОВКА', H: 'ГОСПИТАЛЬ' };
                    const label = labels[vac.type] || 'ОТПУСК';
                    inner = `<div class="duty-vacation-bar duty-vacation-bar--${vac.type}"
                                  style="width: calc(${vac.length * 100}% + ${vac.length - 1}px);"
                                  title="${label.charAt(0) + label.slice(1).toLowerCase()}: ${vac.length} дн.">
                                 ${label}
                             </div>`;
                }
            } else if (mark) {
                inner = `<span class="duty-mark duty-mark--${mark.mark_type}"
                               title="${MARK_LABEL[mark.mark_type] || ''}">${MARK_LETTER[mark.mark_type] || ''}</span>`;
            }

            const hoursTip = hoursForDate(iso, _holidays);
            const titleAttr = `${_esc(p.full_name)} — ${iso}` +
                              (holi ? ` · ${_esc(holi.title)}` : '') +
                              ` · +${hoursTip}ч`;

            return `<td class="${classes}"
                        data-person-id="${p.person_id}"
                        data-date="${iso}"
                        title="${titleAttr}">
                        ${inner}
                    </td>`;
        }).join('');

        const rankBadge = p.rank
            ? `<span class="duty-grid__rank">${_esc(p.rank)}</span>`
            : '';

        return `<tr data-person-id="${p.person_id}">
            <td class="duty-grid__name-cell duty-name-td">
                <div class="duty-grid__name-wrap">
                    ${readOnly ? '' : `
                    <button class="duty-grid__remove-person"
                            data-remove-person="${p.person_id}"
                            title="Убрать из графика">✕</button>
                    <button class="duty-grid__clear-vac"
                            data-clear-vac="${p.person_id}"
                            data-pname="${_esc(p.full_name)}"
                            title="Снять все отпуска у этого человека за месяц">🏖×</button>
                    `}
                    <div class="duty-grid__name-info">
                        ${rankBadge}
                        <span class="duty-grid__fullname">${_esc(p.full_name)}</span>
                    </div>
                </div>
            </td>
            ${cells}
        </tr>`;
    }).join('');

    const totalCols = days + 1;   // ФИО + days (summary вынесен под таблицу)
    const emptyRow = _currentPersons.length === 0
        ? `<tr><td colspan="${totalCols}"
               style="text-align:center;padding:24px;color:var(--md-on-surface-hint);font-size:0.85rem;">
               Нет людей — добавьте через кнопку «+ Добавить человека»
           </td></tr>`
        : '';

    // colgroup убран сознательно: его inline-width перебивал CSS
    // (.duty-grid__name-cell width:190px, .duty-grid__day-hdr без width)
    // и таблица не помещалась в окно.
    table.innerHTML = `
        <thead>
            <tr>
                <th class="duty-grid__name-hdr">ФИО</th>
                ${dayHeaders}
            </tr>
        </thead>
        <tbody>${rows || emptyRow}</tbody>`;

    renderSummaryBlock('duty-grid-summary', sortByRank(_currentPersons),
                       marksByPerson, _holidays);

    const schedule = _schedules.find(s => s.id === _currentId);
    updatePrintCover('duty-print-cover', schedule?.title, _year, _month);

    // Делегированные события (только в draft — approved режим read-only)
    table.onclick = readOnly ? null : async (e) => {
        const cell      = e.target.closest('.duty-grid__cell');
        const removeBtn = e.target.closest('.duty-grid__remove-person');
        const clearVac  = e.target.closest('.duty-grid__clear-vac');

        if (removeBtn) {
            await _removePersonFromSchedule(parseInt(removeBtn.dataset.removePerson));
            return;
        }
        if (clearVac) {
            await clearMarks({
                scheduleId:  _currentId,
                markType:    MARK_VACATION,
                year:        _year,
                month:       _month,
                apiPath:     `/admin/schedules/${_currentId}/marks`,
                isReadOnly:  _isReadOnly,
                personId:    parseInt(clearVac.dataset.clearVac, 10),
                personLabel: clearVac.dataset.pname,
                reload:      _loadGrid,
            });
            return;
        }
        if (cell) {
            await _onCellClick(
                parseInt(cell.dataset.personId),
                cell.dataset.date,
                cell,
                e.shiftKey,
            );
        }
    };
}

// Селектор ограничен #duty-grid-container. Раньше брался первый
// .duty-grid-toolbar в DOM — а это dept-toolbar (он идёт раньше в index.html),
// поэтому кнопки режимов уходили в dept и в admin-графике их не было видно.
function _renderModeSwitcher() {
    renderModeSwitcher({
        toolbarSelector: '#duty-grid-container .duty-grid-toolbar',
        currentMode:     _currentMode,
        onModeChange:    (newMode) => {
            _currentMode   = newMode;
            _vacationStart = null;
            if (ABSENT_MARK_TYPES.includes(newMode)) {
                const labels = { V: 'Отпуск', T: 'Командировка', H: 'Госпиталь' };
                window.showSnackbar?.(
                    `Режим «${labels[newMode]}»: кликните на первую дату диапазона, затем на последнюю`,
                    'info',
                );
            }
        },
    });
}

async function _onCellClick(personId, dateStr, cellEl, isShift) {
    // V / T / H — двухступенчатый выбор диапазона. Один режим = одна
    // полосовая отметка; смена режима между кликами сбрасывает «начало».
    if (ABSENT_MARK_TYPES.includes(_currentMode)) {
        if (_vacationStart
            && _vacationStart.personId === personId
            && _vacationStart.mode === _currentMode) {
            const startDate = _vacationStart.date <= dateStr ? _vacationStart.date : dateStr;
            const endDate   = _vacationStart.date <= dateStr ? dateStr : _vacationStart.date;
            const mode = _vacationStart.mode;
            _vacationStart = null;
            await _applyVacationRange(personId, startDate, endDate, mode);
            return;
        }
        _vacationStart = { personId, date: dateStr, mode: _currentMode };
        cellEl.style.outline = '2px dashed #059669';
        window.showSnackbar?.(`Начало: ${dateStr}. Кликните на конец диапазона.`, 'info');
        return;
    }

    // Обычный клик — toggle одной отметкой
    await _toggleMark(personId, dateStr, _currentMode);
}

async function _applyVacationRange(personId, startIso, endIso, markType) {
    // Посылаем по одному дню — бэкенд с toggle-логикой либо поставит,
    // либо (если уже та же отметка) снимет. Для "заполнения диапазона"
    // НЕ снимаем: читаем что в этих днях и отправляем только недостающие.
    const s = new Date(startIso + 'T00:00:00');
    const e = new Date(endIso   + 'T00:00:00');
    const ops = [];
    const cur = new Date(s);
    while (cur <= e) {
        const iso = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`;
        const existing = _currentMarks.find(m => m.person_id === personId && m.duty_date === iso);
        if (!existing || existing.mark_type !== markType) {
            ops.push(iso);
        }
        cur.setDate(cur.getDate() + 1);
    }
    try {
        for (const iso of ops) {
            await api.post(`/admin/schedules/${_currentId}/marks`, {
                person_id: personId,
                duty_date: iso,
                mark_type: markType,
            });
        }
        await _loadGrid();
        const label = (MARK_LABEL[markType] || markType).toLowerCase();
        window.showSnackbar?.(`${label.charAt(0).toUpperCase() + label.slice(1)} поставлен (${ops.length} дн.)`, 'success');
    } catch (err) {
        console.error('[duty] absent range:', err);
        window.showSnackbar?.(`Ошибка постановки «${MARK_LABEL[markType] || markType}»`, 'error');
        await _loadGrid();
    }
}

async function _toggleMark(personId, dateStr, markType = MARK_DUTY) {
    // Защита: нельзя ставить наряд на день, где уже стоит отпуск/
    // командировка/госпиталь. Сначала надо снять полосовую отметку.
    if (markType === MARK_DUTY) {
        const existing = _currentMarks.find(
            m => m.person_id === personId && m.duty_date === dateStr
        );
        if (existing && ABSENT_MARK_TYPES.includes(existing.mark_type)) {
            const label = (MARK_LABEL[existing.mark_type] || existing.mark_type).toLowerCase();
            window.showSnackbar?.(
                `На день «${label}» нельзя ставить наряд. Сначала снимите отметку.`,
                'error',
            );
            return;
        }
    }
    try {
        const res = await postDutyMark(`/admin/schedules/${_currentId}/marks`, {
            person_id: personId,
            duty_date: dateStr,
            mark_type: markType,
        });
        if (res === null) return;   // пользователь отказался / strict-запрет
        console.log('[duty] toggleMark result:', res);

        // Обновляем локальный _currentMarks на основе ответа
        if (res.action === 'removed') {
            _currentMarks = _currentMarks.filter(
                m => !(m.person_id === personId && m.duty_date === dateStr)
            );
        } else if (res.action === 'created' || res.action === 'added') {
            _currentMarks.push({
                person_id: personId, duty_date: dateStr,
                mark_type: res.mark_type || markType,
            });
        } else if (res.action === 'changed') {
            const idx = _currentMarks.findIndex(
                m => m.person_id === personId && m.duty_date === dateStr);
            if (idx !== -1) _currentMarks[idx].mark_type = res.mark_type || markType;
        }

        if (res.filled_events_count > 0) {
            window.showSnackbar?.(
                `Наряд выставлен. Заполнено: ${res.filled_events_count}`,
                'success',
            );
        }

        _renderGrid();
    } catch (err) {
        console.error('[duty] toggleMark error:', err);
        window.showSnackbar?.(`Ошибка: ${err?.message || 'сервер'}`, 'error');
    }
}

async function _removePersonFromSchedule(personId) {
    const p = _currentPersons.find(x => x.person_id === personId);
    if (!confirm(`Убрать «${p?.full_name}» из графика?`)) return;
    try {
        await api.delete(`/admin/schedules/${_currentId}/persons/${personId}`);
        await _loadGrid();
    } catch (err) {
        console.error('[duty] removePersonFromSchedule error:', err);
        window.showSnackbar?.('Ошибка удаления из графика', 'error');
    }
}

function _shiftMonth(delta) {
    _month += delta;
    if (_month > 12) { _month = 1;  _year++; }
    if (_month < 1)  { _month = 12; _year--; }
    _loadGrid();
}

function _showGridEmpty() {
    document.getElementById('duty-grid-empty')?.classList.remove('hidden');
    document.getElementById('duty-grid-container')?.classList.add('hidden');
}

// ─── Person search ────────────────────────────────────────────────────────────
// Поиск с подсказками делает fio_autocomplete (см. _bindUI),
// здесь — только добавление выбранного в график.

async function _addPersonToSchedule(personId) {
    return addPersonToSchedule({
        personId,
        scheduleId:   _currentId,
        apiPath:      `/admin/schedules/${_currentId}/persons`,
        inputId:      'duty-person-search-input',
        wrapId:       'duty-person-search-wrap',
        reload:       _loadGrid,
        keepFormOpen: true,   // multi-add: форма остаётся открытой
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}