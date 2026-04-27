// static/js/combat_calc.js
/**
 * Боевой расчёт — модуль заполнения.
 *
 * Используется в двух контекстах:
 *  1. Вкладка «Боевой расчёт» в панели управления (для управлений)
 *  2. Вкладка «Боевой расчёт» в панели администратора
 */

import { api } from './api.js';
import { attach as attachFio } from './fio_autocomplete.js';

// ─── State ────────────────────────────────────────────────────────────────────

let _instances      = [];
let _templates      = [];     // Шаблоны для выпадающего списка
let _currentInst    = null;   // {instance, structure, slots_map, my_department}
let _saveTimeout    = null;   // дебаунс автосохранения
let _isAdmin        = false;

// Состояние календаря
let _currentWeekStart = _getMonday(new Date());

// ─── Helpers ──────────────────────────────────────────────────────────────────


// Функция для умного поиска элементов с суффиксами
function _getEl(id) {
    const suffix = _isAdmin ? '-admin' : '-dept';
    let el = document.getElementById(id + suffix);

    // Fallback: если элемента с суффиксом нет, ищем просто по ID
    // (например динамически созданная кнопка экспорта)
    if (!el) {
        el = document.getElementById(id);
    }
    return el;
}

const MONTHS_RU = ['Января', 'Февраля', 'Марта', 'Апреля', 'Мая', 'Июня', 'Июля', 'Августа', 'Сентября', 'Октября', 'Ноября', 'Декабря'];

function _formatDateNice(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d, 10)} ${MONTHS_RU[parseInt(m, 10) - 1]} ${y}`;
}

function _esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _todayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
}

function _getMonday(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1); // корректировка, если день воскресенье
    return new Date(date.setDate(diff));
}

function _updateWeekLabel() {
    const end = new Date(_currentWeekStart);
    end.setDate(end.getDate() + 6);

    const sD = _currentWeekStart.getDate();
    const sM = MONTHS_RU[_currentWeekStart.getMonth()].substring(0, 3).toLowerCase();
    const eD = end.getDate();
    const eM = MONTHS_RU[end.getMonth()].substring(0, 3).toLowerCase();

    const label = _getEl('cc-week-label');
    if (label) label.textContent = `${sD} ${sM} — ${eD} ${eM}`;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initCombatCalc(isAdmin = false) {
    _isAdmin = isAdmin;

    // Слушаем WebSocket чтобы обновляться при изменениях другими
    document.addEventListener('datachanged', (e) => {
        if (e.detail?.action === 'combat_calc_slot_update') {
            if (_currentInst && e.detail.instance_id === _currentInst.instance.id) {
                _reloadCurrentSilent();
            }
        }
        if (e.detail?.action === 'combat_calc_update') {
            loadCombatInstances();
        }
    });

    // Навигация по неделям (доступна и админу, и управлениям)
    _getEl('cc-prev-week')?.addEventListener('click', () => {
        _currentWeekStart.setDate(_currentWeekStart.getDate() - 7);
        _renderInstanceList();
    });
    _getEl('cc-next-week')?.addEventListener('click', () => {
        _currentWeekStart.setDate(_currentWeekStart.getDate() + 7);
        _renderInstanceList();
    });
    _getEl('cc-today-week')?.addEventListener('click', () => {
        _currentWeekStart = _getMonday(new Date());
        _renderInstanceList();
    });

    // Загрузка шаблонов для администратора
    if (isAdmin) {
        _loadTemplates();
    }

    loadCombatInstances();
}

async function _loadTemplates() {
    try {
        _templates = await api.get('/admin/combat/templates');
        _renderInstanceList();
    } catch (err) {
        console.error('[combat_calc] load templates:', err);
    }
}

// Статистика для шапки (только админ)
function _updateAdminStats() {
    // Считаем по текущей неделе (от _currentWeekStart на 7 дней)
    const start = new Date(_currentWeekStart);
    const end   = new Date(_currentWeekStart);
    end.setDate(end.getDate() + 7);

    const inWeek = _instances.filter(inst => {
        const d = new Date(inst.calc_date + 'T00:00:00');
        return d >= start && d < end;
    });

    const total  = inWeek.length;
    const active = inWeek.filter(x => x.status === 'active').length;
    const draft  = inWeek.filter(x => x.status === 'draft').length;
    const closed = inWeek.filter(x => x.status === 'closed').length;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('cc-stat-total',     total);
    set('cc-stat-active',    active);
    set('cc-stat-draft',     draft);
    set('cc-stat-closed',    closed);
    set('cc-stat-templates', _templates.length);
}

// ─── Instance list ────────────────────────────────────────────────────────────

export async function loadCombatInstances() {
    try {
        const endpoint = _isAdmin ? '/admin/combat/instances' : '/combat/my/instances';
        _instances = await api.get(endpoint);
    } catch (err) {
        console.error('[combat_calc] loadInstances:', err);
        _instances = [];
    }
    _renderInstanceList();
}

function _renderInstanceList() {
    const container = _getEl('cc-instances-list');
    if (!container) return;

    // Обновляем текст текущей недели (Пн - Вс)
    _updateWeekLabel();

    // Группируем по дате
    const byDate = {};
    _instances.forEach(inst => {
        const d = inst.calc_date;
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(inst);
    });

    // Обновляем статистику (только для админа)
    if (_isAdmin) _updateAdminStats();

    const STATUS_LABEL = { draft: 'Черновик', active: 'Активен', closed: 'Закрыт' };
    const STATUS_CLASS = { draft: 'cc-badge--draft', active: 'cc-badge--active', closed: 'cc-badge--closed' };

    const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    let html = '';

    // Строим сетку на 7 дней текущей выбранной недели
    for (let i = 0; i < 7; i++) {
        const currentDay = new Date(_currentWeekStart);
        currentDay.setDate(currentDay.getDate() + i);
        const isoDate = `${currentDay.getFullYear()}-${String(currentDay.getMonth()+1).padStart(2,'0')}-${String(currentDay.getDate()).padStart(2,'0')}`;
        const isToday = isoDate === _todayIso();
        const dayName = dayNames[currentDay.getDay()];

        const insts = byDate[isoDate] || [];

        // Колонка одного дня (вертикальный flex контейнер)
        html += `
            <div class="cc-date-group" style="display:flex; flex-direction:column; padding: 10px; background: ${isToday ? 'var(--md-surface)' : 'var(--md-surface)'}; border: 1.5px solid ${isToday ? 'var(--md-primary)' : 'var(--md-outline-variant)'}; border-radius: 8px; min-height: 120px;">
                <div style="text-align:center; margin-bottom: 10px; font-size: 0.85rem; border-bottom: 1px solid var(--md-outline-variant); padding-bottom: 6px;">
                    <b style="color:${isToday ? 'var(--md-primary)' : 'var(--md-on-surface)'};">${dayName}</b>
                    <span style="color:var(--md-on-surface-variant); margin-left:4px;">${currentDay.getDate()} ${MONTHS_RU[currentDay.getMonth()].substring(0,3).toLowerCase()}</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:6px; flex:1;">
        `;

        if (insts.length === 0 && !_isAdmin) {
            html += `<div style="font-size: 0.75rem; color: var(--md-on-surface-hint); text-align: center; margin-top: auto; margin-bottom: auto;">Нет расчётов</div>`;
        }

        // Выводим карточки существующих расчётов в этот день
        insts.forEach(inst => {
            const isActive = inst.id === _currentInst?.instance?.id;
            const activeStyle = isActive
                ? `border-color:var(--md-primary); background:var(--md-surface-variant);`
                : `border-color:var(--md-outline-variant); background:var(--md-background);`;

            html += `
            <div class="cc-inst-card${isActive ? ' cc-inst-card--active' : ''}" data-inst-id="${inst.id}" style="border:1px solid; ${activeStyle}">
                <div style="font-size: 0.75rem; font-weight:600; color:var(--md-on-surface); margin-bottom:2px; line-height:1.2;">${_esc(inst.template_title)}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                    <span class="cc-badge ${STATUS_CLASS[inst.status] || ''}" style="font-size:0.65rem; margin-bottom: 2px;">${STATUS_LABEL[inst.status] || inst.status}</span>
                    ${_isAdmin ? `
                    <div style="display:flex; gap:4px; margin-left:auto;">
                        <button class="btn btn-xs btn-outlined cc-status-btn" data-inst-id="${inst.id}" title="Сменить статус" style="padding:2px 6px; font-size:0.7rem; flex-shrink:0;">⟳</button>
                        <button class="btn btn-xs btn-danger cc-del-btn" data-inst-id="${inst.id}" title="Удалить" style="padding:2px 6px; font-size:0.7rem; flex-shrink:0;">✕</button>
                    </div>` : ''}
                </div>
            </div>
        `;
        });

        // Строка быстрого создания расчёта (Только для Админа)
        if (_isAdmin) {
            const selectOptions = '<option value="">— Шаблон —</option>' + _templates.map(t => `<option value="${t.id}">${_esc(t.title)}</option>`).join('');
            html += `
                <div class="cc-add-inline" style="margin-top:auto; display:flex; flex-direction:column; gap:4px; padding-top:12px;">
                    <select class="cc-inline-select" style="width:100%; padding:4px; font-size:0.7rem; border:1px solid var(--md-outline-variant); border-radius:4px; background:var(--md-surface); color:var(--md-on-surface); outline:none;">
                        ${selectOptions}
                    </select>
                    <button class="btn btn-success btn-xs cc-create-inline-btn" data-date="${isoDate}" style="width:100%; padding:4px;" title="Создать на этот день">+ Добавить</button>
                </div>
            `;
        }

        html += `</div></div>`; // Закрываем flex контент и карточку дня
    }

    container.innerHTML = html;

    // Навешиваем события на элементы
    container.onclick = async (e) => {
        const delBtn    = e.target.closest('.cc-del-btn');
        const statusBtn = e.target.closest('.cc-status-btn');
        const createBtn = e.target.closest('.cc-create-inline-btn');
        const card      = e.target.closest('.cc-inst-card');

        if (delBtn) {
            e.stopPropagation();
            await _deleteInstance(parseInt(delBtn.dataset.instId));
            return;
        }
        if (statusBtn) {
            e.stopPropagation();
            await _cycleStatus(parseInt(statusBtn.dataset.instId));
            return;
        }
        if (createBtn) {
            e.stopPropagation();
            const date = createBtn.dataset.date;
            const select = createBtn.closest('.cc-add-inline').querySelector('.cc-inline-select');
            const templateId = select?.value;

            if (!templateId) {
                window.showSnackbar?.('Выберите шаблон из списка', 'error');
                return;
            }
            await _createInstanceInline(templateId, date);
            return;
        }
        if (card) {
            await _openInstance(parseInt(card.dataset.instId));
        }
    };
}

// Функция быстрого создания
async function _createInstanceInline(templateId, date) {
    try {
        await api.post('/admin/combat/instances', {
            template_id: parseInt(templateId),
            calc_date:   date,
        });
        window.showSnackbar?.('Расчёт создан', 'success');
        await loadCombatInstances();
    } catch (err) {
        const msg = err?.message || 'Ошибка';
        window.showSnackbar?.(`Ошибка: ${msg}`, 'error');
    }
}

async function _deleteInstance(id) {
    const inst = _instances.find(x => x.id === id);
    if (!confirm(`Удалить расчёт «${inst?.template_title}» за ${_formatDateNice(inst?.calc_date)}?`)) return;
    try {
        await api.delete(`/admin/combat/instances/${id}`);
        if (_currentInst?.instance?.id === id) _showEmpty();
        await loadCombatInstances();
    } catch (err) {
        window.showSnackbar?.('Ошибка удаления', 'error');
    }
}

async function _cycleStatus(id) {
    try {
        const res = await api.patch(`/admin/combat/instances/${id}/status`);
        const STATUS_LABEL = { draft: 'Черновик', active: 'Активен', closed: 'Закрыт' };
        window.showSnackbar?.(`Статус: ${STATUS_LABEL[res.status] || res.status}`, 'success');
        await loadCombatInstances();
        // Обновляем открытый экземпляр
        if (_currentInst?.instance?.id === id) {
            await _openInstance(id);
        }
    } catch (err) {
        window.showSnackbar?.('Ошибка смены статуса', 'error');
    }
}

// ─── Instance view ────────────────────────────────────────────────────────────

async function _openInstance(id) {
    const endpoint = _isAdmin
        ? `/admin/combat/instances/${id}/full`
        : `/combat/instances/${id}/view`;

    try {
        _currentInst = await api.get(endpoint);
    } catch (err) {
        console.error('[combat_calc] open instance:', err);
        window.showSnackbar?.('Ошибка загрузки расчёта', 'error');
        return;
    }

    _renderInstanceList();  // обновить активную карточку
    _renderCalcView();
}

async function _reloadCurrentSilent() {
    if (!_currentInst) return;
    const id = _currentInst.instance.id;
    const endpoint = _isAdmin
        ? `/admin/combat/instances/${id}/full`
        : `/combat/instances/${id}/view`;
    try {
        const fresh = await api.get(endpoint);
        // Обновляем slots_map без перерисовки всей формы
        _currentInst.slots_map = fresh.slots_map;
        _applyFreshSlots(fresh.slots_map);
    } catch { /* тихо */ }
}

function _applyFreshSlots(slotsMap) {
    // Обновляем только незаполненные поля чтобы не прерывать ввод
    Object.entries(slotsMap).forEach(([rowKey, byIdx]) => {
        Object.entries(byIdx).forEach(([idx, slotData]) => {
            const nameInput = document.getElementById(`cc-name-${slotData.id}`);
            const rankInput = document.getElementById(`cc-rank-${slotData.id}`);
            if (nameInput && document.activeElement !== nameInput && !nameInput.value) {
                nameInput.value = slotData.full_name || '';
            }
            if (rankInput && document.activeElement !== rankInput && !rankInput.value) {
                rankInput.value = slotData.rank || '';
            }
            // Обновляем data-version
            const row = document.querySelector(`[data-slot-id="${slotData.id}"]`);
            if (row) row.dataset.version = slotData.version;
        });
    });
}

function _renderCalcView() {
    const panel = _getEl('cc-view-panel');
    const empty = _getEl('cc-view-empty');
    if (!panel) return;

    empty?.classList.add('hidden');
    panel.classList.remove('hidden');

    const { instance, structure, slots_map } = _currentInst;
    const isClosed  = instance.status === 'closed';
    const myDept    = _currentInst.my_department;
    const dateLabel = _formatDateNice(instance.calc_date);
    const calendarIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px; vertical-align:text-bottom;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;

    let html = `
        <div class="cc-view-header">
            <div class="cc-view-header__left">
                <h3 class="cc-view-header__title">${_esc(instance.template_title)}</h3>
                <span class="cc-view-header__date">${calendarIcon}${dateLabel}</span>
            </div>
            ${_isAdmin ? `
            <div class="cc-view-header__actions">
                <button class="btn btn-xs btn-tonal" id="cc-export-btn"
                        data-inst-id="${instance.id}">⬇ Скачать .docx</button>
            </div>` : ''}
        </div>`;

    if (isClosed && !_isAdmin) {
        html += `<div class="cc-closed-banner">Расчёт закрыт — только просмотр</div>`;
    }

    structure.sections.forEach(section => {
        html += `<div class="cc-section">
            <div class="cc-section__title">${_esc(section.title)}</div>
            <table class="cc-table">
                <thead>
                    <tr>
                        <th class="cc-th cc-th--label">Мероприятие / Состав наряда</th>
                        <th class="cc-th cc-th--time">Время</th>
                        <th class="cc-th cc-th--who">Кто выделяет</th>
                        <th class="cc-th cc-th--loc">Место / Подразд.</th>
                        <th class="cc-th cc-th--person">В/звание, Фамилия И.О.</th>
                    </tr>
                </thead>
                <tbody>`;

        section.rows.forEach(row => {
            const rowSlots = slots_map[row.key] || {};
            const slotList = row.slots || [];

            if (slotList.length === 0) return;

            // Первый слот — объединяем ячейки мероприятия
            slotList.forEach((slotDef, si) => {
                const slotData = rowSlots[slotDef.index] || {};
                const slotId   = slotData.id;
                const version  = slotData.version || 1;
                const fname    = slotData.full_name || '';
                const rank     = slotData.rank      || '';
                const isMySlot = !myDept || !slotData.department
                               || slotData.department === myDept
                               || _isAdmin;
                const disabled = (!isMySlot || isClosed) ? 'disabled' : '';

                const filledClass = fname ? ' cc-slot--filled' : '';

                if (si === 0) {
                    const rowspan = slotList.length > 1 ? ` rowspan="${slotList.length}"` : '';
                    html += `
                    <tr data-slot-id="${slotId}" data-version="${version}" class="cc-row${filledClass}">
                        <td class="cc-td cc-td--label"${rowspan}>${_esc(row.label)}</td>
                        <td class="cc-td cc-td--time"${rowspan}>${_esc(row.time)}</td>
                        <td class="cc-td cc-td--who"${rowspan}>${_esc(row.who_provides)}</td>
                        <td class="cc-td cc-td--loc">${_esc(slotDef.location)}</td>
                        <td class="cc-td cc-td--person">
                            ${_renderPersonCell(slotId, rank, fname, disabled)}
                        </td>
                    </tr>`;
                } else {
                    html += `
                    <tr data-slot-id="${slotId}" data-version="${version}" class="cc-row${filledClass}">
                        <td class="cc-td cc-td--loc">${_esc(slotDef.location)}</td>
                        <td class="cc-td cc-td--person">
                            ${_renderPersonCell(slotId, rank, fname, disabled)}
                        </td>
                    </tr>`;
                }
            });
        });

        html += `</tbody></table></div>`;
    });

    panel.innerHTML = html;

    // Биндим события
    panel.querySelectorAll('.cc-slot-input').forEach(input => {
        input.addEventListener('input', () => _onSlotInput(input));
        input.addEventListener('change', () => _saveSlotNow(input));
    });

    // Кнопка экспорта
    _getEl('cc-export-btn')?.addEventListener('click', () => {
        _exportInstance(instance.id);
    });

    // Автодополнение из базы людей — единый компонент fio_autocomplete.
    // При выборе подставляем ФИО и звание в парный input того же слота,
    // затем сохраняем сразу (не ждём debounce).
    panel.querySelectorAll('.cc-name-input').forEach(input => {
        if (input.__fioAc) return;
        const slotId = input.dataset.slotId;
        attachFio(input, {
            container: input.closest('.cc-person-wrap') || input.parentElement,
            getExtraParams: () => ({
                rank: document.getElementById(`cc-rank-${slotId}`)?.value.trim() || '',
            }),
            onSelect: (person) => {
                const nameInp = document.getElementById(`cc-name-${slotId}`);
                const rankInp = document.getElementById(`cc-rank-${slotId}`);
                if (nameInp && person.full_name) nameInp.value = person.full_name;
                if (rankInp && person.rank)      rankInp.value = person.rank;
                _saveSlotNow(nameInp || input);
            },
        });
    });
}

function _renderPersonCell(slotId, rank, fname, disabled) {
    if (!slotId) {
        return '<span style="color:var(--md-on-surface-hint);font-size:0.75rem;">—</span>';
    }
    return `
        <div class="cc-person-wrap">
            <input type="text"
                   id="cc-rank-${slotId}"
                   class="cc-slot-input cc-rank-input"
                   value="${_esc(rank)}"
                   placeholder="Звание"
                   data-slot-id="${slotId}"
                   data-field="rank"
                   ${disabled}>
            <input type="text"
                   id="cc-name-${slotId}"
                   class="cc-slot-input cc-name-input"
                   value="${_esc(fname)}"
                   placeholder="Фамилия И.О."
                   data-slot-id="${slotId}"
                   data-field="name"
                   autocomplete="off"
                   ${disabled}>
        </div>`;
}

// ─── Saving ────────────────────────────────────────────────────────────────────

function _onSlotInput(input) {
    const row = input.closest('[data-slot-id]');
    if (!row) return;
    // Показываем индикатор "несохранено"
    row.classList.add('cc-row--dirty');
    clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => _saveSlotNow(input), 800);
}

async function _saveSlotNow(input) {
    const slotId = parseInt(input.dataset.slotId);
    if (!slotId) return;

    const row = input.closest('[data-slot-id]');
    if (!row) return;

    const nameInput = document.getElementById(`cc-name-${slotId}`);
    const rankInput = document.getElementById(`cc-rank-${slotId}`);
    const version   = parseInt(row.dataset.version || 1);

    try {
        const result = await api.put(`/combat/slots/${slotId}`, {
            version,
            full_name: nameInput?.value.trim() || null,
            rank:      rankInput?.value.trim() || null,
        });

        row.dataset.version = result.version;
        row.classList.remove('cc-row--dirty');

        const isFilled = !!result.full_name;
        row.classList.toggle('cc-slot--filled', isFilled);

    } catch (err) {
        if (err?.status === 409) {
            window.showSnackbar?.('Конфликт версий — перезагружаю…', 'error');
            await _reloadCurrentSilent();
        } else {
            console.error('[combat_calc] save slot:', err);
        }
    }
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────
// Реализовано через единый fio_autocomplete (см. attach выше).

// ─── Export ───────────────────────────────────────────────────────────────────

async function _exportInstance(instanceId) {
    try {
        const blob = await api.download(`/export/combat/${instanceId}`);
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), {
            href:     url,
            download: `Боевой_расчёт_${instanceId}.docx`,
        });
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        window.showSnackbar?.('Ошибка экспорта', 'error');
    }
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function _showEmpty() {
    _currentInst = null;
    _getEl('cc-view-panel')?.classList.add('hidden');
    _getEl('cc-view-empty')?.classList.remove('hidden');
}