# app/api/dependencies.py

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.database import get_db
from app.models.user import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def get_current_user(
    db: Session = Depends(get_db),
    token: str = Depends(oauth2_scheme),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        raw_sub: str | None = payload.get("sub")
        if raw_sub is None:
            raise credentials_exception

        # БАГ-ФИКС: sub в JWT — строка, User.id — integer.
        # Раньше SQLAlchemy молча приводил тип, но crafted-токен с нечисловым sub
        # (например, sub="1 OR 1=1") мог вызвать неожиданное поведение.
        # Явный int() с перехватом ValueError закрывает этот вектор.
        try:
            user_id = int(raw_sub)
        except ValueError:
            raise credentials_exception

    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise credentials_exception

    # Проверяем что аккаунт активен — без этого деактивированные пользователи
    # продолжали работать до истечения токена
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Аккаунт деактивирован",
        )

    return user


def get_current_active_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Недостаточно прав. Только для Админа.",
        )
    return current_user


def require_permission(permission: str):
    """
    Фабрика зависимостей для проверки доступа к конкретной вкладке.

    Использование:
        router = APIRouter(dependencies=[Depends(require_permission("persons"))])
        или точечно на handler:
        def handler(user: User = Depends(require_permission("persons"))): ...

    Логика:
        admin — пропускается всегда (полный доступ);
        department — permission должно быть в user.permissions;
        иначе — 403.

    Защищает backend от обхода UI-ограничений: пользователь мог узнать
    URL из devtools и дёргать API напрямую. Без этой проверки скрытие
    кнопки в UI — только косметика.
    """
    def _check(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role == "admin":
            return current_user
        user_perms = current_user.permissions or []
        if permission not in user_perms:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"У вас нет доступа к разделу '{permission}'",
            )
        return current_user

    return _check