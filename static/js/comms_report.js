// static/js/comms_report.js
//
// Модуль Формы 3-СВЯЗЬ (отчёт отдела связи).
// Состоит из двух частей:
//   mountOpsPanel()  — рендерит кнопки операций в dept-ops-panel
//                      (пока одна: «Сформировать отчёт 3-СВЯЗЬ»)
//   openReportEditor() — оверлей с 18 карточками-направлениями,
//                        раскрытие с редактированием позиций,
//                        сохранение и экспорт .docx.
//
// Данные хранятся в БД в таблице comms_reports (см. app/models/comms_report.py),
// структура формируется из app/data/comms_report_defaults.py.

import { api } from './api.js';

const CURRENT_YEAR = new Date().getFullYear();
const NUMERIC_FIELDS = [
    'required', 'start', 'arrived', 'removed',
    'working', 'modern', 'overdue',
    'nz', 'td', 'backup_fund', 'mchs_reserve',
    'capital_repair', 'mb', 'written_off', 'plus',
];

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toInt(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
}

// ── Математика производных значений ─────────────────────────────────────────
// total   = start + arrived - removed
// percent = round(total / required * 100), если required>0; иначе 0 или 100
// diff    = total - required
function derivedFor(item) {
    const required = toInt(item.required);
    const total    = toInt(item.start) + toInt(item.arrived) - toInt(item.removed);
    let   percent;
    if (required > 0)     percent = Math.round(total / required * 100);
    else if (total === 0) percent = 0;
    else                  percent = 100;
    const diff = total - required;
    return { total, percent, diff };
}

// Сумма направления — по всем позициям, кроме is_group (заголовков).
function categorySum(cat) {
    const leafs = (cat.items || []).filter(i => !i.is_group);
    const sum = Object.fromEntries(NUMERIC_FIELDS.map(f => [f, 0]));
    for (const it of leafs) for (const f of NUMERIC_FIELDS) sum[f] += toInt(it[f]);
    const required = sum.required;
    const total    = sum.start + sum.arrived - sum.removed;
    let percent;
    if (required > 0)     percent = Math.round(total / required * 100);
    else if (total === 0) percent = 0;
    else                  percent = 100;
    return { ...sum, total, percent, diff: total - required };
}


// ── Панель операций в dept-view ─────────────────────────────────────────────

// Каждой операции назначен идентификатор модуля. Видимость карточки
// определяется списком user.available_modules (приходит из /auth/me).
// Бэкенд хранит привязку username ↔ модуль в env-переменных
// COMMS_UNIT_USERNAMES, MEDIA_UNIT_USERNAMES, PROCUREMENT_UNIT_USERNAMES,
// TRAINING_UNIT_USERNAMES — пустое значение = модуль открыт всем unit'ам
// (бэкворд-совместимость для старых установок).
const OPERATIONS = [
    {
        id:       'comms-3',
        module:   'comms',
        title:    'Форма 3-СВЯЗЬ',
        desc:     'Ежегодный отчёт об укомплектованности средствами связи, ' +
                  'вычислительной и оргтехникой. Редактируется по 18 направлениям.',
        icon: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
            </svg>`,
        run: () => openReportEditor(),
    },
    {
        id:       'procurement',
        module:   'procurement',
        title:    'Гос. закупки',
        desc:     'Учёт ЛБО, торгов и контрактов. Сколько отыграно, ' +
                  'законтрактовано, остаток и экономия.',
        icon: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 11V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8"/>
                <path d="M16 3v4M8 3v4M3 11h18"/>
                <circle cx="18" cy="18" r="3"/>
                <path d="M18 16v2l1 1"/>
            </svg>`,
        run: () => import('./procurement.js').then(m => m.openProcurement()),
    },
    {
        id:       'media',
        module:   'media',
        title:    'Учёт МНИ',
        desc:     'Машинные носители информации (флешки, SSD, HDD, SD-карты). ' +
                  'Учёт, выдача, журнал движений, печать бирок.',
        icon: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="6" y="3" width="12" height="14" rx="1"/>
                <rect x="9" y="6" width="6" height="4"/>
                <path d="M9 17v4M15 17v4"/>
            </svg>`,
        run: () => import('./media.js').then(m => m.openMedia()),
    },
    {
        id:       'training',
        module:   'training',
        title:    'Профессиональная подготовка',
        desc:     'Темы тестирования, генерация QR-кодов и ссылок для ' +
                  'персонального прохождения тестов сотрудниками.',
        icon: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
                <path d="M6 12v5c3 3 9 3 12 0v-5"/>
            </svg>`,
        // Версия в query — чтобы при обновлении модуля браузер не отдавал
        // старую кэшированную копию. Меняй число при правках training_admin.js
        // если пользователи жалуются «не вижу новую кнопку».
        run: () => import('./training_admin.js?v=4').then(m => m.openTraining()),
    },
    // Будущие операции — добавятся сюда. Если у операции нет module —
    // карточка видна всем (общая для всех отделов).
];


// Фильтрует операции по списку user.available_modules. Если поля нет
// (старая версия бэкенда без /auth/me-расширения) — возвращаем все,
// чтобы не сломать UX.
function _filterOps() {
    const user = window.currentUser;
    if (!user) return [];

    const modules = user.available_modules;
    if (!Array.isArray(modules)) {
        // Бэкенд не сообщил список — fallback на полный набор.
        return OPERATIONS;
    }
    const allow = new Set(modules);
    return OPERATIONS.filter(op => !op.module || allow.has(op.module));
}

export function mountOpsPanel() {
    const root = document.getElementById('dept-ops-buttons');
    if (!root) return;
    const visibleOps = _filterOps();
    if (!visibleOps.length) {
        root.innerHTML = `
            <div class="ops-empty">
                Для вашего отдела пока не назначены модули операций.
                Обратитесь к администратору.
            </div>`;
        return;
    }
    root.innerHTML = visibleOps.map(op => `
        <section class="ops-section">
            <button class="ops-card" type="button" data-op-id="${op.id}">
                <span class="ops-card__icon">${op.icon}</span>
                <span class="ops-card__body">
                    <span class="ops-card__title">${esc(op.title)}</span>
                    <span class="ops-card__desc">${esc(op.desc)}</span>
                </span>
                <svg class="ops-card__chevron" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
            </button>
        </section>
    `).join('');

    root.addEventListener('click', (e) => {
        const card = e.target.closest('.ops-card');
        if (!card) return;
        const op = OPERATIONS.find(o => o.id === card.dataset.opId);
        op?.run?.();
    });
}


// ── Редактор отчёта: состояние ──────────────────────────────────────────────

const _state = {
    year:     CURRENT_YEAR,
    unit:     null,     // username отдела (для запросов; admin может override)
    data:     [],       // массив направлений
    dirty:    false,    // есть несохранённые изменения
    overlay:  null,
};


export async function openReportEditor() {
    _state.year = CURRENT_YEAR;
    _state.dirty = false;

    _renderShell();

    try {
        const report = await api.get(`/comms-report?year=${_state.year}`);
        _state.unit = report.unit_username;
        _state.data = report.data || [];
        _renderCards();
    } catch (err) {
        console.error('[comms-report] load:', err);
        _setStatus(`Ошибка загрузки: ${err.message || ''}`, 'error');
    }
}


function _closeOverlay() {
    if (_state.dirty && !window.confirm('Есть несохранённые изменения. Закрыть без сохранения?')) {
        return;
    }
    _state.overlay?.remove();
    _state.overlay = null;
    document.removeEventListener('keydown', _escHandler);
}

function _escHandler(e) { if (e.key === 'Escape') _closeOverlay(); }


function _renderShell() {
    document.getElementById('comms-report-overlay')?.remove();

    const ov = document.createElement('div');
    ov.id = 'comms-report-overlay';
    ov.className = 'cr-overlay';
    ov.innerHTML = `
        <div class="cr-dialog" role="dialog" aria-label="Форма 3-СВЯЗЬ">
            <div class="cr-header">
                <div class="cr-header__titles">
                    <div class="cr-header__title">Форма 3-СВЯЗЬ</div>
                    <div class="cr-header__subtitle">
                        Отчёт об обеспеченности средствами связи на 1 января ${_state.year + 1} г.
                    </div>
                </div>
                <div class="cr-header__actions">
                    <span class="cr-status" id="cr-status"></span>
                    <button class="btn btn-outlined btn-sm" id="cr-export" type="button">
                        ⬇ .docx
                    </button>
                    <button class="btn btn-filled btn-sm" id="cr-save" type="button">
                        💾 Сохранить
                    </button>
                    <button class="btn btn-text btn-sm" id="cr-close" type="button">Закрыть</button>
                </div>
            </div>
            <div class="cr-body" id="cr-body">
                <div class="cr-loading">Загрузка отчёта…</div>
            </div>
        </div>
    `;
    document.body.appendChild(ov);
    _state.overlay = ov;

    ov.querySelector('#cr-close').addEventListener('click', _closeOverlay);
    ov.querySelector('#cr-save' ).addEventListener('click', _saveReport);
    ov.querySelector('#cr-export').addEventListener('click', _exportReport);
    ov.addEventListener('click', (e) => { if (e.target === ov) _closeOverlay(); });
    document.addEventListener('keydown', _escHandler);
}


function _setStatus(text, kind = 'ok') {
    const el = document.getElementById('cr-status');
    if (!el) return;
    el.className = `cr-status cr-status--${kind}`;
    el.textContent = text;
    if (kind === 'ok' || kind === 'saved') {
        setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2400);
    }
}


// ── Рендер карточек направлений ─────────────────────────────────────────────

function _renderCards() {
    const body = document.getElementById('cr-body');
    if (!body) return;

    body.innerHTML = _state.data.map((cat, idx) => _renderCategoryCard(cat, idx)).join('');

    // Открытие/закрытие карточки
    body.querySelectorAll('.cr-card').forEach(card => {
        const head = card.querySelector('.cr-card__head');
        head.addEventListener('click', () => {
            card.classList.toggle('cr-card--open');
        });
    });

    // Блюр инпута → обновить итог направления + отметить dirty
    body.addEventListener('input', _onInputChange);
    body.addEventListener('change', _onInputChange);
}


function _renderCategoryCard(cat, idx) {
    const sum = categorySum(cat);
    const statusClass = sum.percent >= 90 ? 'ok'
                      : sum.percent >= 60 ? 'warn'
                      : 'alert';
    const rows = (cat.items || []).map((it, rowIdx) =>
        _renderItemRow(cat, idx, it, rowIdx)
    ).join('');

    return `
        <section class="cr-card" data-cat-idx="${idx}">
            <button type="button" class="cr-card__head">
                <span class="cr-card__num">${cat.index}</span>
                <span class="cr-card__title">${esc(cat.title)}</span>
                <span class="cr-card__stats">
                    <span class="cr-stat"><span class="cr-stat__lbl">Потреб.</span><span>${sum.required}</span></span>
                    <span class="cr-stat"><span class="cr-stat__lbl">В наличии</span><span>${sum.total}</span></span>
                    <span class="cr-stat cr-stat--${statusClass}">
                        <span class="cr-stat__lbl">%</span><span>${sum.percent}</span>
                    </span>
                    <span class="cr-stat">
                        <span class="cr-stat__lbl">+/−</span>
                        <span>${sum.diff > 0 ? '+' : ''}${sum.diff}</span>
                    </span>
                </span>
                <svg class="cr-card__chevron" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </button>
            <div class="cr-card__body">
                <div class="cr-table-wrap">
                    <table class="cr-table">
                        <thead>
                            <tr>
                                <th style="min-width:200px; text-align:left;">Позиция</th>
                                <th title="Потребность">Потр.</th>
                                <th title="Состояло на начало года">Нач.</th>
                                <th title="Прибыло">Приб.</th>
                                <th title="Убыло">Уб.</th>
                                <th title="Всего в наличии (авто)">Всего</th>
                                <th title="В наличии исправной">Испр.</th>
                                <th title="В наличии современной">Совр.</th>
                                <th title="Со сроком службы свыше установленного">Св. срока</th>
                                <th title="В «НЗ» (неприкосновенный запас)">НЗ</th>
                                <th title="На «ТД» (текущий довольствующий)">ТД</th>
                                <th title="Подменный фонд 2-3 кат">Подм. фонд</th>
                                <th title="Резерв МЧС России">Резерв МЧС</th>
                                <th title="В т.ч. кап. ремонт">Кап. рем.</th>
                                <th title="На МБ">МБ</th>
                                <th title="В т.ч. списано">Списано</th>
                                <th title="В запасах центров">В запасах</th>
                                <th title="Укомплектованность %">%</th>
                                <th title="Недостаёт / излишествует">+/−</th>
                                <th style="min-width:120px; text-align:left;">Примечание</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
}


function _renderItemRow(cat, catIdx, item, rowIdx) {
    // colspan = всего колонок таблицы (см. _renderCategoryCard thead): 1+19+1 = 21
    if (item.is_group) {
        return `
            <tr class="cr-row cr-row--group"
                data-cat="${catIdx}" data-row="${rowIdx}">
                <td colspan="21" class="cr-row__group-title">${esc(item.name)}</td>
            </tr>`;
    }
    const d = derivedFor(item);
    const diffClass = d.diff > 0 ? 'cr-diff--plus' : d.diff < 0 ? 'cr-diff--minus' : '';
    const pctClass  = d.percent >= 90 ? 'cr-pct--ok'
                    : d.percent >= 60 ? 'cr-pct--warn'
                    :                   'cr-pct--alert';
    const field = (f) => `
        <td><input type="number" min="0" class="cr-cell"
                   data-cat="${catIdx}" data-row="${rowIdx}" data-field="${f}"
                   value="${esc(item[f] ?? 0)}"></td>`;
    return `
        <tr class="cr-row" data-cat="${catIdx}" data-row="${rowIdx}">
            <td class="cr-row__name">${esc(item.name)}</td>
            ${field('required')}
            ${field('start')}
            ${field('arrived')}
            ${field('removed')}
            <td class="cr-derived"><span data-derived="total">${d.total}</span></td>
            ${field('working')}
            ${field('modern')}
            ${field('overdue')}
            ${field('nz')}
            ${field('td')}
            ${field('backup_fund')}
            ${field('mchs_reserve')}
            ${field('capital_repair')}
            ${field('mb')}
            ${field('written_off')}
            ${field('plus')}
            <td class="cr-derived ${pctClass}"><span data-derived="percent">${d.percent}</span></td>
            <td class="cr-derived ${diffClass}">
                <span data-derived="diff">${d.diff > 0 ? '+' : ''}${d.diff}</span>
            </td>
            <td><input type="text" class="cr-cell cr-cell--text"
                       data-cat="${catIdx}" data-row="${rowIdx}" data-field="note"
                       value="${esc(item.note || '')}"></td>
        </tr>`;
}


// ── Обработчики ввода ───────────────────────────────────────────────────────

function _onInputChange(e) {
    const input = e.target.closest('.cr-cell');
    if (!input) return;
    const catIdx = parseInt(input.dataset.cat, 10);
    const rowIdx = parseInt(input.dataset.row, 10);
    const field  = input.dataset.field;
    if (Number.isNaN(catIdx) || Number.isNaN(rowIdx) || !field) return;

    const item = _state.data[catIdx]?.items?.[rowIdx];
    if (!item) return;

    const newVal = field === 'note' ? input.value : toInt(input.value);
    if (item[field] === newVal) return;
    item[field] = newVal;
    _state.dirty = true;

    // Пересчёт строки + суммарной карточки
    _refreshRow(catIdx, rowIdx);
    _refreshCategoryHeader(catIdx);
}


function _refreshRow(catIdx, rowIdx) {
    const row = _state.overlay?.querySelector(
        `tr[data-cat="${catIdx}"][data-row="${rowIdx}"]`
    );
    if (!row) return;
    const it = _state.data[catIdx].items[rowIdx];
    const d = derivedFor(it);
    const setDerived = (key, val, cls) => {
        const span = row.querySelector(`[data-derived="${key}"]`);
        if (!span) return;
        span.textContent = val;
        if (cls !== undefined) {
            const td = span.parentElement;
            td.className = 'cr-derived';
            if (cls) td.classList.add(cls);
        }
    };
    setDerived('total',   d.total);
    setDerived('percent', d.percent,
        d.percent >= 90 ? 'cr-pct--ok'
        : d.percent >= 60 ? 'cr-pct--warn'
        : 'cr-pct--alert');
    setDerived('diff',
        `${d.diff > 0 ? '+' : ''}${d.diff}`,
        d.diff > 0 ? 'cr-diff--plus' : d.diff < 0 ? 'cr-diff--minus' : '');
}


function _refreshCategoryHeader(catIdx) {
    const card = _state.overlay?.querySelector(`.cr-card[data-cat-idx="${catIdx}"]`);
    if (!card) return;
    const cat = _state.data[catIdx];
    const sum = categorySum(cat);
    const stats = card.querySelectorAll('.cr-card__head .cr-stat');
    if (stats.length >= 4) {
        stats[0].querySelector('span:last-child').textContent = sum.required;
        stats[1].querySelector('span:last-child').textContent = sum.total;
        const pctStat = stats[2];
        pctStat.classList.remove('cr-stat--ok', 'cr-stat--warn', 'cr-stat--alert');
        pctStat.classList.add(sum.percent >= 90 ? 'cr-stat--ok'
                            : sum.percent >= 60 ? 'cr-stat--warn'
                            : 'cr-stat--alert');
        pctStat.querySelector('span:last-child').textContent = sum.percent;
        stats[3].querySelector('span:last-child').textContent =
            `${sum.diff > 0 ? '+' : ''}${sum.diff}`;
    }
}


// ── Save / Export ───────────────────────────────────────────────────────────

async function _saveReport() {
    _setStatus('Сохранение…', 'saving');
    try {
        const payload = { data: _state.data };
        const res = await api.put(`/comms-report?year=${_state.year}`, payload);
        _state.data = res.data || _state.data;
        _state.dirty = false;
        _setStatus('Сохранено ✓', 'saved');
    } catch (err) {
        console.error('[comms-report] save:', err);
        _setStatus(`Ошибка сохранения: ${err.message || ''}`, 'error');
    }
}


async function _exportReport() {
    if (_state.dirty) {
        if (!window.confirm('Есть несохранённые изменения. Сохранить перед экспортом?')) return;
        await _saveReport();
        if (_state.dirty) return; // сохранение не удалось
    }
    try {
        const blob = await api.download(`/comms-report/export?year=${_state.year}`);
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'),
            { href: url, download: `Форма_3-СВЯЗЬ_${_state.year}.docx` });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        _setStatus('Отчёт сформирован', 'saved');
    } catch (err) {
        console.error('[comms-report] export:', err);
        _setStatus('Ошибка экспорта', 'error');
    }
}


// Экспорт в window для удобной отладки (и чтобы dept-tab-switcher мог открыть)
window.openCommsReport = openReportEditor;
