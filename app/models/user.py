from sqlalchemy import Column, Integer, String, Boolean
from sqlalchemy.dialects.postgresql import JSONB
from app.db.database import Base


# Полный список доступных вкладок для управлений.
# Admin всегда имеет доступ ко всему — его permissions игнорируются.
# Любая новая вкладка добавляется сюда + в frontend-проверки.
AVAILABLE_PERMISSIONS = ("lists", "duty", "combat", "tasks", "persons")
DEFAULT_PERMISSIONS   = list(AVAILABLE_PERMISSIONS)


# ── Модули операций (для unit-юзеров) ───────────────────────────────────────
# Каждый отдел видит только те модули которые ему явно назначил админ.
# Список каждого юзера хранится в users.modules (JSONB-массив идентификаторов).
# Если modules == NULL — это «не настроено», бэкенд отдаёт пустой список,
# чтобы новые отделы по умолчанию ничего лишнего не видели.
AVAILABLE_MODULES = ("comms", "media", "procurement", "training")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False) # например: upr_3, admin
    hashed_password = Column(String, nullable=False)
    role = Column(String, default="department") # 'admin' или 'department'
    is_active = Column(Boolean, default=True)

    # Список вкладок которые разрешены пользователю (для role='department').
    # Хранится как JSONB-массив строк: ["lists", "duty", "combat", "tasks", "persons"].
    # JSONB выбран вместо ARRAY(String) для переносимости и удобства миграций.
    # Для admin игнорируется (admin всё равно видит всё).
    permissions = Column(JSONB, nullable=False, server_default='["lists","duty","combat","tasks","persons"]')

    # Список модулей-операций (для role='unit'): каждая карточка в «Операциях»
    # появляется только если её id есть в этом списке. JSONB-массив строк
    # из AVAILABLE_MODULES. Для admin игнорируется. NULL = «не настроено» →
    # юзер не видит ни одного модуля до тех пор пока админ их не назначит.
    modules     = Column(JSONB, nullable=True)