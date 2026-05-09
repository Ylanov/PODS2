// static/js/dept_duty.js
/**
 * Графики наряда для управлений.
 * Аналог duty.js, но работает с /api/v1/dept/schedules
 * и показывает только графики текущего управления.
 */

import { api }         from './api.js';
import {
    MARK_DUTY, MARK_LEAVE, MARK_VACATION, MARK_RESERVE, MARK_LETTER, MARK_LABEL,
    getHolidaysMap, hoursForDate,
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
import { mountDutyWindow } from './duty_window.js';

let _windowBanner = null;

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

// Монтаж виджета «Окно подачи». Вызывается из app.js после авторизации.
export function mountDeptDutyWindowBanner() {
    if (_windowBanner) _windowBanner.stop();
    _windowBanner = mountDutyWindow(
        document.getElementById('dept-duty-window-banner'),
        { variant: 'banner' },
    );
}

// Остановка таймеров баннера — для logout / смены пользователя.
export function stopDeptDutyWindowBanner() {
    if (_windowBanner) { _windowBanner.stop(); _windowBanner = null; }
}

// Загрузка данных — только после авторизации
export async function loadDeptDutyData() {
    mountDeptDutyWindowBanner();
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

    document.getElementById('dept-duty-person-queue-add')
        ?.addEventListener('click', _commitPendingQueue);
    document.getElementById('dept-duty-person-queue-cancel')
        ?.addEventListener('click', _hidePersonSearch);
    document.getElementById('dept-duty-person-queue')
        ?.addEventListener('click', (e) => {
            const x = e.target.closest('button[data-q-idx]');
            if (!x) return;
            const idx = parseInt(x.dataset.qIdx, 10);
            if (Number.isFinite(idx)) {
                _pendingPersons.splice(idx, 1);
                _renderPendingQueue();
            }
        });

    _attachPersonSearch();

    document.getElementById('dept-duty-approve-btn')
        ?.addEventListener('click', _approveCurrentMonth);
    document.getElementById('dept-duty-unapprove-btn')
        ?.addEventListener('click', _unapproveCurrentMonth);

    document.querySelectorAll('#dept-duty-clear-menu [data-clear-mark]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('dept-duty-clear-menu')?.removeAttribute('open');
            clearMarks({
                scheduleId: _currentId,
                markType:   btn.dataset.clearMark,
                year:       _viewYear,
                month:      _viewMonth,
                apiPath:    `/dept/schedules/${_currentId}/marks`,
                isReadOnly: _isReadOnly,
                reload:     _loadMarksAndRender,
            });
        });
    });

    document.getElementById('dept-duty-export-docx-btn')
        ?.addEventListener('click', () => _exportDocx());
}

async function _exportDocx() {
    if (!_currentId) return;
    try {
        const blob = await api.download(
            `/dept/schedules/${_currentId}/export-docx?year=${_viewYear}&month=${_viewMonth}`,
        );
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url;
        a.download = `Naryad_${_viewYear}-${String(_viewMonth).padStart(2, '0')}.docx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        window.showSnackbar?.(`Ошибка экспорта: ${err?.message || err}`, 'error');
    }
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
    const kind = document.querySelector('input[name="dept-duty-create-kind"]:checked')?.value
              || 'duty';

    if (!title) { window.showSnackbar?.('Введите название графика', 'error'); return; }

    try {
        await api.post('/dept/schedules', {
            title,
            position_id:   posId,
            position_name: posName,
            kind,
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
            <div class="duty-sched-item__title">${esc(s.title)}</div>
            ${s.position_name ? `<div class="duty-sched-item__sub">${esc(s.position_name)}</div>` : ''}
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
                        data-sched-id="${s.id}" type="button">✕</button>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.duty-sched-item').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('.duty-sched-item__del')) return;
            if (e.target.closest('.duty-sched-item__tpl')) return;
            if (e.target.closest('.duty-sched-item__kind-toggle')) return;
            _selectSchedule(parseInt(el.dataset.schedId));
        });
    });

    container.querySelectorAll('.duty-sched-item__del').forEach(btn => {
        btn.addEventListener('click', () => _deleteSchedule(parseInt(btn.dataset.schedId)));
    });

    container.querySelectorAll('.duty-sched-item__tpl').forEach(btn => {
        btn.addEventListener('click', () => _openTemplateFilterModal(parseInt(btn.dataset.schedTpl)));
    });

    container.querySelectorAll('.duty-sched-item__kind-toggle').forEach(btn => {
        btn.addEventListener('click', () => _toggleScheduleKind(
            parseInt(btn.dataset.schedKind, 10),
            btn.dataset.currentKind || 'duty',
        ));
    });
}


async function _toggleScheduleKind(scheduleId, currentKind) {
    const next = currentKind === 'amg_duty' ? 'duty' : 'amg_duty';
    const label = next === 'amg_duty' ? '«Дежурство в АМГ»' : '«Наряд»';
    if (!confirm(`Сменить тип графика на ${label}?`)) return;
    try {
        await api.patch(`/dept/schedules/${scheduleId}/kind`, { kind: next });
        window.showSnackbar?.(`Тип графика изменён на ${label}`, 'success');
        await loadDeptSchedules();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
}


// Модалка «Применять только к шаблонам». Чекбоксы шаблонов из
// /api/v1/dept/templates; уже отмеченные — те что в schedule.applicable_template_ids.
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
                    График «${esc(schedule.title)}». Если ничего не отметить — он будет применяться ко всем
                    спискам с должностью «${esc(schedule.position_name || '—')}». Отметив шаблоны,
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
                            <span style="flex:1; font-size:0.86rem;">${esc(t.title)}</span>
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
        await api.patch(`/dept/schedules/${scheduleId}/applicable-templates`, {
            template_ids: templateIds,
        });
        window.showSnackbar?.(
            templateIds.length === 0
                ? 'Привязка к шаблонам снята — график применяется ко всем'
                : `Привязка обновлена (${templateIds.length} шаблонов)`,
            'success',
        );
        await loadDeptSchedules();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err?.message || err}`, 'error');
    }
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
    await _doApprove();
}

// ─── Wizard замещений (substitution) ───────────────────────────────────────
//
// Вызывается из _doApprove когда бэк возвращает 409 с conflicts. Показывает
// для каждого конфликтного дня список людей и для каждого предлагает выбор:
// «по своей должности (primary)» или «замещает на квоту X в группу шаблона Y».
//
// Кнопка «Авто»: первый по порядку в каждом дне → primary; остальные —
// все на одну общую (quota+template+group), которую админ выбирает один раз.

async function _openSubstitutionWizard(conflicts) {
    // Фоновые данные для выбора квоты + группы
    let templates = [];
    let departments = [];
    try {
        [templates, departments] = await Promise.all([
            api.get('/dept/templates'),
            api.get('/dept/departments'),
        ]);
    } catch (err) {
        window.showSnackbar?.(`Не удалось загрузить шаблоны/управления: ${err?.message || err}`, 'error');
        return;
    }

    // Кэш групп по template_id — лениво
    const groupsByTpl = new Map();
    async function _loadTplGroups(tplId) {
        if (groupsByTpl.has(tplId)) return groupsByTpl.get(tplId);
        try {
            const groups = await api.get(`/dept/templates/${tplId}/groups`);
            groupsByTpl.set(tplId, groups);
            return groups;
        } catch {
            return [];
        }
    }

    // Локальное состояние решений: {markId: {is_primary, dept, tpl_id, group_id}}
    const decisions = new Map();
    for (const day of conflicts) {
        for (const m of day.marks) {
            decisions.set(m.mark_id, {
                is_primary: m.is_primary,
                dept:       m.substitute_department || '',
                tpl_id:     '',   // tpl_id вычисляем по group_id при сохранении
                group_id:   m.substitute_template_group_id || '',
            });
        }
    }

    document.getElementById('duty-subst-wizard')?.remove();
    const modal = document.createElement('div');
    modal.id = 'duty-subst-wizard';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5);
        display:flex; align-items:center; justify-content:center; padding:20px;
    `;
    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:780px; width:100%; max-height:90vh;
                    display:flex; flex-direction:column;
                    box-shadow:0 20px 60px rgba(0,0,0,0.25);">
            <div style="padding:14px 18px; border-bottom:1px solid var(--md-outline-variant);">
                <h3 style="margin:0; font-size:1.02rem; font-weight:600;">
                    Замещения в графике
                </h3>
                <p style="margin:6px 0 0; font-size:0.82rem; color:var(--md-on-surface-variant); line-height:1.4;">
                    Дней с >1 нарядом: <b>${conflicts.length}</b>. Для каждого дня укажите,
                    кто идёт <i>по своей должности</i> (этот заполнит штатные слоты), а кто
                    <i>замещает</i> на конкретной квоте и группе. Для скорости — кнопка «Авто»
                    делает первого по порядку primary, для остальных — единое правило.
                </p>
            </div>
            <div style="padding:10px 14px; border-bottom:1px solid var(--md-outline-variant);
                        background:var(--md-surface-variant); display:flex; gap:8px; flex-wrap:wrap;
                        align-items:flex-end;">
                <div style="flex:1; min-width:200px;">
                    <label style="font-size:0.74rem; font-weight:600; color:var(--md-on-surface-variant);
                                  text-transform:uppercase; letter-spacing:0.04em;">
                        Авто-режим: куда идут «вторые»
                    </label>
                    <div style="display:flex; gap:6px; margin-top:4px; flex-wrap:wrap;">
                        <select id="auto-dept" style="flex:1; min-width:140px; padding:5px;">
                            <option value="">— квота —</option>
                            ${departments.map(d => `<option value="${_esc(d)}">${_esc(d)}</option>`).join('')}
                        </select>
                        <select id="auto-tpl" style="flex:1; min-width:140px; padding:5px;">
                            <option value="">— шаблон —</option>
                            ${templates.map(t => `<option value="${t.id}">${_esc(t.title)}</option>`).join('')}
                        </select>
                        <select id="auto-group" style="flex:1; min-width:140px; padding:5px;" disabled>
                            <option value="">— группа —</option>
                        </select>
                    </div>
                </div>
                <button id="auto-apply" class="btn btn-outlined btn-sm" type="button">⚡ Применить ко всем</button>
            </div>
            <div id="subst-list" style="flex:1; overflow-y:auto; padding:10px 14px;"></div>
            <div style="display:flex; gap:8px; justify-content:flex-end;
                        padding:10px 14px; border-top:1px solid var(--md-outline-variant);
                        background:var(--md-surface-container);">
                <button id="subst-cancel" class="btn btn-outlined btn-sm" type="button">Отмена</button>
                <button id="subst-save"   class="btn btn-success  btn-sm" type="button">Сохранить и утвердить</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const listEl = modal.querySelector('#subst-list');

    // Шаблон → группы для строки с автокомплитом
    async function _renderRow(day, mark) {
        const dec = decisions.get(mark.mark_id);
        const tplId = dec.tpl_id;
        let groupOpts = '<option value="">— группа —</option>';
        if (tplId) {
            const groups = await _loadTplGroups(parseInt(tplId, 10));
            groupOpts += groups.map(g =>
                `<option value="${g.id}" ${String(g.id) === String(dec.group_id) ? 'selected' : ''}>${_esc(g.name)}${g.time_offset ? ` (${_esc(g.time_offset)})` : ''}</option>`
            ).join('');
        }
        const isPrim = dec.is_primary;
        return `
            <div class="subst-row" data-mark="${mark.mark_id}">
                <div class="subst-row__person">
                    <b>${_esc(mark.person)}</b>
                    ${mark.rank ? `<small> · ${_esc(mark.rank)}</small>` : ''}
                </div>
                <label class="subst-row__radio">
                    <input type="radio" name="prim-${mark.mark_id}" value="primary" ${isPrim ? 'checked' : ''}>
                    <span>По своей должности</span>
                </label>
                <label class="subst-row__radio">
                    <input type="radio" name="prim-${mark.mark_id}" value="substitute" ${!isPrim ? 'checked' : ''}>
                    <span>Замещает</span>
                </label>
                <div class="subst-row__placement" ${isPrim ? 'style="opacity:0.4; pointer-events:none;"' : ''}>
                    <select class="subst-dept" data-field="dept">
                        <option value="">— квота —</option>
                        ${departments.map(d =>
                            `<option value="${_esc(d)}" ${d === dec.dept ? 'selected' : ''}>${_esc(d)}</option>`
                        ).join('')}
                    </select>
                    <select class="subst-tpl" data-field="tpl">
                        <option value="">— шаблон —</option>
                        ${templates.map(t =>
                            `<option value="${t.id}" ${String(t.id) === String(tplId) ? 'selected' : ''}>${_esc(t.title)}</option>`
                        ).join('')}
                    </select>
                    <select class="subst-group" data-field="group" ${tplId ? '' : 'disabled'}>
                        ${groupOpts}
                    </select>
                </div>
            </div>
        `;
    }

    async function _renderAll() {
        const sections = await Promise.all(
            conflicts.map(async day => `
                <div class="subst-day">
                    <h4 class="subst-day__title">${_esc(day.date)} · ${day.marks.length} наряда</h4>
                    <div class="subst-day__rows">
                        ${(await Promise.all(day.marks.map(m => _renderRow(day, m)))).join('')}
                    </div>
                </div>
            `)
        );
        listEl.innerHTML = sections.join('');
        _bindRowEvents();
    }

    function _bindRowEvents() {
        listEl.querySelectorAll('.subst-row').forEach(row => {
            const markId = parseInt(row.dataset.mark, 10);
            const dec = decisions.get(markId);

            // Радио primary / substitute
            row.querySelectorAll(`input[name="prim-${markId}"]`).forEach(r => {
                r.addEventListener('change', () => {
                    const v = row.querySelector(`input[name="prim-${markId}"]:checked`)?.value;
                    dec.is_primary = (v === 'primary');
                    const placement = row.querySelector('.subst-row__placement');
                    if (placement) {
                        placement.style.opacity = dec.is_primary ? '0.4' : '';
                        placement.style.pointerEvents = dec.is_primary ? 'none' : '';
                    }
                });
            });

            const deptSel  = row.querySelector('.subst-dept');
            const tplSel   = row.querySelector('.subst-tpl');
            const groupSel = row.querySelector('.subst-group');

            deptSel?.addEventListener('change',  () => { dec.dept = deptSel.value || ''; });
            tplSel?.addEventListener('change', async () => {
                dec.tpl_id = tplSel.value || '';
                dec.group_id = '';
                groupSel.innerHTML = '<option value="">— группа —</option>';
                if (dec.tpl_id) {
                    const groups = await _loadTplGroups(parseInt(dec.tpl_id, 10));
                    groupSel.innerHTML += groups.map(g =>
                        `<option value="${g.id}">${_esc(g.name)}${g.time_offset ? ` (${_esc(g.time_offset)})` : ''}</option>`
                    ).join('');
                    groupSel.disabled = false;
                } else {
                    groupSel.disabled = true;
                }
            });
            groupSel?.addEventListener('change', () => { dec.group_id = groupSel.value || ''; });
        });
    }

    await _renderAll();

    // Auto-режим: при выборе шаблона — подгружаем группы.
    const autoTpl   = modal.querySelector('#auto-tpl');
    const autoGroup = modal.querySelector('#auto-group');
    autoTpl.addEventListener('change', async () => {
        autoGroup.innerHTML = '<option value="">— группа —</option>';
        if (autoTpl.value) {
            const groups = await _loadTplGroups(parseInt(autoTpl.value, 10));
            autoGroup.innerHTML += groups.map(g =>
                `<option value="${g.id}">${_esc(g.name)}${g.time_offset ? ` (${_esc(g.time_offset)})` : ''}</option>`
            ).join('');
            autoGroup.disabled = false;
        } else {
            autoGroup.disabled = true;
        }
    });

    modal.querySelector('#auto-apply').addEventListener('click', async () => {
        const dept    = modal.querySelector('#auto-dept').value;
        const tplId   = modal.querySelector('#auto-tpl').value;
        const groupId = modal.querySelector('#auto-group').value;
        if (!dept || !tplId || !groupId) {
            window.showSnackbar?.('Заполните квоту, шаблон и группу для авто-режима', 'error');
            return;
        }
        // Для каждого конфликтного дня: первый по порядку → primary, остальные →
        // substitute с указанной квотой/группой.
        for (const day of conflicts) {
            day.marks.forEach((m, i) => {
                const dec = decisions.get(m.mark_id);
                if (i === 0) {
                    dec.is_primary = true;
                    dec.dept = '';
                    dec.tpl_id = '';
                    dec.group_id = '';
                } else {
                    dec.is_primary = false;
                    dec.dept = dept;
                    dec.tpl_id = tplId;
                    dec.group_id = groupId;
                }
            });
        }
        await _renderAll();
        window.showSnackbar?.('Авто-правило применено ко всем дням', 'info');
    });

    modal.querySelector('#subst-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    modal.querySelector('#subst-save').addEventListener('click', async () => {
        // Валидация: для каждого дня должен быть РОВНО ОДИН primary, и у
        // каждого substitute заполнены dept + group_id.
        for (const day of conflicts) {
            const primaryCount = day.marks.filter(m => decisions.get(m.mark_id).is_primary).length;
            if (primaryCount !== 1) {
                window.showSnackbar?.(`${day.date}: должен быть ровно один «по своей должности»`, 'error');
                return;
            }
            for (const m of day.marks) {
                const d = decisions.get(m.mark_id);
                if (!d.is_primary && (!d.dept || !d.group_id)) {
                    window.showSnackbar?.(`${day.date}: для замещающего «${m.person}» укажите квоту и группу`, 'error');
                    return;
                }
            }
        }

        const payload = {
            decisions: Array.from(decisions.entries()).map(([mark_id, d]) => ({
                mark_id,
                is_primary: d.is_primary,
                substitute_department:        d.is_primary ? null : d.dept,
                substitute_template_group_id: d.is_primary ? null : parseInt(d.group_id, 10),
            })),
        };

        try {
            await api.patch(`/dept/schedules/${_currentId}/conflicts`, payload);
        } catch (err) {
            window.showSnackbar?.(`Ошибка сохранения: ${err?.message || err}`, 'error');
            return;
        }
        modal.remove();
        // После решения конфликтов — повторно вызываем approve
        await _doApprove();
    });
}


async function _doApprove() {
    try {
        _approval = await api.post(
            `/dept/schedules/${_currentId}/approval?year=${_viewYear}&month=${_viewMonth}`
        );
        _publishDraftFlag();
        _renderApprovalUI();
        _renderGrid();
        window.showSnackbar?.('График утверждён', 'success');
    } catch (err) {
        // 409 c кодом duty_conflicts_unresolved → нужен wizard замещений
        if (err?.status === 409 && err?.detail?.code === 'duty_conflicts_unresolved') {
            _openSubstitutionWizard(err.detail.conflicts || []);
            return;
        }
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

// Накопительная очередь людей для добавления одним нажатием.
// Это поле изолировано — пересоздаётся при открытии формы.
let _pendingPersons = [];   // [{id, full_name, rank}]

function _renderPendingQueue() {
    const queue = document.getElementById('dept-duty-person-queue');
    const addBtn = document.getElementById('dept-duty-person-queue-add');
    if (!queue || !addBtn) return;
    if (_pendingPersons.length === 0) {
        queue.innerHTML = '';
        addBtn.classList.add('hidden');
        return;
    }
    queue.innerHTML = _pendingPersons.map((p, idx) => `
        <span class="duty-person-chip" title="${esc(p.full_name)}">
            ${esc(p.full_name)}
            ${p.rank ? `<small>· ${esc(p.rank)}</small>` : ''}
            <button class="duty-person-chip__x" type="button" data-q-idx="${idx}" title="Убрать">×</button>
        </span>`).join('');
    addBtn.classList.remove('hidden');
    addBtn.textContent = `+ Добавить (${_pendingPersons.length})`;
}

// Тонкий обёрток над duty_ui.attachPersonSearch — кладёт выбранного
// человека в очередь, не отправляя POST сразу. Дубль (по id или ФИО)
// отбрасывается.
function _attachPersonSearch() {
    attachPersonSearch({
        inputId:          'dept-duty-person-search-input',
        emptyHint:        'Не найдено в базе управления',
        keepOpenOnSelect: true,
        onSelect:         (person) => {
            const norm = (s) => String(s || '').trim().toLocaleLowerCase('ru-RU');
            const dup = _pendingPersons.some(
                p => p.id === person.id || norm(p.full_name) === norm(person.full_name),
            );
            if (dup) {
                window.showSnackbar?.('Этот человек уже в очереди', 'info');
                return;
            }
            _pendingPersons.push({
                id:        person.id,
                full_name: person.full_name,
                rank:      person.rank || '',
            });
            _renderPendingQueue();
            const inp = document.getElementById('dept-duty-person-search-input');
            if (inp) inp.value = '';
            inp?.focus();
        },
    });
}

function _showPersonSearch() {
    const wrap  = document.getElementById('dept-duty-person-search-wrap');
    const input = document.getElementById('dept-duty-person-search-input');
    wrap?.classList.remove('hidden');
    if (input) input.value = '';
    _pendingPersons = [];
    _renderPendingQueue();
    _attachPersonSearch();
    input?.focus();
}

function _hidePersonSearch() {
    document.getElementById('dept-duty-person-search-wrap')?.classList.add('hidden');
    _pendingPersons = [];
    _renderPendingQueue();
}

// Применяет всю очередь: POST'ит каждого человека через addPersonToSchedule
// с keepFormOpen:true (не закрывает форму на каждом отдельно). После всех —
// закрывает форму и обновляет грид. 409-конфликты собираются в общий
// snackbar, не валят остальное добавление.
async function _commitPendingQueue() {
    if (_pendingPersons.length === 0) return;
    const queue = [..._pendingPersons];
    let added = 0, alreadyIn = 0, failed = 0;
    for (const p of queue) {
        try {
            await api.post(`/dept/schedules/${_currentId}/persons`, { person_id: p.id });
            added += 1;
        } catch (err) {
            if (err?.status === 409) alreadyIn += 1;
            else                     failed    += 1;
        }
    }
    _pendingPersons = [];
    _renderPendingQueue();
    _hidePersonSearch();
    await _loadMarksAndRender();
    const parts = [];
    if (added)     parts.push(`добавлено ${added}`);
    if (alreadyIn) parts.push(`уже было ${alreadyIn}`);
    if (failed)    parts.push(`ошибок ${failed}`);
    window.showSnackbar?.(parts.join(', ') || 'Готово', failed ? 'error' : 'success');
}

async function _addPerson(personId) {
    return addPersonToSchedule({
        personId,
        scheduleId:   _currentId,
        apiPath:      `/dept/schedules/${_currentId}/persons`,
        inputId:      'dept-duty-person-search-input',
        wrapId:       'dept-duty-person-search-wrap',
        reload:       _loadPersonsAndMarks,
        isReadOnly:   _isReadOnly,
        keepFormOpen: true,   // multi-add: форма остаётся открытой
    });
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
        <th style="width:32px;"></th>
    </tr></thead>`;

    // Строки. Сортируем по званию (от высшего к низшему), при равных —
    // по ФИО. Серверный order_num игнорируем: пользователь хочет
    // автосортировку, а не ручной порядок.
    const sortedPersons = sortByRank(_persons);
    const tbody = `<tbody>${sortedPersons.map(p => {
        const personMarks = marksByPerson.get(p.person_id) || new Map();
        const vacRanges   = extractVacationRanges(personMarks, monthDays);
        // Зоны рядом с N-нарядами: подсветка дней-соседей и «через сутки».
        const dutyZones   = computeDutyZones(personMarks, monthDays);
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
            const zone = (!mark && !vac) ? dutyZones.get(iso) : null;
            const cls = [
                'duty-grid__cell',
                isWk ? 'duty-col--weekend' : '',
                holi ? 'duty-col--holiday' : '',
                isToday ? 'duty-grid__cell--today' : '',
                vac  ? 'duty-cell--in-vacation' : '',
                zone === 'strict' ? 'duty-cell--zone-strict' : '',
                zone === 'warn'   ? 'duty-cell--zone-warn'   : '',
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

        return `<tr>
            <td class="duty-name-td" style="font-size:0.82rem; padding:4px 8px; white-space:nowrap;">
                ${esc(p.full_name)}
                ${p.rank ? `<span style="color:var(--md-on-surface-hint); font-size:0.7rem;"> ${esc(p.rank)}</span>` : ''}
            </td>
            ${cells}
            <td style="text-align:center; white-space:nowrap;">
                ${readOnly ? '' : `
                    <button class="btn btn-outlined btn-xs dept-duty-clear-vac"
                            data-pid="${p.person_id}"
                            data-pname="${esc(p.full_name)}"
                            type="button"
                            title="Снять все отпуска у этого человека за месяц">🏖×</button>
                    <button class="btn btn-danger btn-xs dept-duty-remove-person"
                            data-pid="${p.person_id}" type="button" title="Убрать из графика">✕</button>
                `}
            </td>
        </tr>`;
    }).join('')}
    ${_persons.length === 0 ? `<tr><td colspan="${daysInMonth + 2}" style="padding:24px; text-align:center; color:var(--md-on-surface-hint); font-size:0.85rem;">
        Добавьте сотрудников через кнопку «+ Добавить человека»
    </td></tr>` : ''}
    </tbody>`;

    table.innerHTML = thead + tbody;
    table.className = 'duty-grid';

    renderSummaryBlock('dept-duty-grid-summary', sortedPersons,
                       marksByPerson, _holidays);

    const schedule = _schedules.find(s => s.id === _currentId);
    updatePrintCover('dept-duty-print-cover', schedule?.title, _viewYear, _viewMonth);

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
    table.querySelectorAll('.dept-duty-clear-vac').forEach(btn => {
        btn.addEventListener('click', () => {
            clearMarks({
                scheduleId:  _currentId,
                markType:    MARK_VACATION,
                year:        _viewYear,
                month:       _viewMonth,
                apiPath:     `/dept/schedules/${_currentId}/marks`,
                isReadOnly:  _isReadOnly,
                personId:    parseInt(btn.dataset.pid, 10),
                personLabel: btn.dataset.pname,
                reload:      _loadMarksAndRender,
            });
        });
    });
}

function _renderModeSwitcher() {
    renderModeSwitcher({
        toolbarSelector: '#dept-duty-grid-container .duty-grid-toolbar',
        currentMode:     _currentMode,
        onModeChange:    (newMode) => {
            _currentMode   = newMode;
            _vacationStart = null;
            if (newMode === MARK_VACATION) {
                window.showSnackbar?.('Режим «Отпуск»: кликните первую и последнюю дату диапазона', 'info');
            }
        },
    });
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
        const result = await postDutyMark(`/dept/schedules/${_currentId}/marks`, {
            person_id: personId,
            duty_date: date,
            mark_type: markType,
        });
        if (result === null) return;   // пользователь отказался / strict-запрет
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