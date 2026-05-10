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


// ─── Парсер страницы письма /node/{N} ────────────────────────────────────

// Маппинг технических field-name → читаемых ключей. Расширяем по мере
// встречи новых полей. То что не в маппинге — попадает в meta под своим
// техническим именем (для отладки и форвард-совместимости).
const META_FIELD_MAP = {
    "extra-status-new":   "status",          // Состояние документа
    "do-type":            "doc_type",        // Вид документа
    "do-priority":        "priority",        // Срочность
    "do-body":            "summary",         // Содержание (краткое)
    "extra-internal-new": "internal_no",     // Номер/дата внутреннего
    "do-corr":            "addressee",       // Адресат
    "extra-executors":    "executor",        // Исполнитель
    "extra-signer":       "signer",          // Подписант
    "do-is-ds":           "with_signature",  // Документ с ЭП
    "base-doc-sheet":     "sheets_count",    // Кол-во листов
    "base-doc-attach":    "attachments_cnt", // Кол-во приложений
};

/**
 * Извлекает письмо из HTML страницы /node/{N}.
 * Возвращает { node_id, title, body_html, meta, files } или null если
 * страница не похожа на документ (нет h1.page-header).
 *
 * body_html — содержимое .region-content, очищенное от:
 *   • .node-actions-wrapper (кнопки делегировать/расписать/закрыть)
 *   • .tabs-wrap (вкладки переключения видов документа)
 *   • любые <a> с use-ajax классом (модальные действия)
 *   • <script>, <style>, on*-атрибуты (защита от инъекций)
 *
 * Пользователь явно запретил workflow-действия в pods2.
 */
export function extractLetter(html, nodeId) {
    if (!html) return null;

    // Title: <h1 class="page-header">…</h1>
    const titleMatch = html.match(/<h1[^>]*class="[^"]*page-header[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
    if (!titleMatch) return null;
    const title = decodeEntities(stripTags(titleMatch[1])).slice(0, 1000);

    // Meta-поля. Один проход regex'ом по всему HTML.
    const meta = {};
    const fieldRe = /class="field field-name-field-([a-z0-9-]+)[^"]*"[\s\S]{0,400}?<div class="field-label">([^<]+)<\/div>[\s\S]{0,2000}?<div class="field-item even">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
    let fm;
    while ((fm = fieldRe.exec(html)) !== null) {
        const tech  = fm[1];
        const label = decodeEntities(stripTags(fm[2])).replace(/[:\s]+$/, "").trim();
        const valHtml = fm[3];
        const val   = decodeEntities(stripTags(valHtml)).trim();
        const key   = META_FIELD_MAP[tech] || `_${tech}`;
        if (val) {
            meta[key] = val;
            // На всякий случай сохраняем человеческий label (для форвард-совместимости)
            if (!META_FIELD_MAP[tech]) meta[`${key}__label`] = label;
        }
    }

    // Файлы — ссылки на /systems3/files/. Ищем уникальные URL.
    const files = [];
    const seen = new Set();
    const fileRe = /<a[^>]+href="(https:\/\/sed\.mchs\.ru\/systems3\/files\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let xm;
    while ((xm = fileRe.exec(html)) !== null) {
        const url = xm[1];
        if (seen.has(url)) continue;
        seen.add(url);
        // Имя файла — приоритетно из <span class="file-title">, иначе из innerHTML <a>,
        // иначе из URL.
        let name = "";
        const ftMatch = xm[2].match(/<span class="file-title">([\s\S]*?)<\/span>/);
        if (ftMatch) name = decodeEntities(stripTags(ftMatch[1]));
        if (!name) name = decodeEntities(stripTags(xm[2]));
        if (!name) {
            try { name = decodeURIComponent(url.split("/").pop().split("?")[0]); }
            catch { name = url.split("/").pop(); }
        }
        files.push({ name: name.slice(0, 300), url });
        if (files.length >= 30) break;
    }

    // Body — содержимое .region-content, очищенное от workflow.
    // Берём последнее вхождение region-content (Drupal иногда даёт
    // вложенные region'ы; основной — последний).
    let bodyHtml = "";
    const regionRe = /<div class="region region-content">([\s\S]*?)<\/div>\s*<\/main>/;
    const regionMatch = html.match(regionRe);
    if (regionMatch) {
        bodyHtml = regionMatch[1];
    } else {
        // Fallback — после <h1 class="page-header"> до </main>
        const i = html.indexOf("page-header");
        if (i > 0) {
            const tail = html.slice(i, i + 200_000);
            const closeMain = tail.indexOf("</main>");
            bodyHtml = tail.slice(tail.indexOf("</h1>") + 5, closeMain > 0 ? closeMain : tail.length);
        }
    }
    bodyHtml = sanitizeBody(bodyHtml);

    return {
        node_id: nodeId,
        title,
        body_html: bodyHtml,
        meta,
        files,
    };
}


/**
 * Чистит HTML тела от:
 *   • node-actions-wrapper (кнопки делегировать/расписать/ознакомлен)
 *   • tabs-wrap (вкладки переключения)
 *   • <a class="use-ajax ...">  (модалки workflow)
 *   • <script>, <style>
 *   • on*-атрибуты (onclick и пр.)
 *
 * Жёстких санитайзеров типа DOMPurify нет (в service worker нет DOM API),
 * поэтому работаем regex'ами. Этого достаточно для вырезания понятных
 * паттернов Drupal'а — фронт отрисует через innerHTML с CSP,
 * который запрещает inline-script.
 */
function sanitizeBody(html) {
    if (!html) return "";
    return html
        // page-header (h1 с заголовком документа) — в pods2 он уже в head'е модалки
        .replace(/<h1[^>]*class="[^"]*page-header[^"]*"[^>]*>[\s\S]*?<\/h1>/gi, "")
        // field-divs Drupal — те же значения уже извлечены в meta-словарь
        // фронтом выше; в теле они только дублируют и мешают.
        .replace(/<div[^>]*class="[^"]*field field-name-field-[a-z0-9-]+[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, "")
        // node-actions-wrapper и его содержимое
        .replace(/<div[^>]*class="[^"]*node-actions-wrapper[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi, "")
        // tabs-wrap (вкладки)
        .replace(/<div[^>]*class="[^"]*tabs-wrap[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi, "")
        // <a class="use-ajax ..."> — модальные действия СЭД
        .replace(/<a[^>]*class="[^"]*use-ajax[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "")
        // dropdown-menu (меню действий)
        .replace(/<ul[^>]*class="[^"]*dropdown-menu[^"]*"[\s\S]*?<\/ul>/gi, "")
        // <script>, <style>
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
        // on*-атрибуты (onclick="..." и т.д.)
        .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, "")
        .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, "")
        // Относительные URL → абсолютные на sed.mchs.ru. Без этого браузер
        // pods2 пытается грузить /sites/all/themes/.../icon.png со staff.asy-tk.ru
        // и получает 404 (иконки PDF, аватары и пр.). Не трогаем уже
        // абсолютные (http://, https://, //, data:, mailto:).
        .replace(/(\s(?:src|href)=)"\/(?!\/)/gi, '$1"https://sed.mchs.ru/')
        .replace(/(\s(?:src|href)=)'\/(?!\/)/gi, "$1'https://sed.mchs.ru/")
        // Лишние пробелы (косметика)
        .replace(/\s{2,}/g, " ")
        .trim()
        // Урезаем — на всякий случай (бэк всё равно лимитирует 500KB)
        .slice(0, 400_000);
}
