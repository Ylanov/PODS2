#!/usr/bin/env bash
# Запуск карт зон ответственности (Linux/macOS). Нужен Python 3.10+ и интернет.
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
    echo "[1/2] Создаю окружение и ставлю зависимости..."
    python3 -m venv .venv
    . .venv/bin/activate
    python -m pip install --upgrade pip
    pip install -r requirements.txt
else
    . .venv/bin/activate
fi
echo "[2/2] Запускаю сервер..."
python server.py
