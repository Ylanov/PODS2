# =========================
# 🏗️ BUILD STAGE
# =========================
FROM python:3.13-slim AS builder

WORKDIR /install

# system deps (только для сборки нативных расширений)
RUN apt-get update && apt-get install -y \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip

COPY requirements.txt .

# БАГ-ФИКС: убран флаг --no-deps.
# С --no-deps pip собирал wheel'ы только для прямых зависимостей из requirements.txt,
# но НЕ для транзитивных (starlette, anyio, pydantic-core и т.д.).
# В runtime-стадии pip install /install/*.whl не находил их в /install/
# и был вынужден скачивать из PyPI — многоэтапная сборка теряла смысл.
# Без --no-deps все зависимости (включая транзитивные) попадают в /install/,
# и runtime-образ собирается полностью offline.
RUN pip wheel --no-cache-dir -r requirements.txt


# =========================
# 🚀 RUNTIME STAGE
# =========================
FROM python:3.13-slim

WORKDIR /code

# runtime-зависимости: libpq5 для psycopg2, curl для healthcheck
RUN apt-get update && apt-get install -y \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Не запускаем от root
RUN useradd -m appuser

# Копируем все wheel'ы из builder (включая транзитивные зависимости)
COPY --from=builder /install /install

# Устанавливаем из локальных wheel'ов — PyPI не нужен
RUN pip install --no-cache-dir --no-index --find-links=/install /install/*.whl

COPY . .

# entrypoint.sh применяет миграции перед запуском gunicorn
RUN chmod +x /code/entrypoint.sh && chown -R appuser:appuser /code

USER appuser

EXPOSE 8000

ENTRYPOINT ["/code/entrypoint.sh"]
CMD ["gunicorn", "app.main:app", "-k", "uvicorn.workers.UvicornWorker", "-w", "4", "-b", "0.0.0.0:8000"]