// extension/sed-bridge/options.js

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

const $ = (id) => document.getElementById(id);
let sections = [];

function renderSections() {
    const tbody = $("sections-body");
    tbody.innerHTML = sections.map((s, i) => `
        <tr data-idx="${i}">
            <td><input type="text" data-field="key"   value="${esc(s.key)}"   placeholder="key"></td>
            <td><input type="text" data-field="url"   value="${esc(s.url)}"   placeholder="/path"></td>
            <td><input type="text" data-field="title" value="${esc(s.title)}" placeholder="Заголовок"></td>
            <td><button class="row-x" data-remove="${i}" title="Убрать">×</button></td>
        </tr>
    `).join("");
}

function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function readSectionsFromDom() {
    return Array.from(document.querySelectorAll("#sections-body tr")).map(tr => {
        const get = (f) => tr.querySelector(`input[data-field="${f}"]`)?.value.trim() || "";
        return { key: get("key"), url: get("url"), title: get("title") };
    }).filter(s => s.key && s.url);
}

async function load() {
    const stored = await chrome.storage.local.get(
        ["pods2_url", "pods2_token", "period_min", "sections"]
    );
    $("pods2_url").value     = stored.pods2_url     || "https://staff.asy-tk.ru";
    $("pods2_token").value   = stored.pods2_token   || "";
    $("period_min").value    = stored.period_min    || 5;
    sections = (Array.isArray(stored.sections) && stored.sections.length)
        ? stored.sections
        : DEFAULT_SECTIONS;
    renderSections();
}

async function save() {
    const period = Math.max(1, Math.min(60, parseInt($("period_min").value, 10) || 5));
    sections = readSectionsFromDom();
    await chrome.storage.local.set({
        pods2_url:   $("pods2_url").value.trim().replace(/\/+$/, ""),
        pods2_token: $("pods2_token").value.trim(),
        period_min:  period,
        sections,
    });
    // Перенастраиваем alarm с новой периодичностью
    try { await chrome.alarms.clear("sed-sync"); } catch {}
    chrome.alarms.create("sed-sync", { periodInMinutes: period, delayInMinutes: 0.5 });
    showStatus("ok", "Настройки сохранены.");
}

function showStatus(kind, msg) {
    const el = $("status");
    el.className = `status status--${kind === "ok" ? "ok" : "err"}`;
    el.textContent = msg;
    el.style.display = "block";
}

$("save-btn").addEventListener("click", save);

$("add-section").addEventListener("click", () => {
    sections = readSectionsFromDom();
    sections.push({ key: "", url: "", title: "" });
    renderSections();
});

$("reset-sections").addEventListener("click", () => {
    sections = DEFAULT_SECTIONS.map(s => ({ ...s }));
    renderSections();
});

$("sections-body").addEventListener("click", (e) => {
    const idx = e.target?.dataset?.remove;
    if (idx == null) return;
    sections = readSectionsFromDom();
    sections.splice(parseInt(idx, 10), 1);
    renderSections();
});

$("test-btn").addEventListener("click", async () => {
    await save();
    showStatus("ok", "Запустил синхронизацию…");
    chrome.runtime.sendMessage({ type: "sync_now" }, (resp) => {
        if (chrome.runtime.lastError) {
            showStatus("err", `Сбой: ${chrome.runtime.lastError.message}`);
            return;
        }
        if (!resp || !resp.ok) {
            showStatus("err", `Не удалось: ${resp?.error || resp?.reason || "—"}`);
            return;
        }
        showStatus("ok", `Готово. Отправлено: ${resp.sent ? "да" : "нет"}, total: ${resp.total ?? "—"}.`);
    });
});

load();
