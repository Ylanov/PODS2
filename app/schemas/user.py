# app/schemas/user.py
#
# БАГ-ФИКС: ранее UserBase/UserCreate/UserResponse были в token.py с комментарием
# "# app/schemas/user.py" — файл был разделён, но схемы так и остались в неправильном месте.
# Теперь каждая схема в своём файле по назначению.
#
from pydantic import BaseModel, ConfigDict


class UserBase(BaseModel):
    username: str


class UserCreate(UserBase):
    password: str


class UserResponse(UserBase):
    id: int
    role: str
    is_active: bool

    model_config = ConfigDict(from_attributes=True)