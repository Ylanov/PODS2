// static/js/websockets.js

// ─── Состояние модуля ─────────────────────────────────────────────────────────
let ws                = null;
let reconnectTimeout  = null;
let reconnectAttempts = 0;
let heartbeatInterval = null;

let lastPongTimestamp = Date.now();

const MAX_RECONNECT_DELAY = 30_000;
const BASE_DELAY          = 1_000;

// ─── Создание соединения ──────────────────────────────────────────────────────

function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Передаём JWT в query — единственный источник истины для сервера, кто
    // подключился. Раньше шли отдельным identify-сообщением, и любой клиент
    // мог сказать "я user 42" — это была cross-user leak.
    const token   = localStorage.getItem('token') || '';
    const wsUrl   = `${protocol}//${window.location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
        reconnectAttempts = 0;
        lastPongTimestamp = Date.now();
        startHeartbeat();
        // Никакого identify — user_id сервер уже знает из токена в URL.

        // Восстанавливаем все активные room-подписки после реконнекта.
        // Без этого после короткого отрыва WS пользователь перестал бы
        // получать обновления открытого списка до F5.
        _resubscribeAllRooms();
    };

    ws.onmessage = function (event) {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'pong') {
                lastPongTimestamp = Date.now();
                return;
            }

            // Defence-in-depth: если в сообщении явно указан user_id и он не
            // совпадает с текущим — пропускаем. Сервер уже фильтрует, но
            // дополнительная проверка на клиенте не повредит (вдруг прокси
            // как-то перепутал соединения).
            if (data.user_id !== undefined &&
                window.currentUser?.id &&
                data.user_id !== window.currentUser.id) {
                return;
            }

            if (data.action === 'update') {
                document.dispatchEvent(
                    new CustomEvent('datachanged', { detail: { eventId: data.event_id } })
                );
                import('./dashboard.js').then(m => m.onWsUpdate()).catch(() => {});
            }

            else if (data.action === 'combat_calc_update' || data.action === 'combat_calc_slot_update') {
                document.dispatchEvent(
                    new CustomEvent('datachanged', { detail: data })
                );
            }

            else if (data.action === 'person_update') {
                document.dispatchEvent(
                    new CustomEvent('datachanged', { detail: data })
                );
                document.dispatchEvent(
                    new CustomEvent('person-update', { detail: data })
                );
            }

            // Персональное уведомление: дебаунсим вызовы — при batch'е из
            // нескольких событий (например, после массовой операции админа)
            // делаем один запрос к /notifications вместо N.
            else if (data.action === 'notification_new') {
                _scheduleNotifRefresh();
            }

            else if (data.action === 'sed_snapshot_updated') {
                import('./sed_inbox.js')
                    .then(m => m.onSedWsUpdate?.())
                    .catch(() => {});
            }

            else if (data.action === 'alert_lists_update') {
                import('./alert_lists.js')
                    .then(m => m.onAlertListsWsUpdate?.(data.list_id))
                    .catch(() => {});
            }

        } catch (error) {
            console.error('WS message error:', error);
        }
    };

    ws.onclose = function (event) {
        stopHeartbeat();
        scheduleReconnect();
    };

    ws.onerror = function () {
        // onclose всё равно вызовется и запустит reconnect
    };
}


// Debounce для пушей `notification_new` — если за короткий промежуток
// прилетело несколько событий, делаем один запрос к /notifications.
let _notifRefreshTimer = null;
function _scheduleNotifRefresh() {
    if (_notifRefreshTimer) return;
    _notifRefreshTimer = setTimeout(() => {
        _notifRefreshTimer = null;
        window._refreshNotifications?.();
    }, 500);
}

// ─── Реконнект с экспоненциальной задержкой ───────────────────────────────────

function scheduleReconnect() {
    if (reconnectTimeout) return;

    reconnectAttempts += 1;

    const delay = Math.min(BASE_DELAY * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
    console.log(`🔄 Reconnecting in ${delay / 1000}s... (attempt ${reconnectAttempts})`);

    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connect();
    }, delay);
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

function startHeartbeat() {
    stopHeartbeat();

    heartbeatInterval = setInterval(() => {
        const timeSinceLastPong = Date.now() - lastPongTimestamp;

        if (timeSinceLastPong > 45_000) {
            console.warn('💀 No pong received for 45s — forcing reconnect...');
            if (ws) ws.close();
            return;
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
        }
    }, 15_000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

// ─── Публичный API ────────────────────────────────────────────────────────────

export function sendMessage(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('⚠️ WebSocket not ready, message not sent');
        return;
    }
    ws.send(JSON.stringify(data));
}

// ─── Rooms (универсальные подписки) ────────────────────────────────────────
// Помнящий клиент: при reconnect автоматически восстанавливает все активные
// подписки. Без этого после кратковременного отвала WS пользователь
// перестал бы получать обновления своего открытого списка до F5.
const _activeRooms = new Set();

export function subscribeRoom(room) {
    if (!room) return;
    _activeRooms.add(room);
    sendMessage({ type: 'subscribe', room });
}

export function unsubscribeRoom(room) {
    if (!room) return;
    _activeRooms.delete(room);
    sendMessage({ type: 'unsubscribe', room });
}

function _resubscribeAllRooms() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const room of _activeRooms) {
        try { ws.send(JSON.stringify({ type: 'subscribe', room })); }
        catch (_) { /* noop — соединение валится, переподключение тоже придёт */ }
    }
}

export function initWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log('ℹ️ WebSocket already active');
        return;
    }
    connect();
}

export function closeWebSocket() {
    console.log('🛑 Closing WebSocket manually');

    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    stopHeartbeat();
    reconnectAttempts = 0;

    if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
    }
}