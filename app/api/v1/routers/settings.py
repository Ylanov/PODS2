# app/api/v1/routers/settings.py

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from app.db.database import get_db
from app.models.setting import Setting
from app.models.user import User
from app.api.dependencies import get_current_active_admin, get_current_user

router = APIRouter()

# Ключи которые разрешены для изменения через API.
# Группа print_* используется для шапки/подписи в распечатке графиков
# нарядов (см. js/duty_ui.js → updatePrintCover).
ALLOWED_KEYS = {
    "duty_rank", "duty_name", "duty_title", "org_name",
    "print_approve_position", "print_approve_rank", "print_approve_name",
    "print_footer_position",  "print_footer_rank",  "print_footer_name",
}

# Значения по умолчанию — используются если ключ ещё не сохранён в БД
DEFAULTS = {
    "duty_title": "Оперативный дежурный",
    "duty_rank":  "",
    "duty_name":  "",
    "org_name":   "ФГКУ «ЦСООР «Лидер»",
    "print_approve_position": "Начальник штаба ФГКУ «ЦСООР «Лидер»",
    "print_approve_rank":     "полковник",
    "print_approve_name":     "А.А. Шевченко",
    "print_footer_position":  "Начальник отдела (связи, автоматизированных систем управления и телекоммуникаций)",
    "print_footer_rank":      "подполковник",
    "print_footer_name":      "С.А. Цауменко",
}


class SettingUpdate(BaseModel):
    duty_rank:  Optional[str] = None
    duty_name:  Optional[str] = None
    duty_title: Optional[str] = None
    org_name:   Optional[str] = None
    print_approve_position: Optional[str] = None
    print_approve_rank:     Optional[str] = None
    print_approve_name:     Optional[str] = None
    print_footer_position:  Optional[str] = None
    print_footer_rank:      Optional[str] = None
    print_footer_name:      Optional[str] = None


def get_setting(db: Session, key: str) -> str:
    """Получить значение настройки. Возвращает дефолт если ключ не найден."""
    row = db.query(Setting).filter(Setting.key == key).first()
    if row is None:
        return DEFAULTS.get(key, "")
    return row.value or ""


def set_setting(db: Session, key: str, value: str) -> None:
    """Сохранить или обновить настройку."""
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))


@router.get(
    "",
    summary="Получить текущие настройки (дежурный и реквизиты)",
)
def get_settings(
        db:           Session = Depends(get_db),
        # Доступно всем авторизованным: print_* нужны фронту для печати
        # графиков любому юзеру, а не только admin'у. Изменения остаются
        # admin-only через PATCH.
        current_user: User    = Depends(get_current_user),
):
    return {key: get_setting(db, key) for key in ALLOWED_KEYS}


@router.patch(
    "",
    summary="Обновить настройки",
)
def update_settings(
        payload:       SettingUpdate,
        db:            Session = Depends(get_db),
        current_admin: User    = Depends(get_current_active_admin),
):
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        if key in ALLOWED_KEYS:
            set_setting(db, key, value or "")
    db.commit()
    return {key: get_setting(db, key) for key in ALLOWED_KEYS}