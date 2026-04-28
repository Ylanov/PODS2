// static/js/duty_calc.js
//
// Общая логика для графиков наряда: загрузка праздников, расчёт
// переработки, хелперы рендеринга.
//
// Используется обоими графиками — админским (duty.js) и департаментским
// (dept_duty.js). Единая точка истины для формулы часов.
//
// Правила переработки (по ТЗ):
//   Пн-Чт               → +4 ч
//   Пт                  → +12 ч
//   Сб                  → +20 ч
//   Вс                  → +12 ч
//   Праздник (обычный)  → +20 ч
//   Праздник (последний
//    день каникул)      → +12 ч   (флаг is_last_day в таблице holidays)
//   День перед
//    праздником         → +12 ч   (если завтра праздник с is_last_day=false)
//
// Типы отметок (mark_type):
//   'N' — Наряд      → даёт переработку
//   'U' — Увольнение → в счётчики не попадает
//   'V' — Отпуск     → в счётчики не попадает

import { api } from './api.js';

// ─── Типы отметок ──────────────────────────────────────────────────────────
export const MARK_DUTY     = 'N';
export const MARK_LEAVE    = 'U';
export const MARK_VACATION = 'V';
export const MARK_RESERVE  = 'R';   // UI: «РЗ», отдельный счётчик, без переработки

// ─── Иерархия воинских званий ─────────────────────────────────────────────
// От высшего к низшему. Используется для автосортировки в графиках наряда:
// генералы сверху, рядовые внизу. Звание, которого нет в списке (нестандартное
// или пустое поле), уходит в конец таблицы.
export const RANK_ORDER = [
    'Генерал армии',
    'Генерал-полковник',
    'Генерал-лейтенант',
    'Генерал-майор',
    'Полковник',
    'Подполковник',
    'Майор',
    'Капитан',
    'Старший лейтенант',
    'Лейтенант',
    'Младший лейтенант',
    'Старший прапорщик',
    'Прапорщик',
    'Старшина',
    'Старший сержант',
    'Сержант',
    'Младший сержант',
    'Ефрейтор',
    'Рядовой',
];

const _rankLookup = new Map(RANK_ORDER.map((r, i) => [r.toLowerCase(), i]));

export function rankIndex(rank) {
    if (!rank) return RANK_ORDER.length + 1;
    const idx = _rankLookup.get(String(rank).trim().toLowerCase());
    return idx === undefined ? RANK_ORDER.length : idx;
}

// При равных званиях сортируем по ФИО (русская локаль) — даёт стабильный
// порядок и читается естественно.
export function sortByRank(persons) {
    return [...persons].sort((a, b) => {
        const ra = rankIndex(a.rank);
        const rb = rankIndex(b.rank);
        if (ra !== rb) return ra - rb;
        return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'ru');
    });
}

// ─── Кеш праздников ───────────────────────────────────────────────────────
// Ключ — ISO-строка "YYYY-MM-DD". Значение — объект {title, is_last_day}.
// Грузим по годам и кешируем, чтобы не дёргать API на каждый ререндер.
const _holidaysByYear = new Map();   // year → Map<iso, {title, is_last_day}>
const _loadingYear    = new Map();   // year → Promise

export async function getHolidaysMap(year) {
    if (_holidaysByYear.has(year)) return _holidaysByYear.get(year);
    if (_loadingYear.has(year))   return _loadingYear.get(year);

    const promise = (async () => {
        try {
            const list = await api.get(`/holidays?year=${year}`);
            const map = new Map();
            for (const h of (list || [])) {
                map.set(h.date, { title: h.title, is_last_day: !!h.is_last_day });
            }
            _holidaysByYear.set(year, map);
            return map;
        } catch {
            const empty = new Map();
            _holidaysByYear.set(year, empty);
            return empty;
        } finally {
            _loadingYear.delete(year);
        }
    })();
    _loadingYear.set(year, promise);
    return promise;
}

export function invalidateHolidayCache(year = null) {
    if (year === null) {
        _holidaysByYear.clear();
    } else {
        _holidaysByYear.delete(year);
    }
}

// ─── Расчёт переработки для одной даты ─────────────────────────────────────
// holidaysMap: Map<iso, {title, is_last_day}>
export function hoursForDate(iso, holidaysMap) {
    if (!iso) return 0;
    const h = holidaysMap?.get(iso);
    if (h) {
        return h.is_last_day ? 12 : 20;
    }
    const d   = new Date(iso + 'T00:00:00');
    const dow = d.getDay();          // 0=Вс, 1=Пн, ... 6=Сб

    if (dow === 6) return 20;        // Сб
    if (dow === 0) return 12;        // Вс
    if (dow === 5) return 12;        // Пт

    // День перед праздником (завтра праздник с is_last_day=false) → +12.
    // Если завтра последний день каникул — не считаем (завтрашний день
    // сам даст +12; сегодня обычный будний +4).
    const tom = new Date(d);
    tom.setDate(d.getDate() + 1);
    const tomIso = _isoOf(tom);
    const tomH = holidaysMap?.get(tomIso);
    if (tomH && !tomH.is_last_day) return 12;

    return 4;                        // Пн-Чт обычный день
}

function _isoOf(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── Выходной / праздничный ли день ────────────────────────────────────────
// Используется для серой подсветки столбцов.
export function isWeekendOrHoliday(iso, holidaysMap) {
    if (!iso) return false;
    if (holidaysMap?.has(iso)) return true;
    const dow = new Date(iso + 'T00:00:00').getDay();
    return dow === 0 || dow === 6;    // Сб/Вс
}

// ─── Группировка отметок по человеку ──────────────────────────────────────
// Возвращает: Map<personId, Map<iso, mark>>.
// mark: { mark_type, id }
export function groupMarks(marks) {
    const out = new Map();
    for (const m of (marks || [])) {
        if (!out.has(m.person_id)) out.set(m.person_id, new Map());
        out.get(m.person_id).set(m.duty_date, {
            id:        m.id,
            mark_type: m.mark_type || MARK_DUTY,
        });
    }
    return out;
}

// ─── Счётчики для человека (кол-во нарядов и часов переработки) ───────────
// personMarksByDate: Map<iso, {mark_type}> (из groupMarks())
// holidaysMap: Map<iso, {title, is_last_day}>
export function computeSummary(personMarksByDate, holidaysMap) {
    let duty = 0, overtime = 0, leave = 0, vacation = 0, reserve = 0;
    if (!personMarksByDate) {
        return { duty, overtime, leave, vacation, reserve };
    }
    for (const [iso, info] of personMarksByDate) {
        if (info.mark_type === MARK_DUTY) {
            duty += 1;
            overtime += hoursForDate(iso, holidaysMap);
        } else if (info.mark_type === MARK_LEAVE) {
            leave += 1;
        } else if (info.mark_type === MARK_VACATION) {
            vacation += 1;
        } else if (info.mark_type === MARK_RESERVE) {
            reserve += 1;
        }
    }
    return { duty, overtime, leave, vacation, reserve };
}

// ─── Зоны рядом с существующими нарядами (подсветка ДО клика) ─────────────
// Возвращает Map<iso, 'strict' | 'warn'> для пустых дней, соседних с
// существующими 'N'-нарядами:
//   • дельта 1 (соседний день)        → 'strict' (нельзя ставить)
//   • дельта 2 (через сутки)          → 'warn'   (можно с подтверждением)
// Дни, на которых уже стоит ЛЮБАЯ метка, не помечаются — фронт всё равно
// рисует там содержимое (наряд/отпуск/...).
export function computeDutyZones(personMarksByDate, monthDays) {
    const zones = new Map();
    if (!personMarksByDate || !monthDays) return zones;

    const dutyTimes = [];
    for (const [iso, info] of personMarksByDate) {
        if (info.mark_type === MARK_DUTY) {
            dutyTimes.push(new Date(iso + 'T00:00:00').getTime());
        }
    }
    if (!dutyTimes.length) return zones;

    const DAY_MS = 86400000;
    for (const iso of monthDays) {
        if (personMarksByDate.has(iso)) continue;          // занятая ячейка
        const t = new Date(iso + 'T00:00:00').getTime();
        let minDelta = Infinity;
        for (const dt of dutyTimes) {
            const delta = Math.abs((t - dt) / DAY_MS);
            if (delta < minDelta) minDelta = delta;
        }
        if (minDelta === 1)      zones.set(iso, 'strict');
        else if (minDelta === 2) zones.set(iso, 'warn');
    }
    return zones;
}


// ─── Непрерывные диапазоны отпуска для одного человека ────────────────────
// Возвращает массив {start_iso, end_iso, days} для отрисовки "Отпуск" полосой.
// monthDays: массив iso-строк в порядке возрастания (все дни отображаемого месяца).
export function extractVacationRanges(personMarksByDate, monthDays) {
    const ranges = [];
    if (!personMarksByDate || !monthDays) return ranges;

    let curStart = null;
    let curEnd   = null;

    const flush = () => {
        if (curStart) {
            const days = 1 + (monthDays.indexOf(curEnd) - monthDays.indexOf(curStart));
            ranges.push({ start_iso: curStart, end_iso: curEnd, days });
        }
        curStart = null;
        curEnd   = null;
    };

    for (const iso of monthDays) {
        const m = personMarksByDate.get(iso);
        const isVac = m && m.mark_type === MARK_VACATION;
        if (isVac) {
            if (!curStart) curStart = iso;
            curEnd = iso;
        } else {
            flush();
        }
    }
    flush();
    return ranges;
}

// ─── Короткие названия типов для UI ────────────────────────────────────────
export const MARK_LETTER = {
    [MARK_DUTY]:     'Н',
    [MARK_LEAVE]:    'У',
    [MARK_VACATION]: 'О',   // используется только для одиночных дней; полоса "Отпуск" рендерится отдельно
    [MARK_RESERVE]:  'РЗ',  // две буквы — стилизация в .duty-mark--R снижает font-size
};

export const MARK_LABEL = {
    [MARK_DUTY]:     'Наряд',
    [MARK_LEAVE]:    'Увольнение',
    [MARK_VACATION]: 'Отпуск',
    [MARK_RESERVE]:  'Резерв',
};
