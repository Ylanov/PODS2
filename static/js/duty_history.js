// static/js/duty_history.js
//
// Вкладка «История утверждений» (admin).
//
// Показывает список всех snapshot'ов утверждённых графиков наряда —
// с фильтром по графику и году. По клику на строку загружается детальный
// snapshot: состав + сетка отметок за месяц. ФИО в snapshot'е
// денормализованы — последующие увольнения или переименования не влияют.

import { api } from './api.js';

let _inited    = false;
let _approvals = [];   // последние загруженные (с учётом фильтров)
let _schedules = [];   // для фильтра "График"

const MONTHS_FULL = [
    'Январь','Февраль','Март','Апрель','Май','Июнь',
    'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь',
];
const DAY_ABBR = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

function _esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function initDutyHistory() {
    if (!_inited) {
        _inited = true;
        document.getElementById('dh-filter-schedule')?.addEventListener('change', _applyFilters);
        document.getElementById('dh-filter-year')?.addEventListener('change', _applyFilters);
        document.getElementById('dh-reset-btn')?.addEventListener('click', () => {
            const s = document.getElementById('dh-filter-schedule');
            const y = document.getElementById('dh-filter-year');
            if (s) s.value = '';
            if (y) y.value = '';
            _applyFilters();
        });
        document.getElementById('dh-tbody')?.addEventListener('click', (e) => {
            const row = e.target.closest('tr[data-approval-id]');
            if (row) _showDetail(parseInt(row.dataset.approvalId, 10));
        });

        // Грузим графики для фильтра — один раз
        try {
            _schedules = await api.get('/admin/schedules');
        } catch {
            _schedules = [];
        }
        _populateScheduleFilter();
    }
    await _loadApprovals();
}

function _populateScheduleFilter() {
    const sel = document.getElementById('dh-filter-schedule');
    if (!sel) return;
    // первая опция «— все графики —» уже есть в HTML
    const cur = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    _schedules.forEach(s => {
        const opt = document.createElement('option');
        opt.value = String(s.id);
        opt.textContent = s.title || `График #${s.id}`;
        sel.appendChild(opt);
    });
    sel.value = cur;
}

function _populateYearFilter() {
    const sel = document.getElementById('dh-filter-year');
    if (!sel) return;
    const years = [...new Set(_approvals.map(a => a.year))].sort((a, b) => b - a);
    const cur = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    years.forEach(y => {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        sel.appendChild(opt);
    });
    sel.value = cur;
}

async function _loadApprovals() {
    const tbody = document.getElementById('dh-tbody');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:24px; text-align:center;
                            color:var(--md-on-surface-hint);">Загрузка…</td></tr>`;
    }

    const sid = document.getElementById('dh-filter-schedule')?.value || '';
    const yr  = document.getElementById('dh-filter-year')?.value     || '';
    const qs = new URLSearchParams();
    if (sid) qs.set('schedule_id', sid);
    if (yr)  qs.set('year', yr);

    try {
        _approvals = await api.get(
            '/admin/approvals' + (qs.toString() ? ('?' + qs.toString()) : '')
        );
    } catch (err) {
        console.error('[duty_history] load:', err);
        _approvals = [];
    }

    _populateYearFilter();
    _renderList();
}

function _applyFilters() {
    _loadApprovals();
}

function _renderList() {
    const tbody = document.getElementById('dh-tbody');
    if (!tbody) return;

    if (_approvals.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="padding:24px; text-align:center;
                            color:var(--md-on-surface-hint);">Нет утверждённых графиков</td></tr>`;
        return;
    }

    tbody.innerHTML = _approvals.map(a => {
        const when  = new Date(a.approved_at).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
        const owner = a.schedule_owner
            ? `<span style="font-size:0.75rem; color:var(--md-on-surface-variant);">${_esc(a.schedule_owner)}</span>`
            : `<span style="color:var(--md-on-surface-hint);">— admin —</span>`;
        return `
            <tr data-approval-id="${a.id}" style="cursor:pointer;">
                <td style="font-weight:500;">${_esc(a.schedule_title)}</td>
                <td>${owner}</td>
                <td>${MONTHS_FULL[a.month - 1]} ${a.year}</td>
                <td style="white-space:nowrap; font-size:0.82rem;">${_esc(when)}</td>
                <td>${_esc(a.approved_by || '—')}</td>
                <td><button class="btn btn-outlined btn-xs" type="button">Открыть</button></td>
            </tr>
        `;
    }).join('');
}

async function _showDetail(approvalId) {
    const panel = document.getElementById('dh-detail');
    if (!panel) return;

    panel.classList.remove('hidden');
    panel.innerHTML = `<p style="padding:12px; color:var(--md-on-surface-hint);">Загрузка snapshot'а…</p>`;

    let data;
    try {
        data = await api.get(`/admin/approvals/${approvalId}`);
    } catch (err) {
        panel.innerHTML = `<p style="color:var(--md-error);">Не удалось загрузить snapshot: ${_esc(err?.message || err)}</p>`;
        return;
    }

    const daysInMonth = new Date(data.year, data.month, 0).getDate();
    const monthDays = Array.from({ length: daysInMonth }, (_, i) => {
        const d = String(i + 1).padStart(2, '0');
        const m = String(data.month).padStart(2, '0');
        return `${data.year}-${m}-${d}`;
    });

    // Группируем отметки: person_id → Map(date_iso → mark_type)
    const marksBy = new Map();
    for (const m of data.marks) {
        if (!marksBy.has(m.person_id)) marksBy.set(m.person_id, new Map());
        marksBy.get(m.person_id).set(m.duty_date, m.mark_type);
    }
    // marks могут быть и с person_id=null (если Person удалён hard-delete
    // после утверждения) — их привяжем по full_name_at_time.
    const marksByName = new Map();
    for (const m of data.marks) {
        if (m.person_id != null) continue;
        if (!marksByName.has(m.full_name_at_time)) marksByName.set(m.full_name_at_time, new Map());
        marksByName.get(m.full_name_at_time).set(m.duty_date, m.mark_type);
    }

    // Шапка дней
    const headerDays = monthDays.map(iso => {
        const dow   = new Date(iso + 'T00:00:00').getDay();
        const day   = iso.slice(8);
        const isWk  = dow === 0 || dow === 6;
        return `<th style="text-align:center; padding:3px 2px; font-size:0.72rem; min-width:24px;
                          ${isWk ? 'background:rgba(220,38,38,0.08);' : ''}"
                     title="${DAY_ABBR[dow]}">${parseInt(day)}<br><span style="font-size:0.65rem;
                     color:var(--md-on-surface-hint);">${DAY_ABBR[dow]}</span></th>`;
    }).join('');

    // Строки по людям
    const personRows = data.persons.length === 0
        ? `<tr><td colspan="${daysInMonth + 2}" style="padding:16px; text-align:center; color:var(--md-on-surface-hint);">
              В графике не было людей на момент утверждения
           </td></tr>`
        : data.persons.map(p => {
            const marks = marksBy.get(p.person_id) || marksByName.get(p.full_name) || new Map();
            const cells = monthDays.map(iso => {
                const mt = marks.get(iso);
                if (!mt) return `<td style="text-align:center;"></td>`;
                const letter = { N: 'Н', U: 'У', V: 'О' }[mt] || mt;
                return `<td style="text-align:center; font-weight:600;
                                   color:var(--md-primary);">${letter}</td>`;
            }).join('');
            const rank = p.rank ? ` <span style="color:var(--md-on-surface-hint); font-size:0.72rem;">${_esc(p.rank)}</span>` : '';
            return `<tr>
                <td style="padding:4px 8px; font-size:0.82rem; white-space:nowrap;">
                    ${_esc(p.full_name)}${rank}
                </td>
                ${cells}
                <td></td>
            </tr>`;
        }).join('');

    const whenLocal = new Date(data.approved_at).toLocaleString('ru-RU');

    panel.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap;">
            <h3 style="margin:0; font-size:1.05rem;">
                ${_esc(data.schedule_title)}
                <span style="color:var(--md-on-surface-variant); font-weight:400;">
                    · ${MONTHS_FULL[data.month - 1]} ${data.year}
                </span>
            </h3>
            <span style="font-size:0.78rem; color:var(--md-on-surface-hint); margin-left:auto;">
                Утверждён ${_esc(whenLocal)}${data.approved_by ? ` · ${_esc(data.approved_by)}` : ''}
            </span>
            <button id="dh-detail-close" class="btn btn-outlined btn-xs" type="button">Закрыть</button>
        </div>
        <div style="overflow-x:auto;">
            <table class="duty-grid" style="font-size:0.78rem;">
                <thead>
                    <tr>
                        <th style="min-width:180px; text-align:left;">Сотрудник</th>
                        ${headerDays}
                        <th style="width:16px;"></th>
                    </tr>
                </thead>
                <tbody>${personRows}</tbody>
            </table>
        </div>
        <p style="margin-top:10px; font-size:0.72rem; color:var(--md-on-surface-hint);">
            Snapshot содержит копию состава и отметок на момент утверждения.
            Последующие изменения в активном графике и в базе людей здесь не отражаются.
        </p>
    `;

    document.getElementById('dh-detail-close')?.addEventListener('click', () => {
        panel.classList.add('hidden');
        panel.innerHTML = '';
    });
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
