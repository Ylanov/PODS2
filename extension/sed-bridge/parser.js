// extension/sed-bridge/parser.js
//
// Извлечение писем из HTML страниц СЭД. В MV3 service worker нет DOM API
// (DOMParser отсутствует), поэтому парсим регулярками. Структура HTML
// стабильная — Drupal 7 + Views рендерит каждое письмо как
// <tr ... data-entity-id="N" ...> со ссылкой <a href="/node/N">title</a>.
// Сложного парсинга не нужно — только аккуратное декодирование сущностей
// и игнор вложенных тегов в title.

// HTML-сущности, которые встречаются в Drupal-выдаче.
// Полный набор не нужен — &amp;/&lt;/&gt;/&quot;/&#039;/&nbsp; покрывают
// 99% реальных заголовков.
const ENTITY_MAP = {
    "&amp;":  "&",
    "&lt;":   "<",
    "&gt;":   ">",
    "&quot;": "\"",
    "&#039;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
};

export function decodeEntities(s) {
    if (!s) return "";
    return s.replace(/&(?:amp|lt|gt|quot|#039|apos|nbsp);/g, m => ENTITY_MAP[m] || m)
            // числовые: &#34;, &#x22;
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
            .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s) {
    return s ? s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
}


/**
 * Возвращает счётчик «непрочитанных» рядом со ссылкой раздела в навигации.
 * В DOM это:
 *   <a class="..." href="/decision/delegate" ...>
 *     <span class="ti-marker-alt"></span>
 *     <span class="label text-primary ...">13</span>
 *     ...
 *   </a>
 * Парсим без DOM: ищем подстроку с href и берём ближайший <span class="label..."> с числом.
 */
export function extractCount(html, sectionPath) {
    if (!html || !sectionPath) return 0;
    // Экранируем path для regex.
    const p = sectionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Ищем <a href="<path>"> ... <span class="label ...">N</span>
    const re = new RegExp(
        `<a[^>]+href="${p}"[\\s\\S]{0,500}?<span class="label[^"]*">\\s*(\\d+)\\s*<`,
        "i",
    );
    const m = html.match(re);
    return m ? parseInt(m[1], 10) : 0;
}


/**
 * Парсит таблицу писем раздела. Возвращает items[] (без count — count
 * берём из навигации через extractCount, он точнее: показывает ВСЕ
 * непрочитанные, а в таблице — текущая страница пагинации).
 */
export function extractItems(html, { limit = 20 } = {}) {
    if (!html) return [];

    // Каждое письмо — <tr ... data-entity-id="N" ...>...</tr>. Ловим
    // открытие, потом вырезаем содержимое до </tr>. Жадность ограничиваем
    // через нежадный квантификатор + флаг 's' (через [\s\S], т.к. флаг
    // 's' в старом V8 service worker может вести себя по-разному).
    const rowRe = /<tr[^>]*data-entity-id="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
    const items = [];
    let m;
    while ((m = rowRe.exec(html)) !== null) {
        const nodeId = parseInt(m[1], 10);
        const body   = m[2];
        if (!nodeId) continue;

        // Заголовок — первый <a href="/node/N">…</a>. Берём innerHTML и
        // вырезаем теги (там может быть <em>, <span class="marker-...">).
        const titleMatch = body.match(/<a[^>]+href="\/node\/\d+"[^>]*>([\s\S]*?)<\/a>/);
        if (!titleMatch) continue;
        const title = decodeEntities(stripTags(titleMatch[1])).slice(0, 1000);
        if (!title) continue;

        // Файлы — <a href="https://sed.mchs.ru/systems3/..."> ...
        // <span class="file-title">file.pdf<span></span></span></a>
        const files = [];
        const fileRe = /<a[^>]+href="(https:\/\/sed\.mchs\.ru\/systems3\/[^"]+)"[^>]*>[\s\S]*?<span class="file-title">([\s\S]*?)<\/span>/g;
        let fm;
        while ((fm = fileRe.exec(body)) !== null) {
            const url  = fm[1];
            const name = decodeEntities(stripTags(fm[2])).slice(0, 300);
            if (url && name) files.push({ name, url });
            if (files.length >= 10) break;   // защита от мусора
        }

        items.push({
            node_id: nodeId,
            title,
            files,
            actions: [],
        });
        if (items.length >= limit) break;
    }
    return items;
}


/**
 * Признак «не залогинен» — fetch отдаёт login-форму вместо нужной страницы.
 * Drupal 7 ставит на анонимной странице class="not-logged-in" + форму
 * #user-login-form. Любого из этих признаков достаточно.
 */
export function isLoginPage(html) {
    if (!html) return true;
    return /class="[^"]*\bnot-logged-in\b[^"]*"/.test(html)
        || /id="user-login-form"/.test(html);
}
