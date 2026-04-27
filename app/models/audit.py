# app/models/audit.py
"""
AuditLog — полный журнал изменений сущностей в системе.

Зачем:
    Военная служебная система требует трассировки "кто, что, когда и с каким
    IP менял". version на слоте отвечает только за optimistic locking и не
    даёт восстановить ИСТОРИЮ значений — только их наличие поменялось.

    audit_log — append-only, строки никогда не обновляются и не удаляются
    (кроме retention-задания которое чистит записи старше N дней).

Логика заполнения:
    Вызов через app.core.audit.log_change() в конкретных API-handlers,
    там где меняем бизнес-сущности (slot, person, user, permissions).
    Не через SQLAlchemy events потому что:
      - event-хуку трудно получить user_id / ip (нет request context);
      - events срабатывают внутри autoflush и могут спровоцировать
        рекурсивные коммиты.

Notification:
    Записи этого лога являются источником для Notification-ленты:
    например, при UPDATE slot с department=upr_3 генерируется notification
    для пользователя upr_3 "ваш слот был изменён админом".
"""
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, DateTime, ForeignKey, Index, Text
)
from sqlalchemy.dialects.postgresql import JSONB, INET
from sqlalchemy.orm import relationship

from app.db.database import Base


# Константы действий — используются как enum, но хранятся строкой
# для простоты миграций. Добавлять новые значения — просто вызвать
# log_change с новой строкой, никаких alembic-правок не надо.
ACTION_CREATE = "create"
ACTION_UPDATE = "update"
ACTION_DELETE = "delete"
ACTION_REVERT = "revert"


class AuditLog(Base):
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True)

    # Время строго с TZ — важно для корреляции между узлами и читаемости
    # в UI через new Date(iso). Индекс для фильтра "последние N записей".
    timestamp = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )

    # user_id: кто сделал действие.
    # SET NULL при удалении юзера, чтобы не терять историю.
    # username кешируем отдельной колонкой — на случай если user удалён,
    # чтобы UI показал "кто был" без JOIN.
    user_id  = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    username = Column(String(100), nullable=True)

    # action: create / update / delete / revert (см. ACTION_* константы).
    # entity_type: "slot" | "person" | "user" | "user_permissions" | ...
    # entity_id:   ID изменяемой сущности. Nullable для bulk-операций.
    action      = Column(String(50),  nullable=False, index=True)
    entity_type = Column(String(50),  nullable=False, index=True)
    entity_id   = Column(Integer,     nullable=True,  index=True)

    # Значения ДО и ПОСЛЕ, JSONB для индексации по ключам на PG если нужно.
    # old_values = {} для create, new_values = {} для delete.
    # Для update храним ТОЛЬКО изменённые поля, а не весь объект —
    # это экономит место и делает diff читаемым в UI.
    old_values = Column(JSONB, nullable=True)
    new_values = Column(JSONB, nullable=True)

    # Сетевой контекст. INET — нативный тип PG, валидирует IP на уровне БД.
    ip_address = Column(INET,        nullable=True)
    user_agent = Column(String(400), nullable=True)

    # Произвольный контекст: {"event_id": 42, "group_name": "Группа 1", ...}
    # Помогает при выводе в UI (название списка вместо event_id).
    extra = Column(JSONB, nullable=True)

    user = relationship("User", foreign_keys=[user_id])

    __table_args__ = (
        # Самый частый запрос — "история одной сущности, свежие сверху".
        # Композитный индекс покрывает WHERE entity_type=... AND entity_id=...
        # ORDER BY timestamp DESC без sort.
        Index("ix_audit_entity_ts", "entity_type", "entity_id", "timestamp"),
        # Для дашборда "что делал пользователь X за период"
        Index("ix_audit_user_ts",   "user_id",     "timestamp"),
    )


class Notification(Base):
    """
    Уведомления пользователей.

    Персональная лента. Отделена от audit_log потому что:
      - audit — это полный лог (админский), а notifications — для юзера;
      - один audit-event может породить несколько notifications (например,
        admin изменил квоту → уведомить старого и нового департаментов);
      - у notification есть состояние is_read которое меняется.

    Создаётся явными вызовами из хендлеров (см. app.core.notify.notify_user).
    Доставляется realtime через WebSocket (канал user_{id}) + хранится
    в БД для "пропущенных пока был offline".
    """
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True)

    # Владелец уведомления. CASCADE на удаление пользователя —
    # хранить notifications удалённого user'а не нужно.
    user_id = Column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    # Тип для классификации и иконки в UI:
    #   "slot_filled"        — кто-то заполнил ваш слот
    #   "slot_changed"       — ваш слот изменён (админом)
    #   "duty_assigned"      — вас поставили в наряд
    #   "task_assigned"      — админ дал вам задачу (на будущее)
    #   "person_applied"     — ваша запись из общей базы применена к другому управлению
    #   "system"             — системное сообщение админа
    kind = Column(String(50), nullable=False, index=True)

    title   = Column(String(200),  nullable=False)
    body    = Column(Text,         nullable=True)
    # Deeplink куда вести по клику: "/slots/events/42" или "/persons"
    link    = Column(String(500),  nullable=True)

    # Связь с audit-записью, если была. Позволяет "развернуть"
    # уведомление в детали изменений.
    audit_id = Column(
        Integer, ForeignKey("audit_log.id", ondelete="SET NULL"),
        nullable=True,
    )

    is_read    = Column(
        Integer, nullable=False, server_default="0", default=0, index=True,
    )
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )
    read_at    = Column(DateTime(timezone=True), nullable=True)

    user  = relationship("User", foreign_keys=[user_id])
    audit = relationship("AuditLog", foreign_keys=[audit_id])

    __table_args__ = (
        # Частый запрос: "непрочитанные у этого пользователя, новые сверху"
        Index("ix_notifications_user_read_ts", "user_id", "is_read", "created_at"),
    )
