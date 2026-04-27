// static/js/event_editor.js
//
// Редактируемая модалка списка для администратора — открывается с дашборда.
// Все 7 полей слота (ФИО, Звание, № Документа, Должность, Позывной, Квота,
// Примечание) редактируются inline; изменения сохраняются на blur через
// PUT /api/v1/admin/slots/{id}. Backend делает manager.broadcast — таблицы
// department-пользователей обновляются в реальном времени через WebSocket.
//
// ФИО с подсказкой из общей базы (/persons/suggest) — админ может выбрать
// существующего человека, бэк сам упсертит Person + применит управление.
//
// Экспорт:
//   openEventEditor(eventId)  — главная точка входа
//
// На dashboard вызывается вместо openEventReadonly если role===admin.

import { api } from './api.js';
import { formatRole } from './ui.js';
import { attach as attachFio } from './fio_autocomplete.js';

const WEEKDAYS_FULL = [
    'Воскресенье', 'Понедельник', 'Вторник', 'Среда',
    'Четверг', 'Пятница', 'Суббота',
];
const MONTHS_GENITIVE = [
    'января','февраля','марта','апреля','мая','июня',
    'июля','августа','сентября','октября','ноября','декабря',
];

function _esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function _fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS_GENITIVE[m - 1]} ${y}`;
}

function _weekdayOf(iso) {
    if (!iso) return '';
    return WEEKDAYS_FULL[new Date(iso + 'T00:00:00').getDay()];
}

// ─── Состояние текущей открытой модалки ────────────────────────────────────
const _state = {
    eventId:     null,
    event:       null,
    columns:     [],                // конфигурация столбцов списка
    groups:      [],                // группы со слотами
    positions:   [],                // справочник должностей
    departments: [],                // список username'ов department-пользователей
    saving:      new Set(),         // id слотов сейчас в процессе сохранения
};

// ─── Точка входа ───────────────────────────────────────────────────────────
export async function openEventEditor(eventId) {
    _state.eventId  = eventId;
    _state.saving.clear();

    _openShellModal();

    try {
        // Параллельно грузим всё: сам список, положения, пользователей
        const [data, positions, users] = await Promise.all([
            api.get(`/admin/events/${eventId}/full`),
            api.get('/admin/positions').catch(() => []),
            api.get('/admin/users').catch(() => []),
        ]);

        _state.event       = data.event;
        _state.columns     = (data.columns || [])
                                .filter(c => c.visible !== false)
                                .sort((a, b) => a.order - b.order);
        _state.groups      = data.groups || [];
        _state.positions   = positions || [];
        // В выпадашку «Квота» пускаем всех активных юзеров — включая admin'а.
        // Раньше admin фильтровался, но это мешало назначать квоту на админа
        // для строк, которые он заполняет лично (главные показатели и т.п.).
        // Сортируем admin наверх, дальше управления и отделы по username.
        _state.departments = (users || [])
            .filter(u => u.is_active)
            .sort((a, b) => {
                if (a.role === 'admin' && b.role !== 'admin') return -1;
                if (b.role === 'admin' && a.role !== 'admin') return 1;
                return (a.username || '').localeCompare(b.username || '', 'ru');
            })
            .map(u => u.username);

        _renderContent();
        _listenWsUpdates();
    } catch (err) {
        console.error('[event_editor] load:', err);
        _setShellError(err.message || 'Не удалось загрузить список');
    }
}

// ─── Shell модалки ─────────────────────────────────────────────────────────
function _openShellModal() {
    document.getElementById('event-editor-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'event-editor-modal';
    modal.className = 'evt-edit__backdrop';
    modal.innerHTML = `
        <div class="evt-edit__dialog">
            <div class="evt-edit__header" id="evt-edit-header">
                <div class="evt-edit__title-group">
                    <div class="evt-edit__title">Загрузка…</div>
                    <div class="evt-edit__subtitle" id="evt-edit-subtitle"></div>
                </div>
                <div class="evt-edit__header-actions">
                    <span class="evt-edit__status" id="evt-edit-status" title="Состояние синхронизации">
                        <span class="evt-edit__status-dot"></span>
                        <span class="evt-edit__status-text">Синхронизировано</span>
                    </span>
                    <button class="btn btn-outlined btn-sm" id="evt-edit-export" type="button" title="Скачать .docx">
                        ⬇ .docx
                    </button>
                    <button class="btn btn-text btn-sm" id="evt-edit-close" type="button">Закрыть</button>
                </div>
            </div>
            <!-- Дежурный (подпись в документе): глобальная настройка /settings.
                 Применяется при выгрузке .docx для ВСЕХ списков — тот же
                 функционал, что в редакторе шаблонов (панель «Выгрузка .docx»).
                 Дублируется здесь, чтобы админ не переключался между вкладками. -->
            <div class="evt-edit__duty" id="evt-edit-duty">
                <span class="evt-edit__duty-label">Дежурный (подпись в документе)</span>
                <div class="evt-edit__duty-field evt-edit__duty-field--rank">
                    <label class="evt-edit__duty-field-label" for="evt-edit-duty-rank">Звание</label>
                    <input type="text" id="evt-edit-duty-rank" placeholder="подполковник" autocomplete="off">
                </div>
                <div class="evt-edit__duty-field evt-edit__duty-field--name">
                    <label class="evt-edit__duty-field-label" for="evt-edit-duty-name">ФИО</label>
                    <input type="text" id="evt-edit-duty-name" placeholder="Д.М. Фамилия" autocomplete="off">
                </div>
                <button id="evt-edit-duty-save" class="btn btn-outlined btn-sm evt-edit__duty-save" type="button">
                    Сохранить
                </button>
                <span class="evt-edit__duty-note">
                    Применяется при выгрузке .docx для всех списков.
                </span>
            </div>
            <div class="evt-edit__body" id="evt-edit-body">
                <div class="evt-edit__loading">Загрузка списка…</div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    // Закрытие по ESC / клику на backdrop
    modal.addEventListener('click', (e) => {
        if (e.target === modal) _closeModal();
    });
    const escHandler = (e) => { if (e.key === 'Escape') _closeModal(); };
    document.addEventListener('keydown', escHandler);
    modal._escHandler = escHandler;

    document.getElementById('evt-edit-close')?.addEventListener('click', _closeModal);
    document.getElementById('evt-edit-export')?.addEventListener('click', _exportEvent);
    document.getElementById('evt-edit-duty-save')?.addEventListener('click', _saveDutyOfficer);
    _loadDutyOfficer();
}

function _closeModal() {
    const modal = document.getElementById('event-editor-modal');
    if (modal?._escHandler) document.removeEventListener('keydown', modal._escHandler);
    modal?.remove();
    document.removeEventListener('datachanged', _handleWsUpdate);
    _state.eventId = null;
}

function _setShellError(msg) {
    const body = document.getElementById('evt-edit-body');
    if (!body) return;
    body.innerHTML = `<div class="evt-edit__error">⚠ ${_esc(msg)}</div>`;
}

// ─── Статус синхронизации (pill в header) ──────────────────────────────────
function _setStatus(kind) {
    // kind: 'ok' | 'saving' | 'error'
    const el = document.getElementById('evt-edit-status');
    if (!el) return;
    el.classList.remove('evt-edit__status--ok','evt-edit__status--saving','evt-edit__status--error');
    el.classList.add(`evt-edit__status--${kind}`);
    const text = el.querySelector('.evt-edit__status-text');
    if (text) {
        text.textContent = kind === 'saving' ? 'Сохранение…'
                         : kind === 'error'  ? 'Ошибка сохранения'
                         : 'Синхронизировано';
    }
}

// ─── Рендер содержимого ────────────────────────────────────────────────────
function _renderContent() {
    // Уничтожаем старые instances autocomplete'а до перезаписи innerHTML.
    // Иначе висят глобальные document-listener'ы и бокс-элементы.
    _detachFioSuggest();

    const ev      = _state.event;
    const subtitle = document.getElementById('evt-edit-subtitle');
    const title    = document.querySelector('#evt-edit-header .evt-edit__title');
    if (title)    title.textContent = ev.title || '—';
    if (subtitle) {
        subtitle.textContent = [
            _fmtDate(ev.date),
            _weekdayOf(ev.date),
            ev.status === 'active' ? 'Активен' : ev.status,
        ].filter(Boolean).join(' · ');
    }

    const body = document.getElementById('evt-edit-body');
    if (!body) return;

    _setStatus('ok');

    let globalIdx = 1;
    const groupsHtml = _state.groups.map(group => {
        const slotRows = (group.slots || []).map(slot => {
            const row = _renderSlotRow(slot, globalIdx++);
            return row;
        }).join('');

        return `
            <tr class="evt-edit__group-row">
                <td colspan="${_state.columns.length + 2}">
                    <span class="evt-edit__group-name">${_esc(group.name)}</span>
                </td>
            </tr>
            ${slotRows}
        `;
    }).join('');

    body.innerHTML = `
        <div class="evt-edit__table-wrap">
            <table class="evt-edit__table">
                <thead>
                    <tr>
                        <th style="width:36px; text-align:center;">№</th>
                        ${_state.columns.map(c =>
                            `<th style="min-width:${_colMinWidth(c)}px;">${_esc(c.label)}</th>`
                        ).join('')}
                        <th style="width:28px;"></th>
                    </tr>
                </thead>
                <tbody id="evt-edit-tbody">${groupsHtml}</tbody>
            </table>
        </div>
    `;

    _attachFioSuggest();
    _attachAutoSave();
}

function _colMinWidth(c) {
    switch (c.key) {
        case 'full_name':   return 200;
        case 'position_id': return 160;
        case 'department':  return 140;
        case 'note':        return 140;
        default:            return 110;
    }
}

// ─── Одна строка-слот ──────────────────────────────────────────────────────
function _renderSlotRow(slot, idx) {
    const cells = _state.columns.map(c => _renderCell(c, slot)).join('');
    return `
        <tr data-slot-id="${slot.id}" data-version="${slot.version || 1}">
            <td style="text-align:center; color:var(--md-on-surface-hint); font-size:0.74rem; font-family:var(--md-font-mono);">${idx}</td>
            ${cells}
            <td style="text-align:center;">
                <span class="evt-edit__saved-indicator" id="saved-${slot.id}"></span>
            </td>
        </tr>
    `;
}

function _renderCell(col, slot) {
    if (col.type === 'select_position') {
        const curId = slot.position_id ?? '';
        const opts  = ['<option value="">— не выбрано —</option>']
            .concat(_state.positions.map(p =>
                `<option value="${p.id}" ${p.id === slot.position_id ? 'selected' : ''}>${_esc(p.name)}</option>`
            )).join('');
        return `<td><select class="evt-edit__input" data-field="position_id">${opts}</select></td>`;
    }

    if (col.type === 'select_dept') {
        const deps = _state.departments;
        const opts = ['<option value="">— без квоты —</option>']
            .concat(deps.map(u =>
                `<option value="${_esc(u)}" ${u === slot.department ? 'selected' : ''}>${_esc(formatRole(u))}</option>`
            )).join('');
        return `<td><select class="evt-edit__input" data-field="department">${opts}</select></td>`;
    }

    // Текстовые поля: full_name с suggest, остальные — обычный input.
    // Dropdown подсказок создаёт FioAutocomplete (см. _attachFioSuggest).
    // Якорный td должен быть position:relative, иначе dropdown вылетит.
    const key   = col.key;
    const val   = (key in slot) ? (slot[key] ?? '')
                                : (slot.extra_data?.[key] ?? '');
    const extra = key === 'full_name' ? 'data-fio-input="1" autocomplete="off"' : '';
    return `
        <td${key === 'full_name' ? ' style="position:relative;"' : ''}>
            <input type="text" class="evt-edit__input"
                   data-field="${_esc(key)}" value="${_esc(val)}" ${extra}>
        </td>
    `;
}

// ─── Авто-сохранение по blur ───────────────────────────────────────────────
function _attachAutoSave() {
    const tbody = document.getElementById('evt-edit-tbody');
    if (!tbody) return;

    tbody.addEventListener('change', async (e) => {
        const input = e.target.closest('[data-field]');
        if (!input) return;
        const tr = input.closest('tr[data-slot-id]');
        if (!tr) return;
        await _saveSlot(tr);
    });

    // Для text-input'ов — сохраняем при blur (change на input не срабатывает
    // если пользователь только стирал и вернулся). И при Enter.
    tbody.addEventListener('blur', async (e) => {
        const input = e.target.closest('input[type="text"][data-field]');
        if (!input) return;
        const tr = input.closest('tr[data-slot-id]');
        if (!tr) return;
        // blur-event может прилетать при клике на suggest-item — тогда значение
        // ещё меняется; даём 150мс чтобы клик успел отработать
        setTimeout(() => {
            if (tr.isConnected) _saveSlot(tr);
        }, 150);
    }, true);

    tbody.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const input = e.target.closest('input[type="text"][data-field]');
        if (!input) return;
        input.blur();
    });
}

async function _saveSlot(tr) {
    const slotId  = parseInt(tr.dataset.slotId, 10);
    if (!slotId || _state.saving.has(slotId)) return;
    _state.saving.add(slotId);

    const version = parseInt(tr.dataset.version, 10) || 1;

    const payload = { version };
    tr.querySelectorAll('[data-field]').forEach(inp => {
        const field = inp.dataset.field;
        let   val   = inp.value;
        // position_id — число или null
        if (field === 'position_id') {
            payload.position_id = val ? parseInt(val, 10) : null;
        } else {
            payload[field] = val ? String(val).trim() : null;
        }
    });

    // department обязателен на бэке — если пусто, посылаем пустую строку
    if (!payload.department) payload.department = '';

    _setStatus('saving');
    const indicator = document.getElementById(`saved-${slotId}`);
    if (indicator) indicator.textContent = '⋯';

    try {
        const updated = await api.put(`/admin/slots/${slotId}`, payload);
        tr.dataset.version = updated.version;

        // Обновляем значения которые мог проставить бэк (например, авто-заполнение
        // ФИО из наряда при смене position_id). Не трогаем активный фокус.
        _applyServerUpdate(tr, updated);

        if (indicator) {
            indicator.textContent = '✓';
            indicator.className = 'evt-edit__saved-indicator evt-edit__saved-indicator--ok';
            setTimeout(() => {
                if (indicator) indicator.textContent = '';
                indicator.className = 'evt-edit__saved-indicator';
            }, 1500);
        }
        _setStatus('ok');
    } catch (err) {
        console.error('[event_editor] save:', err);
        if (indicator) {
            indicator.textContent = '✕';
            indicator.className = 'evt-edit__saved-indicator evt-edit__saved-indicator--err';
        }
        _setStatus('error');
        if (err.status === 409) {
            window.showSnackbar?.(
                'Данные уже изменены кем-то другим. Обновляю…', 'error'
            );
            // Перезагружаем полностью чтобы взять актуальную версию
            await _reloadFromServer();
        } else {
            window.showSnackbar?.(`Ошибка сохранения: ${err.message || ''}`, 'error');
        }
    } finally {
        _state.saving.delete(slotId);
    }
}

function _applyServerUpdate(tr, serverSlot) {
    tr.querySelectorAll('[data-field]').forEach(inp => {
        if (document.activeElement === inp) return; // не перетираем поле в фокусе
        const field = inp.dataset.field;
        const val   = serverSlot[field];
        if (inp.tagName === 'SELECT') {
            inp.value = val == null ? '' : String(val);
        } else {
            inp.value = val == null ? '' : String(val);
        }
    });
}

async function _reloadFromServer() {
    try {
        const data   = await api.get(`/admin/events/${_state.eventId}/full`);
        _state.event   = data.event;
        _state.groups  = data.groups || [];
        _state.columns = (data.columns || [])
                            .filter(c => c.visible !== false)
                            .sort((a, b) => a.order - b.order);
        _renderContent();
    } catch (err) {
        console.error('[event_editor] reload:', err);
    }
}

// ─── FIO suggest (подсказки из общей базы) ─────────────────────────────────
// Используем единый компонент fio_autocomplete — один и тот же UX везде.
// При выборе подставляем ФИО/звание/№ документа из предложенного Person
// и сразу триггерим сохранение слота (как делала старая кастомная версия).
function _attachFioSuggest() {
    const tbody = document.getElementById('evt-edit-tbody');
    if (!tbody) return;

    tbody.querySelectorAll('[data-fio-input]').forEach(input => {
        if (input.__fioAc) return; // уже подвязан
        const tr = input.closest('tr[data-slot-id]');
        if (!tr) return;

        attachFio(input, {
            container: input.parentElement, // td[position:relative]
            getExtraParams: () => ({
                rank:       tr.querySelector('[data-field="rank"]')?.value.trim()       || '',
                doc_number: tr.querySelector('[data-field="doc_number"]')?.value.trim() || '',
            }),
            onSelect: (person) => {
                const setField = (name, val) => {
                    const i = tr.querySelector(`[data-field="${name}"]`);
                    if (i && val) i.value = val;
                };
                setField('full_name',  person.full_name);
                setField('rank',       person.rank);
                setField('doc_number', person.doc_number);
                _saveSlot(tr);
            },
        });
    });
}

function _detachFioSuggest() {
    document
        .querySelectorAll('#evt-edit-tbody [data-fio-input]')
        .forEach(inp => inp.__fioAc?.destroy());
}

// ─── WebSocket обновления от других юзеров ─────────────────────────────────
function _listenWsUpdates() {
    document.removeEventListener('datachanged', _handleWsUpdate);
    document.addEventListener('datachanged', _handleWsUpdate);
}

function _handleWsUpdate(ev) {
    const eid = ev.detail?.eventId;
    if (!eid || eid != _state.eventId) return;
    // Если пользователь сейчас что-то печатает — не мешаем, подождём
    // пока поле потеряет фокус. Мягкая синхронизация.
    if (document.activeElement?.classList.contains('evt-edit__input')) return;
    _reloadFromServer();
}

// ─── Дежурный (подпись в документе) ────────────────────────────────────────
// Глобальная настройка /api/v1/settings (duty_rank + duty_name) —
// используется при экспорте .docx. То же самое сохраняет кнопка в
// панели «Выгрузка .docx» редактора шаблонов. Здесь просто дублируем UX.

async function _loadDutyOfficer() {
    try {
        const s = await api.get('/settings');
        const rankEl = document.getElementById('evt-edit-duty-rank');
        const nameEl = document.getElementById('evt-edit-duty-name');
        if (rankEl) rankEl.value = s.duty_rank || '';
        if (nameEl) nameEl.value = s.duty_name || '';
    } catch (err) {
        console.error('[event_editor] duty load:', err);
        // Ошибка не фатальна — поля остаются пустыми, кнопка работает
    }
}

async function _saveDutyOfficer() {
    const rank = document.getElementById('evt-edit-duty-rank')?.value.trim() ?? '';
    const name = document.getElementById('evt-edit-duty-name')?.value.trim() ?? '';
    try {
        await api.patch('/settings', { duty_rank: rank, duty_name: name });
        window.showSnackbar?.(
            `Дежурный сохранён: ${rank} ${name}`.trim(),
            'success'
        );
    } catch (err) {
        console.error('[event_editor] duty save:', err);
        window.showSnackbar?.('Ошибка сохранения дежурного', 'error');
    }
}


// ─── Экспорт .docx ─────────────────────────────────────────────────────────
async function _exportEvent() {
    const id = _state.eventId;
    if (!id) return;
    try {
        const blob = await api.download(`/export/events/${id}/export-word`);
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'),
            { href: url, download: `Список_${id}.docx` });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('[event_editor] export:', err);
        window.showSnackbar?.('Ошибка выгрузки', 'error');
    }
}

// Глобальный доступ — используется из dashboard и history
window.openEventEditor = openEventEditor;
