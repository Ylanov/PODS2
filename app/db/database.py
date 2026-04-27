from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base

from app.core.config import settings

# Строка подключения собирается из полей settings.POSTGRES_*
SQLALCHEMY_DATABASE_URL = settings.DATABASE_URI

# Engine — одна точка входа в SQLAlchemy.
# Параметры пула берём из settings, чтобы тюнить через .env без пересборки.
#
# Расчёт соединений: pool_size × workers + max_overflow × workers = пик.
# Для 2к пользователей по умолчанию: 4 воркера × (10+15) = до 100 соединений.
# Это совпадает со стоковым postgres max_connections=100.
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    echo=settings.DB_ECHO,
    pool_size=settings.DB_POOL_SIZE,
    max_overflow=settings.DB_MAX_OVERFLOW,
    pool_timeout=settings.DB_POOL_TIMEOUT,
    pool_pre_ping=True,            # отсекает мёртвые соединения до использования
    pool_recycle=settings.DB_POOL_RECYCLE,
    # connect_args для psycopg2: таймауты на уровне соединения.
    # statement_timeout защищает от долгих запросов съедающих воркер
    # (например случайно тяжёлый SELECT без WHERE). 30 секунд — с запасом
    # на импорт Excel и экспорт DOCX, но не столько чтобы блокировать сервис.
    connect_args={
        "connect_timeout": 10,
        "options": "-c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000",
    },
)

# Фабрика сессий — на каждый HTTP-запрос создаётся новая сессия через get_db
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()


def get_db():
    """
    Зависимость FastAPI — гарантированно закрывает сессию.

    Если обработчик выбросит исключение, сессия всё равно закроется
    (отдав коннект обратно в пул) — это критично при 2к пользователей,
    иначе утечка соединений быстро исчерпает пул.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
