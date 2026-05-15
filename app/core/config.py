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

    # ─── Точечные лимиты на тяжёлые эндпоинты (per-IP) ────────────────────────
    # СЭД-расширение шлёт snapshot раз в 5 мин (12/час нормально).
    # Лимит 30/час даёт х2.5 запас на ручные синки + защищает от взбесившейся
    # копии расширения которая стучит каждую секунду.
    SED_SNAPSHOT_RATE_LIMIT: str = "30/hour"
    # Тела писем: расширение шлёт по одному после получения snapshot (до 30
    # за тик в нашей логике + 8 секций). 300/час = ~5/мин, реалистично.
    SED_LETTER_RATE_LIMIT:   str = "300/hour"
    # Импорты Excel/Word — большие файлы, тяжёлые парсинги. 10/час хватит даже
    # самому активному админу (обычно 1-2 импорта в день).
    IMPORT_RATE_LIMIT:       str = "10/hour"
    # Yandex API — у их ключа суточный лимит. Per-IP лимит 60/min на геокодер
    # и 120/min на suggest (debounce 250ms у фронта = ~4/sec при наборе).
    GEOCODE_RATE_LIMIT:      str = "60/minute"
    SUGGEST_RATE_LIMIT:      str = "120/minute"
    # Аналитика — тяжёлый запрос (12+ агрегатов). Один юзер не должен дёргать
    # её чаще ~1/sec.
    ANALYTICS_RATE_LIMIT:    str = "30/minute"

    # ─── СЭД-файлы (кеш бинарников) ───────────────────────────────────────────
    # Каталог на диске для blob'ов (mount volume seddata в docker-compose).
    SED_FILES_DIR:           str = "/data/sed_files"
    # Максимальный размер одного файла — отвергаем большие, чтобы расширение
    # не залило диск гигантским PDF'ом случайно.
    SED_FILE_MAX_SIZE:       int = 20 * 1024 * 1024   # 20 МБ
    # TTL: файлы с fetched_at старше этого — кандидаты на удаление через
    # cleanup-endpoint (или будущий cron).
    SED_FILE_RETENTION_DAYS: int = 90
    # Максимум попыток скачать — после этого расширение перестаёт пробовать.
    SED_FILE_MAX_ATTEMPTS:   int = 5
    # Rate-limit на загрузку (расширение шлёт по 30 файлов за тик).
    SED_FILE_UPLOAD_RATE_LIMIT: str = "600/hour"
    SED_FILE_DOWNLOAD_RATE_LIMIT: str = "1200/hour"

    # ─── Ключи и сертификаты КриптоПро (модуль crypto-keys) ──────────────────
    # Хранилище секретов. Vault — основной путь (PODS2 кладёт зашифрованные
    # контейнеры в Vault, а Vault на своей стороне делает sealed-шифрование).
    # Для dev/PoC можно указать пустой VAULT_URL — тогда контейнеры будут
    # храниться на диске в CRYPTO_KEYS_FALLBACK_DIR (с шифрованием Fernet
    # на ключе SECRET_KEY). В проде VAULT_URL должен быть задан.
    VAULT_URL:               str = "http://vault:8200"
    VAULT_TOKEN:             str = ""      # root-токен или AppRole-токен
    VAULT_MOUNT:             str = "secret"  # имя KV-engine v2 в Vault
    VAULT_KV_PATH_PREFIX:    str = "crypto-keys"  # path: <mount>/data/<prefix>/<thumbprint>
    # Локальный fallback (на случай если Vault недоступен / в dev).
    # В проде оставить пустым — отключает fallback и форсит работу через Vault.
    CRYPTO_KEYS_FALLBACK_DIR: str = ""
    # Лимиты на загрузку контейнеров (multipart с 6 файлами *.key).
    # Один контейнер ~3 КБ, .cer ~2 КБ — но защищаемся от ошибочной отправки
    # больших файлов. 1 МБ с запасом.
    CRYPTO_CONTAINER_MAX_SIZE: int = 1 * 1024 * 1024   # 1 МБ
    CRYPTO_CERT_MAX_SIZE:      int = 64 * 1024          # 64 КБ
    # Rate-limits.
    # Админ загружает редко (несколько ключей в день), но возможен пакетный
    # импорт — 60/час с запасом. Парсинг превью .cer чаще (юзер пробует разные
    # файлы) — 120/час.
    CRYPTO_ADMIN_UPLOAD_RATE_LIMIT: str = "60/hour"
    CRYPTO_CERT_PARSE_RATE_LIMIT:   str = "120/hour"
    # Агент пингует часто — раз в N минут. Лимит щедрый, но защищает от
    # сошедшего с ума агента который стучит каждую секунду.
    # NB: с per-token keyfunc (см. _agent_rate_key в certs.py) лимит у
    # каждого агента свой, а не делится на всех через корпоративный NAT.
    CRYPTO_AGENT_SYNC_RATE_LIMIT:   str = "120/hour"
    # Enrollment редкий, но при bulk-раскатке (300 ПК сразу через
    # Invoke-Command) все идут с одного админского IP — отдельный
    # увеличенный лимит для этого случая.
    CRYPTO_AGENT_ENROLL_RATE_LIMIT: str = "600/hour"
    # Сколько живёт токен агента после генерации install-пакета.
    # 365 дней = годовой цикл переустановки. Можно отзывать раньше из админки.
    CRYPTO_AGENT_TOKEN_TTL_DAYS:    int = 365

    # ─── TTL для журналов (авточистка при старте + раз в сутки) ──────────────
    # При 300 ПК журналы растут быстро: каждый poll = строка в last_seen
    # (UPDATE, не INSERT — ок); каждая подпись = строка в crypto_key_usage
    # (INSERT — может быть 1000+/день); каждая команда = строка в agent_commands.
    # Эти лимиты задают сколько дней истории держать.
    CRYPTO_USAGE_RETENTION_DAYS:    int = 90
    # CRYPTO_COMMANDS_RETENTION_DAYS удалена — таблица agent_commands больше
    # не существует (миграция f6a7b8c9d0e1). Активация Win/Office —
    # через /api/v1/activator/run.ps1.
    # Удалять revoked agent_tokens старше N дней (для аудита оставляем).
    CRYPTO_REVOKED_AGENT_TOKEN_TTL_DAYS: int = 180

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

    # ─── Карта Оперативного дежурного (oper_map) ──────────────────────────────
    # Ключ Яндекс.Карт для прокси геокодера/тайлов. Запрашивается на сервере
    # (со стороны интернет-сетевухи), браузеру пользователя в локалке не уходит.
    # Если пусто — прокси отдают 503; UI показывает «карта не настроена».
    YANDEX_MAPS_API_KEY: str = ""
    # URL OSRM для маршрутов. Публичный по умолчанию; можно поднять свой
    # инстанс в локалке и переопределить (например http://osrm:5000).
    OSRM_BASE_URL: str = "https://router.project-osrm.org"
    # Папка для кеша Яндекс-тайлов — в проде маппится в volume,
    # в dev живёт рядом с проектом. Пустая строка = без кеша.
    OPER_MAP_TILE_CACHE_DIR: str = "var/oper_map_tiles"

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