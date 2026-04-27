// static/js/person_conflicts.js
//
// Мини-модуль «Расхождения данных в общей базе людей».
// Открывается из кнопки в шапке (#conflicts-header-btn) — видна только
// админу. Список открытых расхождений + две кнопки на запись:
//    «Оставить старое» — выбор=old, ничего не меняет в Person
//    «Применить новое» — выбор=new, обновляет Person тем что прислано из анкеты

import { api } from './api.js';

function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Полл-интервал для бейджа: 60 секунд. WS-нотификация ускорит обновление,
// если будем слать события (пока — просто polling).
let _pollTimer = null;

export function initConflictsBadge() {
    const btn = document.getElementById('conflicts-header-btn');
    if (!btn) return;
    if (window.currentUser?.role !== 'admin') {
        btn.classList.add('hidden');
        return;
    }
    btn.classList.remove('hidden');
    btn.addEventListener('click', openConflictsModal);

    refreshBadge();
    // На person-update также пересчитаем — расхождения могут появиться/уйти
    document.addEventListener('person-update', refreshBadge);
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(refreshBadge, 60_000);
}

export async function refreshBadge() {
    try {
        const res = await api.get('/persons/conflicts/count');
        const dot = document.getElementById('conflicts-header-dot');
        if (!dot) return;
        const n = res.count || 0;
        dot.textContent = n > 99 ? '99+' : String(n);
        dot.classList.toggle('hidden', n === 0);
    } catch (_) { /* noop */ }
}


export async function openConflictsModal() {
    document.getElementById('conflicts-overlay')?.remove();

    const ov = document.createElement('div');
    ov.id = 'conflicts-overlay';
    ov.className = 'cf-overlay';
    ov.innerHTML = `
        <div class="cf-dialog" role="dialog" aria-label="Расхождения данных">
            <div class="cf-header">
                <div>
                    <div class="cf-header__title">Расхождения данных</div>
                    <div class="cf-header__subtitle">
                        Анкеты участников тестирования предложили
                        значения, отличающиеся от уже сохранённых в общей
                        базе людей. Выберите какие из двух правильные.
                    </div>
                </div>
                <button class="btn btn-text btn-sm" id="cf-close" type="button">Закрыть</button>
            </div>
            <div class="cf-body">
                <div id="cf-list">
                    <div class="cf-loading">Загрузка…</div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    ov.querySelector('#cf-close').addEventListener('click', () => ov.remove());

    await reloadList();
}


async function reloadList() {
    const root = document.getElementById('cf-list');
    if (!root) return;
    try {
        const items = await api.get('/persons/conflicts?only_pending=true');
        if (!items.length) {
            root.innerHTML = `
                <div class="cf-empty">
                    Нерешённых расхождений нет. Все данные синхронизированы.
                </div>`;
            return;
        }
        // Группируем по person_id, чтобы по одному человеку одна карточка
        const byPerson = new Map();
        for (const c of items) {
            if (!byPerson.has(c.person_id)) byPerson.set(c.person_id, {
                person_id: c.person_id,
                person_full_name: c.person_full_name,
                conflicts: [],
            });
            byPerson.get(c.person_id).conflicts.push(c);
        }
        root.innerHTML = [...byPerson.values()].map(g => `
            <div class="cf-card" data-person-id="${g.person_id}">
                <div class="cf-card__head">
                    <div class="cf-card__name">${esc(g.person_full_name || `Person #${g.person_id}`)}</div>
                    <div class="cf-card__sub">
                        ${g.conflicts.length} ${plural(g.conflicts.length, 'поле', 'поля', 'полей')} с расхождением
                    </div>
                </div>
                <div class="cf-card__rows">
                    ${g.conflicts.map(c => `
                        <div class="cf-row" data-id="${c.id}">
                            <div class="cf-row__field">${esc(c.field_label)}</div>
                            <div class="cf-row__values">
                                <div class="cf-val cf-val--old">
                                    <div class="cf-val__label">В базе сейчас</div>
                                    <div class="cf-val__text">${esc(c.old_value || '—')}</div>
                                </div>
                                <div class="cf-val cf-val--new">
                                    <div class="cf-val__label">Прислано из анкеты</div>
                                    <div class="cf-val__text">${esc(c.new_value || '—')}</div>
                                </div>
                            </div>
                            <div class="cf-row__actions">
                                <button class="btn btn-outlined btn-sm"
                                        data-act="old" data-id="${c.id}">
                                    ✓ Оставить старое
                                </button>
                                <button class="btn btn-filled btn-sm"
                                        data-act="new" data-id="${c.id}">
                                    ↻ Применить новое
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');

        root.querySelectorAll('[data-act]').forEach(btn => {
            btn.addEventListener('click', () => resolve(
                parseInt(btn.dataset.id, 10),
                btn.dataset.act,
                btn,
            ));
        });
    } catch (err) {
        root.innerHTML = `<div class="cf-error">Ошибка: ${esc(err.message || '')}</div>`;
    }
}


async function resolve(id, choice, btnEl) {
    const row = btnEl.closest('.cf-row');
    if (row) row.style.opacity = '0.5';
    try {
        await api.post(`/persons/conflicts/${id}/resolve`, { choice });
        window.showSnackbar?.(
            choice === 'new' ? 'Применено новое значение' : 'Старое значение оставлено',
            'success',
        );
        await reloadList();
        await refreshBadge();
    } catch (err) {
        if (row) row.style.opacity = '1';
        window.showSnackbar?.(`Ошибка: ${err.message || ''}`, 'error');
    }
}


function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
}
