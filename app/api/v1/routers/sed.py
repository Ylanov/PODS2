# app/api/v1/routers/sed.py
"""
Дайджест СЭД (sed.mchs.ru) — pods2-сторона.

Браузерное расширение, установленное у пользователя c permission'ом
'sed_inbox', парсит DOM страниц СЭД и POST'ит сюда дайджест. UI
читает GET и рисует кнопку «Почта» в шапке pods2.

Контракт «дайджеста»:
  {
    "sections": [
      {
        "key":   "decision_delegate",
        "title": "На рассмотрение",
        "url":   "/decision/delegate",
        "count": 13,
        "items": [
          {
            "node_id": 227846833,
            "title":   "Протокол от 09.05.2026 № ОДС-129",
            "files": [
              { "name": "Протокол от 09.05.2026 № ОДС-129.pdf",
                "url":  "https://sed.mchs.ru/systems3/files/.../Протокол.pdf" }
            ],
            "actions": []
          }
        ]
      }
    ]
  }

Permission «sed_inbox» защищает оба эндпоинта; require_permission
автоматически пропускает админа без явного permission'а.
"""

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user, require_permission
from app.core.websockets import manager
from app.db.database import get_db
from app.models.sed_inbox import SedInboxSnapshot
from app.models.user import User


router = APIRouter(dependencies=[Depends(require_permission("sed_inbox"))])


# ─── Pydantic-схемы ──────────────────────────────────────────────────────────

class SedFileRef(BaseModel):
    name: str = Field(..., max_length=500)
    url:  str = Field(..., max_length=2000)


class SedAction(BaseModel):
    """Опционально: ссылки вида /modal/delegate/node/{id} — пока не используем."""
    kind: str = Field(..., max_length=50)
    url:  str = Field(..., max_length=2000)


class SedItem(BaseModel):
    node_id: int
    title:   str = Field(..., max_length=2000)
    files:   List[SedFileRef] = []
    actions: List[SedAction]  = []


class SedSection(BaseModel):
    key:   str = Field(..., max_length=100)
    title: str = Field(..., max_length=200)
    url:   str = Field(..., max_length=500)
    count: int = 0
    items: List[SedItem] = []


class SedSnapshotIn(BaseModel):
    sections: List[SedSection]


class SedSnapshotOut(BaseModel):
    taken_at: datetime
    sections: List[SedSection]
    total:    int   # сумма count по секциям — кеш для бейджа

    model_config = ConfigDict(from_attributes=True)


# ─── Эндпоинты ──────────────────────────────────────────────────────────────

@router.get("/snapshot", response_model=Optional[SedSnapshotOut],
            summary="Текущий снимок СЭД-дайджеста")
def get_snapshot(
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Возвращает свежий снимок текущего пользователя или null если ещё нет."""
    row = (
        db.query(SedInboxSnapshot)
        .filter(SedInboxSnapshot.user_id == current_user.id)
        .first()
    )
    if not row:
        return None
    sections = row.get_sections()
    total = sum(int(s.get("count") or 0) for s in sections)
    return SedSnapshotOut(
        taken_at=row.taken_at,
        sections=sections,
        total=total,
    )


@router.post("/snapshot", response_model=SedSnapshotOut, status_code=200,
             summary="Сохранить дайджест от расширения (UPSERT по user)")
async def upsert_snapshot(
    payload:      SedSnapshotIn,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    UPSERT: один снимок на пользователя. Расширение шлёт периодически —
    мы заменяем предыдущий, не плодим историю.
    """
    sections_payload = [s.model_dump() for s in payload.sections]

    row = (
        db.query(SedInboxSnapshot)
        .filter(SedInboxSnapshot.user_id == current_user.id)
        .first()
    )
    if row is None:
        row = SedInboxSnapshot(user_id=current_user.id)
        db.add(row)

    row.set_sections(sections_payload)
    row.taken_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)

    total = sum(int(s.get("count") or 0) for s in sections_payload)

    # Кидаем юзеру по WS — UI обновит бейдж без F5.
    try:
        await manager.push_to_user(current_user.id, {
            "action": "sed_snapshot_updated",
            "total":  total,
        })
    except Exception:
        # WS не критичен — основной поток должен ответить даже если push упал
        pass

    return SedSnapshotOut(
        taken_at=row.taken_at,
        sections=sections_payload,
        total=total,
    )


@router.delete("/snapshot", status_code=204,
               summary="Удалить снимок пользователя (например, при logout)")
def delete_snapshot(
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    db.query(SedInboxSnapshot).filter(
        SedInboxSnapshot.user_id == current_user.id
    ).delete(synchronize_session=False)
    db.commit()
