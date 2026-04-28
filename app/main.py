# app/main.py

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy.exc import ProgrammingError, OperationalError
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.core.config import settings
from app.core.limiter import limiter
from app.db.database import SessionLocal
from app.api.v1.routers import auth, admin, slots, export, persons, duty
from app.api.v1.routers import combat_calc
from app.api.v1.routers import comms_report
from app.api.v1.routers import procurement
from app.api.v1.routers import media as media_router
from app.api.v1.routers import training as training_router
from app.api.v1.routers import settings as settings_router
from app.api.v1.routers import dept_duty
from app.api.v1.routers import dashboard
from app.api.v1.routers import tasks
from app.api.v1.routers import audit as audit_module
from app.api.v1.routers import holidays as holidays_module
from app.db.init_db import init_db
from app.core.websockets import manager, handle_websocket_connection


# ─── Lifespan (startup / shutdown) ───────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("🚀 Starting application...")

    db = SessionLocal()
    try:
        for attempt in range(10):
            try:
                init_db(db)
                print("✅ Database ready and initial data ensured")
                break

            except OperationalError:
                print(f"⏳ Waiting for database... attempt {attempt + 1}/10")
                await asyncio.sleep(2)

            except ProgrammingError:
                print("⚠️  Tables not found. Run 'alembic upgrade head'")
                break

            except Exception as error:
                print(f"🔥 Unexpected init_db error: {error}")
                break
    finally:
        db.close()

    print("✅ Application started")
    yield
    print("🛑 Application stopped")


# ─── Приложение ───────────────────────────────────────────────────────────────

app = FastAPI(
    title=settings.PROJECT_NAME,
    lifespan=lifespan,
)


# ─── Rate limiting ────────────────────────────────────────────────────────────
# Глобальный лимитер (per-IP). Используется через app.state.limiter,
# чтобы SlowAPIMiddleware и декораторы @limiter.limit(...) в роутерах
# могли обращаться к одному инстансу.
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded):
    # 429 Too Many Requests — стандартный ответ по RFC 6585.
    # detail с понятной формулировкой, Retry-After добавляет SlowAPI.
    return JSONResponse(
        status_code=429,
        content={"detail": f"Слишком много запросов. Повторите позже ({exc.detail})."},
    )


app.add_middleware(SlowAPIMiddleware)

# GZip для текстовых ответов: HTML/CSS/JS/JSON жмутся в 5-7 раз. Особенно
# заметно для CSS bundle (328 KB → ~50 KB) и больших JSON-ответов API.
# minimum_size=500 — мелкие ответы не жмём (overhead больше выигрыша).
app.add_middleware(GZipMiddleware, minimum_size=500)


# ─── CORS ─────────────────────────────────────────────────────────────────────
# ИСПРАВЛЕНО: раньше allow_methods/allow_headers=["*"] — слишком широко.
# Теперь явный список методов которые реально используются API.
# allow_headers включает Authorization (JWT), Content-Type, и всё что
# фронт реально шлёт. Это снижает поверхность атаки через CORS-preflight.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=settings.cors_allow_credentials,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "Accept"],
)


# ─── Роутеры ─────────────────────────────────────────────────────────────────

app.include_router(auth.router,            prefix="/api/v1/auth",    tags=["Авторизация"])
app.include_router(admin.router,           prefix="/api/v1/admin",   tags=["Администрирование"])
app.include_router(slots.router,           prefix="/api/v1/slots",   tags=["Слоты"])
app.include_router(export.router,          prefix="/api/v1/export",  tags=["Экспорт"])
app.include_router(persons.router,         prefix="/api/v1/persons", tags=["Справочник людей"])
app.include_router(settings_router.router, prefix="/api/v1/settings",tags=["Настройки"])
app.include_router(duty.router,            prefix="/api/v1/admin",   tags=["Графики наряда"])
app.include_router(dashboard.router,       prefix="/api/v1/admin",   tags=["Дашборд"])
app.include_router(dept_duty.router,       prefix="/api/v1/dept",    tags=["Графики наряда (управление)"])
app.include_router(tasks.router,           prefix="/api/v1/tasks",   tags=["Календарь задач"])

# Аудит и уведомления.
# audit_admin_router — админский /admin/audit-log и /admin/audit-log/day-counts.
# slot_history_router — /slots/{id}/history и /slots/{id}/revert/{aid},
# доступен и админу, и department'у (своей истории); поэтому без /admin.
app.include_router(audit_module.audit_admin_router,   prefix="/api/v1/admin",         tags=["Аудит (admin)"])
app.include_router(audit_module.slot_history_router,  prefix="/api/v1",               tags=["История слотов"])
app.include_router(audit_module.notifications_router, prefix="/api/v1/notifications", tags=["Уведомления"])

# Праздники: чтение — всем, управление — админу.
app.include_router(holidays_module.public_router, prefix="/api/v1/holidays",       tags=["Праздники"])
app.include_router(holidays_module.admin_router,  prefix="/api/v1/admin",          tags=["Праздники (admin)"])

# ─── Боевой расчёт ────────────────────────────────────────────────────────────
# ИСПРАВЛЕНО: раньше один и тот же роутер подключался дважды с разными prefix,
# что дублировало все маршруты. Теперь:
#   - /api/v1/admin/combat/...  — маршруты только для администратора
#   - /api/v1/combat/...        — маршруты для управлений (заполнение)
# Оба набора маршрутов находятся в одном файле combat_calc.py и разделены
# зависимостями get_current_active_admin / get_current_user внутри роутера.
# Подключаем ОДИН РАЗ с prefix /api/v1, маршруты внутри уже имеют /admin/combat/...
# и /combat/... — FastAPI сам строит полный путь.
app.include_router(combat_calc.admin_router, prefix="/api/v1/admin", tags=["Боевой расчёт (admin)"])
app.include_router(combat_calc.dept_router,  prefix="/api/v1",       tags=["Боевой расчёт (управление)"])

# ─── Отдел связи: Форма 3-СВЯЗЬ ───────────────────────────────────────────────
app.include_router(comms_report.router,      prefix="/api/v1/comms-report",
                   tags=["Отдел связи (Форма 3-СВЯЗЬ)"])

# ─── Гос. закупки отдела ──────────────────────────────────────────────────────
app.include_router(procurement.router,       prefix="/api/v1/procurement",
                   tags=["Гос. закупки отдела"])

# ─── Учёт МНИ (флешки, диски, носители) ──────────────────────────────────────
app.include_router(media_router.router,      prefix="/api/v1/media",
                   tags=["Учёт МНИ"])

# ─── Отдел проф. подготовки (тестирование) ───────────────────────────────────
app.include_router(training_router.router,   prefix="/api/v1/training",
                   tags=["Проф. подготовка"])


# ─── Статика ──────────────────────────────────────────────────────────────────

# CSS bundle: 21 отдельный <link> в index.html → один HTTP-запрос.
# В локальной сети без интернета каждый round-trip заметен; склейка
# делается один раз при старте сервера, дальше отдаётся из памяти.
# Маршрут объявлен ДО app.mount("/static") — иначе StaticFiles попробует
# найти bundle.css на диске и вернёт 404.
from pathlib import Path
from fastapi import Response

_CSS_BUNDLE_ORDER = [
    "tokens.css",       "layout.css",         "components.css",
    "login.css",        "editor.css",         "overview.css",
    "dashboard.css",    "duty.css",           "schedule.css",
    "department.css",   "persons.css",        "users.css",
    "audit.css",        "event-editor.css",   "history-calendar.css",
    "operations.css",   "comms-report.css",   "procurement.css",
    "media.css",        "training.css",       "person_conflicts.css",
]

def _build_css_bundle() -> str:
    base = Path(__file__).resolve().parent.parent / "static" / "css"
    parts: list[str] = []
    for name in _CSS_BUNDLE_ORDER:
        path = base / name
        if path.exists():
            parts.append(f"\n/* ===== {name} ===== */\n")
            parts.append(path.read_text(encoding="utf-8"))
    return "".join(parts)

_CSS_BUNDLE = _build_css_bundle()

@app.get("/css-bundle.css", include_in_schema=False)
async def css_bundle():
    # Путь вне /static/ — иначе app.mount("/static", StaticFiles(...))
    # перехватывает запрос и пытается найти файл на диске → 404.
    # Cache-Control: бандл собирается при старте сервера и не меняется
    # до перезапуска — браузер может смело кэшировать его на сутки.
    # При изменении CSS перезапусти бэк, и пользователи получат свежий
    # файл (URL тот же, но Last-Modified / содержимое отличаются — браузер
    # перепроверит после max-age).
    return Response(
        content=_CSS_BUNDLE,
        media_type="text/css; charset=utf-8",
        headers={"Cache-Control": "public, max-age=86400"},
    )


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=RedirectResponse, include_in_schema=False)
async def read_root():
    return RedirectResponse(url="/static/index.html")


# ─── Публичная страница для прохождения тестирования ─────────────────────────
# Открывается по QR-коду или прямой ссылке вида /training/{token}.
# Эта страница без авторизации — токен сам является ключом доступа.
# Файл лежит в static/training.html и грузит данные через /api/v1/training/public/...
@app.get("/training/{token}", include_in_schema=False)
async def training_public_page(token: str):
    return FileResponse("static/training.html")


# ─── WebSocket ────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await handle_websocket_connection(websocket)