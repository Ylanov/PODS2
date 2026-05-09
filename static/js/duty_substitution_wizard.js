// static/js/duty_substitution_wizard.js
//
// Универсальный wizard замещений в графике наряда. Открывается, когда
// при утверждении месяца бэк вернул 409 с detail.code='duty_conflicts_unresolved'
// — для каждого конфликтного дня админ/dept-юзер указывает кто primary,
// а кто куда замещает.
//
// Используется и из dept_duty.js, и из duty.js (admin).
//
// API:
//   openSubstitutionWizard({
//       conflicts:    [{date, marks: [{mark_id, person, rank, is_primary, ...}], unresolved}, ...],
//       scheduleId:   int,
//       apiPrefix:    '/dept' | '/admin',
//       onResolved:   () => void  // вызывается после PATCH /conflicts успешно
//   })
//
// Справочные данные (шаблоны / группы / управления) тащим с dept-стороны
// — её endpoint'ы /dept/templates, /dept/templates/{id}/groups,
// /dept/departments доступны и админу через require_permission(...).

import { api } from './api.js';

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function openSubstitutionWizard({
    conflicts,
    scheduleId,
    apiPrefix = '/dept',
    onResolved,
}) {
    if (!conflicts || conflicts.length === 0 || !scheduleId) return;

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

    // Решения по mark_id
    const decisions = new Map();
    for (const day of conflicts) {
        for (const m of day.marks) {
            decisions.set(m.mark_id, {
                is_primary: m.is_primary,
                dept:       m.substitute_department || '',
                tpl_id:     '',   // tpl_id уточняется при сохранении из group_id
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
            await api.patch(`${apiPrefix}/schedules/${scheduleId}/conflicts`, payload);
        } catch (err) {
            window.showSnackbar?.(`Ошибка сохранения: ${err?.message || err}`, 'error');
            return;
        }
        modal.remove();
        if (typeof onResolved === 'function') {
            await onResolved();
        }
    });
}
