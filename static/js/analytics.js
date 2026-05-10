// static/js/analytics.js
//
// Дашборд аналитики для admin: глобальные счётчики, заполнение по
// управлениям, использование должностей, топ нарядов, «призраки» в базе.
// Один GET /admin/analytics/overview — всё разом.

import { api } from './api.js';

let _loaded = false;


export async function loadAnalytics() {
    const root = document.getElementById('analytics-root');
    if (!root) return;
    root.innerHTML = '<div class="analytics-loading">Загрузка…</div>';

    let data;
    try {
        data = await api.get('/admin/analytics/overview');
    } catch (err) {
        root.innerHTML = `<div class="analytics-error">Ошибка: ${_esc(err?.message || err)}</div>`;
        return;
    }
    _loaded = true;

    root.innerHTML = `
        ${_renderTotals(data.totals)}
        ${_renderDutyLoad(data.duty_load)}
        ${_renderDataHealth(data.data_health)}
        ${_renderUncovered(data.uncovered, data.uncovered_month)}
        ${_renderUsers(data.users)}
        ${_renderPositions(data.positions)}
        ${_renderDutyTop(data.duty_top)}
        ${_renderGhosts(data.ghosts, data.ghosts_total)}
    `;
}


// Перезагрузить только если вкладка уже была открыта раньше (не дёргаем
// сервер для пользователей, которые ни разу не нажимали «Аналитика»).
export function refreshAnalyticsIfOpen() {
    if (_loaded) loadAnalytics();
}


// ─── Глобальные карточки ───────────────────────────────────────────────────
function _renderTotals(t) {
    const card = (label, value, hint = '') => `
        <div class="analytics-stat">
            <div class="analytics-stat__value">${value}</div>
            <div class="analytics-stat__label">${_esc(label)}</div>
            ${hint ? `<div class="analytics-stat__hint">${_esc(hint)}</div>` : ''}
        </div>
    `;
    return `
        <section class="analytics-section">
            <h2 class="analytics-h">Общая картина</h2>
            <div class="analytics-stats">
                ${card('Шаблонов',          t.templates)}
                ${card('Списков',           t.events)}
                ${card('Людей в базе',      t.persons_active, `${t.persons_fired} уволено`)}
                ${card('Слотов всего',      t.total_slots)}
                ${card('Заполнено слотов',  t.filled_slots, `${t.fill_rate}%`)}
            </div>
        </section>
    `;
}


// ─── Управления ───────────────────────────────────────────────────────────
function _renderUsers(rows) {
    if (!rows?.length) return '';
    const max = Math.max(...rows.map(r => r.total));
    return `
        <section class="analytics-section">
            <h2 class="analytics-h">Заполнение по управлениям</h2>
            <p class="analytics-sub">Из реальных списков (без шаблонов). Показано:
                сколько слотов закреплено за управлением, какая доля заполнена.</p>
            <table class="analytics-table">
                <thead><tr>
                    <th>Управление</th>
                    <th style="text-align:right;">Слотов</th>
                    <th style="text-align:right;">Заполнено</th>
                    <th style="text-align:right;">% заполнения</th>
                    <th style="text-align:right;">Списков</th>
                    <th style="width:30%;">Прогресс</th>
                </tr></thead>
                <tbody>
                ${rows.map(r => `
                    <tr>
                        <td>${_esc(r.department)}</td>
                        <td style="text-align:right;">${r.total}</td>
                        <td style="text-align:right;">${r.filled}</td>
                        <td style="text-align:right;">
                            <span class="${_rateClass(r.fill_rate)}">${r.fill_rate}%</span>
                        </td>
                        <td style="text-align:right;">${r.events_count}</td>
                        <td>
                            <div class="analytics-bar">
                                <div class="analytics-bar__fill ${_rateClass(r.fill_rate)}"
                                     style="width:${Math.min(100, (r.total / max) * 100)}%;
                                            opacity:${0.4 + 0.6 * (r.fill_rate / 100)};"></div>
                            </div>
                        </td>
                    </tr>
                `).join('')}
                </tbody>
            </table>
        </section>
    `;
}


// ─── Должности ─────────────────────────────────────────────────────────────
function _renderPositions(rows) {
    if (!rows?.length) return '';
    const usedCount   = rows.filter(p => p.slot_count > 0).length;
    const ghostsCount = rows.filter(p => p.slot_count === 0).length;
    return `
        <section class="analytics-section">
            <h2 class="analytics-h">Должности</h2>
            <p class="analytics-sub">
                Используется: <strong>${usedCount}</strong> ·
                Без слотов («мёртвый груз»): <strong>${ghostsCount}</strong>.
                Должности без слотов не используются нигде в шаблонах и списках —
                стоит подумать, нужны ли они.
            </p>
            <table class="analytics-table">
                <thead><tr>
                    <th>Название</th>
                    <th style="text-align:right;">Слотов всего</th>
                    <th style="text-align:right;">Из них заполнено</th>
                    <th style="text-align:right;">Статус</th>
                </tr></thead>
                <tbody>
                ${rows.map(p => `
                    <tr class="${p.slot_count === 0 ? 'analytics-row-dead' : ''}">
                        <td>${_esc(p.name)}</td>
                        <td style="text-align:right;">${p.slot_count}</td>
                        <td style="text-align:right;">${p.filled_count}</td>
                        <td style="text-align:right;">
                            ${p.slot_count === 0
                                ? '<span class="analytics-tag analytics-tag--dead">мёртвый груз</span>'
                                : (p.filled_count / p.slot_count) >= 0.8
                                    ? '<span class="analytics-tag analytics-tag--ok">ОК</span>'
                                    : '<span class="analytics-tag analytics-tag--warn">недозаполнено</span>'}
                        </td>
                    </tr>
                `).join('')}
                </tbody>
            </table>
        </section>
    `;
}


// ─── Топ нарядов (за 90 дней) ──────────────────────────────────────────────
function _renderDutyTop(rows) {
    if (!rows?.length) {
        return `<section class="analytics-section">
            <h2 class="analytics-h">Топ нарядов (90 дней)</h2>
            <p class="analytics-sub">Нарядов за последние 90 дней пока нет.</p>
        </section>`;
    }
    return `
        <section class="analytics-section">
            <h2 class="analytics-h">Топ нарядов (за 90 дней)</h2>
            <p class="analytics-sub">Кто чаще всего был в нарядах. Полезно для
                контроля переработки и равномерности распределения.</p>
            <table class="analytics-table">
                <thead><tr>
                    <th>#</th>
                    <th>ФИО</th>
                    <th>Звание</th>
                    <th style="text-align:right;">Нарядов</th>
                </tr></thead>
                <tbody>
                ${rows.map((p, i) => `
                    <tr>
                        <td style="color:var(--md-on-surface-hint);">${i + 1}</td>
                        <td>${_esc(p.full_name)}</td>
                        <td>${_esc(p.rank || '')}</td>
                        <td style="text-align:right; font-weight:600;">${p.count}</td>
                    </tr>
                `).join('')}
                </tbody>
            </table>
        </section>
    `;
}


// ─── «Призраки» — люди ни разу не назначенные ─────────────────────────────
function _renderGhosts(ghosts, total) {
    if (!total) return '';
    return `
        <section class="analytics-section">
            <h2 class="analytics-h">Люди-«призраки» в базе (${total})</h2>
            <p class="analytics-sub">Активные сотрудники, которых ни разу
                не назначали в списки и нет в нарядах. Возможно, стоит добавить
                их в актуальные списки или уволить из базы (если уже не работают).
                ${ghosts.length < total ? `Показано первые ${ghosts.length}.` : ''}
            </p>
            <table class="analytics-table">
                <thead><tr>
                    <th>ФИО</th>
                    <th>Звание</th>
                    <th>Управление</th>
                </tr></thead>
                <tbody>
                ${ghosts.map(p => `
                    <tr>
                        <td>${_esc(p.full_name)}</td>
                        <td>${_esc(p.rank || '')}</td>
                        <td>${_esc(p.department || '— нераспределён')}</td>
                    </tr>
                `).join('')}
                </tbody>
            </table>
        </section>
    `;
}


// ─── Перегруз / недогруз в нарядах за 90 дней ─────────────────────────────
function _renderDutyLoad(d) {
    if (!d || !d.active_with_duty) return '';
    const showOver = d.overloaded?.length || 0;
    const showUnder = d.underloaded?.length || 0;
    if (!showOver && !showUnder) return `
        <section class="analytics-section">
            <h2 class="analytics-h">Нагрузка нарядов (90 дней)</h2>
            <p class="analytics-sub">
                Среднее: <b>${d.avg_per_person}</b> N/чел. (по ${d.active_with_duty} активным).
                Распределение в норме — нет ни перегруженных (≥${d.threshold_high}),
                ни недогруженных (≤${d.threshold_low}).
            </p>
        </section>
    `;
    const renderRow = (e) => `
        <tr>
            <td>${_esc(e.full_name)}${e.rank ? ` <small>${_esc(e.rank)}</small>` : ''}</td>
            <td>${_esc(e.department || '—')}</td>
            <td style="text-align:right;"><b>${e.count}</b></td>
            <td style="text-align:right;"><span class="analytics-load-pct">${e.pct_of_avg}%</span></td>
        </tr>
    `;
    return `
        <section class="analytics-section">
            <h2 class="analytics-h">Нагрузка нарядов (90 дней)</h2>
            <p class="analytics-sub">
                Среднее <b>${d.avg_per_person}</b> N/чел. по ${d.active_with_duty} активным.
                Перегруз: ≥<b>${d.threshold_high}</b> (150% от среднего).
                Недогруз: ≤<b>${d.threshold_low}</b> (40% от среднего).
            </p>
            <div class="analytics-twocol">
                ${showOver ? `
                    <div class="analytics-twocol__col">
                        <h3 class="analytics-h-sm analytics-h-sm--warn">Перегруженные (${showOver})</h3>
                        <table class="analytics-table">
                            <thead><tr>
                                <th>ФИО</th>
                                <th>Управление</th>
                                <th style="text-align:right;">Нарядов</th>
                                <th style="text-align:right;">% от ср.</th>
                            </tr></thead>
                            <tbody>${d.overloaded.map(renderRow).join('')}</tbody>
                        </table>
                    </div>
                ` : ''}
                ${showUnder ? `
                    <div class="analytics-twocol__col">
                        <h3 class="analytics-h-sm analytics-h-sm--cool">Недогруженные (${showUnder})</h3>
                        <table class="analytics-table">
                            <thead><tr>
                                <th>ФИО</th>
                                <th>Управление</th>
                                <th style="text-align:right;">Нарядов</th>
                                <th style="text-align:right;">% от ср.</th>
                            </tr></thead>
                            <tbody>${d.underloaded.map(renderRow).join('')}</tbody>
                        </table>
                    </div>
                ` : ''}
            </div>
        </section>
    `;
}


// ─── Здоровье Базы людей ──────────────────────────────────────────────────
function _renderDataHealth(h) {
    if (!h) return '';
    const pct = (n) => h.total_active ? Math.round(100 * n / h.total_active) : 0;
    const dupBlock = (label, items, total, fmt) => {
        if (!total) return '';
        return `
            <div class="analytics-twocol__col">
                <h3 class="analytics-h-sm analytics-h-sm--warn">
                    ${_esc(label)} (${total}${total > items.length ? `, показано ${items.length}` : ''})
                </h3>
                <ul class="analytics-dup-list">
                    ${items.map(g => `
                        <li>
                            <code>${_esc(g.key)}</code>:
                            ${g.persons.map(p => `<span>${_esc(p.full_name)}${fmt(p)}</span>`).join(' · ')}
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    };
    return `
        <section class="analytics-section">
            <h2 class="analytics-h">Здоровье Базы людей</h2>
            <p class="analytics-sub">
                Активных в базе: <b>${h.total_active}</b>. Незаполненные поля и
                подозрения на дубликаты — точки внимания для админа.
            </p>
            <div class="analytics-stats">
                <div class="analytics-stat ${h.no_position ? 'analytics-stat--warn' : ''}">
                    <div class="analytics-stat__value">${h.no_position}</div>
                    <div class="analytics-stat__label">без должности</div>
                    <div class="analytics-stat__hint">${pct(h.no_position)}%</div>
                </div>
                <div class="analytics-stat ${h.no_phone ? 'analytics-stat--warn' : ''}">
                    <div class="analytics-stat__value">${h.no_phone}</div>
                    <div class="analytics-stat__label">без телефона</div>
                    <div class="analytics-stat__hint">${pct(h.no_phone)}%</div>
                </div>
                <div class="analytics-stat ${h.no_department ? 'analytics-stat--warn' : ''}">
                    <div class="analytics-stat__value">${h.no_department}</div>
                    <div class="analytics-stat__label">без управления</div>
                    <div class="analytics-stat__hint">${pct(h.no_department)}%</div>
                </div>
                <div class="analytics-stat ${h.dup_phones_total ? 'analytics-stat--err' : ''}">
                    <div class="analytics-stat__value">${h.dup_phones_total}</div>
                    <div class="analytics-stat__label">дубл. телефоны</div>
                </div>
                <div class="analytics-stat ${h.dup_docs_total ? 'analytics-stat--err' : ''}">
                    <div class="analytics-stat__value">${h.dup_docs_total}</div>
                    <div class="analytics-stat__label">дубл. документы</div>
                </div>
            </div>
            ${(h.dup_phones_total || h.dup_docs_total) ? `
                <div class="analytics-twocol">
                    ${dupBlock(
                        'Дубликаты по телефону',
                        h.dup_phones,
                        h.dup_phones_total,
                        p => p.phone ? ` <small>${_esc(p.phone)}</small>` : '',
                    )}
                    ${dupBlock(
                        'Дубликаты по № документа',
                        h.dup_docs,
                        h.dup_docs_total,
                        p => p.doc_number ? ` <small>${_esc(p.doc_number)}</small>` : '',
                    )}
                </div>
            ` : ''}
        </section>
    `;
}


// ─── Дни без покрытия в графиках нарядов (текущий месяц) ──────────────────
function _renderUncovered(rows, monthInfo) {
    if (!rows?.length) return `
        <section class="analytics-section">
            <h2 class="analytics-h">Дни без покрытия в графиках нарядов</h2>
            <p class="analytics-sub">
                В графиках с привязанными людьми в этом месяце пропусков нет —
                каждый день кто-то стоит. 👍
            </p>
        </section>
    `;
    const monthName = ['январь','февраль','март','апрель','май','июнь',
                       'июль','август','сентябрь','октябрь','ноябрь','декабрь'][
        (monthInfo?.month || 1) - 1
    ];
    return `
        <section class="analytics-section">
            <h2 class="analytics-h">Дни без покрытия (${monthName} ${monthInfo?.year || ''})</h2>
            <p class="analytics-sub">
                Графики с привязанными людьми, в которых в этом месяце есть дни
                без отметки наряда (N). Превентивная диагностика «забыли назначить».
            </p>
            <table class="analytics-table">
                <thead><tr>
                    <th>График</th>
                    <th>Должность</th>
                    <th style="text-align:right;">Людей</th>
                    <th style="text-align:right;">Пропусков</th>
                    <th>Дни</th>
                </tr></thead>
                <tbody>
                ${rows.map(r => `
                    <tr>
                        <td>${_esc(r.schedule_title)}</td>
                        <td>${_esc(r.position_name || '—')}</td>
                        <td style="text-align:right;">${r.persons_cnt}</td>
                        <td style="text-align:right;">
                            <b class="${r.missing_count > 7 ? 'analytics-rate--low' : 'analytics-rate--mid'}">${r.missing_count}</b>
                        </td>
                        <td class="analytics-missing-days">
                            ${r.missing_dates.slice(0, 12).map(d => `
                                <span class="analytics-day-chip">${d.slice(8)}.${d.slice(5, 7)}</span>
                            `).join('')}
                            ${r.missing_dates.length > 12 ? `<small>… и ещё ${r.missing_dates.length - 12}</small>` : ''}
                        </td>
                    </tr>
                `).join('')}
                </tbody>
            </table>
        </section>
    `;
}


function _rateClass(rate) {
    if (rate >= 80) return 'analytics-rate--high';
    if (rate >= 50) return 'analytics-rate--mid';
    return 'analytics-rate--low';
}


function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
