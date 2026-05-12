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

import hashlib
import io
import logging
import os
import re
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile,
)
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.dependencies import (
    get_current_active_admin, get_current_user, require_permission,
)
from app.core.config import settings
from app.core.limiter import limiter
from app.core.websockets import manager
from app.db.database import get_db
from app.models.sed_file import SedFileBlob
from app.models.sed_inbox import SedInboxSnapshot, SedLetter
from app.models.user import User


logger = logging.getLogger(__name__)


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
    # Заполняется сервером в GET /letter (через JOIN с sed_file_blobs);
    # расширение шлёт без них при POST /letter.
    local_id: Optional[int] = None
    status:   Optional[str] = None   # pending / ok / failed / None (нет записи)


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
        files=_files_with_blob_info(db, current_user.id, row.get_files()),
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
        files=_files_with_blob_info(db, current_user.id, row.get_files()),
        fetched_at=row.fetched_at,
    )


# ─── Helpers для файлов СЭД ─────────────────────────────────────────────────

_SAFE_NAME_RE = re.compile(r"[\\/:*?\"<>|\r\n\t]+")


def _files_with_blob_info(db: Session, user_id: int, raw_files: list[dict]) -> list[SedLetterFile]:
    """
    Обогащает массив файлов (как они лежат в sed_letters.files_json)
    полями local_id/status из таблицы sed_file_blobs — UI потом решает:
    качать с pods2 (если status='ok') или открыть СЭД (fallback).
    """
    if not raw_files:
        return []
    urls = [f.get("url") for f in raw_files if f.get("url")]
    blobs = {}
    if urls:
        rows = (
            db.query(SedFileBlob.id, SedFileBlob.sed_url, SedFileBlob.status)
            .filter(
                SedFileBlob.user_id == user_id,
                SedFileBlob.sed_url.in_(urls),
            )
            .all()
        )
        blobs = {r.sed_url: (r.id, r.status) for r in rows}
    out: list[SedLetterFile] = []
    for f in raw_files:
        url = f.get("url") or ""
        info = blobs.get(url)
        out.append(SedLetterFile(
            name=f.get("name") or "Файл",
            url=url,
            size=f.get("size"),
            mime=f.get("mime"),
            local_id=info[0] if info else None,
            status=info[1] if info else None,
        ))
    return out


def _blob_disk_path(user_id: int, sha256: str) -> Path:
    """
    Возвращает абсолютный путь к blob'у на диске:
    {SED_FILES_DIR}/{user_id}/{sha256[:2]}/{sha256[2:]}.bin

    Шардируем по первым двум hex-символам — иначе при N>10к файлов
    у одного юзера директория с тысячами файлов тормозит ls/sync.
    """
    if not sha256 or len(sha256) < 4:
        raise ValueError("sha256 должен быть hex(64)")
    return (
        Path(settings.SED_FILES_DIR)
        / str(user_id)
        / sha256[:2]
        / f"{sha256[2:]}.bin"
    )


def _sanitize_download_name(raw: str) -> str:
    """Чистка имени для Content-Disposition: убираем разделители путей и пр."""
    s = _SAFE_NAME_RE.sub("_", (raw or "").strip())
    s = s.strip(". ")
    return s[:200] or "file"


# ─── Pydantic-схемы для файлов ─────────────────────────────────────────────

class SedFileUploadOut(BaseModel):
    id:       int
    name:     str
    size:     int
    status:   str
    sha256:   Optional[str] = None
    mime:     Optional[str] = None
    cached:   bool = False   # True если запись уже была со status=ok, файл не перезаписывали


class SedFileFailedIn(BaseModel):
    sed_url: str = Field(..., max_length=2000)
    name:    str = Field(default="file", max_length=500)
    error:   str = Field(default="", max_length=500)


class SedFileStatusOut(BaseModel):
    sed_url:  str
    local_id: Optional[int] = None
    status:   Optional[str] = None
    attempts: int = 0
    size:     int = 0


# ─── Эндпоинты файлов ──────────────────────────────────────────────────────

@router.post("/file", response_model=SedFileUploadOut,
             summary="Сохранить бинарный файл СЭД на pods2 (от расширения)")
@limiter.limit(lambda: settings.SED_FILE_UPLOAD_RATE_LIMIT)
async def upload_file(
    request:      Request,
    sed_url:      str           = Form(..., max_length=2000),
    name:         str           = Form(..., max_length=500),
    file:         UploadFile    = File(...),
    db:           Session       = Depends(get_db),
    current_user: User          = Depends(get_current_user),
):
    """
    Принимает blob от расширения (которое скачало файл из СЭД через свою
    cookie-сессию). Лимит SED_FILE_MAX_SIZE (20 МБ по умолчанию).

    Идемпотентность: если запись (user_id, sed_url) уже есть со status=ok —
    возвращаем существующий id без перезаписи (расширение само дедуплицирует
    по своему cache, но дополнительная страховка на случай гонок).
    """
    if not sed_url.lower().startswith(("https://sed.mchs.ru/", "http://sed.mchs.ru/")):
        raise HTTPException(400, "sed_url должен быть на sed.mchs.ru")

    # Читаем blob в память (для sha256 + диска). Для 20МБ это OK.
    blob_bytes = await file.read()
    if not blob_bytes:
        raise HTTPException(400, "Пустой файл")
    if len(blob_bytes) > settings.SED_FILE_MAX_SIZE:
        raise HTTPException(
            413,
            f"Файл больше {settings.SED_FILE_MAX_SIZE // (1024*1024)} МБ "
            "— такие большие не кешируем.",
        )

    sha = hashlib.sha256(blob_bytes).hexdigest()
    mime = file.content_type or "application/octet-stream"
    safe_name = _sanitize_download_name(name)

    existing = (
        db.query(SedFileBlob)
        .filter(
            SedFileBlob.user_id == current_user.id,
            SedFileBlob.sed_url == sed_url,
        )
        .first()
    )
    cached = False
    if existing and existing.status == "ok" and existing.sha256 == sha:
        # Тот же файл уже есть — ничего не делаем, возвращаем id.
        cached = True
        return SedFileUploadOut(
            id=existing.id, name=existing.name, size=existing.size,
            status=existing.status, sha256=existing.sha256,
            mime=existing.mime, cached=True,
        )

    # Пишем на диск (атомарно — сначала во временный, потом mv).
    disk_path = _blob_disk_path(current_user.id, sha)
    disk_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = disk_path.with_suffix(".tmp")
    try:
        with open(tmp_path, "wb") as f:
            f.write(blob_bytes)
        os.replace(tmp_path, disk_path)
    except OSError as exc:
        logger.exception("Запись blob'а на диск упала: %s", exc)
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(500, f"Не удалось записать файл на диск: {exc}")

    now = datetime.now(timezone.utc)
    if existing is None:
        existing = SedFileBlob(
            user_id=current_user.id, sed_url=sed_url,
        )
        db.add(existing)
    existing.name           = safe_name
    existing.mime           = mime[:120]
    existing.size           = len(blob_bytes)
    existing.sha256         = sha
    existing.status         = "ok"
    existing.attempts       = (existing.attempts or 0) + 1
    existing.error          = None
    existing.last_attempt_at = now
    existing.fetched_at     = now
    db.commit()
    db.refresh(existing)

    return SedFileUploadOut(
        id=existing.id, name=existing.name, size=existing.size,
        status=existing.status, sha256=existing.sha256,
        mime=existing.mime, cached=cached,
    )


@router.post("/file/failed", response_model=SedFileStatusOut,
             summary="Зафиксировать неудачную попытку скачивания файла")
@limiter.limit(lambda: settings.SED_FILE_UPLOAD_RATE_LIMIT)
def mark_file_failed(
    request:      Request,
    payload:      SedFileFailedIn,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Расширение сообщает что качнуть не удалось (404/timeout/etc).
    Увеличиваем attempts, ставим status='failed' если превысили MAX_ATTEMPTS.
    """
    row = (
        db.query(SedFileBlob)
        .filter(
            SedFileBlob.user_id == current_user.id,
            SedFileBlob.sed_url == payload.sed_url,
        )
        .first()
    )
    now = datetime.now(timezone.utc)
    if row is None:
        row = SedFileBlob(
            user_id=current_user.id,
            sed_url=payload.sed_url,
            name=_sanitize_download_name(payload.name),
            status="pending",
            attempts=1,
            error=(payload.error or "")[:500],
            last_attempt_at=now,
        )
        db.add(row)
    else:
        row.attempts        = (row.attempts or 0) + 1
        row.error           = (payload.error or "")[:500]
        row.last_attempt_at = now
        # status='ok' не сбиваем — если раньше успешно скачался, новая ошибка
        # не должна стирать существующий blob (расширение могло перепутать).
        if row.status != "ok":
            row.status = (
                "failed"
                if row.attempts >= settings.SED_FILE_MAX_ATTEMPTS
                else "pending"
            )
    db.commit()
    db.refresh(row)
    return SedFileStatusOut(
        sed_url=row.sed_url, local_id=row.id,
        status=row.status, attempts=row.attempts, size=row.size,
    )


@router.get("/file/by-urls", response_model=list[SedFileStatusOut],
            summary="Узнать статусы файлов по списку URL (для расширения)")
def get_files_by_urls(
    urls:         str   = "",   # CSV в query string — у расширения ≤30 URL за тик
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Расширение перед циклом загрузки проверяет: что уже есть в pods2 (status=ok
    или failed с attempts>=MAX) — не качаем повторно. status=pending — пробуем
    снова.
    """
    if not urls.strip():
        return []
    url_list = [u.strip() for u in urls.split("\n") if u.strip()][:60]
    if not url_list:
        return []
    rows = (
        db.query(SedFileBlob)
        .filter(
            SedFileBlob.user_id == current_user.id,
            SedFileBlob.sed_url.in_(url_list),
        )
        .all()
    )
    return [
        SedFileStatusOut(
            sed_url=r.sed_url, local_id=r.id, status=r.status,
            attempts=r.attempts, size=r.size,
        )
        for r in rows
    ]


@router.get("/file/{file_id}",
            summary="Скачать кешированный файл по id")
@limiter.limit(lambda: settings.SED_FILE_DOWNLOAD_RATE_LIMIT)
def download_file(
    request:      Request,
    file_id:      int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Стрим бинарника с диска. Только владельцу записи (user_id == current).
    Content-Disposition: attachment — браузер всегда сохраняет, не открывает
    в pdf-viewer. Имя берётся из БД (уже санитизированное).
    """
    row = (
        db.query(SedFileBlob)
        .filter(SedFileBlob.id == file_id)
        .first()
    )
    if not row or row.user_id != current_user.id:
        raise HTTPException(404, "Файл не найден")
    if row.status != "ok" or not row.sha256:
        raise HTTPException(
            409,
            f"Файл ещё не закеширован (status={row.status}). "
            "Подождите следующей синхронизации расширения.",
        )
    disk_path = _blob_disk_path(row.user_id, row.sha256)
    if not disk_path.exists():
        # БД говорит ok, но файла нет на диске — пометим как failed чтобы
        # расширение перекачало.
        row.status = "pending"
        row.error  = "Файл потерян на диске"
        db.commit()
        raise HTTPException(
            410, "Файл потерян на диске. Запросим перекачать у расширения.",
        )
    safe = _sanitize_download_name(row.name)
    # quote для RFC5987 в filename* — иначе кириллица в имени файла ломается
    # в некоторых браузерах. Простой filename= оставляем для совместимости.
    from urllib.parse import quote
    cd = (
        f'attachment; filename="{safe.encode("ascii", "replace").decode()}"; '
        f"filename*=UTF-8''{quote(safe)}"
    )
    return FileResponse(
        path=str(disk_path),
        media_type=row.mime or "application/octet-stream",
        headers={
            "Content-Disposition": cd,
            "Content-Length":      str(row.size),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/file/cleanup",
             summary="Удалить старые blob'ы старше retention (только админ)")
def cleanup_old_files(
    db:    Session = Depends(get_db),
    admin: User    = Depends(get_current_active_admin),
):
    """
    GC: blobs с fetched_at старше SED_FILE_RETENTION_DAYS — удаляем запись
    из БД и файл с диска. Возвращаем сколько было удалено.
    Запускать вручную или из cron'а раз в сутки.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.SED_FILE_RETENTION_DAYS)
    rows = (
        db.query(SedFileBlob)
        .filter(SedFileBlob.fetched_at.isnot(None))
        .filter(SedFileBlob.fetched_at < cutoff)
        .all()
    )
    removed_disk = 0
    removed_db   = 0
    for r in rows:
        if r.sha256:
            try:
                _blob_disk_path(r.user_id, r.sha256).unlink(missing_ok=True)
                removed_disk += 1
            except Exception:
                logger.exception("cleanup: не удалось удалить blob %s", r.id)
        db.delete(r)
        removed_db += 1
    db.commit()
    return {
        "removed_db":   removed_db,
        "removed_disk": removed_disk,
        "cutoff_iso":   cutoff.isoformat(),
        "retention_days": settings.SED_FILE_RETENTION_DAYS,
    }


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
