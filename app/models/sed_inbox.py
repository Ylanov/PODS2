# app/models/sed_inbox.py
"""
СЭД-дайджест (sed.mchs.ru).

Браузерное расширение, установленное у пользователя с permission'ом
'sed_inbox', парсит DOM страниц СЭД (Drupal 7 + Views), формирует
JSON-дайджест и POST'ит его в pods2. На бэке — один свежий снимок
на пользователя (UPSERT по user_id). UI читает снимок и показывает
кнопку «Почта» с бейджем + выпадающую панель с разделами.

Не храним: тела документов, файлы, медиа. Только метаданные:
заголовки, node-ID, имена + URL прикреплённых файлов (ссылки
открывает браузер пользователя сам, когда тот в МЧС-сети — pods2
файлы не проксирует и не кеширует).
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, Text, DateTime, ForeignKey, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.db.database import Base


class SedInboxSnapshot(Base):
    """Один снимок СЭД-дайджеста на пользователя."""

    __tablename__ = "sed_inbox_snapshots"

    id            = Column(Integer, primary_key=True, index=True)
    user_id       = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    taken_at      = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    # JSONB-список секций: [{key,title,url,count,items:[{node_id,title,
    # files:[{name,url}], actions:[{kind,url}]}]}]
    sections_json = Column(JSONB, nullable=False, default=list)

    user = relationship("User")

    __table_args__ = (
        # Один свежий снимок на пользователя — POST upsert'ит, не плодит
        # историю. Если позже понадобится история — снимем уникальность
        # и добавим index на (user_id, taken_at DESC).
        UniqueConstraint("user_id", name="uq_sed_inbox_snapshots_user"),
    )

    def get_sections(self) -> list[dict]:
        data = self.sections_json
        return data if isinstance(data, list) else []

    def set_sections(self, sections: list[dict]) -> None:
        self.sections_json = sections or []


class SedLetter(Base):
    """
    Полное письмо/документ из СЭД, сохранённое в pods2 для офлайн-просмотра.

    Расширение, у которого есть cookie-сессия СЭД, скачивает страницу
    /node/{N}, парсит body+meta и POST'ит сюда. Pods2 кеширует на (user, node_id)
    — переоткрытие письма потом не дёргает СЭД, всё уже в БД.

    body_html — содержимое письма после очистки от workflow-кнопок.
    Никаких ссылок «делегировать», «расписать», «ознакомлен» там быть не
    должно — это требование пользователя (только просмотр и скачивание).

    files_json — массив {name, url, size?, mime?} с URL'ами на sed.mchs.ru.
    Сами файлы пока НЕ скачиваются (этап 2 — отдельный коммит).
    """

    __tablename__ = "sed_letters"

    id        = Column(Integer, primary_key=True, index=True)
    user_id   = Column(
        Integer,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    node_id   = Column(Integer, nullable=False, index=True)
    title     = Column(Text,    nullable=False)
    body_html = Column(Text,    nullable=False, default="")
    # Структурированные поля: vid_dokumenta, srochnost, status, nomer_data,
    # adresat, ispolnitel, podpisant, kol_listov, etc. (плоский dict).
    meta_json  = Column(JSONB, nullable=False, default=dict)
    # Массив {name, url, size, mime}
    files_json = Column(JSONB, nullable=False, default=list)
    # ISO-время взятия с СЭД (для UI «обновлено N минут назад»)
    fetched_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    user = relationship("User")

    __table_args__ = (
        # Один node на пользователя — повторный POST с тем же node_id
        # обновляет существующую запись.
        UniqueConstraint("user_id", "node_id", name="uq_sed_letters_user_node"),
    )

    def get_meta(self) -> dict:
        data = self.meta_json
        return data if isinstance(data, dict) else {}

    def set_meta(self, meta: dict) -> None:
        self.meta_json = meta or {}

    def get_files(self) -> list[dict]:
        data = self.files_json
        return data if isinstance(data, list) else []

    def set_files(self, files: list[dict]) -> None:
        self.files_json = files or []
