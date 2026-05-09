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

import json
from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, Text, DateTime, ForeignKey, UniqueConstraint,
)
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
    # JSON-список секций: [{key,title,url,count,items:[{node_id,title,
    # files:[{name,url}], actions:[{kind,url}]}]}]
    sections_json = Column(Text, nullable=False, default="[]")

    user = relationship("User")

    __table_args__ = (
        # Один свежий снимок на пользователя — POST upsert'ит, не плодит
        # историю. Если позже понадобится история — снимем уникальность
        # и добавим index на (user_id, taken_at DESC).
        UniqueConstraint("user_id", name="uq_sed_inbox_snapshots_user"),
    )

    def get_sections(self) -> list[dict]:
        try:
            data = json.loads(self.sections_json or "[]")
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, ValueError):
            return []

    def set_sections(self, sections: list[dict]) -> None:
        self.sections_json = json.dumps(sections, ensure_ascii=False)
