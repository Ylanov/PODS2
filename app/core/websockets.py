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


# Маппинг action → room. Если в broadcast message нет event_id, но есть
# знакомый action из этого списка — шлём только подписчикам соотв-ей комнаты.
#
# Сейчас — пустой: чтобы не ломать функционал на этапе перехода
# (alert_lists / combat_calc / persons-модули ещё не научились шлёт
# subscribe-сообщения). По мере подключения подписки на фронте
# переносим actions сюда — это снижает нагрузку постепенно.
#
# Этап 1: только event:N работает через rooms (сделано).
# Этап 2: добавляем "alert_lists_update": "alert_lists" + фронт-subscribe.
_ACTION_ROOM_MAP: Dict[str, str] = {}


class ConnectionManager:
    def __init__(self) -> None:
        # Все активные соединения
        self._connections: Set[WebSocket] = set()
        # Подписки на конкретный event_id (legacy): websocket → event_id|None.
        # Сохранено для бэк-совместимости со старым broadcast({event_id}).
        self._subscriptions: Dict[WebSocket, Optional[int]] = {}
        # Универсальные rooms: room → set[websocket]. Любой строковый ключ:
        # "event:42", "alert_lists", "duty:5", "combat_calc:7".
        # При 1000 онлайн каждое изменение списка X шлёт только подписчикам
        # room="event:X" (5-20 человек), а не всем 1000.
        self._rooms: Dict[str, Set[WebSocket]] = {}
        self._ws_rooms: Dict[WebSocket, Set[str]] = {}
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
            # Чистим rooms — иначе утечка ws-ссылок при долгих сессиях.
            for room in self._ws_rooms.pop(websocket, set()):
                bucket = self._rooms.get(room)
                if bucket:
                    bucket.discard(websocket)
                    if not bucket:
                        self._rooms.pop(room, None)
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
        """Legacy: подписка на event_id. Внутри переадресуется в room 'event:N'."""
        await self.subscribe_room(websocket, f"event:{event_id}")
        async with self._lock:
            if websocket in self._subscriptions:
                self._subscriptions[websocket] = event_id

    async def unsubscribe(self, websocket: WebSocket) -> None:
        """Legacy: снимает event_id-подписку (room тоже очистится)."""
        async with self._lock:
            old_eid = self._subscriptions.get(websocket)
            if websocket in self._subscriptions:
                self._subscriptions[websocket] = None
        if old_eid is not None:
            await self.unsubscribe_room(websocket, f"event:{old_eid}")

    # ─── Universal rooms ──────────────────────────────────────────────────────
    # Любой строковый ключ-комната: "event:42", "alert_lists", "combat_calc:7".
    # Один websocket может быть подписан на N rooms (например, открыл вкладку
    # «Карта ОД» + получает уведомления по своему управлению).

    async def subscribe_room(self, websocket: WebSocket, room: str) -> None:
        if not room:
            return
        async with self._lock:
            if websocket not in self._connections:
                return
            self._rooms.setdefault(room, set()).add(websocket)
            self._ws_rooms.setdefault(websocket, set()).add(room)

    async def unsubscribe_room(self, websocket: WebSocket, room: str) -> None:
        if not room:
            return
        async with self._lock:
            bucket = self._rooms.get(room)
            if bucket:
                bucket.discard(websocket)
                if not bucket:
                    self._rooms.pop(room, None)
            ws_set = self._ws_rooms.get(websocket)
            if ws_set:
                ws_set.discard(room)
                if not ws_set:
                    self._ws_rooms.pop(websocket, None)

    async def push_to_room(self, room: str, message: dict) -> None:
        """Отправить сообщение всем подписанным на эту room. ~5-20 ws вместо 1000."""
        text = json.dumps(message)
        async with self._lock:
            targets = list(self._rooms.get(room, ()))
        await self._send_with_cleanup(targets, text)

    # ─── Рассылка ─────────────────────────────────────────────────────────────

    async def _send_with_cleanup(self, targets: list, text: str) -> None:
        """Шлёт text всем сокетам, мёртвые удаляет из всех структур."""
        failed = []
        for ws in targets:
            try:
                await ws.send_text(text)
            except Exception:
                failed.append(ws)
        if failed:
            for ws in failed:
                # Параллельные disconnect'ы — каждый берёт свой lock внутри.
                await self.disconnect(ws)

    async def broadcast(self, message: dict) -> None:
        """
        Универсальный вход: маршрутизация на rooms.

        Логика:
          • Если в message['event_id'] — push в room "event:{id}".
          • Если message['action'] и есть room-маппинг — push в свою room
            (alert_lists_update → "alert_lists", combat_calc_update → "combat_calc",
            person_update → "persons").
          • Если ни того ни другого — broadcast_all (глобальное сообщение).

        Для 1000 онлайн это превращает «каждое изменение списка X шлёт всем 1000»
        в «5-20 подписчикам комнаты event:X».
        """
        target_eid = message.get("event_id")
        if target_eid is not None:
            await self.push_to_room(f"event:{target_eid}", message)
            return

        action = message.get("action") or ""
        room = _ACTION_ROOM_MAP.get(action)
        if room:
            await self.push_to_room(room, message)
            return

        # Действие неизвестно или явно глобальное — всем.
        await self.broadcast_all(message)

    async def broadcast_all(self, message: dict) -> None:
        """Безусловная рассылка всем клиентам (системные уведомления)."""
        text = json.dumps(message)
        async with self._lock:
            snapshot = list(self._connections)
        await self._send_with_cleanup(snapshot, text)

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

            # ── Подписка на event_id (legacy) или произвольную room ───────────
            elif msg_type == "subscribe":
                room = payload.get("room")
                if isinstance(room, str) and room:
                    await manager.subscribe_room(websocket, room)
                else:
                    event_id = payload.get("event_id")
                    if isinstance(event_id, int):
                        await manager.subscribe(websocket, event_id)

            # ── Отписка от конкретной room или сразу от event_id (legacy) ─────
            elif msg_type == "unsubscribe":
                room = payload.get("room")
                if isinstance(room, str) and room:
                    await manager.unsubscribe_room(websocket, room)
                else:
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