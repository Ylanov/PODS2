# app/api/v1/routers/certs.py
"""
Централизованное хранилище ключей и сертификатов КриптоПро.

Три набора эндпоинтов (три APIRouter, регистрируются с одним префиксом
/api/v1/certs в main.py):

  • admin_router  — управление ключами: загрузка, переназначение, отзыв.
                    Доступ — role=admin или permission="crypto_keys_admin".

  • user_router   — кабинет пользователя: посмотреть свои ключи, скачать
                    install-пакет агента. Permission="crypto_keys" или admin.

  • agent_router  — для агента на клиентской машине. Аутентификация —
                    отдельный долгоживущий токен (AgentToken), не JWT.
                    Эндпоинты: sync (манифест), container.zip / cert.cer
                    (бинари), heartbeat.

Бинари (контейнеры xxx.000 и .cer) хранятся в Vault. В БД (crypto_keys) —
только метаданные. См. app/services/vault_client.py и app/models/crypto_key.py.
"""

import hashlib
import io
import json
import logging
import re
import secrets
import zipfile
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import (
    APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status,
)
from fastapi.responses import Response, StreamingResponse
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.dependencies import (
    get_current_active_admin, get_current_user, oauth2_scheme,
    require_permission,
)
from app.core.config import settings
from app.core.limiter import limiter
from app.db.database import get_db
from app.models.crypto_key import AgentToken, CryptoKey
from app.models.user import User
from app.services.cert_parser import parse_certificate
from app.services.vault_client import storage


logger = logging.getLogger(__name__)


# Имена файлов в папке контейнера КриптоПро. Жёсткий whitelist — отвергаем
# всё лишнее, чтобы юзер не загрузил, например, executable под видом *.key.
_ALLOWED_CONTAINER_FILES = frozenset({
    "header.key", "masks.key", "masks2.key",
    "name.key", "primary.key", "primary2.key",
})
# Минимальный набор для жизнеспособного контейнера. masks2/primary2 опциональны
# у некоторых КриптоПро-версий — не делаем их обязательными.
_REQUIRED_CONTAINER_FILES = frozenset({
    "header.key", "masks.key", "name.key", "primary.key",
})

# Имя контейнера может содержать только безопасные символы — то что КриптоПро
# реально допускает. Используется в Content-Disposition и пути на клиенте,
# поэтому отсекаем shell-meta и слеши.
_CONTAINER_NAME_RE = re.compile(r"^[A-Za-zА-Яа-я0-9._\-() ]{1,200}$")


# ─── Pydantic-схемы ──────────────────────────────────────────────────────────

class CertParseOut(BaseModel):
    """Превью .cer — то что админ видит в форме загрузки до сохранения."""
    subject_cn:    Optional[str]
    subject_o:     Optional[str]
    subject_inn:   Optional[str]
    subject_snils: Optional[str]
    subject_ogrn:  Optional[str]
    issuer_cn:     Optional[str]
    serial_number: str
    valid_from:    datetime
    valid_to:      datetime
    thumbprint:    str
    algorithm:     str
    already_exists: bool                  = False
    existing_owner: Optional[str]         = None  # username владельца если есть


class CryptoKeyOut(BaseModel):
    """Запись из crypto_keys для UI (без бинарей)."""
    id:               int
    owner_user_id:    Optional[int]
    owner_username:   Optional[str]
    container_name:   str
    thumbprint:       str
    subject_cn:       Optional[str]
    subject_o:        Optional[str]
    subject_inn:      Optional[str]
    subject_snils:    Optional[str]
    issuer_cn:        Optional[str]
    serial_number:    Optional[str]
    valid_from:       datetime
    valid_to:         datetime
    status:           str
    purpose:          Optional[str]
    note:             Optional[str]
    uploaded_by_username: Optional[str]
    uploaded_at:      datetime
    updated_at:       datetime

    model_config = ConfigDict(from_attributes=True)


class CryptoKeyPatchIn(BaseModel):
    """Что разрешено менять админу через PATCH."""
    owner_user_id: Optional[int] = None
    purpose:       Optional[str] = None
    note:          Optional[str] = None
    status:        Optional[str] = None   # active | revoked


class AgentKeyEntry(BaseModel):
    """Одна запись в манифесте синхронизации для агента."""
    id:               int
    container_name:   str
    thumbprint:       str
    container_zip_url: str
    cert_url:         str
    valid_to:         datetime
    # ISO timestamp последней правки записи — агент использует для diff'а.
    updated_at:       datetime


class AgentSyncOut(BaseModel):
    keys:        List[AgentKeyEntry]
    server_time: datetime


class HeartbeatIn(BaseModel):
    synced_thumbprints:  List[str] = Field(default_factory=list)
    failed_thumbprints:  List[str] = Field(default_factory=list)
    agent_version:       str = "1.0"


class AgentTokenOut(BaseModel):
    """Запись токена для админки (без самого токена — только метаданные)."""
    id:           int
    user_id:      int
    username:     str
    description:  Optional[str]
    issued_at:    datetime
    expires_at:   datetime
    last_seen_at: Optional[datetime]
    last_seen_ip: Optional[str]
    revoked:      bool


# ─── Хелперы ──────────────────────────────────────────────────────────────────

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_out(key: CryptoKey) -> CryptoKeyOut:
    """SQLAlchemy → Pydantic с подгрузкой username'ов из relationships."""
    return CryptoKeyOut(
        id                   = key.id,
        owner_user_id        = key.owner_user_id,
        owner_username       = key.owner.username if key.owner else None,
        container_name       = key.container_name,
        thumbprint           = key.thumbprint,
        subject_cn           = key.subject_cn,
        subject_o            = key.subject_o,
        subject_inn          = key.subject_inn,
        subject_snils        = key.subject_snils,
        issuer_cn            = key.issuer_cn,
        serial_number        = key.serial_number,
        valid_from           = key.valid_from,
        valid_to             = key.valid_to,
        status               = key.status,
        purpose              = key.purpose,
        note                 = key.note,
        uploaded_by_username = key.uploaded_by.username if key.uploaded_by else None,
        uploaded_at          = key.uploaded_at,
        updated_at           = key.updated_at,
    )


async def _read_upload(upload: UploadFile, max_size: int, label: str) -> bytes:
    """Читаем UploadFile с защитой от слишком больших файлов."""
    data = await upload.read()
    if len(data) > max_size:
        raise HTTPException(
            status_code=413,
            detail=f"{label}: файл слишком большой ({len(data)} байт, лимит {max_size}).",
        )
    if not data:
        raise HTTPException(status_code=400, detail=f"{label}: пустой файл.")
    return data


def _sanitize_container_name(name: str) -> str:
    """
    Из имени папки/файла выделяем «чистое» имя контейнера. Пользователь может
    прислать "buh_2026.000", "buh_2026", "C:\\path\\buh_2026.000" — берём
    последний segment, убираем .000 (или другой числовой суффикс КриптоПро).
    """
    # Берём basename — отсекаем все слеши, даже виндовые.
    base = re.split(r"[\\/]", name.strip())[-1]
    # КриптоПро использует расширения .000, .001 и т.д. (счётчик дубликатов).
    base = re.sub(r"\.\d{3}$", "", base)
    if not _CONTAINER_NAME_RE.match(base):
        raise HTTPException(
            status_code=400,
            detail=f"Недопустимое имя контейнера: '{base}'. Разрешены буквы, цифры, _.-() и пробел.",
        )
    return base


def get_current_agent(
    request: Request,
    db: Session = Depends(get_db),
    token: str  = Depends(oauth2_scheme),
) -> tuple[User, AgentToken]:
    """
    Аутентификация агента (Windows-службы) по долгоживущему токену.

    Используется отдельный механизм (не JWT), потому что:
      • токен живёт год — отзыв через blacklist в JWT неудобен;
      • в админке хочется видеть «когда последний раз пинговал агент» —
        для этого нужна запись в БД и обновление last_seen_at.

    Сам токен (raw) на сервере не хранится — хранится SHA256 от него,
    при запросе хешируем и ищем match.
    """
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    agent_token = (
        db.query(AgentToken)
        .filter(
            AgentToken.token_hash == token_hash,
            AgentToken.revoked == False,                      # noqa: E712
            AgentToken.expires_at > _now(),
        )
        .first()
    )
    if not agent_token:
        raise HTTPException(
            status_code=401,
            detail="Невалидный или истёкший токен агента.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = agent_token.user
    if not user or not user.is_active:
        raise HTTPException(status_code=403, detail="Аккаунт пользователя деактивирован.")

    # Обновляем last_seen для админки. Не делаем commit здесь — пусть endpoint
    # сам решит когда коммитить (внутри транзакции своего запроса).
    agent_token.last_seen_at = _now()
    client_ip = request.client.host if request.client else None
    if client_ip:
        agent_token.last_seen_ip = client_ip[:64]

    return user, agent_token


# ═══════════════════════════════════════════════════════════════════════════
# ADMIN ROUTER — управление ключами (загрузка, переназначение, отзыв)
# ═══════════════════════════════════════════════════════════════════════════

admin_router = APIRouter(
    dependencies=[Depends(get_current_active_admin)],
    tags=["Ключи и сертификаты (admin)"],
)


@admin_router.post(
    "/admin/parse-cer",
    response_model=CertParseOut,
    summary="Превью .cer — распарсить и проверить на дубликат (без сохранения)",
)
@limiter.limit(lambda: settings.CRYPTO_CERT_PARSE_RATE_LIMIT)
async def parse_cer_endpoint(
    request: Request,
    cert: UploadFile = File(..., description=".cer-файл (PEM или DER)"),
    db:    Session   = Depends(get_db),
):
    """
    Принимает .cer-файл, парсит метаданные, проверяет уникальность thumbprint.
    Используется фронтом в модалке «Загрузить ключ» для preview ⓘ + защиты
    от случайной повторной загрузки.
    """
    cer_bytes = await _read_upload(cert, settings.CRYPTO_CERT_MAX_SIZE, "Сертификат")
    try:
        parsed = parse_certificate(cer_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    existing = (
        db.query(CryptoKey)
        .filter(CryptoKey.thumbprint == parsed.thumbprint)
        .first()
    )

    return CertParseOut(
        **parsed.to_dict(),
        already_exists = existing is not None,
        existing_owner = existing.owner.username if (existing and existing.owner) else None,
    )


@admin_router.post(
    "/admin/upload",
    response_model=CryptoKeyOut,
    status_code=201,
    summary="Загрузить новый ключ (контейнер + сертификат) в Vault",
)
@limiter.limit(lambda: settings.CRYPTO_ADMIN_UPLOAD_RATE_LIMIT)
async def upload_key(
    request:        Request,
    cert:           UploadFile       = File(..., description=".cer-файл"),
    container:      List[UploadFile] = File(..., description="Файлы папки xxx.000 (header.key и др.)"),
    container_name: str              = Form(..., description="Имя контейнера, напр. 'buh_2026'"),
    owner_user_id:  Optional[int]    = Form(None, description="ID пользователя-владельца (None = свободный)"),
    purpose:        Optional[str]    = Form(None),
    note:           Optional[str]    = Form(None),
    db:             Session          = Depends(get_db),
    current_user:   User             = Depends(get_current_active_admin),
):
    """
    Загружает контейнер КриптоПро + сертификат в Vault, метаданные — в БД.

    Контракт multipart/form-data:
      • cert            — один .cer-файл
      • container       — несколько файлов: header.key, masks.key, ...
                          (имена файлов должны быть из whitelist)
      • container_name  — желаемое имя контейнера (без .000)
      • owner_user_id   — кому назначить (опционально)
      • purpose, note   — справочные поля
    """
    # 1. Имя контейнера — нормализуем и валидируем (защита от path traversal).
    container_name = _sanitize_container_name(container_name)

    # 2. Сертификат — парсим, проверяем уникальность.
    cer_bytes = await _read_upload(cert, settings.CRYPTO_CERT_MAX_SIZE, "Сертификат")
    try:
        parsed = parse_certificate(cer_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if db.query(CryptoKey).filter(CryptoKey.thumbprint == parsed.thumbprint).first():
        raise HTTPException(
            status_code=409,
            detail=f"Ключ с отпечатком {parsed.thumbprint[:16]}... уже загружен.",
        )

    # 3. Файлы контейнера — читаем по одному с проверкой имён и общего размера.
    container_files: dict[str, bytes] = {}
    total_size = 0
    for f in container:
        # filename может быть None в редких случаях — отсекаем.
        if not f.filename:
            raise HTTPException(status_code=400, detail="Один из файлов контейнера без имени.")
        # У filename может быть путь вида "xxx.000/header.key" — берём только последний segment.
        fname = re.split(r"[\\/]", f.filename.strip())[-1].lower()
        if fname not in _ALLOWED_CONTAINER_FILES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Недопустимое имя файла в контейнере: '{fname}'. "
                    f"Разрешены только: {sorted(_ALLOWED_CONTAINER_FILES)}."
                ),
            )
        if fname in container_files:
            raise HTTPException(status_code=400, detail=f"Дублирующий файл '{fname}' в контейнере.")
        data = await f.read()
        total_size += len(data)
        if total_size > settings.CRYPTO_CONTAINER_MAX_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"Суммарный размер контейнера превышает {settings.CRYPTO_CONTAINER_MAX_SIZE} байт.",
            )
        container_files[fname] = data

    missing = _REQUIRED_CONTAINER_FILES - set(container_files.keys())
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"В контейнере не хватает обязательных файлов: {sorted(missing)}.",
        )

    # 4. Проверяем что owner_user_id, если задан, существует и активен.
    if owner_user_id is not None:
        owner = db.query(User).filter(User.id == owner_user_id, User.is_active == True).first()  # noqa: E712
        if not owner:
            raise HTTPException(status_code=404, detail=f"Пользователь {owner_user_id} не найден или деактивирован.")

    # 5. Складываем в Vault и пишем в БД одной транзакцией.
    try:
        storage_path = storage.store(
            thumbprint      = parsed.thumbprint,
            container_name  = container_name,
            container_files = container_files,
            cert_bytes      = cer_bytes,
        )
    except Exception as exc:
        logger.exception("Vault store failed for thumbprint=%s", parsed.thumbprint)
        raise HTTPException(status_code=503, detail=f"Хранилище недоступно: {exc}")

    key = CryptoKey(
        owner_user_id  = owner_user_id,
        container_name = container_name,
        thumbprint     = parsed.thumbprint,
        subject_cn     = parsed.subject_cn,
        subject_o      = parsed.subject_o,
        subject_inn    = parsed.subject_inn,
        subject_snils  = parsed.subject_snils,
        issuer_cn      = parsed.issuer_cn,
        serial_number  = parsed.serial_number,
        valid_from     = parsed.valid_from,
        valid_to       = parsed.valid_to,
        storage_path   = storage_path,
        status         = "active",
        purpose        = purpose,
        note           = note,
        uploaded_by_id = current_user.id,
    )
    db.add(key)
    try:
        db.commit()
    except Exception:
        # Если БД упала — откатываем запись в Vault, чтобы не оставить «висячий»
        # секрет без метаданных.
        db.rollback()
        try:
            storage.delete(storage_path)
        except Exception:
            logger.exception("Failed to rollback Vault entry after DB error")
        raise
    db.refresh(key)
    return _to_out(key)


@admin_router.get(
    "/admin/all",
    response_model=List[CryptoKeyOut],
    summary="Все ключи в системе (для админки)",
)
def admin_list_all(
    status_filter: Optional[str] = None,
    owner_id:      Optional[int] = None,
    db:            Session       = Depends(get_db),
):
    q = db.query(CryptoKey)
    if status_filter:
        q = q.filter(CryptoKey.status == status_filter)
    if owner_id is not None:
        q = q.filter(CryptoKey.owner_user_id == owner_id)
    q = q.order_by(CryptoKey.uploaded_at.desc())
    return [_to_out(k) for k in q.all()]


@admin_router.get(
    "/admin/{key_id}",
    response_model=CryptoKeyOut,
    summary="Один ключ по ID",
)
def admin_get_one(key_id: int, db: Session = Depends(get_db)):
    key = db.query(CryptoKey).filter(CryptoKey.id == key_id).first()
    if not key:
        raise HTTPException(status_code=404, detail="Ключ не найден.")
    return _to_out(key)


@admin_router.patch(
    "/admin/{key_id}",
    response_model=CryptoKeyOut,
    summary="Изменить владельца / статус / назначение / комментарий",
)
def admin_patch(
    key_id:  int,
    payload: CryptoKeyPatchIn,
    db:      Session = Depends(get_db),
):
    key = db.query(CryptoKey).filter(CryptoKey.id == key_id).first()
    if not key:
        raise HTTPException(status_code=404, detail="Ключ не найден.")

    if payload.owner_user_id is not None:
        # owner_user_id=0 → разрешено как «снять владельца». Иначе проверяем.
        if payload.owner_user_id == 0:
            key.owner_user_id = None
        else:
            owner = db.query(User).filter(User.id == payload.owner_user_id).first()
            if not owner:
                raise HTTPException(status_code=404, detail="Пользователь не найден.")
            key.owner_user_id = owner.id

    if payload.purpose is not None:
        key.purpose = payload.purpose
    if payload.note is not None:
        key.note = payload.note
    if payload.status is not None:
        if payload.status not in {"active", "revoked", "expired"}:
            raise HTTPException(status_code=400, detail="Недопустимый статус.")
        key.status = payload.status

    db.commit()
    db.refresh(key)
    return _to_out(key)


@admin_router.delete(
    "/admin/{key_id}",
    status_code=204,
    summary="Полностью удалить ключ (из Vault и БД)",
)
def admin_delete(key_id: int, db: Session = Depends(get_db)):
    key = db.query(CryptoKey).filter(CryptoKey.id == key_id).first()
    if not key:
        raise HTTPException(status_code=404, detail="Ключ не найден.")
    # Сначала пробуем удалить из Vault. Если не получилось — НЕ удаляем из БД,
    # чтобы не оставить осиротевший секрет в Vault без следа в админке.
    try:
        storage.delete(key.storage_path)
    except Exception as exc:
        logger.exception("Vault delete failed for key_id=%s", key_id)
        raise HTTPException(status_code=503, detail=f"Не удалось удалить из хранилища: {exc}")
    db.delete(key)
    db.commit()
    return Response(status_code=204)


@admin_router.get(
    "/admin/agent-tokens",
    response_model=List[AgentTokenOut],
    summary="Список установленных агентов (для аудита)",
)
def admin_list_agent_tokens(db: Session = Depends(get_db)):
    rows = (
        db.query(AgentToken)
        .order_by(AgentToken.issued_at.desc())
        .limit(500)
        .all()
    )
    return [
        AgentTokenOut(
            id           = t.id,
            user_id      = t.user_id,
            username     = t.user.username if t.user else "",
            description  = t.description,
            issued_at    = t.issued_at,
            expires_at   = t.expires_at,
            last_seen_at = t.last_seen_at,
            last_seen_ip = t.last_seen_ip,
            revoked      = t.revoked,
        )
        for t in rows
    ]


@admin_router.post(
    "/admin/agent-tokens/{token_id}/revoke",
    status_code=204,
    summary="Отозвать токен агента (агент сразу перестанет работать)",
)
def admin_revoke_agent_token(token_id: int, db: Session = Depends(get_db)):
    t = db.query(AgentToken).filter(AgentToken.id == token_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Токен не найден.")
    if not t.revoked:
        t.revoked    = True
        t.revoked_at = _now()
        db.commit()
    return Response(status_code=204)


# ═══════════════════════════════════════════════════════════════════════════
# USER ROUTER — кабинет пользователя
# ═══════════════════════════════════════════════════════════════════════════

user_router = APIRouter(
    dependencies=[Depends(require_permission("crypto_keys"))],
    tags=["Ключи и сертификаты"],
)


@user_router.get(
    "/me",
    response_model=List[CryptoKeyOut],
    summary="Мои ключи",
)
def list_my_keys(
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    rows = (
        db.query(CryptoKey)
        .filter(CryptoKey.owner_user_id == current_user.id)
        .order_by(CryptoKey.valid_to.asc())
        .all()
    )
    return [_to_out(k) for k in rows]


@user_router.post(
    "/agent/install-package",
    summary="Скачать ZIP-инсталлятор агента (с уникальным токеном)",
)
def get_install_package(
    request:      Request,
    description:  Optional[str] = Form(None, description="Описание машины (PC-IVANOV)"),
    db:           Session       = Depends(get_db),
    current_user: User          = Depends(get_current_user),
):
    """
    Генерирует ZIP с:
      • config.json (URL сервера + персональный токен агента),
      • install.bat (регистрирует Windows-службу + считыватель КриптоПро),
      • README.txt (инструкция).

    Сам бинарь агента (agent.exe) кладётся отдельно — собирается
    инфраструктурно (PyInstaller на Windows-машине разработчика) и
    включается в шаблон. В этой версии шаблон содержит заглушку с README,
    где написано откуда взять agent.exe.
    """
    # 1. Генерируем случайный токен. token_urlsafe(32) даёт ~256 бит энтропии —
    # подобрать брутфорсом невозможно.
    raw_token  = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

    expires_at = _now() + timedelta(days=settings.CRYPTO_AGENT_TOKEN_TTL_DAYS)
    agent_token = AgentToken(
        user_id     = current_user.id,
        token_hash  = token_hash,
        description = (description or f"PC of {current_user.username}")[:255],
        expires_at  = expires_at,
    )
    db.add(agent_token)
    db.commit()

    # 2. Собираем URL сервера. base_url учитывает Forwarded headers от nginx —
    # в проде получится https://staff.asy-tk.ru, в dev — http://localhost:8000.
    base = str(request.base_url).rstrip("/")

    config = {
        "server_url":      base,
        "token":           raw_token,
        "username":        current_user.username,
        "user_id":         current_user.id,
        "sync_interval_s": 300,                                 # раз в 5 минут
        "keys_dir":        "C:\\\\ProgramData\\\\PODS2Keys",   # двойные слеши для JSON
    }

    install_bat = _INSTALL_BAT_TEMPLATE.replace(
        "{{KEYS_DIR}}", "C:\\ProgramData\\PODS2Keys"
    )
    readme = _README_TEMPLATE.format(
        username       = current_user.username,
        server_url     = base,
        expires_at     = expires_at.strftime("%d.%m.%Y"),
        token_preview  = raw_token[:8] + "..." + raw_token[-4:],
    )

    # 3. ZIP в памяти.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("config.json", json.dumps(config, indent=2, ensure_ascii=False))
        zf.writestr("install.bat", install_bat)
        zf.writestr("README.txt",  readme)
    buf.seek(0)

    fname = f"pods2-agent-{current_user.username}.zip"
    return Response(
        content     = buf.getvalue(),
        media_type  = "application/zip",
        headers     = {"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ═══════════════════════════════════════════════════════════════════════════
# AGENT ROUTER — для агента на клиентской машине
# ═══════════════════════════════════════════════════════════════════════════

agent_router = APIRouter(tags=["Ключи и сертификаты (агент)"])


@agent_router.get(
    "/agent/sync",
    response_model=AgentSyncOut,
    summary="Манифест синхронизации: какие ключи должны быть на этой машине",
)
@limiter.limit(lambda: settings.CRYPTO_AGENT_SYNC_RATE_LIMIT)
def agent_sync(
    request: Request,
    db:      Session = Depends(get_db),
    auth:    tuple   = Depends(get_current_agent),
):
    user, _agent_token = auth
    rows = (
        db.query(CryptoKey)
        .filter(
            CryptoKey.owner_user_id == user.id,
            CryptoKey.status == "active",
        )
        .all()
    )
    base = f"/api/v1/certs/agent"
    entries = [
        AgentKeyEntry(
            id                = k.id,
            container_name    = k.container_name,
            thumbprint        = k.thumbprint,
            container_zip_url = f"{base}/{k.id}/container.zip",
            cert_url          = f"{base}/{k.id}/cert.cer",
            valid_to          = k.valid_to,
            updated_at        = k.updated_at,
        )
        for k in rows
    ]
    db.commit()  # фиксируем last_seen_at, проставленный в get_current_agent
    return AgentSyncOut(keys=entries, server_time=_now())


@agent_router.get(
    "/agent/{key_id}/container.zip",
    summary="Скачать ZIP-архив папки xxx.000 (для распаковки на клиенте)",
)
def agent_download_container(
    key_id:  int,
    request: Request,
    db:      Session = Depends(get_db),
    auth:    tuple   = Depends(get_current_agent),
):
    user, _agent_token = auth
    key = (
        db.query(CryptoKey)
        .filter(
            CryptoKey.id == key_id,
            CryptoKey.owner_user_id == user.id,
            CryptoKey.status == "active",
        )
        .first()
    )
    if not key:
        raise HTTPException(status_code=404, detail="Ключ не найден или отозван.")

    try:
        container_name, container_files, _cert = storage.load(key.storage_path)
    except Exception as exc:
        logger.exception("Vault load failed for key_id=%s", key_id)
        raise HTTPException(status_code=503, detail=f"Хранилище недоступно: {exc}")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # КриптоПро ожидает структуру xxx.000/<файлы.key>. Кладём так, чтобы
        # агент распаковал zip в C:\\ProgramData\\PODS2Keys\\, и КриптоПро увидел
        # папку xxx.000 с правильными файлами внутри.
        folder = f"{container_name}.000"
        for fname, data in container_files.items():
            zf.writestr(f"{folder}/{fname}", data)
    buf.seek(0)
    db.commit()  # фиксируем last_seen_at

    return Response(
        content    = buf.getvalue(),
        media_type = "application/zip",
        headers    = {"Content-Disposition": f'attachment; filename="{container_name}.zip"'},
    )


@agent_router.get(
    "/agent/{key_id}/cert.cer",
    summary="Скачать открытый сертификат (для регистрации в личном хранилище Windows)",
)
def agent_download_cert(
    key_id:  int,
    request: Request,
    db:      Session = Depends(get_db),
    auth:    tuple   = Depends(get_current_agent),
):
    user, _agent_token = auth
    key = (
        db.query(CryptoKey)
        .filter(
            CryptoKey.id == key_id,
            CryptoKey.owner_user_id == user.id,
            CryptoKey.status == "active",
        )
        .first()
    )
    if not key:
        raise HTTPException(status_code=404, detail="Ключ не найден или отозван.")

    try:
        _container_name, _files, cert_bytes = storage.load(key.storage_path)
    except Exception as exc:
        logger.exception("Vault load failed for key_id=%s", key_id)
        raise HTTPException(status_code=503, detail=f"Хранилище недоступно: {exc}")
    db.commit()

    return Response(
        content    = cert_bytes,
        media_type = "application/pkix-cert",
        headers    = {
            "Content-Disposition": f'attachment; filename="{key.container_name}.cer"',
        },
    )


@agent_router.post(
    "/agent/heartbeat",
    status_code=204,
    summary="Агент сообщает что синхронизация прошла (для аудита)",
)
def agent_heartbeat(
    payload: HeartbeatIn,
    request: Request,
    db:      Session = Depends(get_db),
    auth:    tuple   = Depends(get_current_agent),
):
    user, _agent_token = auth
    if payload.failed_thumbprints:
        logger.warning(
            "Agent %s reported failed sync for thumbprints: %s",
            user.username, payload.failed_thumbprints,
        )
    # last_seen_at уже проставлен в get_current_agent. Здесь только commit.
    db.commit()
    return Response(status_code=204)


# ═══════════════════════════════════════════════════════════════════════════
# Шаблоны: install.bat и README.txt
# ═══════════════════════════════════════════════════════════════════════════

_INSTALL_BAT_TEMPLATE = r"""@echo off
REM ───────────────────────────────────────────────────────────────────────
REM   PODS2 Agent — установщик
REM   Должен запускаться от имени АДМИНИСТРАТОРА.
REM ───────────────────────────────────────────────────────────────────────
SETLOCAL ENABLEDELAYEDEXPANSION

REM 0. Проверка прав администратора (net session возвращает 0 у админа)
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo [ОШИБКА] install.bat должен запускаться от имени Администратора.
    echo Щёлкните правой кнопкой → "Запуск от имени администратора".
    pause
    exit /b 1
)

set "INSTALL_DIR=C:\Program Files\PODS2Agent"
set "KEYS_DIR={{KEYS_DIR}}"

echo === PODS2 Agent setup ===
echo Installation dir: %INSTALL_DIR%
echo Keys dir:         %KEYS_DIR%
echo.

REM 1. Папка установки
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

REM 2. Копируем config.json и (если есть) agent.exe рядом
copy /Y "%~dp0config.json" "%INSTALL_DIR%\config.json" >nul
if exist "%~dp0agent.exe" copy /Y "%~dp0agent.exe" "%INSTALL_DIR%\agent.exe" >nul
if exist "%~dp0nssm.exe"  copy /Y "%~dp0nssm.exe"  "%INSTALL_DIR%\nssm.exe"  >nul

REM 3. Создаём папку для ключей
if not exist "%KEYS_DIR%" mkdir "%KEYS_DIR%"

REM 4. Прописываем КриптоПро-считыватель типа "Folder", указывающий на KEYS_DIR.
REM    После этого КриптоПро увидит все папки xxx.000 в KEYS_DIR как контейнеры.
echo Регистрируем считыватель PODS2Folder в КриптоПро...
reg add "HKLM\SOFTWARE\Crypto Pro\Settings\Readers\PODS2Folder" /v "Name" /t REG_SZ /d "PODS2Folder" /f >nul
reg add "HKLM\SOFTWARE\Crypto Pro\Settings\Readers\PODS2Folder" /v "Type" /t REG_SZ /d "Folder"      /f >nul
reg add "HKLM\SOFTWARE\Crypto Pro\Settings\Readers\PODS2Folder" /v "Path" /t REG_SZ /d "%KEYS_DIR%"  /f >nul

REM 5. Регистрируем Windows-службу (если NSSM в комплекте).
if exist "%INSTALL_DIR%\nssm.exe" (
    if exist "%INSTALL_DIR%\agent.exe" (
        echo Регистрируем службу PODS2Agent...
        "%INSTALL_DIR%\nssm.exe" install   PODS2Agent "%INSTALL_DIR%\agent.exe"      >nul
        "%INSTALL_DIR%\nssm.exe" set       PODS2Agent AppDirectory "%INSTALL_DIR%"   >nul
        "%INSTALL_DIR%\nssm.exe" set       PODS2Agent Start SERVICE_AUTO_START       >nul
        "%INSTALL_DIR%\nssm.exe" start     PODS2Agent                                >nul
        echo Служба PODS2Agent запущена.
    ) else (
        echo [ПРЕДУПРЕЖДЕНИЕ] agent.exe не найден — служба не зарегистрирована.
        echo Скачайте agent.exe у администратора и положите в %INSTALL_DIR%, потом запустите этот скрипт ещё раз.
    )
) else (
    echo [ПРЕДУПРЕЖДЕНИЕ] nssm.exe не найден — служба не зарегистрирована.
)

echo.
echo === Установка завершена ===
echo Откройте КриптоПро CSP → «Управление контейнерами» → должны появиться
echo контейнеры из папки %KEYS_DIR% после первого сеанса синхронизации.
pause
ENDLOCAL
"""


_README_TEMPLATE = """PODS2 Agent
═══════════════════════════════════════════════════════════════════════════

Пакет для пользователя:    {username}
Сервер:                    {server_url}
Токен действителен до:     {expires_at}
ID токена (для админа):    {token_preview}

ИНСТРУКЦИЯ
───────────────────────────────────────────────────────────────────────────

1. Распакуйте архив в любую временную папку (например, на рабочий стол).
2. Щёлкните правой кнопкой по install.bat → «Запуск от имени Администратора».
3. После завершения установки агент запустится автоматически.
4. В течение 5 минут все назначенные вам ключи появятся в КриптоПро —
   они будут видны в «Управление контейнерами» в считывателе «PODS2Folder».
5. Подписывайте документы как обычно (Word/Excel/КриптоАРМ/электронные торги).

ЕСЛИ ВЫДАЛО ОШИБКУ «agent.exe не найден»
───────────────────────────────────────────────────────────────────────────

Обратитесь к администратору — он соберёт бинарник агента и пришлёт его
отдельно. После получения положите файл agent.exe в папку
C:\\Program Files\\PODS2Agent\\ и запустите install.bat повторно.

ВАЖНО О БЕЗОПАСНОСТИ
───────────────────────────────────────────────────────────────────────────

• Файл config.json содержит ваш персональный токен — НЕ передавайте его
  никому. Если файл утёк, попросите администратора отозвать токен через
  админку (Ключи и сертификаты → Установленные агенты → Отозвать).

• Ключи на вашей машине лежат в незашифрованной форме (так требует КриптоПро
  для подписания). Не оставляйте машину без блокировки.

ПРИ ПРОБЛЕМАХ
───────────────────────────────────────────────────────────────────────────

Логи службы: C:\\Program Files\\PODS2Agent\\agent.log
"""
