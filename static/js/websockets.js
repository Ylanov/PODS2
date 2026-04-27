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
    const wsUrl    = `${protocol}//${window.location.host}/ws`;

    console.log(`🔌 Connecting to WebSocket: ${wsUrl}`);

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
        console.log('✅ WebSocket connected');
        reconnectAttempts = 0;
        lastPongTimestamp = Date.now();
        startHeartbeat();

        // Идентифицируемся для получения персональных уведомлений
        // через канал push_to_user. currentUser устанавливается в auth.js.
        if (window.currentUser?.id) {
            try {
                ws.send(JSON.stringify({
                    type: 'identify',
                    user_id: window.currentUser.id,
                }));
            } catch (_) { /* noop */ }
        }
    };

    ws.onmessage = function (event) {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'pong') {
                lastPongTimestamp = Date.now();
                console.log('💓 pong received');
                return;
            }

            if (data.action === 'update') {
                console.log('📩 WS message [update]:', data);
                document.dispatchEvent(
                    new CustomEvent('datachanged', { detail: { eventId: data.event_id } })
                );
                // Уведомляем дашборд об изменении — обновится только если вкладка открыта
                import('./dashboard.js').then(m => m.onWsUpdate()).catch(() => {});
            }

            if (data.action === 'combat_calc_update' || data.action === 'combat_calc_slot_update') {
                console.log(`📩 WS message [${data.action}]:`, data);
                document.dispatchEvent(
                    new CustomEvent('datachanged', { detail: data })
                );
            }

            // Персона из общей базы изменилась — denorm-копии в МНИ и других
            // местах могут устареть. Тригерим единое 'datachanged' и
            // дополнительный 'person-update' для модулей, которым нужна
            // именно эта реакция.
            if (data.action === 'person_update') {
                console.log('📩 WS message [person_update]:', data);
                document.dispatchEvent(
                    new CustomEvent('datachanged', { detail: data })
                );
                document.dispatchEvent(
                    new CustomEvent('person-update', { detail: data })
                );
            }

            // Персональное уведомление — тригерим перезагрузку ленты.
            // Сервер шлёт только флаг, сама запись уже в БД.
            if (data.action === 'notification_new') {
                console.log('🔔 WS message [notification_new]:', data);
                window._refreshNotifications?.();
            }

        } catch (error) {
            console.error('❌ WS JSON parse error:', error);
        }
    };

    ws.onclose = function (event) {
        console.warn(`⚠️ WebSocket closed: code=${event.code}, reason=${event.reason}`);
        stopHeartbeat();
        scheduleReconnect();
    };

    ws.onerror = function (error) {
        console.error('🔥 WebSocket error:', error);
    };
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