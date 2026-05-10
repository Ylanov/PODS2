// extension/sed-bridge/content.js
//
// Мост между страницей pods2 и service worker'ом расширения.
//
// Зачем: файл в СЭД отдаётся inline (PDF), браузер открывает встроенный
// pdf-viewer, кнопка «Скачать» внутри него — в shadow DOM Polymer-компонента
// и тыкать её снаружи нельзя. Cross-origin <a download> тоже не работает.
//
// Решение: pods2 UI шлёт window.postMessage({type:'pods2-sed-download', ...}),
// content-script ловит и через chrome.runtime.sendMessage пробрасывает в
// background, тот зовёт chrome.downloads.download — он подставит cookie от
// sed.mchs.ru автоматически (cookie-jar браузера общий).
//
// Маркер pods2 в data-attribute, чтобы случайно не реагировать на чужие
// postMessage с тем же type.

window.addEventListener("message", (event) => {
    // Только от той же страницы — postMessage из других вкладок/iframe-ов
    // через window не приходит, но проверка на всякий.
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type !== "pods2-sed-download") return;
    if (!msg.url || typeof msg.url !== "string") return;

    chrome.runtime.sendMessage({
        type:     "sed_download",
        url:      msg.url,
        filename: msg.name || "",
    }, (resp) => {
        // Ответ опциональный — UI и без него увидит, что файл скачался.
        // Шлём его обратно через тот же window.postMessage чтобы UI мог
        // показать снэкбар об ошибке если что-то пошло не так.
        window.postMessage({
            type: "pods2-sed-download-result",
            ok:   !!(resp && resp.ok),
            url:  msg.url,
            error: resp?.error || (chrome.runtime.lastError?.message || ""),
        }, "*");
    });
});

// Сигналим UI, что расширение установлено — pods2 может показывать
// «⬇» рядом с файлами только если есть кому исполнить запрос.
window.postMessage({ type: "pods2-sed-bridge-ready" }, "*");
