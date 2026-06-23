@echo off
REM Сборка установщика «Карты»: Karty.exe (оконный) + Карты-Setup.exe
REM Нужен установленный Python 3.10+ и (для установщика) бесплатный Inno Setup 6.
cd /d "%~dp0"
chcp 65001 >nul

echo [1/3] Окружение и зависимости...
if not exist .venv (
    python -m venv .venv
    call .venv\Scripts\activate.bat
    python -m pip install --upgrade pip
    pip install -r requirements.txt
) else (
    call .venv\Scripts\activate.bat
)
pip install pyinstaller >nul

echo [2/3] Сборка Karty.exe (оконный, один файл)...
set "ICONOPT="
if exist karty.ico set "ICONOPT=--icon karty.ico"
pyinstaller --noconfirm --onefile --windowed --name Karty %ICONOPT% ^
    --add-data "static;static" ^
    --collect-all uvicorn ^
    --collect-submodules fastapi ^
    --collect-submodules starlette ^
    --collect-all anyio ^
    --collect-data docx ^
    --hidden-import multipart ^
    --hidden-import geodesy ^
    launcher.py
if not exist "dist\Karty.exe" (
    echo [ОШИБКА] Не удалось собрать dist\Karty.exe
    pause & exit /b 1
)

echo [3/3] Компиляция установщика (Inno Setup)...
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"

if "%ISCC%"=="" (
    echo.
    echo Karty.exe собран: dist\Karty.exe
    echo Чтобы получить УСТАНОВЩИК, поставьте бесплатный Inno Setup 6:
    echo     https://jrsoftware.org/isdl.php
    echo и снова запустите build_installer.bat
    pause & exit /b 0
)
"%ISCC%" installer.iss
echo.
echo ГОТОВО. Установщик: Output\Карты-Setup.exe
echo Передавайте/запускайте этот файл — он поставит «Карты» и создаст ярлык.
pause
