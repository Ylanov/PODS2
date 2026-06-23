@echo off
REM Сборка одиночного .exe (PyInstaller). Результат: dist\KartyZon.exe
REM Готовый .exe запускается без Python; интернет на ПК всё равно нужен (тайлы/геокодер).
cd /d "%~dp0"

if not exist .venv (
    python -m venv .venv
    call .venv\Scripts\activate.bat
    python -m pip install --upgrade pip
    pip install -r requirements.txt
) else (
    call .venv\Scripts\activate.bat
)
pip install pyinstaller

pyinstaller --noconfirm --onefile --name KartyZon ^
    --add-data "static;static" ^
    --collect-all uvicorn ^
    --collect-submodules fastapi ^
    --collect-all anyio ^
    --hidden-import geodesy ^
    server.py

echo.
echo Готово. Файл: dist\KartyZon.exe
echo Положи KartyZon.exe куда удобно и запусти двойным кликом.
pause
