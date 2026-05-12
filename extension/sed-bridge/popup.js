// extension/sed-bridge/popup.js

const $ = (id) => document.getElementById(id);

function fmtAgo(ms) {
    if (!ms) return "—";
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 5)        return "только что";
    if (sec < 60)       return `${sec} c назад`;
    const min = Math.floor(sec / 60);
    if (min < 60)       return `${min} мин назад`;
    const hr = Math.floor(min / 60);
    if (hr  < 24)       return `${hr} ч назад`;
    return new Date(ms).toLocaleString("ru-RU");
}

function showStatus(status) {
    const el = $("status");
    if (!status) {
        el.textContent = "Расширение запущено. Жду первой синхронизации…";
        el.className   = "status";
        return;
    }
    const classes = {
        ok:         "status status--ok",
        error:      "status status--err",
        auth:       "status status--auth",
        auth_pods2: "status status--auth_pods2",
        config:     "status status--config",
    };
    el.className   = classes[status.kind] || "status";
    el.textContent = status.message || status.kind;
}

function renderPauseBtn(paused) {
    const btn = $("pause-btn");
    if (!btn) return;
    if (paused) {
        btn.textContent = "▶ Продолжить";
        btn.className   = "btn-primary";
    } else {
        btn.textContent = "⏸ Пауза";
        btn.className   = "btn-warn";
    }
}

async function refresh() {
    const data = await new Promise(res => {
        chrome.runtime.sendMessage({ type: "get_status" }, (r) => res(r || {}));
    });
    showStatus(data.last_status);
    $("total").textContent = (data.last_total ?? 0) > 0 ? data.last_total : "—";
    $("last").textContent  = fmtAgo(data.last_status_at);
    renderPauseBtn(!!data.paused);
}

$("sync-btn").addEventListener("click", () => {
    $("sync-btn").disabled = true;
    $("sync-btn").textContent = "Синхронизирую…";
    chrome.runtime.sendMessage({ type: "sync_now" }, async (resp) => {
        $("sync-btn").disabled = false;
        $("sync-btn").textContent = "Синхр. сейчас";
        if (chrome.runtime.lastError) {
            showStatus({ kind: "error", message: chrome.runtime.lastError.message });
            return;
        }
        await refresh();
    });
});

$("opts-btn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

$("pause-btn")?.addEventListener("click", async () => {
    const data = await new Promise(res => {
        chrome.runtime.sendMessage({ type: "get_status" }, (r) => res(r || {}));
    });
    const next = !data.paused;
    chrome.runtime.sendMessage({ type: "set_paused", value: next }, async () => {
        await refresh();
    });
});

refresh();
setInterval(refresh, 5000);
