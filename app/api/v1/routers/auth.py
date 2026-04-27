# app/api/v1/routers/auth.py

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.user import User
from app.core.config import settings
from app.core.limiter import limiter
from app.core.security import verify_password, create_access_token
from app.schemas.token import Token
from app.api.dependencies import get_current_user

router = APIRouter()


@router.post("/login", response_model=Token, summary="Получить JWT-токен")
# Rate limit per-IP. Лимит берётся из settings, чтобы можно было
# регулировать через .env без пересборки. Request обязателен — SlowAPI
# читает его для получения IP.
@limiter.limit(lambda: settings.LOGIN_RATE_LIMIT)
def login_access_token(
    request: Request,
    db: Session = Depends(get_db),
    form_data: OAuth2PasswordRequestForm = Depends(),
):
    user = db.query(User).filter(User.username == form_data.username).first()

    # БАГ-ФИКС: статус 400 заменён на 401 — это стандарт OAuth2 / RFC 6750.
    # Фронтенд и сторонние клиенты ожидают именно 401 при неверных credentials.
    # Заголовок WWW-Authenticate обязателен при 401 по спецификации HTTP.
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный логин или пароль",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Намеренно не проверяем is_active здесь — деактивированный пользователь
    # получит токен, но get_current_user в dependencies.py отклонит каждый запрос.
    # Это стандартная практика: не раскрывать причину отказа на этапе логина.

    return {
        "access_token": create_access_token(user.id),
        "token_type": "bearer",
    }


@router.get("/me", response_model=dict, summary="Получить данные текущего пользователя")
def read_users_me(current_user: User = Depends(get_current_user)):
    # Admin всегда видит всё — возвращаем полный набор независимо от записи в БД.
    # Department — то что реально разрешил админ (из users.permissions).
    from app.models.user import AVAILABLE_PERMISSIONS, DEFAULT_PERMISSIONS

    if current_user.role == "admin":
        permissions = list(AVAILABLE_PERMISSIONS)
    else:
        # permissions хранится как JSONB — SQLAlchemy возвращает Python list
        permissions = current_user.permissions or DEFAULT_PERMISSIONS

    return {
        "id":                current_user.id,
        "username":          current_user.username,
        "role":              current_user.role,
        "permissions":       permissions,
        "available_modules": _available_modules(current_user),
    }


def _available_modules(user: User) -> list[str]:
    """
    Возвращает список идентификаторов модулей-операций, доступных юзеру.

    Источник истины — поле users.modules (JSONB-массив). Админ выставляет
    его через UI («Пользователи» → «Модули отдела»). Если поле NULL —
    значит для этого юзера модули не настроены, и он не видит ничего;
    админ должен явно проставить нужный набор.

    Admin всегда видит все модули — это нужно для отладки и единого
    формата ответа /auth/me.
    """
    from app.models.user import AVAILABLE_MODULES
    if user.role == "admin":
        return list(AVAILABLE_MODULES)
    if user.role != "unit":
        return []
    raw = user.modules
    if not isinstance(raw, list):
        return []
    # Валидируем по whitelist (на случай если в БД остались устаревшие id)
    return [m for m in raw if m in AVAILABLE_MODULES]