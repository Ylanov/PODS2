# app/db/init_db.py
"""
ИСПРАВЛЕНИЕ: убран вызов Base.metadata.create_all() из init_db.

Проблема была в том что create_all запускался при старте КАЖДОГО gunicorn-воркера.
При 4 воркерах — 4 параллельных вызова create_all при старте.
Это создавало гонку состояний с Alembic-миграциями:
  - один воркер начинает создавать таблицу
  - другой параллельно читает незавершённую схему
  - возможны ошибки типа "relation does not exist" или duplicate column

Правильный подход:
  Управление схемой БД — исключительно через Alembic.
  init_db теперь только:
    1. Засевает шаблоны боевого расчёта (если их нет)
    2. Создаёт admin-пользователя (если его нет)
    3. Обрабатывает сброс пароля по флагу RESET_ADMIN_PASSWORD

Схема запуска в Docker:
  entrypoint.sh:
    alembic upgrade head   ← меняет схему БД (один раз, один процесс)
    gunicorn app.main:app  ← запускает воркеры (init_db без create_all)
"""

import os
import secrets
import sys
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.models.user import User
from app.core.security import get_password_hash
from app.core.config import settings


def _emit_admin_password(password: str, source: str, is_reset: bool) -> None:
    """
    Вывод пароля администратора — безопасно.

    Раньше пароль печатался в stdout (попадает в docker logs / journalctl
    и может остаться в истории навечно). Теперь:
      - Если задан ADMIN_PASSWORD_FILE — сохраняем туда (режим 600)
        и в лог пишем только путь. Это предпочтительный способ для prod.
      - Если в env ADMIN_PASSWORD задан пользователем — ничего не выводим
        (админ сам знает пароль, незачем его дублировать в логи).
      - Иначе (сгенерирован автоматически) — выводим В STDERR один раз,
        без обрамляющих рамок, чтобы было видно что это сенситивная строка.
        Это запасной путь для локальной разработки.
    """
    file_path = os.environ.get("ADMIN_PASSWORD_FILE")
    title = "сброшен" if is_reset else "создан"

    if file_path:
        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(password + "\n")
            try:
                os.chmod(file_path, 0o600)
            except Exception:
                pass
            print(f"✅ Пароль администратора {title}. Сохранён в {file_path} ({source}).")
            return
        except Exception as e:
            print(f"⚠️  Не удалось записать ADMIN_PASSWORD_FILE ({file_path}): {e}")

    if source.startswith("из переменной окружения"):
        # Админ сам задал пароль — не дублируем его в логи
        print(f"✅ Пароль администратора {title} (взят из ADMIN_PASSWORD).")
        return

    # Сгенерирован автоматически — выводим только в stderr, один раз
    print(
        f"\n⚠️  Сгенерирован пароль администратора (логин: admin). "
        f"Сохраните его сейчас — больше показан не будет:\n"
        f"    {password}\n"
        f"Рекомендуется задать ADMIN_PASSWORD или ADMIN_PASSWORD_FILE "
        f"в .env для production.\n",
        file=sys.stderr,
    )


def init_db(db: Session) -> None:
    """
    Инициализация данных при старте приложения.

    НЕ управляет схемой БД — это делает Alembic.
    Только засевает начальные данные если их нет.
    """

    # Advisory lock защищает от гонки при запуске нескольких воркеров gunicorn.
    # Только один воркер пройдёт дальше, остальные дождутся его завершения.
    try:
        db.execute(text("SELECT pg_advisory_xact_lock(2023120101)"))
    except Exception:
        pass

    # ─── Засев шаблонов боевого расчёта ──────────────────────────────────────
    # Идемпотентно: создаёт шаблоны только если их нет
    try:
        from app.db.seed_combat_calc import seed_templates
        seed_templates(db)
    except Exception as e:
        # Важно: после SQL-ошибки транзакция Postgres помечена как aborted,
        # и любые последующие запросы упадут с InFailedSqlTransaction.
        # Откатываем, чтобы дальнейший код (создание админа) мог работать.
        db.rollback()
        print(f"⚠️  seed_templates warning (non-fatal): {e}")

    # ─── Администратор ───────────────────────────────────────────────────────
    admin_user = db.query(User).filter(User.username == "admin").first()

    # Сброс пароля по запросу (флаг RESET_ADMIN_PASSWORD=true в .env)
    if admin_user and settings.RESET_ADMIN_PASSWORD:
        if settings.ADMIN_PASSWORD:
            new_password = settings.ADMIN_PASSWORD
            source = "из переменной окружения ADMIN_PASSWORD"
        else:
            new_password = secrets.token_urlsafe(18)
            source = "сгенерирован автоматически"

        admin_user.hashed_password = get_password_hash(new_password)
        db.commit()

        _emit_admin_password(new_password, source, is_reset=True)
        print("   Снимите флаг RESET_ADMIN_PASSWORD=false после перезапуска.")
        return

    if admin_user:
        print("ℹ️  Суперпользователь 'admin' уже существует")
        return

    # ─── Первичное создание администратора ───────────────────────────────────
    if settings.ADMIN_PASSWORD:
        password        = settings.ADMIN_PASSWORD
        password_source = "из переменной окружения ADMIN_PASSWORD"
    else:
        password        = secrets.token_urlsafe(18)
        password_source = "сгенерирован автоматически"

    new_admin = User(
        username="admin",
        hashed_password=get_password_hash(password),
        role="admin",
        is_active=True,
    )
    db.add(new_admin)
    db.commit()

    _emit_admin_password(password, password_source, is_reset=False)