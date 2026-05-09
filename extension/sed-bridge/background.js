// extension/sed-bridge/background.js
//
// Service worker MV3. Раз в 5 минут (или по кнопке из popup) ходит
// в СЭД под уже-залогиненной cookie-сессией пользователя, парсит
// разделы и шлёт дайджест в pods2.
//
// Ничего не хранит локально кроме настроек (URL pods2 + токен) и
// статуса последней синхронизации.

import { extractCount, extractItems, isLoginPage } from "./parser.js";

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
});


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
        message: `Дайджест отправлен. Всего непрочитанных: ${total}.`,
    });

    // Обновим бейдж на иконке расширения
    try {
        await chrome.action.setBadgeBackgroundColor({ color: "#b85450" });
        await chrome.action.setBadgeText({ text: total > 0 ? String(total > 99 ? "99+" : total) : "" });
    } catch {}

    return { sent: true, total };
}
