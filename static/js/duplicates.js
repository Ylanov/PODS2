// static/js/duplicates.js
/**
 * Поиск и подсветка дубликатов ФИО в одном списке.
 *
 * Дубликат = одинаковое нормализованное ФИО, встречающееся в двух или
 * более слотах одного списка (любых группах). Нормализация: trim +
 * casefold + сжатие пробелов. Пустые ФИО игнорируются.
 */

function _normalize(name) {
    return String(name || '')
        .trim()
        .toLocaleLowerCase('ru-RU')
        .replace(/\s+/g, ' ');
}

/**
 * Возвращает Map<normalized_name, slotId[]> — только для имён, встречающихся
 * 2+ раз. Если дубликатов нет — пустая Map.
 */
export function findDuplicateNames(groups) {
    const byName = new Map();
    for (const g of groups || []) {
        for (const s of (g.slots || [])) {
            const norm = _normalize(s.full_name);
            if (!norm) continue;
            if (!byName.has(norm)) byName.set(norm, []);
            byName.get(norm).push(s.id);
        }
    }
    const dups = new Map();
    for (const [name, ids] of byName) {
        if (ids.length >= 2) dups.set(name, ids);
    }
    return dups;
}

/**
 * Расставляет класс is-duplicate на slot-row'ах внутри rootEl и возвращает
 * массив объектов {name, count} для отображения в баннере. Имена в баннере —
 * с оригинальным регистром первого вхождения.
 */
export function applyDuplicateHighlight(rootEl, groups) {
    if (!rootEl) return [];

    // Снимаем старую подсветку перед перерисовкой.
    rootEl.querySelectorAll('tr.is-duplicate').forEach(tr => tr.classList.remove('is-duplicate'));

    const dups = findDuplicateNames(groups);
    if (dups.size === 0) return [];

    // Берём оригинальное написание имени из первого попавшегося слота.
    const originalCase = new Map();
    for (const g of groups || []) {
        for (const s of (g.slots || [])) {
            const norm = _normalize(s.full_name);
            if (norm && dups.has(norm) && !originalCase.has(norm)) {
                originalCase.set(norm, s.full_name);
            }
        }
    }

    const dupSlotIds = new Set();
    for (const ids of dups.values()) ids.forEach(id => dupSlotIds.add(id));

    rootEl.querySelectorAll('tr[data-slot-id]').forEach(tr => {
        const id = parseInt(tr.dataset.slotId, 10);
        if (dupSlotIds.has(id)) tr.classList.add('is-duplicate');
    });

    return Array.from(dups, ([norm, ids]) => ({
        name:  originalCase.get(norm) || norm,
        count: ids.length,
    }));
}

/**
 * Рендерит/обновляет баннер-сводку дубликатов в указанном контейнере.
 * Если дубликатов нет — баннер скрывается.
 */
export function renderDuplicatesBanner(bannerEl, dupReport) {
    if (!bannerEl) return;
    if (!dupReport || dupReport.length === 0) {
        bannerEl.innerHTML = '';
        bannerEl.classList.add('hidden');
        return;
    }
    const items = dupReport
        .map(d => `${_esc(d.name)} ×${d.count}`)
        .join(', ');
    bannerEl.classList.remove('hidden');
    bannerEl.innerHTML = `
        <div class="dup-banner">
            <span class="dup-banner__title">Дубликаты в списке:</span>
            <span class="dup-banner__list">${items}</span>
        </div>`;
}

function _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
