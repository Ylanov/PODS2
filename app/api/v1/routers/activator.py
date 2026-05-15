# app/api/v1/routers/activator.py
"""
Standalone-активатор Windows/Office.

Принципиально отделён от агента крипто-ключей:
  • Без auth (любой кто имеет URL может запустить — это локалка предприятия).
  • Без привязки к юзеру PODS2 — не пишет токены в БД, не создаёт zombie-агентов.
  • Без Scheduled Task — разовая команда «запустил, активировал, забыл».
  • Без журнала на сервере — результат пользователь видит у себя в окне.

Юзер на машине, где надо активировать:
    PowerShell от админа → одна строка → готово:
        irm https://staff.asy-tk.ru/api/v1/activator/run.ps1 | iex

Что делает скрипт:
  1. Само-elevation через UAC если не админ.
  2. Скачивает MAS_AIO.cmd с GitHub raw в %TEMP%\\MAS\\.
  3. Запускает с методом HWID → активация Windows (вечная, по железу).
  4. Запускает с методом Ohook → активация Office.
  5. Парсит slmgr /xpr и OSPP.VBS /dstatus → показывает финальный статус.
  6. Pause.

Важно: на машине должен быть доступ к raw.githubusercontent.com.
Если стоит KSC — нужно исключение для C:\\Windows\\Temp\\MAS\\*
(MAS у Касперского классифицируется как HackTool).
"""

from fastapi import APIRouter, Request, Response


router = APIRouter(tags=["Активация Windows/Office"])


@router.get(
    "/activator/run.ps1",
    summary="Standalone-скрипт активации Windows + Office (без auth, без агента)",
)
def activator_script(request: Request) -> Response:
    """
    Возвращает self-contained PowerShell-скрипт, который:
      • при необходимости себя re-launch'ит от админа через UAC,
      • качает MAS из официального репо massgravel,
      • активирует Windows (HWID) и Office (Ohook) подряд,
      • показывает финальный статус slmgr/ospp.

    БЕЗ BOM в начале — намеренно. Скрипт рассчитан на запуск через
    `irm <url> | iex`, и `Invoke-RestMethod` сам декодирует UTF-8
    по Content-Type. BOM в строке `irm`-результата для PowerShell
    превращается в литеральный символ \\uFEFF, после которого `#` ПЕРЕСТАЁТ
    быть комментарием — парсер падает с MissingArgument.

    Если кто-то всё-таки решит сохранить файл на диск — нужно использовать
    `Out-File -Encoding UTF8`, который сам добавит BOM при записи.
    Для install/bootstrap endpoints BOM нужен (там основной use-case —
    сохранение на диск), для активатора — нет.

    Endpoint открыт (внутри корп. сети). Если когда-то понадобится
    ограничить — повесить nginx allow/deny на этот путь, или добавить
    Depends(get_current_user) — но это противоречит цели «без логинов».
    """
    return Response(
        content    = _ACTIVATOR_PS1.encode("utf-8"),
        media_type = "text/plain; charset=utf-8",
    )


# Сам скрипт. Никаких {{подстановок}} — он самодостаточный и не зависит
# от user/server context'а. Можно даже без сервера PODS2 запускать —
# берёт MAS напрямую с GitHub.
_ACTIVATOR_PS1 = r"""# PODS2 Activator — Windows + Office (standalone, no auth, no agent)
#
# Запуск:
#   1) PowerShell от Администратора.
#   2) irm https://<server>/api/v1/activator/run.ps1 | iex
#
# Скрипт сам:
#   • перезапустится через UAC если PowerShell не от админа,
#   • скачает MAS_AIO.cmd с массгравел/GitHub,
#   • активирует Windows (HWID) и Office (Ohook),
#   • покажет финальный статус.

$ErrorActionPreference = 'Stop'

# ─── Self-elevation ──────────────────────────────────────────────────────────
# Если запущен НЕ от админа — перезапускаем себя через UAC.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Требуются права администратора — Windows покажет запрос UAC."
    Start-Sleep -Seconds 1
    # Перезапускаем себя через новый PowerShell-процесс с -Verb RunAs.
    # Перекладываем содержимое скрипта в base64, чтобы не зависеть от $PSCommandPath
    # (его нет когда скрипт пришёл через `irm | iex`).
    $self = $MyInvocation.MyCommand.Definition
    if (-not $self) { $self = (Get-Content $PSCommandPath -Raw) }
    if (-not $self) {
        Write-Host "Не удалось перезапустить скрипт от админа." -ForegroundColor Red
        Write-Host "Запусти PowerShell от Администратора и выполни команду заново."
        Read-Host "Enter для выхода"
        exit 1
    }
    $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($self))
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-EncodedCommand",$b64
    exit
}

# ─── Заголовок ───────────────────────────────────────────────────────────────
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host ""
Write-Host "  ╔════════════════════════════════════════════╗"
Write-Host "  ║   Активация Windows + Office (через MAS)    ║"
Write-Host "  ╚════════════════════════════════════════════╝"
Write-Host ""
Write-Host "  Машина: $env:COMPUTERNAME"
Write-Host "  Юзер:   $env:USERNAME (просто текущий, активация на машину)"
Write-Host ""

# ─── 1. Скачиваем MAS ────────────────────────────────────────────────────────
$masDir  = Join-Path $env:TEMP "MAS"
$masFile = Join-Path $masDir "MAS_AIO.cmd"

if (-not (Test-Path $masDir)) {
    New-Item -ItemType Directory -Path $masDir -Force | Out-Null
}

$masUrl = "https://raw.githubusercontent.com/massgravel/Microsoft-Activation-Scripts/master/MAS/All-In-One-Version-KL/MAS_AIO.cmd"

Write-Host "  [1/4] Скачиваю MAS_AIO.cmd..."
try {
    Invoke-WebRequest -Uri $masUrl -OutFile $masFile -UseBasicParsing -ErrorAction Stop
    Write-Host "        OK ($([math]::Round((Get-Item $masFile).Length/1KB)) КБ)"
} catch {
    Write-Host ""
    Write-Host "  ✗ Не удалось скачать MAS: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "  Проверь:"
    Write-Host "   • интернет на этой машине (доступ к raw.githubusercontent.com)"
    Write-Host "   • прокси / корпоративный фаервол"
    Write-Host "   • KSC не блокирует загрузку (если стоит)"
    Read-Host "Enter для выхода"
    exit 1
}

# ─── 2. Запускаем MAS с методом HWID (Windows) ───────────────────────────────
Write-Host ""
Write-Host "  [2/4] Активирую Windows (метод HWID)..."
Write-Host "        Это может занять до 1 минуты. Окно MAS может моргнуть — это норма."
try {
    # /HWID — Windows активация по железу (вечная)
    # /S    — silent (без интерактивных меню MAS)
    $winOut = & cmd.exe /c "`"$masFile`" /HWID" 2>&1 | Out-String
    Write-Host "        Готово."
} catch {
    Write-Host "  ⚠ Активация Windows завершилась с ошибкой: $_" -ForegroundColor Yellow
}

# ─── 3. Запускаем MAS с методом Ohook (Office) ───────────────────────────────
Write-Host ""
Write-Host "  [3/4] Активирую Office (метод Ohook)..."
try {
    # /Ohook — самый безопасный метод для Click-to-Run Office.
    $offOut = & cmd.exe /c "`"$masFile`" /Ohook" 2>&1 | Out-String
    Write-Host "        Готово."
} catch {
    Write-Host "  ⚠ Активация Office завершилась с ошибкой: $_" -ForegroundColor Yellow
}

# ─── 4. Проверка финального статуса ──────────────────────────────────────────
Write-Host ""
Write-Host "  [4/4] Проверка статуса..."
Write-Host ""

# Windows: slmgr /xpr показывает «лицензия активирована до...» / «не активирована»
$winStatus = "не определено"
try {
    $slmgr = & cscript.exe //nologo "$env:SystemRoot\System32\slmgr.vbs" /xpr 2>&1 | Out-String
    if ($slmgr -match "permanent" -or $slmgr -match "постоянн" -or $slmgr -match "бессрочно") {
        $winStatus = "АКТИВИРОВАНА (постоянная лицензия)"
    } elseif ($slmgr -match "activated" -or $slmgr -match "активирована") {
        $winStatus = "АКТИВИРОВАНА"
    } else {
        $winStatus = "не активирована — см. подробности ниже"
    }
} catch {}

# Office: OSPP.VBS /dstatus — но нужно знать где он стоит.
$officeStatus = "Office не найден / не установлен"
$ospp = @(
    "$env:ProgramFiles\Microsoft Office\Office16\OSPP.VBS",
    "${env:ProgramFiles(x86)}\Microsoft Office\Office16\OSPP.VBS",
    "$env:ProgramFiles\Microsoft Office\Office15\OSPP.VBS",
    "${env:ProgramFiles(x86)}\Microsoft Office\Office15\OSPP.VBS"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($ospp) {
    try {
        $ospOut = & cscript.exe //nologo $ospp /dstatus 2>&1 | Out-String
        if ($ospOut -match "LICENSE STATUS:\s*---LICENSED---") {
            $officeStatus = "АКТИВИРОВАН"
        } elseif ($ospOut -match "Ohook") {
            $officeStatus = "АКТИВИРОВАН (Ohook)"
        } else {
            $officeStatus = "статус неясен — см. вывод OSPP.VBS вручную"
        }
    } catch {
        $officeStatus = "ошибка при проверке OSPP: $_"
    }
}

Write-Host "  ┌───────────────────────────────────────────"
Write-Host "  │ Windows: $winStatus"
Write-Host "  │ Office:  $officeStatus"
Write-Host "  └───────────────────────────────────────────"
Write-Host ""

if ($winStatus -like "*АКТИВИРОВАНА*" -and $officeStatus -like "*АКТИВИРОВАН*") {
    Write-Host "  ✓ Всё активировано. Можешь закрыть окно." -ForegroundColor Green
} else {
    Write-Host "  Если что-то не активировалось — обычно помогает:" -ForegroundColor Yellow
    Write-Host "   • перезагрузить ПК и запустить команду заново,"
    Write-Host "   • для Office: закрыть все приложения Office и попробовать опять."
}

Write-Host ""
Read-Host "Enter чтобы закрыть окно"
"""
