// static/js/procurement.js
//
// Гос. закупки отдела — оверлей с дашбордом ЛБО + таблицей контрактов.
// Кнопка «Гос. закупки» рендерится в dept-ops-buttons (см. comms_report.js).
//
// Один эндпоинт GET /procurement?year=YYYY возвращает всё разом:
// бюджет, список контрактов, агрегаты. Изменения шлются точечно:
//   PUT  /procurement/budget?year=YYYY
//   POST /procurement/contracts?year=YYYY
//   PUT  /procurement/contracts/{id}
//   DELETE /procurement/contracts/{id}

import { api } from './api.js';

const CURRENT_YEAR = new Date().getFullYear();

const STATUS_LABELS = {
    plan:       'План',
    tender:     'Торги объявлены',
    awarded:    'Отыграно',
    signed:     'Заключён',
    executing:  'Исполняется',
    completed:  'Исполнен',
    terminated: 'Расторгнут',
};

const METHOD_LABELS = {
    e_auction:       'Электронный аукцион',
    tender:          'Конкурс',
    quote_request:   'Запрос котировок',
    single_supplier: 'У единственного поставщика',
    other:           'Иное',
};

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtMoney(v) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return '0';
    // 1 234 567,89 ₽
    return n.toLocaleString('ru-RU', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
    }) + ' ₽';
}

function fmtMoneyShort(v) {
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n === 0) return '—';
    if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' млн ₽';
    if (Math.abs(n) >= 1_000)     return (n / 1_000).toFixed(1) + ' тыс ₽';
    return n.toFixed(2) + ' ₽';
}

function fmtDate(d) {
    if (!d) return '—';
    const [y, m, day] = String(d).split('-');
    return `${day}.${m}.${y}`;
}


// ─── Состояние ──────────────────────────────────────────────────────────────

const _state = {
    year:    CURRENT_YEAR,
    budget:  null,
    contracts: [],
    summary: null,
    overlay: null,
    editing: null,   // null или объект контракта в форме редактирования (null id = новый)
};


// ─── Открытие/закрытие ──────────────────────────────────────────────────────

export async function openProcurement() {
    _state.year = CURRENT_YEAR;
    _renderShell();
    await _reload();
}

function _close() {
    _state.overlay?.remove();
    _state.overlay = null;
    document.removeEventListener('keydown', _onEsc);
}

function _onEsc(e) { if (e.key === 'Escape') _close(); }


async function _reload() {
    try {
        const res = await api.get(`/procurement?year=${_state.year}`);
        _state.budget    = res.budget;
        _state.contracts = res.contracts || [];
        _state.summary   = res.summary;
        _renderDashboard();
        _renderTable();
    } catch (err) {
        console.error('[procurement] load:', err);
        window.showSnackbar?.(`Ошибка загрузки: ${err.message || ''}`, 'error');
    }
}


// ─── Каркас оверлея ─────────────────────────────────────────────────────────

function _renderShell() {
    document.getElementById('procurement-overlay')?.remove();

    const ov = document.createElement('div');
    ov.id = 'procurement-overlay';
    ov.className = 'pr-overlay';
    ov.innerHTML = `
        <div class="pr-dialog" role="dialog" aria-label="Гос. закупки">
            <div class="pr-header">
                <div class="pr-header__titles">
                    <div class="pr-header__title">Гос. закупки отдела</div>
                    <div class="pr-header__subtitle">
                        Учёт ЛБО, торгов и контрактов за <b id="pr-year">${_state.year}</b> г.
                    </div>
                </div>
                <div class="pr-header__actions">
                    <button class="btn btn-outlined btn-sm" id="pr-edit-budget" type="button">
                        ✎ ЛБО
                    </button>
                    <button class="btn btn-filled btn-sm" id="pr-add" type="button">
                        + Контракт
                    </button>
                    <button class="btn btn-text btn-sm" id="pr-close" type="button">Закрыть</button>
                </div>
            </div>
            <div class="pr-body">
                <div class="pr-dashboard" id="pr-dashboard">
                    <div class="pr-loading">Загрузка…</div>
                </div>
                <div class="pr-list" id="pr-list"></div>
            </div>
        </div>
    `;
    document.body.appendChild(ov);
    _state.overlay = ov;

    ov.addEventListener('click', e => { if (e.target === ov) _close(); });
    document.addEventListener('keydown', _onEsc);
    ov.querySelector('#pr-close').addEventListener('click', _close);
    ov.querySelector('#pr-edit-budget').addEventListener('click', _openBudgetForm);
    ov.querySelector('#pr-add').addEventListener('click', () => _openContractForm(null));
}


// ─── Дашборд (карточки агрегатов) ───────────────────────────────────────────

function _renderDashboard() {
    const el = document.getElementById('pr-dashboard');
    if (!el || !_state.summary) return;
    const s = _state.summary;
    const card = (label, value, tone) => `
        <div class="pr-stat ${tone ? 'pr-stat--' + tone : ''}">
            <div class="pr-stat__label">${esc(label)}</div>
            <div class="pr-stat__value">${esc(fmtMoneyShort(value))}</div>
        </div>`;
    el.innerHTML = `
        ${card('ЛБО',           s.lbo,           'lbo')}
        ${card('План',          s.planned,       'plan')}
        ${card('На торгах',     s.in_tender,     'tender')}
        ${card('Отыграно',      s.awarded,       'awarded')}
        ${card('Законтрактовано', s.contracted,  'contracted')}
        ${card('Исполнено',     s.executed,      'executed')}
        ${card('Остаток ЛБО',   s.remaining,     parseFloat(s.remaining) < 0 ? 'alert' : 'ok')}
        ${card('Экономия',      s.savings_total, 'savings')}
    `;
}


// ─── Таблица контрактов ─────────────────────────────────────────────────────

function _renderTable() {
    const el = document.getElementById('pr-list');
    if (!el) return;
    if (!_state.contracts.length) {
        el.innerHTML = `
            <div class="pr-empty">
                Контрактов на ${_state.year} год пока нет.<br>
                Нажмите «+ Контракт», чтобы добавить первый.
            </div>`;
        return;
    }
    const rows = _state.contracts.map(c => `
        <tr data-id="${c.id}">
            <td class="pr-cell-num">${esc(c.contract_number || '—')}</td>
            <td class="pr-cell-date">${esc(fmtDate(c.contract_date))}</td>
            <td class="pr-cell-supplier">
                ${esc(c.supplier_name || '—')}
                ${c.supplier_inn ? `<div class="pr-cell-sub">ИНН ${esc(c.supplier_inn)}</div>` : ''}
            </td>
            <td class="pr-cell-subject">${esc(c.subject)}</td>
            <td class="pr-cell-amount">${esc(fmtMoney(c.amount))}</td>
            <td>
                <span class="pr-status pr-status--${esc(c.status)}">
                    ${esc(STATUS_LABELS[c.status] || c.status)}
                </span>
            </td>
            <td class="pr-cell-method">${esc(METHOD_LABELS[c.procurement_method] || '—')}</td>
            <td class="pr-cell-actions">
                <button class="users-v2__icon-btn" data-edit-id="${c.id}" title="Редактировать" type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="users-v2__icon-btn users-v2__icon-btn--danger"
                        data-del-id="${c.id}" title="Удалить" type="button">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                         stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    </svg>
                </button>
            </td>
        </tr>`).join('');
    el.innerHTML = `
        <table class="pr-table">
            <thead>
                <tr>
                    <th style="min-width:120px;">№ контракта</th>
                    <th style="min-width:90px;">Дата</th>
                    <th style="min-width:200px;">Поставщик</th>
                    <th style="min-width:280px;">Предмет закупки</th>
                    <th style="min-width:140px;">Сумма</th>
                    <th style="min-width:120px;">Статус</th>
                    <th style="min-width:160px;">Способ</th>
                    <th style="width:90px;"></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;

    el.addEventListener('click', _onTableClick);
}


function _onTableClick(e) {
    const editBtn = e.target.closest('[data-edit-id]');
    if (editBtn) {
        const id = parseInt(editBtn.dataset.editId, 10);
        const c = _state.contracts.find(x => x.id === id);
        if (c) _openContractForm(c);
        return;
    }
    const delBtn = e.target.closest('[data-del-id]');
    if (delBtn) {
        const id = parseInt(delBtn.dataset.delId, 10);
        _deleteContract(id);
    }
}


// ─── Форма ЛБО ──────────────────────────────────────────────────────────────

function _openBudgetForm() {
    const cur = parseFloat(_state.budget?.lbo_amount ?? 0);
    const v = window.prompt(
        `ЛБО на ${_state.year} год (в рублях, можно с копейками):`,
        cur ? cur.toFixed(2) : '',
    );
    if (v == null) return;
    const num = parseFloat(String(v).replace(',', '.').replace(/\s/g, ''));
    if (!Number.isFinite(num) || num < 0) {
        window.showSnackbar?.('Некорректная сумма', 'error');
        return;
    }
    api.put(`/procurement/budget?year=${_state.year}`, { lbo_amount: num })
       .then(() => { window.showSnackbar?.('ЛБО обновлён', 'success'); _reload(); })
       .catch(err => window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error'));
}


// ─── Форма контракта (создать / редактировать) ──────────────────────────────

function _openContractForm(c) {
    _state.editing = c ? { ...c } : {
        contract_number: '', eis_number: '', subject: '', supplier_name: '',
        supplier_inn: '', amount: 0, savings: 0, status: 'plan',
        procurement_method: '', contract_date: '', start_date: '', end_date: '',
        notes: '',
    };

    // Закроем существующий sub-modal если был
    document.getElementById('pr-form-modal')?.remove();

    const m = document.createElement('div');
    m.id = 'pr-form-modal';
    m.className = 'pr-form-modal';

    const v = (k) => esc(_state.editing[k] ?? '');
    const statusOpts = Object.entries(STATUS_LABELS).map(
        ([k, lbl]) => `<option value="${k}" ${k === _state.editing.status ? 'selected' : ''}>${esc(lbl)}</option>`
    ).join('');
    const methodOpts = `<option value="">— не указан —</option>` +
        Object.entries(METHOD_LABELS).map(
            ([k, lbl]) => `<option value="${k}" ${k === (_state.editing.procurement_method || '') ? 'selected' : ''}>${esc(lbl)}</option>`
        ).join('');

    m.innerHTML = `
        <div class="pr-form" role="dialog">
            <div class="pr-form__head">
                <span class="pr-form__title">${c ? 'Редактирование контракта' : 'Новый контракт'}</span>
                <button class="btn btn-text btn-sm" id="pr-form-cancel" type="button">✕</button>
            </div>
            <div class="pr-form__body">
                <div class="pr-form__grid">
                    <label class="field">
                        <span class="field-label">№ контракта</span>
                        <input type="text" data-f="contract_number" value="${v('contract_number')}" maxlength="120">
                    </label>
                    <label class="field">
                        <span class="field-label">№ в ЕИС (zakupki.gov.ru)</span>
                        <input type="text" data-f="eis_number" value="${v('eis_number')}" maxlength="50">
                    </label>
                    <label class="field">
                        <span class="field-label">Дата заключения</span>
                        <input type="date" data-f="contract_date" value="${v('contract_date')}">
                    </label>
                    <label class="field">
                        <span class="field-label">Статус</span>
                        <select data-f="status">${statusOpts}</select>
                    </label>
                    <label class="field pr-form__col-2">
                        <span class="field-label">Поставщик (наименование)</span>
                        <input type="text" data-f="supplier_name" value="${v('supplier_name')}" maxlength="300">
                    </label>
                    <label class="field">
                        <span class="field-label">ИНН поставщика</span>
                        <input type="text" data-f="supplier_inn" value="${v('supplier_inn')}" maxlength="20">
                    </label>
                    <label class="field">
                        <span class="field-label">Способ закупки</span>
                        <select data-f="procurement_method">${methodOpts}</select>
                    </label>
                    <label class="field pr-form__col-2">
                        <span class="field-label">Предмет закупки *</span>
                        <textarea data-f="subject" rows="2" required>${v('subject')}</textarea>
                    </label>
                    <label class="field">
                        <span class="field-label">Сумма по контракту, ₽</span>
                        <input type="number" data-f="amount" min="0" step="0.01" value="${v('amount') || 0}">
                    </label>
                    <label class="field">
                        <span class="field-label">Экономия от НМЦК, ₽</span>
                        <input type="number" data-f="savings" min="0" step="0.01" value="${v('savings') || 0}">
                    </label>
                    <label class="field">
                        <span class="field-label">Начало исполнения</span>
                        <input type="date" data-f="start_date" value="${v('start_date')}">
                    </label>
                    <label class="field">
                        <span class="field-label">Окончание исполнения</span>
                        <input type="date" data-f="end_date" value="${v('end_date')}">
                    </label>
                    <label class="field pr-form__col-full">
                        <span class="field-label">Примечание</span>
                        <textarea data-f="notes" rows="2">${v('notes')}</textarea>
                    </label>

                    ${c ? _renderAttachmentsBlock(c) : `
                        <div class="pr-form__col-full pr-attach-hint">
                            Договор, акты и доп. соглашения можно прикрепить
                            после сохранения контракта.
                        </div>
                    `}
                </div>
            </div>
            <div class="pr-form__foot">
                <button class="btn btn-outlined btn-sm" id="pr-form-cancel-2" type="button">Отмена</button>
                <button class="btn btn-filled btn-sm"   id="pr-form-save"      type="button">Сохранить</button>
            </div>
        </div>
    `;
    _state.overlay.appendChild(m);

    m.querySelectorAll('#pr-form-cancel, #pr-form-cancel-2').forEach(b =>
        b.addEventListener('click', () => m.remove()));
    m.querySelector('#pr-form-save').addEventListener('click', () => _saveContract(m));

    // Привязываем drag-and-drop и кнопки удаления, если контракт уже сохранён
    if (c) _bindAttachments(m, c.id);
}


// ─── Вложения ───────────────────────────────────────────────────────────────

function _fmtBytes(n) {
    if (!n) return '0 Б';
    if (n < 1024)             return n + ' Б';
    if (n < 1024 * 1024)      return (n / 1024).toFixed(1) + ' КБ';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' МБ';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' ГБ';
}

function _attIconForName(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['pdf'].includes(ext))                              return '📄';
    if (['doc', 'docx'].includes(ext))                      return '📝';
    if (['xls', 'xlsx'].includes(ext))                      return '📊';
    if (['jpg', 'jpeg', 'png', 'tif', 'tiff'].includes(ext)) return '🖼';
    if (['zip'].includes(ext))                              return '🗜';
    return '📎';
}

function _renderAttachmentsBlock(contract) {
    // Список + drop-zone в одной полноширинной ячейке формы
    const items = (contract.attachments || []).map(a => `
        <li class="pr-attach__item" data-id="${a.id}">
            <span class="pr-attach__icon">${_attIconForName(a.original_name)}</span>
            <button class="pr-attach__name" type="button" data-att-download="${a.id}"
                    title="Скачать ${esc(a.original_name)}">
                ${esc(a.original_name)}
            </button>
            <span class="pr-attach__size">${_fmtBytes(a.size_bytes)}</span>
            <button class="pr-attach__del" type="button" data-att-del="${a.id}"
                    title="Удалить файл" aria-label="Удалить">
                ✕
            </button>
        </li>
    `).join('');

    return `
        <div class="pr-form__col-full pr-attach">
            <div class="pr-attach__head">
                <span class="field-label">Вложения (договор, акты, доп. соглашения)</span>
                <span class="pr-attach__hint">PDF · DOC · XLS · JPG · ZIP — до 25 МБ</span>
            </div>
            <ul class="pr-attach__list" id="pr-attach-list">
                ${items || '<li class="pr-attach__empty">Файлов пока нет</li>'}
            </ul>
            <label class="pr-attach__drop" id="pr-attach-drop">
                <input type="file" id="pr-attach-input" multiple
                       accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.tif,.tiff,.zip"
                       style="display:none;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                     style="width:24px;height:24px;">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span>Перетащите файлы сюда или нажмите для выбора</span>
            </label>
        </div>
    `;
}


function _bindAttachments(modal, contractId) {
    const drop  = modal.querySelector('#pr-attach-drop');
    const input = modal.querySelector('#pr-attach-input');
    const list  = modal.querySelector('#pr-attach-list');
    if (!drop || !input || !list) return;

    // Клик по drop-зоне → системный диалог
    drop.addEventListener('click', (e) => {
        // не дёргаем диалог при клике именно по input (label сам сработает)
        if (e.target === input) return;
        input.click();
    });

    input.addEventListener('change', () => {
        if (input.files && input.files.length) {
            _uploadFiles(contractId, Array.from(input.files));
            input.value = '';
        }
    });

    // Drag-and-drop. preventDefault на dragover критичен — иначе drop не сработает.
    ['dragenter', 'dragover'].forEach(ev =>
        drop.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation();
            drop.classList.add('pr-attach__drop--active');
        }));
    ['dragleave', 'drop'].forEach(ev =>
        drop.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation();
            drop.classList.remove('pr-attach__drop--active');
        }));
    drop.addEventListener('drop', (e) => {
        const files = e.dataTransfer?.files;
        if (files && files.length) _uploadFiles(contractId, Array.from(files));
    });

    // Делегируем клики по списку (скачать / удалить)
    list.addEventListener('click', async (e) => {
        const dlBtn  = e.target.closest('[data-att-download]');
        const delBtn = e.target.closest('[data-att-del]');
        if (dlBtn) {
            const id = parseInt(dlBtn.dataset.attDownload, 10);
            await _downloadAttachment(id, dlBtn.textContent.trim());
            return;
        }
        if (delBtn) {
            const id = parseInt(delBtn.dataset.attDel, 10);
            if (window.confirm('Удалить этот файл?')) await _deleteAttachment(id);
        }
    });
}


async function _uploadFiles(contractId, files) {
    const list = document.getElementById('pr-attach-list');
    for (const file of files) {
        // Покажем строку-плейсхолдер с прогрессом, заменим её ответом сервера
        const tempId = 'temp-' + Math.random().toString(36).slice(2);
        if (list) {
            const li = document.createElement('li');
            li.className = 'pr-attach__item pr-attach__item--uploading';
            li.id = tempId;
            li.innerHTML = `
                <span class="pr-attach__icon">⏳</span>
                <span class="pr-attach__name">${esc(file.name)}</span>
                <span class="pr-attach__size">${_fmtBytes(file.size)}</span>`;
            const empty = list.querySelector('.pr-attach__empty');
            if (empty) empty.remove();
            list.appendChild(li);
        }

        try {
            const fd = new FormData();
            fd.append('file', file);
            const att = await api.upload(
                `/procurement/contracts/${contractId}/attachments`, fd
            );
            // Заменяем плейсхолдер реальной строкой
            const tmp = document.getElementById(tempId);
            if (tmp) {
                tmp.outerHTML = `
                    <li class="pr-attach__item" data-id="${att.id}">
                        <span class="pr-attach__icon">${_attIconForName(att.original_name)}</span>
                        <button class="pr-attach__name" type="button" data-att-download="${att.id}"
                                title="Скачать ${esc(att.original_name)}">
                            ${esc(att.original_name)}
                        </button>
                        <span class="pr-attach__size">${_fmtBytes(att.size_bytes)}</span>
                        <button class="pr-attach__del" type="button" data-att-del="${att.id}"
                                title="Удалить файл" aria-label="Удалить">✕</button>
                    </li>`;
            }
            window.showSnackbar?.(`Загружено: ${att.original_name}`, 'success');
            // Обновим in-memory state, чтобы при reopen формы было видно
            const c = _state.contracts.find(x => x.id === contractId);
            if (c) {
                c.attachments = c.attachments || [];
                c.attachments.unshift(att);
            }
        } catch (err) {
            console.error('[procurement] upload:', err);
            const tmp = document.getElementById(tempId);
            if (tmp) tmp.remove();
            window.showSnackbar?.(
                `Ошибка загрузки «${file.name}»: ${err.message || ''}`, 'error');
        }
    }
}


async function _downloadAttachment(id, filename) {
    try {
        const blob = await api.download(`/procurement/attachments/${id}/download`);
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'),
            { href: url, download: filename || `file-${id}` });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('[procurement] download:', err);
        window.showSnackbar?.(`Ошибка скачивания: ${err.message || ''}`, 'error');
    }
}


async function _deleteAttachment(id) {
    try {
        await api.delete(`/procurement/attachments/${id}`);
        document.querySelector(`[data-id="${id}"].pr-attach__item`)?.remove();
        const list = document.getElementById('pr-attach-list');
        if (list && !list.querySelector('.pr-attach__item')) {
            list.innerHTML = '<li class="pr-attach__empty">Файлов пока нет</li>';
        }
        // Подчищаем in-memory state
        for (const c of _state.contracts) {
            if (c.attachments) c.attachments = c.attachments.filter(a => a.id !== id);
        }
        window.showSnackbar?.('Файл удалён', 'success');
    } catch (err) {
        console.error('[procurement] delete attachment:', err);
        window.showSnackbar?.(`Ошибка удаления: ${err.message || ''}`, 'error');
    }
}


async function _saveContract(modal) {
    const editing = _state.editing;
    const collect = (f) => {
        const el = modal.querySelector(`[data-f="${f}"]`);
        return el ? el.value : '';
    };
    // Преобразуем значения в типы, ожидаемые API.
    const payload = {
        contract_number:    collect('contract_number') || null,
        eis_number:         collect('eis_number')      || null,
        subject:            collect('subject').trim(),
        supplier_name:      collect('supplier_name')   || null,
        supplier_inn:       collect('supplier_inn')    || null,
        amount:             parseFloat(collect('amount')  || 0) || 0,
        savings:            parseFloat(collect('savings') || 0) || 0,
        status:             collect('status') || 'plan',
        procurement_method: collect('procurement_method') || null,
        contract_date:      collect('contract_date') || null,
        start_date:         collect('start_date')    || null,
        end_date:           collect('end_date')      || null,
        notes:              collect('notes')         || null,
    };
    if (!payload.subject) {
        window.showSnackbar?.('Укажите предмет закупки', 'error'); return;
    }

    try {
        if (editing.id) {
            await api.put(`/procurement/contracts/${editing.id}`, payload);
            window.showSnackbar?.('Контракт обновлён', 'success');
        } else {
            await api.post(`/procurement/contracts?year=${_state.year}`, payload);
            window.showSnackbar?.('Контракт добавлен', 'success');
        }
        modal.remove();
        _state.editing = null;
        _reload();
    } catch (err) {
        console.error('[procurement] save:', err);
        window.showSnackbar?.(`Ошибка сохранения: ${err.message || ''}`, 'error');
    }
}


async function _deleteContract(id) {
    const c = _state.contracts.find(x => x.id === id);
    if (!c) return;
    if (!window.confirm(
        `Удалить контракт «${c.subject.slice(0, 60)}»?\nДействие необратимо.`
    )) return;
    try {
        await api.delete(`/procurement/contracts/${id}`);
        window.showSnackbar?.('Контракт удалён', 'success');
        _reload();
    } catch (err) {
        console.error('[procurement] delete:', err);
        window.showSnackbar?.(`Ошибка удаления: ${err.message || ''}`, 'error');
    }
}


window.openProcurement = openProcurement;
