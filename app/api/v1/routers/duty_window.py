# app/api/v1/routers/duty_window.py
"""
Эндпоинт статуса окна подачи графиков нарядов.

Открыто/закрыто, ближайшие границы — для виджета на дашборде и баннера на
странице графиков управлений. Доступно любому аутентифицированному.
"""

from fastapi import APIRouter, Depends

from app.api.dependencies import get_current_user
from app.core.duty_window import get_window_status
from app.models.user import User

router = APIRouter()


@router.get("/window-status", summary="Текущий статус окна подачи графиков нарядов")
def read_window_status(_user: User = Depends(get_current_user)):
    return get_window_status()
