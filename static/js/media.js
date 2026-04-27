// static/js/media.js
//
// Учёт машинных носителей информации (МНИ): флешки, SSD, HDD, SD-карты, диски.
// Открывается из Операций отдела.
//
// Состоит из:
//   • дашборд агрегатов (всего/выдано/на хранении/списано/утрачено + по типам)
//   • таблица носителей с фильтрами поиска / типа / статуса
//   • форма создания/редактирования
//   • действия: «Выдать», «Вернуть», «Удалить»
//   • экспорт бирок в .docx (сетка как на Лист2 эталонного Excel)

import { api } from './api.js';
import { attach as attachFio } from './fio_autocomplete.js';

const TYPE_LABELS = {
    flash:  'Флешка USB',
    ssd:    'SSD',
    hdd:    'HDD',
    sd:     'SD-карта',
    cd_dvd: 'CD/DVD',
    other:  'Прочее',
};
const CLASS_LABELS = {
    open:       'Открытый',
    dsp:        'ДСП',
    secret:     'Секретно',
    top_secret: 'Совсекретно',
};
const STATUS_LABELS = {
    available:   'На хранении',
    issued:      'Выдан',
    broken:      'Неисправен',
    written_off: 'Списан',
    lost:        'Утрачен',
};

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fmtDate(d) {
    if (!d) return '—';
    const [y, m, day] = String(d).split('-');
    return `${day}.${m}.${y}`;
}


// ─── Состояние ──────────────────────────────────────────────────────────────

const _state = {
    items:     [],
    summary:   null,
    overlay:   null,
    filters:   { q: '', status: '', type: '', dept: '' },
    // «Все управления» рассчитываем при первой нелейфильтрованной загрузке
    // и кэшируем — иначе при выборе фильтра «3 упр.» список вариантов
    // схлопнется до одного.
    allDepartments: [],
    // Группировка таблицы по держателю — удобнее когда у одного человека
    // несколько флешек: они показываются вместе с общим счётчиком.
    // По умолчанию ВКЛЮЧЕНА: сразу видно у кого сколько и какие флешки.
    groupByHolder: true,
    expandedGroups: new Set(),   // ключи раскрытых групп держателей
    expandedItemId: null,        // id флешки с раскрытой панелью действий
};


// WS-обработчик — обновляем список при изменении персоны в общей базе.
// Хранится в модуле, чтобы можно было корректно удалить при закрытии.
function _onPersonUpdate() { _reload(); }

export async function openMedia() {
    _renderShell();
    await _reload();
    document.addEventListener('person-update', _onPersonUpdate);
}

function _close() {
    _state.overlay?.remove();
    _state.overlay = null;
    document.removeEventListener('keydown', _onEsc);
    document.removeEventListener('person-update', _onPersonUpdate);
}
function _onEsc(e) { if (e.key === 'Escape') _close(); }


async function _reload() {
    const params = new URLSearchParams();
    if (_state.filters.q)      params.set('q',      _state.filters.q);
    if (_state.filters.status) params.set('status', _state.filters.status);
    if (_state.filters.type)   params.set('type',   _state.filters.type);
    if (_state.filters.dept)   params.set('dept',   _state.filters.dept);
    try {
        const res = await api.get(`/media?${params.toString()}`);
        _state.items   = res.items || [];
        _state.summary = res.summary;
        // Кэш «всех управлений» — обновляем только когда фильтр сброшен,
        // иначе список схлопнется до одного выбранного значения.
        if (!_state.filters.dept && res.summary?.by_department) {
            _state.allDepartments = Object.keys(res.summary.by_department).sort(
                (a, b) => a.localeCompare(b, 'ru')
            );
        }
        _renderDashboard();
        _renderDeptFilterOptions();
        _renderTable();
    } catch (err) {
        console.error('[media] load:', err);
        window.showSnackbar?.(`Ошибка загрузки: ${err.message || ''}`, 'error');
    }
}


// ─── Каркас ─────────────────────────────────────────────────────────────────

function _renderShell() {
    document.getElementById('media-overlay')?.remove();

    const ov = document.createElement('div');
    ov.id = 'media-overlay';
    ov.className = 'md-overlay';
    ov.innerHTML = `
        <div class="md-dialog" role="dialog" aria-label="Учёт МНИ">
            <div class="md-header">
                <div class="md-header__titles">
                    <div class="md-header__title">Учёт машинных носителей информации</div>
                    <div class="md-header__subtitle">
                        Флешки, SSD, HDD, SD-карты, диски — учёт + бирки + журнал движений.
                    </div>
                </div>
                <div class="md-header__actions">
                    <button class="btn btn-text btn-sm" id="md-template-dl" type="button"
                            title="Скачать шаблон Excel для массовой загрузки">
                        📥 Шаблон
                    </button>
                    <button class="btn btn-outlined btn-sm" id="md-import-btn" type="button"
                            title="Импортировать носители из Excel">
                        ⬆ Импорт
                    </button>
                    <input type="file" id="md-import-input" accept=".xlsx,.xls"
                           style="display:none;">
                    <button class="btn btn-outlined btn-sm" id="md-tags-export" type="button">
                        🏷 Бирки .docx
                    </button>
                    <button class="btn btn-text btn-sm" id="md-cleanup" type="button"
                            title="Удалить пустые записи (без держателя, серийника, объёма)">
                        🧹 Очистить пустые
                    </button>
                    <button class="btn btn-filled btn-sm" id="md-add" type="button">
                        + Носитель
                    </button>
                    <button class="btn btn-text btn-sm" id="md-close" type="button">Закрыть</button>
                </div>
            </div>
            <div class="md-body">
                <div class="md-dashboard" id="md-dashboard">
                    <div class="md-loading">Загрузка…</div>
                </div>
                <div class="md-toolbar">
                    <input type="text" id="md-search" placeholder="Поиск по инв.№, ФИО, серийному…"
                           autocomplete="off" class="md-search-input">
                    <select id="md-filter-status">
                        <option value="">Все статусы</option>
                        ${Object.entries(STATUS_LABELS).map(
                            ([k, v]) => `<option value="${k}">${esc(v)}</option>`
                        ).join('')}
                    </select>
                    <select id="md-filter-type">
                        <option value="">Все типы</option>
                        ${Object.entries(TYPE_LABELS).map(
                            ([k, v]) => `<option value="${k}">${esc(v)}</option>`
                        ).join('')}
                    </select>
                    <select id="md-filter-dept">
                        <option value="">Все управления</option>
                        <!-- options заполняет _renderDeptFilterOptions -->
                    </select>
                    <button class="btn ${_state.groupByHolder ? 'btn-filled' : 'btn-outlined'} btn-sm"
                            id="md-group-toggle" type="button"
                            title="Переключить: группировка по держателю / плоский список">
                        👥 По держателю
                    </button>
                </div>
                <div class="md-list" id="md-list"></div>
            </div>
        </div>
    `;
    document.body.appendChild(ov);
    _state.overlay = ov;

    ov.addEventListener('click', e => { if (e.target === ov) _close(); });
    document.addEventListener('keydown', _onEsc);
    ov.querySelector('#md-close').addEventListener('click', _close);
    ov.querySelector('#md-add').addEventListener('click', () => _openForm(null));
    ov.querySelector('#md-tags-export').addEventListener('click', _exportTags);
    ov.querySelector('#md-template-dl').addEventListener('click', _downloadTemplate);
    ov.querySelector('#md-import-btn').addEventListener('click',
        () => ov.querySelector('#md-import-input').click());
    ov.querySelector('#md-import-input').addEventListener('change', _handleImportFile);
    ov.querySelector('#md-cleanup').addEventListener('click', _cleanupEmpty);

    // Делегированный клик по списку — обрабатывает раскрытия и кнопки действий.
    // Вешаем один раз: #md-list внутри перерисовывается через innerHTML, но
    // сам контейнер не пересоздаётся.
    ov.querySelector('#md-list').addEventListener('click', _onListClick);

    // Фильтры с дебаунсом для поиска
    let timer = null;
    ov.querySelector('#md-search').addEventListener('input', (e) => {
        clearTimeout(timer);
        _state.filters.q = e.target.value.trim();
        timer = setTimeout(_reload, 280);
    });
    ov.querySelector('#md-filter-status').addEventListener('change', (e) => {
        _state.filters.status = e.target.value; _reload();
    });
    ov.querySelector('#md-filter-type').addEventListener('change', (e) => {
        _state.filters.type = e.target.value; _reload();
    });
    ov.querySelector('#md-filter-dept').addEventListener('change', (e) => {
        _state.filters.dept = e.target.value; _reload();
    });
    ov.querySelector('#md-group-toggle').addEventListener('click', (e) => {
        _state.groupByHolder = !_state.groupByHolder;
        e.currentTarget.classList.toggle('btn-filled', _state.groupByHolder);
        e.currentTarget.classList.toggle('btn-outlined', !_state.groupByHolder);
        _renderTable();
    });
}


// Заполняет options селекта «Все управления» из закэшированного списка.
// Сохраняет текущее выбранное значение, чтобы переключение не сбрасывалось.
function _renderDeptFilterOptions() {
    const sel = document.getElementById('md-filter-dept');
    if (!sel) return;
    const current = _state.filters.dept;
    const opts = ['<option value="">Все управления</option>']
        .concat(_state.allDepartments.map(d =>
            `<option value="${esc(d)}" ${d === current ? 'selected' : ''}>${esc(d)}</option>`
        ));
    // Добавим псевдо-опцию «без управления», если такие записи существуют
    const summary = _state.summary?.by_department || {};
    const totalKnown = _state.allDepartments.reduce(
        (s, d) => s + (summary[d] || 0), 0);
    if ((_state.summary?.total || 0) > totalKnown) {
        opts.push(`<option value="—" ${current === '—' ? 'selected' : ''}>— без управления —</option>`);
    }
    sel.innerHTML = opts.join('');
    if (current) sel.value = current;
}


// ─── Дашборд ────────────────────────────────────────────────────────────────

function _renderDashboard() {
    const el = document.getElementById('md-dashboard');
    if (!el || !_state.summary) return;
    const s = _state.summary;
    const card = (label, value, tone = '') => `
        <div class="md-stat ${tone ? 'md-stat--' + tone : ''}">
            <div class="md-stat__label">${esc(label)}</div>
            <div class="md-stat__value">${value ?? 0}</div>
        </div>`;

    // Топ-3 типов и подразделений (если есть данные)
    const typeRows = Object.entries(s.by_type || {})
        .filter(([_, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, n]) => `<li><span>${esc(TYPE_LABELS[k] || k)}</span><b>${n}</b></li>`)
        .join('');
    const deptRows = Object.entries(s.by_department || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, n]) => `<li><span>${esc(k)}</span><b>${n}</b></li>`)
        .join('');

    el.innerHTML = `
        <div class="md-stats-row">
            ${card('Всего',       s.total,       'total')}
            ${card('Выдано',      s.issued,      'issued')}
            ${card('На хранении', s.available,   'available')}
            ${card('Неисправно',  s.broken,      'broken')}
            ${card('Списано',     s.written_off, 'written_off')}
            ${card('Утрачено',    s.lost,        s.lost > 0 ? 'alert' : '')}
            ${card('Просроч. проверка', s.overdue_check, s.overdue_check > 0 ? 'alert' : '')}
        </div>
        <div class="md-breakdown">
            <div class="md-breakdown__col">
                <div class="md-breakdown__title">По типам</div>
                <ul class="md-breakdown__list">${typeRows || '<li class="md-empty">Нет данных</li>'}</ul>
            </div>
            <div class="md-breakdown__col">
                <div class="md-breakdown__title">По подразделениям (топ-5)</div>
                <ul class="md-breakdown__list">${deptRows || '<li class="md-empty">Нет данных</li>'}</ul>
            </div>
        </div>
    `;
}


// ─── Таблица ────────────────────────────────────────────────────────────────

function _renderTable() {
    const el = document.getElementById('md-list');
    if (!el) return;
    if (!_state.items.length) {
        el.innerHTML = `
            <div class="md-empty-block">
                Носителей не найдено. ${(_state.filters.q || _state.filters.status || _state.filters.type)
                    ? 'Попробуйте сбросить фильтры.'
                    : 'Нажмите «+ Носитель», чтобы добавить первый.'}
            </div>`;
        return;
    }

    if (_state.groupByHolder) {
        _renderTableGrouped(el);
        return;
    }

    // В плоском режиме строки тоже кликабельны, действия — в выезжающей
    // панели под строкой. Логика идентична группированному режиму, но
    // без иерархии групп.
    const rows = _state.items.map(it => {
        const isOpen = _state.expandedItemId === it.id;
        const cls = ['md-item-row'];
        if (it.next_check_date && new Date(it.next_check_date) < new Date())
            cls.push('md-row--overdue');
        if (it.status === 'written_off') cls.push('md-row--decommissioned');
        if (isOpen) cls.push('md-item-row--open');
        const mainRow = `
            <tr class="${cls.join(' ')}" data-id="${it.id}" data-toggle-item="${it.id}">
                <td class="md-cell-inv">${esc(it.inv_number)}</td>
                <td class="md-cell-type">${esc(TYPE_LABELS[it.media_type] || it.media_type)}</td>
                <td class="md-cell-cap">${it.capacity_gb ? it.capacity_gb + ' ГБ' : '—'}</td>
                <td class="md-cell-class">${esc(CLASS_LABELS[it.classification] || '')}</td>
                <td class="md-cell-holder">
                    <div>${esc(it.holder_short_name || it.holder_full_name || '—')}</div>
                    ${it.holder_department || it.issue_date ? `
                        <div class="md-cell-sub">
                            ${esc(it.holder_department || '')}${it.issue_date ? ' · ' + fmtDate(it.issue_date) : ''}
                        </div>` : ''}
                </td>
                <td class="md-cell-chev">
                    <svg class="md-row-chev" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </td>
            </tr>`;
        const actionsHtml = isOpen ? `
            <tr class="md-actions-row" data-actions-for="${it.id}">
                <td colspan="6">
                    <div class="md-actions-panel">
                        ${it.serial_number ? `
                            <div class="md-actions-meta">Серийный: <b>${esc(it.serial_number)}</b></div>` : ''}
                        ${it.notes ? `
                            <div class="md-actions-notes"><b>Примечание:</b> ${esc(it.notes)}</div>` : ''}
                        <div class="md-actions-buttons">${_rowActionButtons(it)}</div>
                    </div>
                </td>
            </tr>` : '';
        return mainRow + actionsHtml;
    }).join('');

    el.innerHTML = `
        <table class="md-table">
            <thead>
                <tr>
                    <th>Инв. №</th>
                    <th>Тип</th>
                    <th>Объём</th>
                    <th>Гриф</th>
                    <th>Держатель</th>
                    <th style="width:36px;"></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>`;

    // Обработчик кликов навешивается один раз в _renderShell (делегирование),
    // здесь повторно не вешаем — иначе при каждом перерендере обработчики
    // дублируются.
}


function _renderTableGrouped(el) {
    // Группируем элементы по держателю. Ключ — holder_full_name (норм.) или
    // спец-метка для бесхозных. Списанные строки вне групп — в конце.
    const groups = new Map();
    const unassigned = [];
    const decommissioned = [];
    for (const it of _state.items) {
        if (it.status === 'written_off' || it.status === 'lost') {
            decommissioned.push(it);
            continue;
        }
        const key = (it.holder_full_name || it.holder_short_name || '').trim();
        if (!key) {
            unassigned.push(it);
            continue;
        }
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                full_name:  it.holder_full_name || '',
                short_name: it.holder_short_name || '',
                department: it.holder_department || '',
                items:      [],
            });
        }
        groups.get(key).items.push(it);
    }

    // Сортировка: по ключу (фамилия идёт первой), но внутри группы — по
    // числовой части инв. номера для предсказуемого порядка флешек.
    const invNumKey = (s) => {
        const m = String(s || '').match(/^(\d+)/);
        return m ? parseInt(m[1], 10) : 9999;
    };
    for (const g of groups.values()) {
        g.items.sort((a, b) => invNumKey(a.inv_number) - invNumKey(b.inv_number));
    }
    const groupArr = [...groups.values()]
        .sort((a, b) => a.key.localeCompare(b.key, 'ru'));

    // Чипы инв.номеров — превью содержимого свёрнутой группы.
    // Кликом на чип можно сразу открыть конкретную флешку (auto-expand
    // и группы, и item-action-row для этой флешки).
    function chipsHtml(items) {
        return items.map(it => {
            const cls = ['md-chip'];
            if (it.next_check_date && new Date(it.next_check_date) < new Date())
                cls.push('md-chip--overdue');
            return `<span class="${cls.join(' ')}" data-jump-id="${it.id}"
                          title="${esc(TYPE_LABELS[it.media_type] || '')}${
                              it.capacity_gb ? ' · ' + it.capacity_gb + ' ГБ' : ''
                          }${it.serial_number ? ' · ' + esc(it.serial_number) : ''}">
                ${esc(it.inv_number)}</span>`;
        }).join('');
    }

    // Главная строка флешки в раскрытой группе. Без кнопок — кликабельна,
    // действия выезжают в отдельной строке (см. actionsRow ниже).
    function renderItemRow(it, indented = true) {
        const isOpen = _state.expandedItemId === it.id;
        const cls = ['md-item-row'];
        if (it.next_check_date && new Date(it.next_check_date) < new Date())
            cls.push('md-row--overdue');
        if (it.status === 'written_off') cls.push('md-row--decommissioned');
        if (indented) cls.push('md-row--indented');
        if (isOpen) cls.push('md-item-row--open');

        return `
            <tr class="${cls.join(' ')}" data-id="${it.id}" data-toggle-item="${it.id}">
                <td class="md-cell-inv">${esc(it.inv_number)}</td>
                <td class="md-cell-type">${esc(TYPE_LABELS[it.media_type] || it.media_type)}</td>
                <td class="md-cell-cap">${it.capacity_gb ? it.capacity_gb + ' ГБ' : '—'}</td>
                <td class="md-cell-serial">${esc(it.serial_number || '—')}</td>
                <td class="md-cell-meta">
                    ${it.issue_date ? fmtDate(it.issue_date) : ''}
                </td>
                <td class="md-cell-chev">
                    <svg class="md-row-chev" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="9 18 15 12 9 6"/>
                    </svg>
                </td>
            </tr>
            ${isOpen ? actionsRow(it) : ''}`;
    }

    // Раскрывающаяся под флешкой панель действий.
    function actionsRow(it) {
        return `
            <tr class="md-actions-row" data-actions-for="${it.id}">
                <td colspan="6">
                    <div class="md-actions-panel">
                        ${it.notes ? `
                            <div class="md-actions-notes">
                                <b>Примечание:</b> ${esc(it.notes)}
                            </div>` : ''}
                        <div class="md-actions-buttons">
                            ${_rowActionButtons(it)}
                        </div>
                    </div>
                </td>
            </tr>`;
    }

    function renderGroup(g) {
        const isOpen = _state.expandedGroups.has(g.key);
        const flashWord = g.items.length === 1 ? 'флешка'
                        : g.items.length < 5  ? 'флешки' : 'флешек';
        const itemsHtml = isOpen
            ? g.items.map(it => renderItemRow(it, true)).join('')
            : '';
        // Когда группа свёрнута — показываем компактные чипы инв.№
        // прямо в заголовке. Это даёт обзор «у Иванова: 1-ДСП, 5-ДСП, 12-ДСП»
        // без раскрытия группы.
        const previewHtml = !isOpen ? `
            <div class="md-group-chips">${chipsHtml(g.items)}</div>` : '';
        return `
            <tr class="md-group-row ${isOpen ? 'md-group-row--open' : ''}"
                data-group-key="${esc(g.key)}">
                <td colspan="6">
                    <div class="md-group-head">
                        <svg class="md-group-chevron" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"/>
                        </svg>
                        <span class="md-group-name">${esc(g.short_name || g.full_name || g.key)}</span>
                        ${g.department ? `<span class="md-group-dept">${esc(g.department)}</span>` : ''}
                        <span class="md-group-count">
                            <b>${g.items.length}</b> ${flashWord}
                        </span>
                    </div>
                    ${previewHtml}
                </td>
            </tr>
            ${itemsHtml}`;
    }

    function renderStandalone(items, label, key) {
        if (!items.length) return '';
        const isOpen = _state.expandedGroups.has(key);
        const itemsHtml = isOpen
            ? items.map(it => renderItemRow(it, true)).join('')
            : `<tr class="md-group-row md-group-row--inline-chips">
                   <td colspan="6"><div class="md-group-chips">${chipsHtml(items)}</div></td>
               </tr>`;
        return `
            <tr class="md-group-row md-group-row--standalone ${isOpen ? 'md-group-row--open' : ''}"
                data-group-key="${esc(key)}">
                <td colspan="6">
                    <div class="md-group-head">
                        <svg class="md-group-chevron" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"/>
                        </svg>
                        <span class="md-group-name md-group-name--muted">${esc(label)}</span>
                        <span class="md-group-count"><b>${items.length}</b></span>
                    </div>
                </td>
            </tr>
            ${itemsHtml}`;
    }

    const groupsHtml = groupArr.map(renderGroup).join('');
    const unassignedHtml = renderStandalone(unassigned, '— без держателя —',  '__unassigned__');
    const decomHtml     = renderStandalone(decommissioned, '📦 Списано / архив', '__decom__');

    el.innerHTML = `
        <table class="md-table md-table--grouped">
            <thead>
                <tr>
                    <th>Инв. №</th>
                    <th>Тип</th>
                    <th>Объём</th>
                    <th>Серийный</th>
                    <th>Выдан</th>
                    <th style="width:36px;"></th>
                </tr>
            </thead>
            <tbody>${groupsHtml}${unassignedHtml}${decomHtml}</tbody>
        </table>`;

    // Обработчик кликов — единый, делегированный в _renderShell.
}


// Единый делегированный обработчик клика по таблице — навешивается ОДИН
// раз на #md-list в _renderShell. Понимает все режимы:
//   • data-action          — кнопка действия в раскрытой панели
//   • data-jump-id         — чип инв.№ в свёрнутой группе
//   • data-toggle-item     — строка флешки (раскрытие действий)
//   • data-group-key       — заголовок группы держателя (раскрытие)
function _onListClick(e) {
    if (e.target.closest('[data-action]')) {
        _onTableAction(e);
        return;
    }
    const chip = e.target.closest('[data-jump-id]');
    if (chip) {
        const id = parseInt(chip.dataset.jumpId, 10);
        const item = _state.items.find(x => x.id === id);
        if (item) {
            const isDecom = (item.status === 'written_off' || item.status === 'lost');
            const key = (item.holder_full_name || item.holder_short_name || '').trim()
                        || (isDecom ? '__decom__' : '__unassigned__');
            _state.expandedGroups.add(key);
            _state.expandedItemId = id;
            _renderTable();
        }
        return;
    }
    const itemRow = e.target.closest('[data-toggle-item]');
    if (itemRow) {
        const id = parseInt(itemRow.dataset.toggleItem, 10);
        _state.expandedItemId = (_state.expandedItemId === id) ? null : id;
        _renderTable();
        return;
    }
    const groupRow = e.target.closest('.md-group-row[data-group-key]');
    if (groupRow) {
        const key = groupRow.dataset.groupKey;
        if (_state.expandedGroups.has(key)) _state.expandedGroups.delete(key);
        else _state.expandedGroups.add(key);
        _renderTable();
    }
}


// Кнопки действий для раскрывающейся панели под строкой флешки.
// Семантически они различны:
//   • Редактировать — поправить поля (серийник, тип, объём, примечание)
//   • + Ещё флешку  — добавить новую флешку этому же держателю
//   • Переписать    — передать флешку другому человеку
//   • Списать       — вывести из эксплуатации (архив, status=written_off)
//   • Удалить       — стереть запись из БД (для ошибочно созданных)
// «Очистить держателя» намеренно убрано — операционно ненужный кейс
// (флешка либо переходит другому, либо списывается). Endpoint /clear
// в backend оставлен на случай скриптовой массовой операции.
function _rowActionButtons(it) {
    const hasHolder = !!(it.holder_full_name || it.holder_short_name);
    const btn = (action, label, mods = 'btn-outlined') =>
        `<button type="button" class="btn ${mods} btn-sm md-act-btn"
                 data-action="${action}" data-id="${it.id}">${label}</button>`;

    const parts = [];
    parts.push(btn('edit', '✎ Редактировать'));
    if (hasHolder) {
        parts.push(btn('duplicate', '+ Ещё флешку'));
        parts.push(btn('reassign',  '↻ Переписать'));
    }
    if (it.status !== 'written_off') {
        parts.push(btn('decommission', '📦 Списать'));
    }
    parts.push(btn('delete', '✕ Удалить', 'btn-text md-act-btn--danger'));
    return parts.join('');
}


function _onTableAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    const item = _state.items.find(x => x.id === id);
    if (!item) return;
    switch (btn.dataset.action) {
        case 'edit':         _openForm(item); break;
        case 'duplicate':    _duplicateMedia(item); break;
        case 'reassign':     _openReassignForm(item); break;
        case 'clear':        _clearHolder(item); break;
        case 'decommission': _decommissionMedia(item); break;
        case 'delete':       _deleteMedia(item); break;
    }
}


// Подбираем следующий свободный инв.№ в формате «{N}-{suffix}».
// Берём максимум числовой части среди всех существующих + 1.
function _nextInvNumber(suffix = 'ДСП') {
    const re = new RegExp(`^(\\d+)-${suffix}$`);
    let max = 0;
    for (const it of _state.items) {
        const m = (it.inv_number || '').match(re);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > max) max = n;
        }
    }
    return `${max + 1}-${suffix}`;
}


// «+ Ещё» — открыть форму с предзаполненным держателем и новым инв.№.
function _duplicateMedia(item) {
    // Угадываем суффикс по существующему номеру (1-ДСП → ДСП, 5-С → С).
    const m = (item.inv_number || '').match(/^\d+-(.+)$/);
    const suffix = m ? m[1] : 'ДСП';
    const draft = {
        // НЕ берём id — это новая запись
        inv_number:        _nextInvNumber(suffix),
        media_type:        item.media_type,
        serial_number:     '',                       // у новой флешки свой серийник
        capacity_gb:       null,                     // и свой объём
        classification:    item.classification,
        status:            'issued',
        holder_person_id:  item.holder_person_id,
        holder_full_name:  item.holder_full_name,
        holder_short_name: item.holder_short_name,
        holder_department: item.holder_department,
        issue_date:        new Date().toISOString().slice(0, 10),
        last_check_date:   '',
        next_check_date:   '',
        notes:             '',
    };
    _openForm(draft);
}


async function _clearHolder(item) {
    const holderName = item.holder_short_name || item.holder_full_name || '—';
    if (!window.confirm(
        `Очистить держателя у носителя «${item.inv_number}» (${holderName})?\n\n` +
        `Носитель останется в учёте, но без закрепления. ` +
        `Бывший держатель будет записан в журнал движений.`
    )) return;
    try {
        await api.post(`/media/${item.id}/clear`, {});
        window.showSnackbar?.('Держатель очищен', 'success');
        _reload();
    } catch (err) {
        console.error('[media] clear:', err);
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


function _openReassignForm(item) {
    document.getElementById('md-form-modal')?.remove();

    const today = new Date().toISOString().slice(0, 10);
    const m = document.createElement('div');
    m.id = 'md-form-modal';
    m.className = 'md-form-modal';
    // Связь с персоной — храним на DOM-элементе формы
    m.dataset.holderPersonId = '';

    const oldHolder = item.holder_short_name || item.holder_full_name || '—';

    m.innerHTML = `
        <div class="md-form" role="dialog" style="width: min(720px, 100%);">
            <div class="md-form__head">
                <span class="md-form__title">
                    Переписать носитель «${esc(item.inv_number)}»
                </span>
                <button class="btn btn-text btn-sm" data-md-close type="button">✕</button>
            </div>
            <div class="md-form__body">
                <p class="md-rs-hint">
                    Сейчас закреплён за: <b>${esc(oldHolder)}</b>${
                        item.holder_department ? ' · ' + esc(item.holder_department) : ''
                    }
                </p>
                <div class="md-form__grid">
                    <label class="field md-form__col-2">
                        <span class="field-label">Новый держатель — выбор из общей базы</span>
                        <input type="text" data-f="holder_full_name" maxlength="300"
                               placeholder="Начните вводить фамилию…"
                               autocomplete="off" data-fio-input="1">
                    </label>
                    <label class="field">
                        <span class="field-label">Краткое (на бирку)</span>
                        <input type="text" data-f="holder_short_name" maxlength="100"
                               placeholder="Иванов И.И.">
                    </label>
                    <label class="field">
                        <span class="field-label">Подразделение</span>
                        <input type="text" data-f="holder_department" maxlength="100"
                               placeholder="3 упр.">
                    </label>
                    <label class="field">
                        <span class="field-label">Дата передачи</span>
                        <input type="date" data-f="issue_date" value="${today}">
                    </label>
                    <label class="field md-form__col-full">
                        <span class="field-label">Примечание</span>
                        <textarea data-f="notes" rows="2"
                                  placeholder="Причина передачи (увольнение, перевод…)"></textarea>
                    </label>
                </div>
            </div>
            <div class="md-form__foot">
                <button class="btn btn-outlined btn-sm" data-md-close type="button">Отмена</button>
                <button class="btn btn-filled btn-sm" id="md-reassign-save" type="button">
                    Переписать
                </button>
            </div>
        </div>`;
    _state.overlay.appendChild(m);

    m.querySelectorAll('[data-md-close]').forEach(b =>
        b.addEventListener('click', () => m.remove()));

    // Автокомплит ФИО — связываем с persons.id
    const fioInput = m.querySelector('input[data-fio-input="1"]');
    fioInput.addEventListener('input', () => { m.dataset.holderPersonId = ''; });
    attachFio(fioInput, {
        container: fioInput.parentElement,
        onSelect: (person) => {
            fioInput.value = person.full_name;
            m.dataset.holderPersonId = String(person.id);
            const shortInput = m.querySelector('[data-f="holder_short_name"]');
            if (shortInput && person.full_name) {
                const parts = person.full_name.split(' ');
                shortInput.value = parts.length >= 2
                    ? `${parts[0]} ${parts.slice(1).map(w => w[0] + '.').join('')}`
                    : person.full_name;
            }
            const deptInput = m.querySelector('[data-f="holder_department"]');
            if (deptInput && person.department) deptInput.value = person.department;
        },
    });

    m.querySelector('#md-reassign-save').addEventListener('click', async () => {
        const get = (f) => m.querySelector(`[data-f="${f}"]`)?.value || '';
        const personIdRaw = m.dataset.holderPersonId || '';
        const personId = personIdRaw ? parseInt(personIdRaw, 10) : null;

        const payload = {
            holder_person_id:  Number.isFinite(personId) ? personId : null,
            holder_full_name:  get('holder_full_name').trim() || null,
            holder_short_name: get('holder_short_name').trim() || null,
            holder_department: get('holder_department').trim() || null,
            issue_date:        get('issue_date') || null,
            notes:             get('notes').trim() || null,
        };

        if (!payload.holder_full_name && !payload.holder_short_name) {
            window.showSnackbar?.(
                'Укажите нового держателя — выберите из базы или впишите ФИО',
                'error');
            return;
        }
        try {
            await api.post(`/media/${item.id}/reassign`, payload);
            window.showSnackbar?.(
                `Носитель переписан на ${payload.holder_short_name || payload.holder_full_name}`,
                'success');
            m.remove();
            _reload();
        } catch (err) {
            console.error('[media] reassign:', err);
            window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
        }
    });

    // Фокус на поле ФИО
    setTimeout(() => fioInput?.focus(), 50);
}


async function _decommissionMedia(item) {
    const reason = window.prompt(
        `Списать носитель «${item.inv_number}» (${item.holder_short_name || '—'})?\n` +
        `Можете указать причину (поломка / увольнение / истёк срок ...). Оставьте пустым, если не нужно:`,
        '',
    );
    // null = пользователь нажал «Отмена» (Esc / Cancel)
    if (reason === null) return;

    try {
        const url = `/media/${item.id}/decommission`
            + (reason.trim() ? `?reason=${encodeURIComponent(reason.trim())}` : '');
        await api.post(url, {});
        window.showSnackbar?.('Носитель списан', 'success');
        _reload();
    } catch (err) {
        console.error('[media] decommission:', err);
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


// ─── Форма CRUD ─────────────────────────────────────────────────────────────

function _openForm(item) {
    document.getElementById('md-form-modal')?.remove();
    const editing = item ? { ...item } : {
        inv_number: '', media_type: 'flash',
        serial_number: '', capacity_gb: null, classification: 'dsp',
        status: 'available', holder_full_name: '', holder_short_name: '',
        holder_department: '', issue_date: '',
        last_check_date: '', next_check_date: '', notes: '',
    };
    const v = (k) => esc(editing[k] ?? '');

    const opts = (map, current) => Object.entries(map).map(
        ([k, l]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${esc(l)}</option>`
    ).join('');

    const m = document.createElement('div');
    m.id = 'md-form-modal';
    m.className = 'md-form-modal';
    const isExisting = !!(item && item.id);
    m.innerHTML = `
        <div class="md-form" role="dialog">
            <div class="md-form__head">
                <span class="md-form__title">${isExisting ? 'Редактирование носителя' : 'Новый носитель'}</span>
                <button class="btn btn-text btn-sm" data-md-close type="button">✕</button>
            </div>
            <div class="md-form__body">
                <div class="md-form__grid">
                    <label class="field">
                        <span class="field-label">Инв. № *</span>
                        <input type="text" data-f="inv_number" value="${v('inv_number')}" maxlength="50" placeholder="1-ДСП">
                    </label>
                    <label class="field">
                        <span class="field-label">Тип</span>
                        <select data-f="media_type">${opts(TYPE_LABELS, editing.media_type)}</select>
                    </label>
                    <label class="field">
                        <span class="field-label">Объём, ГБ</span>
                        <input type="number" min="0" data-f="capacity_gb" value="${v('capacity_gb')}">
                    </label>
                    <label class="field md-form__col-2">
                        <span class="field-label">Серийный номер</span>
                        <input type="text" data-f="serial_number" value="${v('serial_number')}" maxlength="120">
                    </label>
                    <label class="field md-form__col-2">
                        <span class="field-label">ФИО держателя (выбор из общей базы)</span>
                        <input type="text" data-f="holder_full_name" value="${v('holder_full_name')}" maxlength="300"
                               placeholder="Начните вводить — появятся подсказки"
                               autocomplete="off" data-fio-input="1">
                    </label>
                    <label class="field">
                        <span class="field-label">Краткое (на бирку)</span>
                        <input type="text" data-f="holder_short_name" value="${v('holder_short_name')}" maxlength="100" placeholder="Иванов И.И.">
                    </label>
                    <label class="field">
                        <span class="field-label">Подразделение</span>
                        <input type="text" data-f="holder_department" value="${v('holder_department')}" maxlength="100" placeholder="3 упр.">
                    </label>
                    <label class="field">
                        <span class="field-label">Дата выдачи</span>
                        <input type="date" data-f="issue_date" value="${v('issue_date')}">
                    </label>
                    <label class="field">
                        <span class="field-label">Последняя проверка</span>
                        <input type="date" data-f="last_check_date" value="${v('last_check_date')}">
                    </label>
                    <label class="field">
                        <span class="field-label">Следующая проверка</span>
                        <input type="date" data-f="next_check_date" value="${v('next_check_date')}">
                    </label>
                    <label class="field md-form__col-full">
                        <span class="field-label">Примечание</span>
                        <textarea data-f="notes" rows="2">${v('notes')}</textarea>
                    </label>
                </div>
            </div>
            <div class="md-form__foot">
                <button class="btn btn-outlined btn-sm" data-md-close type="button">Отмена</button>
                <button class="btn btn-filled btn-sm"   id="md-form-save"   type="button">Сохранить</button>
            </div>
        </div>`;
    _state.overlay.appendChild(m);
    m.querySelectorAll('[data-md-close]').forEach(b => b.addEventListener('click', () => m.remove()));
    m.querySelector('#md-form-save').addEventListener('click', () => _saveItem(m, editing.id));

    // Автокомплит ФИО — связываем с persons.id, чтобы изменения в общей базе
    // (переименование, перевод) автоматически отражались в этом носителе.
    const fioInput = m.querySelector('input[data-fio-input="1"]');
    if (fioInput) {
        // Сохраняем выбранную персону на DOM-элементе формы
        m.dataset.holderPersonId = editing.holder_person_id || '';
        // Если оператор начал править вручную — связь сбрасываем
        fioInput.addEventListener('input', () => {
            m.dataset.holderPersonId = '';
        });
        attachFio(fioInput, {
            container: fioInput.parentElement,
            onSelect: (person) => {
                fioInput.value = person.full_name;
                m.dataset.holderPersonId = String(person.id);
                const shortInput = m.querySelector('[data-f="holder_short_name"]');
                if (shortInput && person.full_name) {
                    const parts = person.full_name.split(' ');
                    shortInput.value = parts.length >= 2
                        ? `${parts[0]} ${parts.slice(1).map(w => w[0] + '.').join('')}`
                        : person.full_name;
                }
                const deptInput = m.querySelector('[data-f="holder_department"]');
                if (deptInput && person.department) {
                    deptInput.value = person.department;
                }
            },
        });
    }
}


async function _saveItem(modal, editingId) {
    const get = (f) => modal.querySelector(`[data-f="${f}"]`)?.value ?? '';
    // Гриф всегда ДСП. Статус выводится автоматически: есть держатель → issued.
    // Эти два поля всё равно в pydantic Optional/default, поэтому шлём фиксы.
    const holderFull  = get('holder_full_name')  || null;
    const holderShort = get('holder_short_name') || null;
    const status = (holderFull || holderShort) ? 'issued' : 'available';

    const personIdRaw = modal.dataset.holderPersonId || '';
    const personId = personIdRaw ? parseInt(personIdRaw, 10) : null;

    const payload = {
        inv_number:        get('inv_number').trim(),
        media_type:        get('media_type') || 'flash',
        serial_number:     get('serial_number') || null,
        capacity_gb:       get('capacity_gb') ? parseInt(get('capacity_gb'), 10) : null,
        classification:    'dsp',
        status:            status,
        holder_person_id:  Number.isFinite(personId) ? personId : null,
        holder_full_name:  holderFull,
        holder_short_name: holderShort,
        holder_department: get('holder_department') || null,
        issue_date:        get('issue_date') || null,
        last_check_date:   get('issue_date') || null,   // = дата выдачи
        next_check_date:   get('next_check_date') || null,
        notes:             get('notes') || null,
    };
    if (!payload.inv_number) {
        window.showSnackbar?.('Введите инвентарный №', 'error'); return;
    }
    try {
        if (editingId) {
            await api.put(`/media/${editingId}`, payload);
            window.showSnackbar?.('Носитель обновлён', 'success');
        } else {
            await api.post('/media', payload);
            window.showSnackbar?.('Носитель добавлен', 'success');
        }
        modal.remove();
        _reload();
    } catch (err) {
        console.error('[media] save:', err);
        window.showSnackbar?.(`Ошибка сохранения: ${err.message || ''}`, 'error');
    }
}


// ─── Удаление ───────────────────────────────────────────────────────────────

async function _deleteMedia(item) {
    if (!window.confirm(`Удалить носитель «${item.inv_number}»? Действие необратимо.`)) return;
    try {
        await api.delete(`/media/${item.id}`);
        window.showSnackbar?.('Носитель удалён', 'success');
        _reload();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


// «Пустая» = ни одного значимого поля кроме инв.№. Считаем локально, чтобы
// до запроса показать оператору сколько именно записей будет снесено.
function _isEmptyItem(it) {
    return !it.holder_full_name && !it.holder_short_name
        && !it.holder_person_id  && !it.serial_number
        && !it.capacity_gb       && !it.notes;
}

async function _cleanupEmpty() {
    const empties = _state.items.filter(_isEmptyItem);
    if (!empties.length) {
        window.showSnackbar?.('Пустых записей не найдено', 'info');
        return;
    }
    const msg = `Найдено пустых записей: ${empties.length}.\n` +
                `Это записи без держателя, серийника, объёма и примечаний — ` +
                `обычно создаются случайно при импорте шаблона на 500 строк.\n\n` +
                `Удалить их? Действие необратимо.`;
    if (!window.confirm(msg)) return;
    try {
        const res = await api.delete('/media/cleanup?mode=empty');
        window.showSnackbar?.(`Удалено: ${res.deleted}`, 'success');
        _reload();
    } catch (err) {
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


async function _downloadTemplate() {
    // Default 500 — типовая ёмкость учёта МНИ отдела связи.
    const ans = window.prompt(
        'Сколько строк предзаполнить инвентарными номерами (1-ДСП … N-ДСП)?\n' +
        'Введите число от 1 до 1000.',
        '500',
    );
    if (ans == null) return;
    const count = Math.max(1, Math.min(1000, parseInt(ans, 10) || 500));

    try {
        const blob = await api.download(`/media/import/template?count=${count}`);
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'),
            { href: url, download: `Учёт_МНИ_шаблон_${count}_строк.xlsx` });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        window.showSnackbar?.(`Шаблон создан: ${count} строк`, 'success');
    } catch (err) {
        console.error('[media] template download:', err);
        window.showSnackbar?.('Ошибка скачивания шаблона', 'error');
    }
}


async function _handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';   // reset, чтобы повторный выбор того же файла триггерил
    if (!file) return;

    if (!/\.(xlsx|xls)$/i.test(file.name)) {
        window.showSnackbar?.('Выберите файл .xlsx', 'error');
        return;
    }

    const fd = new FormData();
    fd.append('file', file);

    window.showSnackbar?.(`Импорт: ${file.name}…`, 'info');
    try {
        const res = await api.upload('/media/import', fd);

        // Если есть строки, требующие разрешения — открываем визард
        if (res.ambiguous && res.ambiguous.length) {
            _showResolveWizard(res);
            return;
        }

        // Иначе сразу финальный отчёт
        const summary = `+${res.added} · ↻${res.updated}` +
                        (res.skipped ? ` · ↷${res.skipped}` : '');
        if (res.errors && res.errors.length) {
            _showImportReport(res);
        } else {
            window.showSnackbar?.(`Импорт завершён: ${summary}`, 'success', 6000);
        }
        _reload();
    } catch (err) {
        console.error('[media] import:', err);
        window.showSnackbar?.(`Ошибка импорта: ${err.message || ''}`, 'error');
    }
}


function _showImportReport(res) {
    document.getElementById('md-import-report')?.remove();
    const m = document.createElement('div');
    m.id = 'md-import-report';
    m.className = 'md-form-modal';
    const errRows = (res.errors || []).map(
        e => `<li>Строка <b>${e.row}</b>: ${esc(e.message)}</li>`
    ).join('');
    m.innerHTML = `
        <div class="md-form" role="dialog" style="width: min(720px, 100%);">
            <div class="md-form__head">
                <span class="md-form__title">Отчёт по импорту</span>
                <button class="btn btn-text btn-sm" data-md-close type="button">✕</button>
            </div>
            <div class="md-form__body">
                <div class="md-import-summary">
                    <span class="md-import-stat md-import-stat--ok">Добавлено: <b>${res.added}</b></span>
                    <span class="md-import-stat md-import-stat--upd">Обновлено: <b>${res.updated}</b></span>
                    ${res.skipped ? `<span class="md-import-stat md-import-stat--skip">Пропущено: <b>${res.skipped}</b></span>` : ''}
                    ${res.errors?.length
                        ? `<span class="md-import-stat md-import-stat--err">Ошибок: <b>${res.errors.length}</b></span>`
                        : ''}
                </div>
                ${res.errors?.length ? `
                    <div class="md-import-errors">
                        <div class="field-label" style="margin-bottom:6px;">Ошибки в строках</div>
                        <ul class="md-import-err-list">${errRows}</ul>
                    </div>` : '<p style="color:var(--md-on-surface-hint);">Всё прошло без ошибок.</p>'}
            </div>
            <div class="md-form__foot">
                <button class="btn btn-filled btn-sm" data-md-close type="button">OK</button>
            </div>
        </div>`;
    _state.overlay.appendChild(m);
    m.querySelectorAll('[data-md-close]').forEach(b =>
        b.addEventListener('click', () => m.remove()));
}


// ─── Визард разрешения неоднозначных строк ─────────────────────────────────
//
// Группировка: ambiguous-строки с одинаковым кратким ФИО показываются ОДНОЙ
// карточкой. Выбор персоны применяется ко ВСЕМ строкам этой группы (если у
// Иванова И.И. в файле 4 флешки — оператор выбирает раз).
//
// Каждая группа имеет:
//   • перечисленные инв.№ (бейджи);
//   • список найденных кандидатов (radio);
//   • поле «🔍 Найти вручную...» — fio_autocomplete по общей базе людей,
//     при выборе создаёт новый radio-вариант;
//   • альтернативы «без полного ФИО» и «пропустить».
//
// При перерисовке сохраняем scrollTop тела модалки + дополнительный radio-
// вариант ручного поиска (если был добавлен) — чтобы оператора не уносило
// в начало после каждого клика.

function _showResolveWizard(initialResult) {
    document.getElementById('md-resolve-wizard')?.remove();

    // Группируем по короткому ФИО (None → '_no_name_').
    const groups = new Map();
    for (const r of initialResult.ambiguous) {
        const key = (r.holder_short_name || '').trim() || '_no_name_';
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                short_name: r.holder_short_name || '',
                rows: [],
                candidates: [...(r.candidates || [])],
                manual: [],     // вручную добавленные через поиск
            });
        }
        const g = groups.get(key);
        g.rows.push(r);
        for (const c of (r.candidates || [])) {
            if (!g.candidates.find(x => x.id === c.id)) g.candidates.push(c);
        }
    }
    const groupList = [...groups.values()];

    // choices: { groupKey: 'no-fio' | 'skip' | personId }
    const choices = {};

    const m = document.createElement('div');
    m.id = 'md-resolve-wizard';
    m.className = 'md-form-modal';
    _state.overlay.appendChild(m);

    // ── Однократный билд DOM ───────────────────────────────────────────────
    // Никаких полных перерисовок: при выборе только переключаем классы
    // и обновляем счётчик в заголовке. Скролл-позиция, фокус, состояние
    // input'а ручного поиска — всё сохраняется естественным образом.

    const groupHtml = groupList.map((g) => {
        const optionHtml = (val, name, meta, mods = '') => `
            <label class="md-rs-option ${mods}">
                <input type="radio" name="rs-${esc(g.key)}" value="${esc(val)}">
                <div class="md-rs-option__main">
                    <div class="md-rs-option__name">${name}</div>
                    ${meta ? `<div class="md-rs-option__meta">${meta}</div>` : ''}
                </div>
            </label>
        `;
        const candOpts = g.candidates.map(c => optionHtml(
            String(c.id),
            esc(c.full_name),
            (c.department ? esc(c.department) : '<i>без управления</i>') +
                (c.rank ? ' · ' + esc(c.rank) : ''),
        )).join('');

        const invsHtml = g.rows.map(r =>
            `<span class="md-rs-inv">${esc(r.inv_number)}</span>`
        ).join('');

        const flashWord = g.rows.length === 1 ? 'флешка'
                        : g.rows.length < 5  ? 'флешки' : 'флешек';

        return `
            <div class="md-rs-row" data-group="${esc(g.key)}">
                <div class="md-rs-row__head">
                    <span class="md-rs-row__short">${esc(g.short_name || '— без ФИО —')}</span>
                    <span class="md-rs-row__count">${g.rows.length} ${flashWord}</span>
                    <span class="md-rs-row__hint">
                        ${g.candidates.length === 0
                            ? 'В базе людей не найдено похожих — поиск ниже'
                            : `Найдено похожих: ${g.candidates.length}`}
                    </span>
                </div>
                <div class="md-rs-invs">${invsHtml}</div>
                <div class="md-rs-options" data-options>${candOpts}</div>
                <div class="md-rs-search">
                    <span class="md-rs-search__label">🔍 Найти вручную:</span>
                    <input type="text" class="md-rs-search__input"
                           data-group="${esc(g.key)}"
                           placeholder="Начните вводить фамилию…"
                           autocomplete="off">
                </div>
                <div class="md-rs-extra">
                    ${optionHtml('no-fio',
                        '— Сохранить только краткое ФИО',
                        'Без подстановки из общей базы')}
                    ${optionHtml('skip',
                        `— Пропустить эти ${g.rows.length} флешек`,
                        '', 'md-rs-option--danger')}
                </div>
            </div>`;
    }).join('');

    const total = groupList.length;
    m.innerHTML = `
        <div class="md-form" role="dialog" style="width: min(880px, 100%);">
            <div class="md-form__head">
                <span class="md-form__title" id="md-rs-title">
                    Разрешите совпадения (0/${total})
                </span>
                <button class="btn btn-text btn-sm" data-md-close type="button">✕</button>
            </div>
            <div class="md-form__body">
                ${initialResult.added || initialResult.updated ? `
                    <div class="md-import-summary">
                        ${initialResult.added ? `<span class="md-import-stat md-import-stat--ok">Уже добавлено: <b>${initialResult.added}</b></span>` : ''}
                        ${initialResult.updated ? `<span class="md-import-stat md-import-stat--upd">Обновлено: <b>${initialResult.updated}</b></span>` : ''}
                        ${initialResult.errors?.length ? `<span class="md-import-stat md-import-stat--err">Ошибок: <b>${initialResult.errors.length}</b></span>` : ''}
                    </div>` : ''}
                ${initialResult.errors?.length ? `
                    <details class="md-rs-errors">
                        <summary>Показать ошибки парсинга (${initialResult.errors.length})</summary>
                        <ul class="md-import-err-list">
                            ${initialResult.errors.map(e =>
                                `<li>Строка <b>${e.row}</b>: ${esc(e.message)}</li>`
                            ).join('')}
                        </ul>
                    </details>` : ''}
                <p class="md-rs-hint">
                    Эти ФИО система не смогла однозначно сопоставить с общей базой людей.
                    Для каждого человека выберите конкретного сотрудника, найдите вручную
                    или пропустите. Все флешки одного человека настраиваются разом.
                </p>
                <div class="md-rs-list">${groupHtml}</div>
            </div>
            <div class="md-form__foot">
                <button class="btn btn-outlined btn-sm" data-md-close type="button">Закрыть</button>
                <button class="btn btn-filled btn-sm" id="md-rs-save" disabled type="button">
                    Сохранить выбранные
                </button>
            </div>
        </div>`;

    m.querySelectorAll('[data-md-close]').forEach(b =>
        b.addEventListener('click', () => m.remove()));
    m.querySelector('#md-rs-save').addEventListener('click',
        () => _commitResolve(groupList, choices, m));

    // ── Обновление счётчика и состояния кнопки сохранения ──────────────────
    function refreshProgress() {
        const decided = groupList.filter(g => choices[g.key] !== undefined).length;
        const titleEl = m.querySelector('#md-rs-title');
        if (titleEl) titleEl.textContent = `Разрешите совпадения (${decided}/${total})`;
        const saveBtn = m.querySelector('#md-rs-save');
        if (saveBtn) {
            if (decided === total) saveBtn.removeAttribute('disabled');
            else saveBtn.setAttribute('disabled', '');
        }
    }

    // ── Делегирование change на radio (in-place, без перерисовки) ──────────
    m.addEventListener('change', (e) => {
        const input = e.target;
        if (!(input instanceof HTMLInputElement)) return;
        if (input.type !== 'radio') return;
        if (!input.name.startsWith('rs-')) return;

        const groupKey = input.name.replace(/^rs-/, '');
        const v = input.value;
        choices[groupKey] = (v === 'skip' || v === 'no-fio') ? v : parseInt(v, 10);

        // Переключаем класс «выбран» в этой группе — никакого innerHTML.
        const groupEl = input.closest('.md-rs-row');
        if (groupEl) {
            groupEl.querySelectorAll('.md-rs-option').forEach(label => {
                const radio = label.querySelector('input[type="radio"]');
                label.classList.toggle('md-rs-option--selected',
                                       radio && radio.checked);
            });
        }
        refreshProgress();
    });

    // ── Ручной поиск через fio_autocomplete ────────────────────────────────
    // При выборе вставляем новую <label> в .md-rs-options этой группы
    // и сразу её активируем — без перерисовки всего визарда.
    m.querySelectorAll('.md-rs-search__input').forEach(input => {
        const groupKey = input.dataset.group;
        attachFio(input, {
            container: input.parentElement,
            onSelect: (person) => {
                const g = groupList.find(x => x.key === groupKey);
                if (!g) return;
                input.value = '';

                // Если уже есть в группе — просто выбираем
                const all = [...g.candidates, ...g.manual];
                if (!all.find(c => c.id === person.id)) {
                    g.manual.push({
                        id: person.id, full_name: person.full_name,
                        department: person.department, rank: person.rank,
                        __manual: true,
                    });
                    // Вставляем DOM-элемент с этим кандидатом в .md-rs-options
                    const groupEl = m.querySelector(
                        `.md-rs-row[data-group="${CSS.escape(groupKey)}"]`);
                    const optionsEl = groupEl?.querySelector('[data-options]');
                    if (optionsEl) {
                        const meta = (person.department ? esc(person.department) : '<i>без управления</i>')
                                   + (person.rank ? ' · ' + esc(person.rank) : '')
                                   + ' · <span class="md-rs-manual-tag">вручную</span>';
                        const html = `
                            <label class="md-rs-option">
                                <input type="radio" name="rs-${esc(groupKey)}" value="${person.id}">
                                <div class="md-rs-option__main">
                                    <div class="md-rs-option__name">${esc(person.full_name)}</div>
                                    <div class="md-rs-option__meta">${meta}</div>
                                </div>
                            </label>`;
                        optionsEl.insertAdjacentHTML('beforeend', html);
                    }
                }

                // Активируем radio выбранного кандидата → триггерит change-handler выше
                const targetRadio = m.querySelector(
                    `input[type="radio"][name="rs-${CSS.escape(groupKey)}"][value="${person.id}"]`);
                if (targetRadio) {
                    targetRadio.checked = true;
                    targetRadio.dispatchEvent(new Event('change', { bubbles: true }));
                }
            },
        });
    });
}


async function _commitResolve(groupList, choices, modal) {
    // Раскрываем группы обратно в плоский список строк.
    const rows = [];
    let skipped = 0;
    for (const g of groupList) {
        const ch = choices[g.key];
        if (ch === 'skip') {
            skipped += g.rows.length;
            continue;
        }
        const personId = (typeof ch === 'number') ? ch : null;  // 'no-fio' → null
        for (const r of g.rows) {
            rows.push({
                inv_number:        r.inv_number,
                media_type:        r.media_type,
                serial_number:     r.serial_number,
                capacity_gb:       r.capacity_gb,
                holder_short_name: r.holder_short_name,
                issue_date:        r.issue_date,
                notes:             r.notes,
                person_id:         personId,
            });
        }
    }

    try {
        const res = await api.post('/media/import/resolve', { rows });
        modal.remove();
        const summary = `+${res.added} · ↻${res.updated}` + (skipped ? ` · ↷${skipped}` : '');
        if (res.errors?.length) {
            _showImportReport({ ...res, skipped });
        } else {
            window.showSnackbar?.(`Импорт завершён: ${summary}`, 'success', 6000);
        }
        _reload();
    } catch (err) {
        console.error('[media] resolve:', err);
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


async function _exportTags() {
    try {
        const blob = await api.download('/media/tags-export');
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'),
            { href: url, download: 'Бирки_МНИ.docx' });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        window.showSnackbar?.('Бирки сформированы', 'success');
    } catch (err) {
        console.error('[media] export tags:', err);
        window.showSnackbar?.('Ошибка выгрузки бирок', 'error');
    }
}


window.openMedia = openMedia;
