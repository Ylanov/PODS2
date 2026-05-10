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

import io
import os
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user, require_permission
from app.core.config import settings
from app.core.limiter import limiter
from app.core.websockets import manager
from app.db.database import get_db
from app.models.sed_inbox import SedInboxSnapshot, SedLetter
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
@limiter.limit(lambda: settings.SED_SNAPSHOT_RATE_LIMIT)
async def upsert_snapshot(
    request:      Request,
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


# ─── Письма (тело + метаданные, кеш в pods2) ─────────────────────────────

class SedLetterFile(BaseModel):
    name: str = Field(..., max_length=500)
    url:  str = Field(..., max_length=2000)
    size: Optional[int] = None
    mime: Optional[str] = Field(default=None, max_length=120)


class SedLetterIn(BaseModel):
    """Что присылает расширение после парсинга /node/{N}."""
    node_id:    int = Field(..., gt=0)
    title:      str = Field(..., max_length=2000)
    body_html:  str = Field(default="", max_length=500_000)   # 500KB на письмо хватит с запасом
    meta:       dict = Field(default_factory=dict)
    files:      list[SedLetterFile] = []


class SedLetterOut(BaseModel):
    node_id:    int
    title:      str
    body_html:  str
    meta:       dict
    files:      list[SedLetterFile]
    fetched_at: datetime

    model_config = ConfigDict(from_attributes=True)


@router.post("/letter", response_model=SedLetterOut, status_code=200,
             summary="Сохранить полное письмо от расширения (UPSERT по user+node)")
@limiter.limit(lambda: settings.SED_LETTER_RATE_LIMIT)
def upsert_letter(
    request:      Request,
    payload:      SedLetterIn,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Расширение по cookie-сессии скачивает /node/{N}, парсит, шлёт сюда.
    Pods2 кеширует — в UI письмо открывается из БД, без перехода в СЭД.

    Важно: тело уже очищено расширением от workflow-кнопок (делегировать,
    ознакомлен, расписать, и т.п.). На бэке доп. санитизация — на уровне
    исключительно нежелательного — уже не нужна, отдаём фронту что есть.
    """
    row = (
        db.query(SedLetter)
        .filter(
            SedLetter.user_id == current_user.id,
            SedLetter.node_id == payload.node_id,
        )
        .first()
    )
    if row is None:
        row = SedLetter(user_id=current_user.id, node_id=payload.node_id)
        db.add(row)

    row.title     = payload.title
    row.body_html = payload.body_html
    row.set_meta(payload.meta)
    row.set_files([f.model_dump() for f in payload.files])
    row.fetched_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)

    return SedLetterOut(
        node_id=row.node_id,
        title=row.title,
        body_html=row.body_html,
        meta=row.get_meta(),
        files=[SedLetterFile(**f) for f in row.get_files()],
        fetched_at=row.fetched_at,
    )


@router.get("/letter/{node_id}", response_model=SedLetterOut,
            summary="Получить кешированное письмо по node_id")
def get_letter(
    node_id:      int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    row = (
        db.query(SedLetter)
        .filter(
            SedLetter.user_id == current_user.id,
            SedLetter.node_id == node_id,
        )
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail="Письмо ещё не было загружено расширением. "
                   "Откройте СЭД и подождите следующей синхронизации.",
        )
    return SedLetterOut(
        node_id=row.node_id,
        title=row.title,
        body_html=row.body_html,
        meta=row.get_meta(),
        files=[SedLetterFile(**f) for f in row.get_files()],
        fetched_at=row.fetched_at,
    )


# ─── Скачивание расширения (zip) ─────────────────────────────────────────────

# Каталог extension/sed-bridge/ относительно корня репо. В docker-образе
# код лежит в /code (см. Dockerfile WORKDIR), поэтому путь — /code/extension/...
_EXT_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent / "extension" / "sed-bridge"


@router.get("/bridge.zip",
            summary="Скачать ZIP расширения 'pods2 — мост СЭД'")
def download_extension_zip(
    _user: User = Depends(get_current_user),
):
    """
    Выдаёт ZIP с папкой sed-bridge — пользователь распаковывает локально и
    подгружает в браузере как «распакованное расширение». Permission уже
    проверен на уровне роутера (sed_inbox).
    """
    if not _EXT_DIR.exists() or not _EXT_DIR.is_dir():
        raise HTTPException(
            status_code=404,
            detail="Каталог расширения не найден на сервере. "
                   "Свяжитесь с администратором pods2.",
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(_EXT_DIR):
            for fname in files:
                fpath = Path(root) / fname
                # Внутри ZIP кладём с префиксом sed-bridge/, чтобы
                # пользователь распаковал именно папку, а не файлы
                # вразброс по диску.
                rel = Path("sed-bridge") / fpath.relative_to(_EXT_DIR)
                zf.write(fpath, arcname=str(rel))

    body = buf.getvalue()

    # Response с bytes (а не StreamingResponse) — Starlette автоматически
    # выставит Content-Length, без него Yandex Browser в редких случаях
    # обрывал загрузку из nginx-прокси с таймаутом «Загрузка прервана».
    return Response(
        content=body,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="sed-bridge.zip"',
            "Content-Length":      str(len(body)),
            "Cache-Control":       "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
