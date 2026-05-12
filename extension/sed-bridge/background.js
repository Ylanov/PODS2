// extension/sed-bridge/background.js
//
// Service worker MV3. Раз в 5 минут (или по кнопке из popup) ходит
// в СЭД под уже-залогиненной cookie-сессией пользователя, парсит
// разделы и шлёт дайджест в pods2.
//
// Ничего не хранит локально кроме настроек (URL pods2 + токен) и
// статуса последней синхронизации.

import { extractCount, extractItems, extractLetter, isLoginPage } from "./parser.js";

const SED_BASE = "https://sed.mchs.ru";
const ALARM    = "sed-sync";
const PERIOD_MIN = 5;

// Список секций по умолчанию. Можно расширить в options-странице,
// но 8 разделов покрывают типовой workflow начальника центра.
const DEFAULT_SECTIONS = [
    { key: "decision_delegate",   url: "/decision/delegate",   title: "На рассмотрение"   },
    { key: "decision_sign",       url: "/decision/sign",       title: "На подписание"     },
    { key: "decision_execution",  url: "/decision/execution",  title: "На исполнение"     },
    { key: "decision_agreement",  url: "/decision/agreement",  title: "На согласование"   },
    { key: "decision_refine",     url: "/decision/refine",     title: "На доработку"      },
    { key: "reg_incoming",        url: "/reg/incoming",        title: "Входящие"          },
    { key: "reg_internal_new",    url: "/reg/internal_new",    title: "Внутренние"        },
    { key: "tasks_expired",       url: "/tasks/in/expired-some-day", title: "Просроченные" },
];


// ─── Settings ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    pods2_url:     "https://staff.asy-tk.ru",
    pods2_token:   "",
    sections:      DEFAULT_SECTIONS,
    period_min:    PERIOD_MIN,
};

async function getSettings() {
    const stored = await chrome.storage.local.get(["pods2_url", "pods2_token", "sections", "period_min"]);
    return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveStatus(status) {
    await chrome.storage.local.set({
        last_status:    status,
        last_status_at: Date.now(),
    });
}


// ─── Lifecycle ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
    const s = await getSettings();
    chrome.alarms.create(ALARM, {
        periodInMinutes: Math.max(1, s.period_min || PERIOD_MIN),
        delayInMinutes:  0.5,    // первая синхронизация через 30 сек
    });
});

// На запуск браузера тоже стартуем сразу
chrome.runtime.onStartup.addListener(async () => {
    const s = await getSettings();
    chrome.alarms.create(ALARM, {
        periodInMinutes: Math.max(1, s.period_min || PERIOD_MIN),
        delayInMinutes:  0.5,
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) syncNow().catch(err => {
        console.error("[sed-bridge] sync failed:", err);
    });
});

// Сообщения из popup/options — для ручной синхронизации и пинга
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "sync_now") {
        syncNow().then(r => sendResponse({ ok: true, ...r }))
                 .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true;   // async
    }
    if (msg?.type === "get_status") {
        chrome.storage.local.get(["last_status", "last_status_at", "last_total"]).then(sendResponse);
        return true;
    }
    // Скачивание файла из СЭД, инициированное pods2 UI через content-script.
    // Используем chrome.downloads.download — он сам подставит cookie sed.mchs.ru
    // (cookie-jar общий с обычной навигацией) и сохранит файл, минуя
    // встроенный pdf-viewer. Если SED отдаёт inline — расширение всё равно
    // принудительно сохранит как attachment.
    if (msg?.type === "sed_download") {
        if (!msg.url || !/^https:\/\/sed\.mchs\.ru\//i.test(msg.url)) {
            sendResponse({ ok: false, error: "URL должен быть https://sed.mchs.ru/..." });
            return false;
        }
        const opts = { url: msg.url, saveAs: false };
        const cleanName = sanitizeFilename(msg.filename);
        // Если имя осталось валидным — передаём; иначе пусть Chrome сам
        // вытащит имя из URL'а или Content-Disposition (надёжнее, чем
        // получить ошибку "Invalid filename" от chrome.downloads).
        if (cleanName) opts.filename = cleanName;
        chrome.downloads.download(opts, (downloadId) => {
            if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ ok: true, downloadId });
            }
        });
        return true;   // async
    }
});


// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * chrome.downloads.download падает с "Invalid filename" если имя содержит
 * запрещённые в Windows-FS символы (/ \ : * ? " < > |), trailing space/dot,
 * или leading dot. Чистим всё это. Если после чистки имя пустое — возвращаем
 * пустую строку, и тогда вызывающий код передаст в API без filename
 * (Chrome возьмёт из URL'а или Content-Disposition сам).
 */
function sanitizeFilename(raw) {
    if (!raw || typeof raw !== "string") return "";
    let s = raw
        .replace(/[\/\\:*?"<>|\r\n\t]/g, "_")  // запрещённые
        .replace(/\s+/g, " ")                   // схлопываем пробелы
        .replace(/^\.+/, "")                    // ведущие точки
        .replace(/[\.\s]+$/, "")                // trailing dots/spaces
        .trim()
        .slice(0, 180);
    // Chrome ругается также на пустое имя или на "только точки"
    if (!s || /^\.+$/.test(s)) return "";
    return s;
}


// ─── Core sync ─────────────────────────────────────────────────────────────

async function fetchSed(path) {
    const r = await fetch(`${SED_BASE}${path}`, {
        method:      "GET",
        credentials: "include",
        // Drupal иногда возвращает 200 + страницу логина, иногда редирект —
        // обрабатываем оба варианта по содержимому, не по статусу.
        redirect:    "follow",
        headers:     { "Accept": "text/html,application/xhtml+xml" },
        cache:       "no-store",
    });
    if (!r.ok) throw new Error(`SED ${path} → ${r.status}`);
    return await r.text();
}

async function syncNow() {
    const settings = await getSettings();
    const sections = (settings.sections && settings.sections.length)
        ? settings.sections
        : DEFAULT_SECTIONS;

    // Первый раздел используем заодно как «логин-чек» — на любой странице
    // СЭД в навигации висят счётчики всех остальных разделов.
    let primaryHtml;
    try {
        primaryHtml = await fetchSed(sections[0].url);
    } catch (err) {
        await saveStatus({ kind: "error", message: `Нет связи с СЭД: ${err.message}` });
        return { sent: false, reason: "fetch_failed" };
    }

    if (isLoginPage(primaryHtml)) {
        await saveStatus({ kind: "auth", message: "Не залогинены в СЭД — откройте sed.mchs.ru и войдите." });
        return { sent: false, reason: "not_logged_in" };
    }

    // Для каждой секции — отдельный fetch (HTML страницы тяжеловат, но
    // 8 запросов раз в 5 минут под уже-открытой сессией это копейки).
    const result = [];
    for (const s of sections) {
        let html = primaryHtml;
        if (s.url !== sections[0].url) {
            try { html = await fetchSed(s.url); }
            catch { continue; }
        }
        const items = extractItems(html, { limit: 20 });
        // Счётчик берём из навигации primaryHtml — он одинаков на всех страницах.
        const count = extractCount(primaryHtml, s.url);
        result.push({
            key:   s.key,
            title: s.title,
            url:   s.url,
            count,
            items,
        });
    }

    if (!settings.pods2_url || !settings.pods2_token) {
        await saveStatus({ kind: "config", message: "Не настроен URL pods2 или токен (см. настройки расширения)." });
        return { sent: false, reason: "no_config" };
    }

    // Отправка в pods2
    let resp;
    try {
        resp = await fetch(`${settings.pods2_url.replace(/\/+$/, "")}/api/v1/sed/snapshot`, {
            method:  "POST",
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Bearer ${settings.pods2_token}`,
            },
            body: JSON.stringify({ sections: result }),
        });
    } catch (err) {
        await saveStatus({ kind: "error", message: `pods2 недоступен: ${err.message}` });
        return { sent: false, reason: "pods2_unreachable" };
    }

    if (resp.status === 401 || resp.status === 403) {
        await saveStatus({
            kind: "auth_pods2",
            message: `pods2 ответил ${resp.status}. Проверьте токен и право sed_inbox у пользователя.`,
        });
        return { sent: false, reason: "pods2_auth" };
    }
    if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        await saveStatus({ kind: "error", message: `pods2: HTTP ${resp.status} ${txt.slice(0, 200)}` });
        return { sent: false, reason: "pods2_error" };
    }

    const total = result.reduce((s, x) => s + (x.count || 0), 0);
    await chrome.storage.local.set({ last_total: total });
    await saveStatus({
        kind:    "ok",
        message: `Дайджест отправлен. Всего непрочитанных: ${total}. Загружаем тела писем…`,
    });

    // Обновим бейдж на иконке расширения
    try {
        await chrome.action.setBadgeBackgroundColor({ color: "#b85450" });
        await chrome.action.setBadgeText({ text: total > 0 ? String(total > 99 ? "99+" : total) : "" });
    } catch {}

    // Тянем тела писем — в фоне, отдельно от snapshot. Если упадёт — не
    // блокируем основной флоу (snapshot уже отправлен). Один раз на
    // node_id за сессию: храним set'ом отправленных в storage.local.
    fetchAndSendLetters(result, settings).catch(err => {
        console.warn("[sed-bridge] fetchAndSendLetters:", err);
    });

    return { sent: true, total };
}


/**
 * Для каждого письма из всех секций — открываем /node/{N}, парсим тело
 * (extractLetter) и шлём в pods2 POST /api/v1/sed/letter.
 *
 * Дедупликация: храним set «уже отправленных» letter-id в текущей сессии,
 * чтобы при следующем тике не качать заново. Cache на стороне pods2 —
 * это server-side кеш через UPSERT по (user_id, node_id).
 */
async function fetchAndSendLetters(sections, settings) {
    const stored = await chrome.storage.local.get(["sent_letters"]);
    const sentSet = new Set(Array.isArray(stored.sent_letters) ? stored.sent_letters : []);

    // Уникальные node_id из всех секций (письмо может быть в нескольких)
    const seen = new Set();
    const queue = [];
    for (const section of sections) {
        for (const it of (section.items || [])) {
            if (!it.node_id || seen.has(it.node_id)) continue;
            seen.add(it.node_id);
            queue.push(it.node_id);
        }
    }

    if (!queue.length) return;

    const podsUrl = settings.pods2_url.replace(/\/+$/, "");
    let sentCount = 0;
    let failCount = 0;
    // Лимит на тик: 30 писем за раз. Иначе при 100+ непрочитанных
    // первый запуск делал бы сотни запросов в СЭД и pods2 одновременно.
    // Остальные подтянутся в следующем тике (через 5 минут).
    const TICK_LIMIT = 30;

    // Собираем все файлы из обработанных писем — после рассылки letter'ов
    // запустим отдельную фазу: скачать файлы из СЭД и upload в pods2.
    const allFiles = [];
    const seenFileUrls = new Set();

    for (const nodeId of queue.slice(0, TICK_LIMIT)) {
        if (sentSet.has(nodeId)) continue;
        let html;
        try {
            html = await fetchSed(`/node/${nodeId}`);
        } catch (err) {
            failCount += 1;
            continue;
        }
        if (isLoginPage(html)) {
            // Сессия СЭД отвалилась посреди тика — прерываем
            break;
        }
        const letter = extractLetter(html, nodeId);
        if (!letter) {
            failCount += 1;
            continue;
        }
        try {
            const r = await fetch(`${podsUrl}/api/v1/sed/letter`, {
                method: "POST",
                headers: {
                    "Content-Type":  "application/json",
                    "Authorization": `Bearer ${settings.pods2_token}`,
                },
                body: JSON.stringify(letter),
            });
            if (r.ok) {
                sentCount += 1;
                sentSet.add(nodeId);
                // Подбираем файлы для последующей загрузки.
                for (const f of (letter.files || [])) {
                    if (!f?.url || seenFileUrls.has(f.url)) continue;
                    seenFileUrls.add(f.url);
                    allFiles.push({ url: f.url, name: f.name || "file" });
                }
            } else {
                failCount += 1;
            }
        } catch {
            failCount += 1;
        }

        // Небольшой sleep между запросами — не валим СЭД и pods2.
        await new Promise(r => setTimeout(r, 250));
    }

    // Сохраняем дедуп-set обратно (ограничиваем размер чтобы не разрастался).
    const sentArr = Array.from(sentSet);
    await chrome.storage.local.set({
        sent_letters: sentArr.slice(-500),
    });

    if (sentCount > 0 || failCount > 0) {
        await saveStatus({
            kind:    sentCount ? "ok" : "warn",
            message: `Тела писем: загружено ${sentCount}${failCount ? `, ошибок ${failCount}` : ""}. Качаем файлы…`,
        });
    }

    // Фаза 2: качаем файлы из СЭД и грузим в pods2-кеш. В фоне — если упадёт,
    // не блокирует основной флоу (letter'ы уже в pods2).
    if (allFiles.length) {
        syncFiles(allFiles, settings).catch(err => {
            console.warn("[sed-bridge] syncFiles:", err);
        });
    }
}


// ─── Кеш файлов СЭД на pods2 ─────────────────────────────────────────────

/**
 * Скачивает каждый файл из СЭД через cookie-сессию пользователя и
 * upload'ит в pods2 (POST /api/v1/sed/file multipart). pods2 хранит blob
 * на диске и потом отдаёт юзеру с /sed/file/{id} — больше не нужно
 * открывать sed.mchs.ru, чтобы скачать вложение.
 *
 * Дедупликация:
 *   • Сначала спрашиваем у pods2 (GET /sed/file/by-urls): какие из URL'ов
 *     уже закешированы (status=ok) или провалены окончательно (failed +
 *     attempts >= MAX). Их пропускаем.
 *   • Локальный set "uploaded_urls" в storage.local — мягкий short-circuit
 *     чтобы не обращаться к pods2 за каждым уже-известным URL'ом.
 *
 * Retry:
 *   • При 404 один раз пробуем альтернативный путь /system/files/ ↔
 *     /systems3/files/ (Drupal алиасит).
 *   • При ошибке шлём POST /sed/file/failed — pods2 ведёт счётчик attempts.
 *   • Следующий 5-минутный тик подберёт failed-with-pending'и и попробует
 *     снова. После SED_FILE_MAX_ATTEMPTS на сервере останется failed.
 */
async function syncFiles(files, settings) {
    const podsUrl = settings.pods2_url.replace(/\/+$/, "");
    const token   = settings.pods2_token;
    if (!files.length || !podsUrl || !token) return;

    // 1. Узнаём статусы оптом — урезаем лишнюю работу.
    let statuses = [];
    try {
        const params = new URLSearchParams({ urls: files.map(f => f.url).join("\n") });
        const r = await fetch(`${podsUrl}/api/v1/sed/file/by-urls?${params}`, {
            headers: { "Authorization": `Bearer ${token}` },
        });
        if (r.ok) statuses = await r.json();
    } catch { /* пофиг — попробуем все */ }

    const knownByUrl = new Map(statuses.map(s => [s.sed_url, s]));
    const MAX_ATTEMPTS = 5;
    // По одному файлу за раз — СЭД медленный, проще не убивать его параллелизмом.
    const PER_TICK_LIMIT = 30;
    let okCount   = 0;
    let failCount = 0;

    for (const f of files.slice(0, PER_TICK_LIMIT)) {
        const known = knownByUrl.get(f.url);
        if (known) {
            if (known.status === "ok") continue;
            if (known.status === "failed" && (known.attempts || 0) >= MAX_ATTEMPTS) continue;
        }

        const dl = await downloadSedFile(f.url);
        if (!dl.ok) {
            failCount += 1;
            await reportFileFailed(podsUrl, token, f.url, f.name, dl.error);
            await new Promise(r => setTimeout(r, 400));
            continue;
        }

        const upOk = await uploadFileToPods(podsUrl, token, f.url, f.name, dl.blob);
        if (upOk) okCount += 1;
        else failCount += 1;

        // 400ms между файлами — СЭД отдаёт PDF'ки по 1-2 МБ, не давим её.
        await new Promise(r => setTimeout(r, 400));
    }

    if (okCount || failCount) {
        await saveStatus({
            kind:    okCount ? "ok" : "warn",
            message: `Файлы: закешировано ${okCount}${failCount ? `, ошибок ${failCount}` : ""}.`,
        });
    }
}


/**
 * Качает blob файла с sed.mchs.ru через cookie-сессию пользователя.
 * При 404 один раз пробует альтернативный путь Drupal'а (system <-> systems3).
 * Возвращает { ok, blob, error, status }.
 */
async function downloadSedFile(url) {
    const tried = [url];
    // Эвристика «другого места»: SED иногда отдаёт файл из /systems3/files/,
    // иногда — из /system/files/ (Drupal-default). Если первый 404 —
    // пробуем альтернативный.
    if (/\/systems3\/files\//i.test(url)) {
        tried.push(url.replace(/\/systems3\/files\//i, "/system/files/"));
    } else if (/\/system\/files\//i.test(url)) {
        tried.push(url.replace(/\/system\/files\//i, "/systems3/files/"));
    }
    let lastError = "";
    for (const u of tried) {
        try {
            const r = await fetch(u, {
                credentials: "include",
                redirect:    "follow",
                cache:       "no-store",
            });
            if (r.status === 401 || r.status === 403) {
                return { ok: false, error: `СЭД отказал (${r.status}) — сессия?`, status: r.status };
            }
            if (r.status === 404) {
                lastError = `404 на ${u.slice(0, 100)}`;
                continue;
            }
            if (!r.ok) {
                lastError = `HTTP ${r.status}`;
                continue;
            }
            // Проверка что это бинарный файл, а не HTML-страница логина:
            // Content-Type должен НЕ быть text/html (СЭД иногда возвращает 200
            // с логин-формой если cookie протухла).
            const ct = (r.headers.get("content-type") || "").toLowerCase();
            if (ct.startsWith("text/html")) {
                return { ok: false, error: "СЭД отдал HTML вместо файла (сессия?)" };
            }
            const blob = await r.blob();
            if (!blob || !blob.size) {
                lastError = "Пустой ответ";
                continue;
            }
            return { ok: true, blob };
        } catch (err) {
            lastError = String(err?.message || err);
        }
    }
    return { ok: false, error: lastError || "Не удалось скачать" };
}


async function uploadFileToPods(podsUrl, token, sedUrl, name, blob) {
    try {
        const fd = new FormData();
        fd.append("sed_url", sedUrl);
        fd.append("name",    name || "file");
        fd.append("file",    blob, name || "file");
        const r = await fetch(`${podsUrl}/api/v1/sed/file`, {
            method:  "POST",
            headers: { "Authorization": `Bearer ${token}` },
            body:    fd,
        });
        return r.ok;
    } catch {
        return false;
    }
}


async function reportFileFailed(podsUrl, token, sedUrl, name, error) {
    try {
        await fetch(`${podsUrl}/api/v1/sed/file/failed`, {
            method:  "POST",
            headers: {
                "Content-Type":  "application/json",
                "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({
                sed_url: sedUrl,
                name:    name || "file",
                error:   String(error || "").slice(0, 500),
            }),
        });
    } catch { /* ignore — следующий тик попробует */ }
}
