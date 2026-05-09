// static/js/duty_substitution_wizard.js
//
// Универсальный wizard замещений в графике наряда. Открывается, когда
// при утверждении месяца бэк вернул 409 с detail.code='duty_conflicts_unresolved'
// — для каждого конфликтного дня админ/dept-юзер указывает кто primary,
// а кто куда замещает.
//
// Один наряд может покрывать несколько мест (разные шаблоны / разные
// группы), поэтому у каждого замещающего — массив целей: «куда»: квота +
// шаблон + группа. Кнопка «+ добавить место» расширяет список.
//
// Используется и из dept_duty.js, и из duty.js (admin).
//
// API:
//   openSubstitutionWizard({
//       conflicts:    [{date, marks: [{mark_id, person, rank, is_primary, substitutes, ...}], unresolved}, ...],
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

function _newTarget(t = {}) {
    return {
        dept:     t.dept     ?? '',
        tpl_id:   t.tpl_id   ?? '',
        group_id: t.group_id ?? '',
    };
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

    // Префетч групп всех шаблонов: нужна карта group_id → tpl_id, чтобы
    // подставить правильный шаблон в селект для уже сохранённых targets.
    const groupsByTpl = new Map();
    const tplIdByGroupId = new Map();
    await Promise.all(templates.map(async t => {
        try {
            const groups = await api.get(`/dept/templates/${t.id}/groups`);
            groupsByTpl.set(t.id, groups);
            for (const g of groups) tplIdByGroupId.set(g.id, t.id);
        } catch {
            groupsByTpl.set(t.id, []);
        }
    }));
    function _loadTplGroups(tplId) {
        return groupsByTpl.get(parseInt(tplId, 10)) || [];
    }

    // Решения по mark_id: targets — массив целей замещения
    const decisions = new Map();
    for (const day of conflicts) {
        for (const m of day.marks) {
            const targets = [];
            const arr = Array.isArray(m.substitutes) ? m.substitutes : [];
            for (const t of arr) {
                const gid  = t.template_group_id;
                const dept = t.department || '';
                if (gid && dept) {
                    targets.push(_newTarget({
                        dept,
                        tpl_id: tplIdByGroupId.get(gid) || '',
                        group_id: gid,
                    }));
                }
            }
            // Fallback: legacy одиночные поля (на случай если бэк вернул
            // старый формат ответа без substitutes)
            if (targets.length === 0 && m.substitute_department && m.substitute_template_group_id) {
                targets.push(_newTarget({
                    dept:     m.substitute_department,
                    tpl_id:   tplIdByGroupId.get(m.substitute_template_group_id) || '',
                    group_id: m.substitute_template_group_id,
                }));
            }
            decisions.set(m.mark_id, {
                is_primary: m.is_primary,
                targets,
            });
        }
    }

    // Авто-режим хранит «список мест» который применится ко всем не-primary
    const autoTargets = [_newTarget()];

    document.getElementById('duty-subst-wizard')?.remove();
    const modal = document.createElement('div');
    modal.id = 'duty-subst-wizard';
    modal.style.cssText = `
        position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.5);
        display:flex; align-items:center; justify-content:center; padding:20px;
    `;
    modal.innerHTML = `
        <div style="background:var(--md-surface,#fff); border-radius:var(--md-radius-lg,14px);
                    max-width:820px; width:100%; max-height:90vh;
                    display:flex; flex-direction:column;
                    box-shadow:0 20px 60px rgba(0,0,0,0.25);">
            <div style="padding:14px 18px; border-bottom:1px solid var(--md-outline-variant);">
                <h3 style="margin:0; font-size:1.02rem; font-weight:600;">
                    Замещения в графике
                </h3>
                <p style="margin:6px 0 0; font-size:0.82rem; color:var(--md-on-surface-variant); line-height:1.4;">
                    Дней с >1 нарядом: <b>${conflicts.length}</b>. Для каждого дня укажите,
                    кто идёт <i>по своей должности</i>, а кто <i>замещает</i>. У замещающего
                    может быть <b>несколько мест</b> в разных шаблонах/группах — добавляйте кнопкой «+ место».
                </p>
            </div>
            <div style="padding:10px 14px; border-bottom:1px solid var(--md-outline-variant);
                        background:var(--md-surface-variant);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <label style="font-size:0.74rem; font-weight:600; color:var(--md-on-surface-variant);
                                  text-transform:uppercase; letter-spacing:0.04em;">
                        Авто-режим: места для всех «вторых»
                    </label>
                    <button id="auto-apply" class="btn btn-outlined btn-sm" type="button">⚡ Применить ко всем</button>
                </div>
                <div id="auto-targets" class="subst-targets"></div>
                <button id="auto-add" class="btn btn-text btn-sm" type="button"
                        style="margin-top:4px;">+ место</button>
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
    const autoEl = modal.querySelector('#auto-targets');

    // ── Универсальная отрисовка ряда «цель замещения» ─────────────────────
    function _renderTargetRow(t, idx, options) {
        // options.canRemove: можно ли удалить эту строку (если targets >1)
        const tplId = t.tpl_id;
        const groups = tplId ? _loadTplGroups(tplId) : [];
        const groupOpts = '<option value="">— группа —</option>'
            + groups.map(g =>
                `<option value="${g.id}" ${String(g.id) === String(t.group_id) ? 'selected' : ''}>${_esc(g.name)}${g.time_offset ? ` (${_esc(g.time_offset)})` : ''}</option>`
            ).join('');
        return `
            <div class="subst-target-row" data-idx="${idx}">
                <select class="t-dept" data-field="dept">
                    <option value="">— квота —</option>
                    ${departments.map(d =>
                        `<option value="${_esc(d)}" ${d === t.dept ? 'selected' : ''}>${_esc(d)}</option>`
                    ).join('')}
                </select>
                <select class="t-tpl" data-field="tpl">
                    <option value="">— шаблон —</option>
                    ${templates.map(tt =>
                        `<option value="${tt.id}" ${String(tt.id) === String(tplId) ? 'selected' : ''}>${_esc(tt.title)}</option>`
                    ).join('')}
                </select>
                <select class="t-group" data-field="group" ${tplId ? '' : 'disabled'}>
                    ${groupOpts}
                </select>
                <button type="button" class="t-remove" title="Убрать место" ${options.canRemove ? '' : 'disabled'}>×</button>
            </div>
        `;
    }

    function _bindTargetRowEvents(container, targets, onRemove) {
        // onRemove вызывается только когда нужно перерисовать список целей
        // (после удаления строки). Простые изменения select-ов не требуют
        // re-render: они только обновляют state и зависимый groupSel.
        container.querySelectorAll('.subst-target-row').forEach(row => {
            const idx = parseInt(row.dataset.idx, 10);
            const t = targets[idx];
            const deptSel  = row.querySelector('.t-dept');
            const tplSel   = row.querySelector('.t-tpl');
            const groupSel = row.querySelector('.t-group');
            const rmBtn    = row.querySelector('.t-remove');

            deptSel?.addEventListener('change',  () => { t.dept = deptSel.value || ''; });
            tplSel?.addEventListener('change', () => {
                t.tpl_id = tplSel.value || '';
                t.group_id = '';
                if (t.tpl_id) {
                    const gs = _loadTplGroups(t.tpl_id);
                    groupSel.innerHTML = '<option value="">— группа —</option>'
                        + gs.map(g =>
                            `<option value="${g.id}">${_esc(g.name)}${g.time_offset ? ` (${_esc(g.time_offset)})` : ''}</option>`
                        ).join('');
                    groupSel.disabled = false;
                } else {
                    groupSel.innerHTML = '<option value="">— группа —</option>';
                    groupSel.disabled = true;
                }
            });
            groupSel?.addEventListener('change', () => { t.group_id = groupSel.value || ''; });
            rmBtn?.addEventListener('click', () => {
                if (targets.length <= 1) return;
                targets.splice(idx, 1);
                onRemove?.();
            });
        });
    }

    // ── Авто-режим: панель с множественными целями ───────────────────────
    function _renderAuto() {
        autoEl.innerHTML = autoTargets
            .map((t, i) => _renderTargetRow(t, i, { canRemove: autoTargets.length > 1 }))
            .join('');
        _bindTargetRowEvents(autoEl, autoTargets, _renderAuto);
    }

    modal.querySelector('#auto-add').addEventListener('click', () => {
        autoTargets.push(_newTarget());
        _renderAuto();
    });

    // ── Список конфликтных дней / марков ─────────────────────────────────
    function _renderRow(mark) {
        const dec = decisions.get(mark.mark_id);
        const isPrim = dec.is_primary;
        const targetsHtml = dec.targets.length === 0
            ? '<div class="subst-empty">— места не указаны (добавьте)</div>'
            : dec.targets
                .map((t, i) => _renderTargetRow(t, i, { canRemove: dec.targets.length > 1 }))
                .join('');
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
                    <div class="subst-targets">${targetsHtml}</div>
                    <button type="button" class="subst-add-target btn btn-text btn-sm">+ место</button>
                </div>
            </div>
        `;
    }

    function _renderAll() {
        listEl.innerHTML = conflicts.map(day => `
            <div class="subst-day">
                <h4 class="subst-day__title">${_esc(day.date)} · ${day.marks.length} наряда</h4>
                <div class="subst-day__rows">
                    ${day.marks.map(m => _renderRow(m)).join('')}
                </div>
            </div>
        `).join('');
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
                    if (!dec.is_primary && dec.targets.length === 0) {
                        dec.targets.push(_newTarget());
                    }
                    _renderAll();
                });
            });

            const placement = row.querySelector('.subst-row__placement');
            const targetsBox = placement?.querySelector('.subst-targets');
            if (targetsBox) {
                _bindTargetRowEvents(targetsBox, dec.targets, _renderAll);
            }

            row.querySelector('.subst-add-target')?.addEventListener('click', () => {
                dec.targets.push(_newTarget());
                _renderAll();
            });
        });
    }

    _renderAuto();
    _renderAll();

    // ── Применение авто-режима ───────────────────────────────────────────
    modal.querySelector('#auto-apply').addEventListener('click', () => {
        const cleanAuto = autoTargets.filter(t => t.dept && t.tpl_id && t.group_id);
        if (cleanAuto.length === 0) {
            window.showSnackbar?.('Заполните хотя бы одно место в авто-режиме (квота + шаблон + группа)', 'error');
            return;
        }
        for (const day of conflicts) {
            day.marks.forEach((m, i) => {
                const dec = decisions.get(m.mark_id);
                if (i === 0) {
                    dec.is_primary = true;
                    dec.targets = [];
                } else {
                    dec.is_primary = false;
                    dec.targets = cleanAuto.map(t => _newTarget(t));
                }
            });
        }
        _renderAll();
        window.showSnackbar?.(`Применено: ${cleanAuto.length} ${cleanAuto.length === 1 ? 'место' : 'мест'} ко всем дням`, 'info');
    });

    modal.querySelector('#subst-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // ── Сохранение ───────────────────────────────────────────────────────
    modal.querySelector('#subst-save').addEventListener('click', async () => {
        for (const day of conflicts) {
            const primaryCount = day.marks.filter(m => decisions.get(m.mark_id).is_primary).length;
            if (primaryCount !== 1) {
                window.showSnackbar?.(`${day.date}: должен быть ровно один «по своей должности»`, 'error');
                return;
            }
            for (const m of day.marks) {
                const d = decisions.get(m.mark_id);
                if (d.is_primary) continue;
                const valid = d.targets.filter(t => t.dept && t.group_id);
                if (valid.length === 0) {
                    window.showSnackbar?.(`${day.date}: для «${m.person}» укажите хотя бы одно место (квота + группа)`, 'error');
                    return;
                }
            }
        }

        const payload = {
            decisions: Array.from(decisions.entries()).map(([mark_id, d]) => {
                if (d.is_primary) {
                    return { mark_id, is_primary: true, substitutes: [] };
                }
                const subs = d.targets
                    .filter(t => t.dept && t.group_id)
                    .map(t => ({
                        department:        t.dept,
                        template_group_id: parseInt(t.group_id, 10),
                    }));
                return { mark_id, is_primary: false, substitutes: subs };
            }),
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
