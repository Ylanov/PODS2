# app/core/config.py

import secrets
from pydantic_settings import BaseSettings
from pydantic import model_validator


class Settings(BaseSettings):
    PROJECT_NAME: str = "Staff Platform"
    ENV: str = "development"  # "development" | "production"

    POSTGRES_USER: str = "admin"
    POSTGRES_PASSWORD: str = "localpassword"
    POSTGRES_DB: str = "staff_db"
    POSTGRES_SERVER: str = "db"
    POSTGRES_PORT: str = "5432"

    SECRET_KEY: str = "change-me"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7

    # БАГ-ФИКС: поля ORG_NAME, DUTY_TITLE, DUTY_RANK, DUTY_NAME удалены.
    # Они дублировали таблицу settings в БД и нигде не использовались —
    # export.py читает эти значения через get_setting(db, key), не из config.
    # Хранить изменяемые runtime-данные в переменных окружения неудобно:
    # требует перезапуска контейнера. Таблица settings решает это правильно.

    # Пароль для авто-создания суперпользователя при первом запуске.
    # Если не задан — генерируется случайный и выводится в лог.
    ADMIN_PASSWORD: str = ""
    RESET_ADMIN_PASSWORD: bool = False

    # CORS: список разрешённых origins через запятую.
    # Пример в .env: ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
    # В dev можно оставить "*", но тогда allow_credentials должен быть False.
    ALLOWED_ORIGINS: str = "*"

    # ─── Rate limiting (защита от brute-force) ────────────────────────────────
    # Лимит попыток авторизации на IP (формат SlowAPI: "N/period").
    # Можно переопределить в .env: LOGIN_RATE_LIMIT=10/minute
    LOGIN_RATE_LIMIT: str = "10/minute"
    # Общий лимит на все эндпоинты (защита от DoS одним клиентом).
    # Считается per-IP. Нулевое значение или пустая строка — выключено.
    GLOBAL_RATE_LIMIT: str = "300/minute"

    # ─── Доступ к модулям отделов ─────────────────────────────────────────────
    # Каждый модуль (форма 3-СВЯЗЬ, гос. закупки, учёт МНИ, проф. подготовка)
    # привязывается к конкретным username'ам через .env. Через запятую:
    #     COMMS_UNIT_USERNAMES=svyaz,signal_dept
    # Если переменная пустая — модуль доступен всем unit-юзерам (поведение
    # по умолчанию для совместимости со старыми установками, где разделения
    # не было). Если переменная содержит хоть один username — модуль виден
    # ТОЛЬКО им; остальные отделы карточку не увидят.
    COMMS_UNIT_USERNAMES:       str = ""   # форма 3-СВЯЗЬ
    MEDIA_UNIT_USERNAMES:       str = ""   # учёт МНИ (флешки/диски)
    PROCUREMENT_UNIT_USERNAMES: str = ""   # гос. закупки
    TRAINING_UNIT_USERNAMES:    str = ""   # проф. подготовка

    @staticmethod
    def _parse_unit_list(raw: str) -> set[str] | None:
        """
        Возвращает None если список пуст (модуль открыт всем unit'ам),
        иначе — set username'ов с разрешённым доступом.
        """
        s = (raw or "").strip()
        if not s:
            return None
        return {u.strip() for u in s.split(",") if u.strip()}

    @property
    def comms_unit_usernames(self) -> set[str] | None:
        return self._parse_unit_list(self.COMMS_UNIT_USERNAMES)

    @property
    def media_unit_usernames(self) -> set[str] | None:
        return self._parse_unit_list(self.MEDIA_UNIT_USERNAMES)

    @property
    def procurement_unit_usernames(self) -> set[str] | None:
        return self._parse_unit_list(self.PROCUREMENT_UNIT_USERNAMES)

    @property
    def training_unit_usernames(self) -> set[str] | None:
        return self._parse_unit_list(self.TRAINING_UNIT_USERNAMES)

    # ─── Пул соединений БД (тюнится под количество gunicorn-воркеров) ─────────
    # Реальные соединения = DB_POOL_SIZE × число_воркеров.
    # Плюс резерв на max_overflow. По умолчанию postgres max_connections=100 —
    # поэтому значения ниже держим умеренными: 4 воркера × (10+15) = 100.
    # Если используете pgbouncer в pool_mode=transaction — можно увеличить.
    DB_POOL_SIZE:     int = 10
    DB_MAX_OVERFLOW:  int = 15
    DB_POOL_TIMEOUT:  int = 30    # сколько ждать свободное соединение из пула
    DB_POOL_RECYCLE:  int = 3600  # пересоздавать коннект старше часа
    DB_ECHO:          bool = False  # логировать ВСЕ SQL-запросы (только для debug)

    @property
    def DATABASE_URI(self) -> str:
        return (
            f"postgresql://{self.POSTGRES_USER}:"
            f"{self.POSTGRES_PASSWORD}@"
            f"{self.POSTGRES_SERVER}:"
            f"{self.POSTGRES_PORT}/"
            f"{self.POSTGRES_DB}"
        )

    @property
    def cors_origins(self) -> list[str]:
        """Разбирает ALLOWED_ORIGINS в список. Возвращает ["*"] если не задан."""
        if not self.ALLOWED_ORIGINS or self.ALLOWED_ORIGINS.strip() == "*":
            return ["*"]
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",") if o.strip()]

    @property
    def cors_allow_credentials(self) -> bool:
        """
        allow_credentials=True несовместим с allow_origins=["*"] по спецификации CORS —
        браузер отклоняет такие ответы. Включаем credentials только если заданы явные origins.
        """
        return self.cors_origins != ["*"]

    # ─── Валидация при старте ─────────────────────────────────────────────────

    @model_validator(mode="after")
    def validate_secret_key(self) -> "Settings":
        """
        В production дефолтный SECRET_KEY недопустим — любой может подделать JWT.
        Приложение не стартует пока ключ не заменён на случайный.
        Сгенерировать: python -c "import secrets; print(secrets.token_hex(32))"

        Также проверяем минимальную длину: HS256-ключ короче 32 символов
        подбирается брутфорсом за разумное время, это известная атака.
        """
        if self.ENV == "production":
            if self.SECRET_KEY == "change-me":
                raise ValueError(
                    "SECRET_KEY не может быть 'change-me' в production. "
                    "Задайте переменную окружения SECRET_KEY (минимум 32 символа)."
                )
            if len(self.SECRET_KEY) < 32:
                raise ValueError(
                    f"SECRET_KEY слишком короткий ({len(self.SECRET_KEY)} символов). "
                    "Требуется минимум 32 символа. "
                    'Сгенерируйте: python -c "import secrets; print(secrets.token_hex(32))"'
                )
        return self

    model_config = {
        "env_file": ".env",
        # БАГ-ФИКс: переменные из .env которых нет в модели (например org_name,
        # duty_title, duty_rank, duty_name оставшиеся от старой конфигурации)
        # теперь молча игнорируются вместо ValidationError.
        "extra": "ignore",
    }


settings = Settings()