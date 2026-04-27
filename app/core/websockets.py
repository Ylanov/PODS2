# app/core/websockets.py
"""
ИСПРАВЛЕНИЕ: Broadcast без фильтрации.

Проблема: broadcast() рассылал сообщения ВСЕМ подключённым клиентам.
При 50 одновременных пользователях каждое сохранение слота будило всех 50,
все 50 делали повторный запрос к API — бессмысленная нагрузка.

Решение: каждое соединение при подключении может подписаться на конкретный
event_id. Сообщения типа "update" рассылаются только подписчикам этого события.
Глобальные сообщения (combat_calc_update, plain update без event_id) рассылаются всем.

Протокол (клиент → сервер):
  {"type": "ping"}                        — heartbeat
  {"type": "subscribe", "event_id": 42}  — подписаться на событие
  {"type": "unsubscribe"}                — отписаться (смотрю другой список)

Протокол (сервер → клиент):
  {"type": "pong"}                        — ответ на ping
  {"action": "update", "event_id": 42}   — изменился список 42
  {"action": "combat_calc_update"}        — изменился боевой расчёт
  {"action": "combat_calc_slot_update", "instance_id": 5}
"""

import json
import asyncio
from typing import Dict, Optional, Set

from fastapi import WebSocket, WebSocketDisconnect


class ConnectionManager:
    def __init__(self) -> None:
        # Все активные соединения
        self._connections: Set[WebSocket] = set()
        # Подписки: websocket → event_id (или None если не подписан)
        self._subscriptions: Dict[WebSocket, Optional[int]] = {}
        # Идентификация юзера: websocket → user_id (для персональных уведомлений)
        # Устанавливается клиентом через {"type":"identify","user_id":N}.
        # user_id → set[websocket] — быстрый lookup для push_to_user.
        self._user_by_ws: Dict[WebSocket, int] = {}
        self._ws_by_user: Dict[int, Set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    # ─── Подключение / отключение ─────────────────────────────────────────────

    async def connect(self, websocket: WebSocket) -> None:
        """Принимает новое WebSocket-соединение."""
        try:
            await websocket.accept()
        except Exception:
            return

        async with self._lock:
            self._connections.add(websocket)
            self._subscriptions[websocket] = None   # пока не подписан ни на что

    async def disconnect(self, websocket: WebSocket) -> None:
        """Удаляет соединение из всех структур."""
        async with self._lock:
            self._connections.discard(websocket)
            self._subscriptions.pop(websocket, None)
            uid = self._user_by_ws.pop(websocket, None)
            if uid is not None:
                bucket = self._ws_by_user.get(uid)
                if bucket:
                    bucket.discard(websocket)
                    if not bucket:
                        self._ws_by_user.pop(uid, None)

    # ─── Идентификация юзера (для персональных уведомлений) ───────────────────

    async def identify(self, websocket: WebSocket, user_id: int) -> None:
        """
        Привязать соединение к user_id. Один юзер может иметь несколько
        сокетов (разные вкладки/устройства) — все получат уведомление.
        """
        async with self._lock:
            if websocket not in self._connections:
                return
            # Перепривязка если соединение уже было привязано
            old = self._user_by_ws.get(websocket)
            if old is not None and old != user_id:
                bucket = self._ws_by_user.get(old)
                if bucket:
                    bucket.discard(websocket)
                    if not bucket:
                        self._ws_by_user.pop(old, None)
            self._user_by_ws[websocket] = user_id
            self._ws_by_user.setdefault(user_id, set()).add(websocket)

    async def push_to_user(self, user_id: int, message: dict) -> None:
        """Отправить сообщение всем сокетам конкретного user_id."""
        text = json.dumps(message)
        async with self._lock:
            targets = list(self._ws_by_user.get(user_id, ()))

        failed = []
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:
                failed.append(ws)

        if failed:
            async with self._lock:
                for ws in failed:
                    self._connections.discard(ws)
                    self._subscriptions.pop(ws, None)
                    uid = self._user_by_ws.pop(ws, None)
                    if uid is not None:
                        bucket = self._ws_by_user.get(uid)
                        if bucket:
                            bucket.discard(ws)
                            if not bucket:
                                self._ws_by_user.pop(uid, None)

    # ─── Подписки ─────────────────────────────────────────────────────────────

    async def subscribe(self, websocket: WebSocket, event_id: int) -> None:
        """Подписывает соединение на конкретный event_id."""
        async with self._lock:
            if websocket in self._subscriptions:
                self._subscriptions[websocket] = event_id

    async def unsubscribe(self, websocket: WebSocket) -> None:
        """Снимает подписку с соединения."""
        async with self._lock:
            if websocket in self._subscriptions:
                self._subscriptions[websocket] = None

    # ─── Рассылка ─────────────────────────────────────────────────────────────

    async def broadcast(self, message: dict) -> None:
        """
        Рассылает сообщение с учётом подписок.

        Логика:
          - Если в сообщении есть event_id — отправляем только тем, кто подписан
            на этот event_id. Остальные не тревожатся.
          - Если event_id нет (combat_calc_update и т.п.) — отправляем всем.
            Это глобальные события, они редкие.
        """
        text       = json.dumps(message)
        target_eid = message.get("event_id")   # None если глобальное сообщение

        async with self._lock:
            # Снимаем snapshot чтобы не держать лок во время IO
            snapshot = dict(self._subscriptions)

        targets  = []
        for ws, subscribed_eid in snapshot.items():
            if target_eid is None:
                # Глобальное сообщение — всем
                targets.append(ws)
            elif subscribed_eid == target_eid:
                # Точечное сообщение — только подписчикам этого события
                targets.append(ws)

        failed = []
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:
                failed.append(ws)

        # Удаляем мёртвые соединения
        if failed:
            async with self._lock:
                for ws in failed:
                    self._connections.discard(ws)
                    self._subscriptions.pop(ws, None)

    async def broadcast_all(self, message: dict) -> None:
        """
        Безусловная рассылка всем клиентам (используется для системных уведомлений).
        """
        text = json.dumps(message)

        async with self._lock:
            snapshot = list(self._connections)

        failed = []
        for ws in snapshot:
            try:
                await ws.send_text(text)
            except Exception:
                failed.append(ws)

        if failed:
            async with self._lock:
                for ws in failed:
                    self._connections.discard(ws)
                    self._subscriptions.pop(ws, None)

    @property
    def connection_count(self) -> int:
        return len(self._connections)


# Глобальный менеджер подключений
manager = ConnectionManager()


# ─── WebSocket endpoint handler ───────────────────────────────────────────────

async def handle_websocket_connection(websocket: WebSocket) -> None:
    """
    Основной обработчик WebSocket-соединения.
    Вызывается из main.py.

    Обрабатывает входящие сообщения:
      ping        → pong (heartbeat)
      subscribe   → подписка на event_id
      unsubscribe → отписка

    При подключении соединение не подписано ни на что.
    Клиент должен послать subscribe сразу после открытия списка.
    """
    await manager.connect(websocket)
    print(f"🔌 WebSocket connected (total: {manager.connection_count})")

    try:
        while True:
            data = await websocket.receive_text()

            if not data:
                continue

            try:
                payload = json.loads(data)
            except (json.JSONDecodeError, AttributeError):
                print(f"⚠️  WS invalid JSON: {data!r}")
                continue

            msg_type = payload.get("type")

            # ── Heartbeat ────────────────────────────────────────────────────
            if msg_type == "ping":
                try:
                    await websocket.send_text('{"type":"pong"}')
                except Exception:
                    break

            # ── Подписка на событие ───────────────────────────────────────────
            elif msg_type == "subscribe":
                event_id = payload.get("event_id")
                if isinstance(event_id, int):
                    await manager.subscribe(websocket, event_id)

            # ── Отписка ───────────────────────────────────────────────────────
            elif msg_type == "unsubscribe":
                await manager.unsubscribe(websocket)

            # ── Идентификация для персональных уведомлений ────────────────────
            elif msg_type == "identify":
                uid = payload.get("user_id")
                if isinstance(uid, int):
                    await manager.identify(websocket, uid)

    except WebSocketDisconnect:
        print(f"❌ WebSocket disconnected (total: {manager.connection_count - 1})")

    except Exception as error:
        print(f"🔥 WebSocket error: {error}")

    finally:
        await manager.disconnect(websocket)