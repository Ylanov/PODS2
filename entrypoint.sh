#!/bin/sh
# entrypoint.sh
#
# Запуск приложения в docker:
#   1. Ждём пока Postgres примет соединения (depends_on healthcheck этого
#      не гарантирует на 100% в условиях перезапусков).
#   2. Применяем миграции alembic upgrade head. Запускается ОДИН раз
#      (не на каждого воркера) — этого достаточно.
#   3. Передаём управление gunicorn через exec, чтобы он получил PID 1
#      и корректно обрабатывал SIGTERM от docker stop.

set -e

echo "▶️  Ожидаем Postgres (${POSTGRES_SERVER:-db}:${POSTGRES_PORT:-5432})..."
# Простой retry с ограничением: максимум 30 × 2с = 60 секунд
for i in $(seq 1 30); do
    if python -c "
import socket, sys, os
s = socket.socket()
s.settimeout(2)
try:
    s.connect((os.environ.get('POSTGRES_SERVER', 'db'),
               int(os.environ.get('POSTGRES_PORT', 5432))))
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
        echo "✅ Postgres доступен"
        break
    fi
    echo "   попытка $i/30..."
    sleep 2
done

echo "▶️  Применяем миграции (alembic upgrade head)..."
alembic upgrade head

echo "▶️  Стартуем приложение: $*"
exec "$@"
