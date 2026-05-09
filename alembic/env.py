from logging.config import fileConfig

from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

# 🔥 подключаем настройки проекта
from app.core.config import settings

# 🔥 база и metadata
from app.db.database import Base
from app.models import duty
import app.models.combat_calc

# ❗ ОБЯЗАТЕЛЬНО импортируем ВСЕ модели
from app.models.user import User
from app.models.event import Slot, Event, Group, Position
from app.models.setting import Setting
from app.models.person import Person
from app.models.audit import AuditLog  # noqa: F401
from app.models.auth_tokens import RefreshToken  # noqa: F401
from app.models.task import Task  # noqa: F401


# =========================
# CONFIG
# =========================
config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)


# =========================
# METADATA (для autogenerate)
# =========================
target_metadata = Base.metadata


# =========================
# DATABASE URL
# =========================
def get_database_url() -> str:
    return settings.DATABASE_URI


# =========================
# OFFLINE MODE
# =========================
def run_migrations_offline() -> None:
    url = get_database_url()

    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,  # 🔥 отслеживает изменения типов
    )

    with context.begin_transaction():
        context.run_migrations()


# =========================
# ONLINE MODE
# =========================
def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section)

    # 🔥 подставляем URL из settings
    configuration["sqlalchemy.url"] = get_database_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,  # 🔥 важно для изменений колонок
        )

        with context.begin_transaction():
            context.run_migrations()


# =========================
# ENTRY POINT
# =========================
if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()