@echo off
REM Запуск карт зон ответственности на этом компьютере.
REM Двойной клик — само поставит зависимости (нужен установленный Python 3.10+ и интернет)
REM и откроет браузер на http://127.0.0.1:8077
cd /d "%~dp0"

if not exist .venv (
    echo [1/2] Создаю окружение и ставлю зависимости...
    python -m venv .venv
    call .venv\Scripts\activate.bat
    python -m pip install --upgrade pip
    pip install -r requirements.txt
) else (
    call .venv\Scripts\activate.bat
)

echo [2/2] Запускаю сервер...
python server.py
pause
