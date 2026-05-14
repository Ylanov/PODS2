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
from urllib.parse import quote

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


class PollOut(BaseModel):
    """Лёгкий ответ /agent/poll — только timestamp."""
    force_sync_at: Optional[datetime] = None
    server_time:   datetime


class AgentTokenOut(BaseModel):
    """Запись токена для админки (без самого токена — только метаданные)."""
    id:             int
    user_id:        int
    username:       str
    description:    Optional[str]
    issued_at:      datetime
    expires_at:     datetime
    last_seen_at:   Optional[datetime]
    last_seen_ip:   Optional[str]
    revoked:        bool
    block_reason:   Optional[str] = None
    bound_mac:      Optional[str] = None
    bound_hostname: Optional[str] = None


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


def _content_disposition(fname: str) -> str:
    """
    Content-Disposition с поддержкой UTF-8 имён файлов по RFC 5987.

    HTTP-заголовки в starlette кодируются в latin-1, поэтому кириллица или
    любой не-ASCII в filename="..." вызывает UnicodeEncodeError. Чтобы
    обеспечить корректную работу с русскоязычными username/container_name:
      • filename="<ascii-fallback>"  — для старых клиентов;
      • filename*=UTF-8''<percent-encoded>  — для современных браузеров.

    Современные браузеры (Chrome, Edge, Firefox, Yandex) при наличии обоих
    параметров отдают приоритет filename*= с UTF-8.
    """
    # ASCII-fallback: всё не [A-Za-z0-9._-] заменяем на _. Минимум 'file' если
    # после очистки строка пустая.
    ascii_safe = re.sub(r"[^A-Za-z0-9._-]+", "_", fname).strip("_") or "file"
    encoded    = quote(fname, safe="")
    return f'attachment; filename="{ascii_safe}"; filename*=UTF-8\'\'{encoded}'


def _bump_force_sync(db: Session, user_id: Optional[int]) -> None:
    """
    Помечает все активные токены пользователя как «требуется sync».
    Вызывается при upload/patch/delete ключа, чтобы агенты при следующем
    poll (раз в минуту) подтянули изменения.
    """
    if not user_id:
        return
    now = _now()
    (
        db.query(AgentToken)
        .filter(
            AgentToken.user_id == user_id,
            AgentToken.revoked == False,                      # noqa: E712
            AgentToken.expires_at > now,
        )
        .update({AgentToken.force_sync_at: now}, synchronize_session=False)
    )


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


_MAC_NORMALIZE_RE = re.compile(r"[^0-9A-Fa-f]")


def _normalize_mac(raw: Optional[str]) -> Optional[str]:
    """
    Приводит MAC к виду 'AABBCCDDEEFF' (без разделителей, uppercase).
    Это даёт устойчивость к разным форматам: AA:BB:..., AA-BB-..., aa:bb:...
    Возвращает None если меньше 12 hex-символов (битый формат).
    """
    if not raw:
        return None
    cleaned = _MAC_NORMALIZE_RE.sub("", raw).upper()
    return cleaned if len(cleaned) == 12 else None


def get_current_agent(
    request: Request,
    db: Session = Depends(get_db),
    token: str  = Depends(oauth2_scheme),
) -> tuple[User, AgentToken]:
    """
    Аутентификация агента (Windows-службы) по долгоживущему токену + MAC.

    Используется отдельный механизм (не JWT), потому что:
      • токен живёт год — отзыв через blacklist в JWT неудобен;
      • в админке хочется видеть «когда последний раз пинговал агент»;
      • поверх токена работает MAC-привязка — при первом обращении агент
        шлёт X-Agent-MAC, сервер запоминает; при последующих сравнивает.
        Это защищает от компрометации через копирование config.json на
        другую машину: токен есть, но MAC другой → 403.

    Сам токен (raw) на сервере не хранится — только SHA256 от него.
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

    # ─── MAC-привязка ────────────────────────────────────────────────────────
    # Агент шлёт MAC primary-сетевой-карты в заголовке X-Agent-MAC.
    # Формат любой (AA:BB:..., AA-BB-...,aabbcc...) — нормализуем.
    incoming_mac = _normalize_mac(request.headers.get("X-Agent-MAC"))
    incoming_host = (request.headers.get("X-Agent-Hostname") or "")[:255]

    if agent_token.bound_mac is None:
        # Первое обращение — запоминаем. Если MAC не пришёл — не блокируем
        # (старые агенты или ручные curl-проверки админа), но и не запоминаем.
        if incoming_mac:
            agent_token.bound_mac      = incoming_mac
            agent_token.bound_hostname = incoming_host or None
            logger.info(
                "Agent token #%s bound to MAC=%s hostname=%s (user=%s)",
                agent_token.id, incoming_mac, incoming_host, user.username,
            )
    else:
        # Уже привязан — сравниваем. MAC не пришёл → пропускаем (curl-проверки),
        # MAC пришёл и не совпал → блокируем токен.
        if incoming_mac and incoming_mac != agent_token.bound_mac:
            agent_token.revoked      = True
            agent_token.revoked_at   = _now()
            agent_token.block_reason = (
                f"MAC mismatch: ждали {agent_token.bound_mac}, "
                f"пришёл {incoming_mac} (hostname={incoming_host or '-'})"
            )
            db.commit()
            logger.warning(
                "Agent token #%s blocked: %s",
                agent_token.id, agent_token.block_reason,
            )
            raise HTTPException(
                status_code=403,
                detail=(
                    "Токен заблокирован: MAC устройства не совпадает с тем, "
                    "на котором агент был установлен. Возможно, config.json был "
                    "скопирован на другую машину. Обратитесь к администратору."
                ),
            )

    # Обновляем last_seen для админки. Commit делает endpoint в конце запроса.
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
    # Сигналим всем агентам владельца, что нужно подтянуть новый ключ.
    _bump_force_sync(db, owner_user_id)
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

    # Запоминаем кто был владельцем до изменений — чтобы дёрнуть его агента
    # тоже, даже если меняем owner на другого юзера (старый должен удалить ключ).
    prev_owner_id = key.owner_user_id

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

    # Сигналим обоим — и старому, и новому владельцу (если меняли).
    _bump_force_sync(db, prev_owner_id)
    if key.owner_user_id != prev_owner_id:
        _bump_force_sync(db, key.owner_user_id)

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
    owner_id = key.owner_user_id
    db.delete(key)
    # Сигналим агенту бывшего владельца — пусть удалит у себя из реестра.
    _bump_force_sync(db, owner_id)
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
            id             = t.id,
            user_id        = t.user_id,
            username       = t.user.username if t.user else "",
            description    = t.description,
            issued_at      = t.issued_at,
            expires_at     = t.expires_at,
            last_seen_at   = t.last_seen_at,
            last_seen_ip   = t.last_seen_ip,
            revoked        = t.revoked,
            block_reason   = t.block_reason,
            bound_mac      = t.bound_mac,
            bound_hostname = t.bound_hostname,
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


@admin_router.post(
    "/admin/agent-tokens/{token_id}/force-sync",
    status_code=204,
    summary="Команда агенту: обновить подпись (sync при следующем poll)",
)
def admin_force_sync_agent(token_id: int, db: Session = Depends(get_db)):
    t = db.query(AgentToken).filter(AgentToken.id == token_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Токен не найден.")
    if t.revoked:
        raise HTTPException(status_code=400, detail="Токен отозван — sync невозможен.")
    t.force_sync_at = _now()
    db.commit()
    return Response(status_code=204)


@admin_router.post(
    "/admin/users/{user_id}/force-sync",
    status_code=204,
    summary="Команда всем агентам пользователя: обновить подпись",
)
def admin_force_sync_user(user_id: int, db: Session = Depends(get_db)):
    _bump_force_sync(db, user_id)
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
    "/me/force-sync",
    status_code=204,
    summary="Кнопка «Обновить сейчас» в кабинете юзера — bump force_sync_at у своих токенов",
)
def user_force_sync(
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Пользователь сам инициирует пересинхронизацию агентов на своих ПК
    (например, после получения нового сертификата от админа).
    """
    _bump_force_sync(db, current_user.id)
    db.commit()
    return Response(status_code=204)


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
        "sync_interval_s": 300,                       # раз в 5 минут
        "keys_dir":        r"C:\ProgramData\PODS2Keys",
    }

    readme = _README_TEMPLATE.format(
        username       = current_user.username,
        server_url     = base,
        expires_at     = expires_at.strftime("%d.%m.%Y"),
        token_preview  = raw_token[:8] + "..." + raw_token[-4:],
    )

    # 3. ZIP в памяти.
    #    install.bat — тонкий launcher (поднимает UAC и зовёт install.ps1).
    #    install.ps1 — основной установщик.
    #    sync.ps1   — движок синхронизации (poll-first, diff-based).
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("config.json", json.dumps(config, indent=2, ensure_ascii=False))
        zf.writestr("install.bat", _INSTALL_BAT_LAUNCHER)
        zf.writestr("install.ps1", _INSTALL_PS1_TEMPLATE)
        zf.writestr("sync.ps1",    _SYNC_PS1_TEMPLATE)
        zf.writestr("README.txt",  readme)
    buf.seek(0)

    fname = f"pods2-agent-{current_user.username}.zip"
    return Response(
        content     = buf.getvalue(),
        media_type  = "application/zip",
        headers     = {"Content-Disposition": _content_disposition(fname)},
    )


# ═══════════════════════════════════════════════════════════════════════════
# AGENT ROUTER — для агента на клиентской машине
# ═══════════════════════════════════════════════════════════════════════════

agent_router = APIRouter(tags=["Ключи и сертификаты (агент)"])


@agent_router.get(
    "/agent/poll",
    response_model=PollOut,
    summary="Лёгкая проверка: нужен ли sync (опрашивается раз в минуту)",
)
@limiter.limit(lambda: settings.CRYPTO_AGENT_SYNC_RATE_LIMIT)
def agent_poll(
    request: Request,
    db:      Session = Depends(get_db),
    auth:    tuple   = Depends(get_current_agent),
):
    """
    Возвращает force_sync_at у токена. Агент сохраняет последнее значение
    в state.json — если оно изменилось с прошлого тика, делает полный sync.
    Запрос идёт раз в минуту и весит ~200 байт, никакой нагрузки на Vault.
    """
    _user, token = auth
    db.commit()  # фиксируем last_seen_at, проставленный в get_current_agent
    return PollOut(force_sync_at=token.force_sync_at, server_time=_now())


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
        headers    = {"Content-Disposition": _content_disposition(f"{container_name}.zip")},
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
            "Content-Disposition": _content_disposition(f"{key.container_name}.cer"),
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

_INSTALL_BAT_LAUNCHER = r"""@echo off
REM Тонкий лаунчер: поднимает UAC и зовёт install.ps1 (основной установщик).
REM Меньше кода в .bat = меньше внимания антивирусов.
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
"""


_INSTALL_PS1_TEMPLATE = r"""# PODS2 Agent — основной установщик
# Запускается из install.bat уже с правами Администратора.
$ErrorActionPreference = 'Stop'
$here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$installDir = "C:\Program Files\PODS2Agent"

Write-Host "═══ PODS2 Agent setup ═══"
Write-Host "Installation dir: $installDir`n"

# 1. Папка установки + копирование sync.ps1 и config.json
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}
Copy-Item (Join-Path $here "config.json") (Join-Path $installDir "config.json") -Force
Copy-Item (Join-Path $here "sync.ps1")    (Join-Path $installDir "sync.ps1")    -Force

# 2. Чистка артефактов от старых версий установщика
Remove-Item "HKLM:\SOFTWARE\Crypto Pro\Settings\Readers\PODS2Folder" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "C:\ProgramData\PODS2Keys" -Recurse -Force -ErrorAction SilentlyContinue

# 3. Первый sync. sync.ps1 сам зашифрует токен через DPAPI при первом
#    запуске, подхватит manifest, импортирует ключи в реестр.
Write-Host "Первая синхронизация..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $installDir "sync.ps1")

# 4. Scheduled task: КАЖДУЮ МИНУТУ запускаем sync.ps1.
#    Сам sync.ps1 сначала делает лёгкий /agent/poll и тихо exit'ит если
#    обновления не требуются. Полный sync — только когда админ нажал
#    «Обновить подпись» или загрузил новый ключ.
#    Это убирает регулярные изменения реестра, на которые реагирует Касперский.
Write-Host "Регистрируем задачу планировщика..."
$taskUser = "$env:USERDOMAIN\$env:USERNAME"
$taskCmd  = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installDir\sync.ps1`""
schtasks /create /tn "PODS2 Cert Sync" /tr $taskCmd `
    /sc minute /mo 1 /ru $taskUser /it /rl HIGHEST /f | Out-Null

Write-Host ""
Write-Host "═══ Установка завершена ═══"
Write-Host "Агент проверяет команды от админа каждую минуту."
Write-Host "Когда админ нажмёт «Обновить подпись» или назначит новый ключ —"
Write-Host "агент подхватит изменения в течение минуты."
Write-Host ""
Write-Host "Запустить sync вручную: schtasks /run /tn `"PODS2 Cert Sync`""
Write-Host "Логи:                   $installDir\sync.log"
"""


# PowerShell sync engine. Выполняет ту же работу что мы делали в ручном тесте:
#  • читает config.json (token + server_url),
#  • получает манифест /agent/sync,
#  • для каждого ключа — скачивает container.zip, распаковывает,
#    пишет файлы как REG_BINARY в HKLM\WOW6432Node\Crypto Pro\Settings\Users\<SID>\Keys\<container>,
#  • скачивает .cer и добавляет в личное хранилище Windows через certutil,
#  • POST'ит /agent/heartbeat с результатом для аудита в админке.
# Запускается из install.bat первый раз + каждые 5 минут через scheduled task.
_SYNC_PS1_TEMPLATE = r"""# PODS2 Cert Sync — синхронизация контейнеров КриптоПро из PODS2 в реестр.
#
# Что делает:
#  • при первом запуске шифрует токен в config.json через DPAPI (LocalMachine);
#  • получает MAC primary-карты и hostname, шлёт их в заголовках X-Agent-MAC /
#    X-Agent-Hostname (сервер использует для bind-проверки на стороне БД);
#  • diff-sync: state.json хранит что уже установлено, sync ставит только
#    разницу (install/update/remove). Без шума и без перезаписи существующего.
#
# Запускается из install.bat первый раз + каждые 5 минут через scheduled task.
$ErrorActionPreference = 'Stop'

$here        = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath  = Join-Path $here "config.json"
$statePath   = Join-Path $here "state.json"
$logPath     = Join-Path $here "sync.log"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    $line | Tee-Object -FilePath $logPath -Append | Out-Null
}

# ─── DPAPI helpers (LocalMachine scope: расшифровывается только на этой машине) ──
function Protect-Token($plain) {
    $bytes  = [System.Text.Encoding]::UTF8.GetBytes($plain)
    $sealed = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'LocalMachine')
    return [Convert]::ToBase64String($sealed)
}

function Unprotect-Token($b64) {
    $sealed = [Convert]::FromBase64String($b64)
    $bytes  = [System.Security.Cryptography.ProtectedData]::Unprotect($sealed, $null, 'LocalMachine')
    return [System.Text.Encoding]::UTF8.GetString($bytes)
}

try {
    if (-not (Test-Path $configPath)) { Log "config.json не найден"; exit 1 }

    $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

    # ─── 1. DPAPI шифрование при первом запуске ─────────────────────────────
    # При свежей установке поле token — plain (сервер не знает наш machine key).
    # Шифруем и перезаписываем config.json. После этого файл не работает на
    # другой машине: DPAPI LocalMachine привязывает blob к ОС.
    if (-not $cfg.token_encrypted) {
        Log "Первый запуск: шифрую токен через DPAPI (LocalMachine)"
        $cfg.token = Protect-Token $cfg.token
        $cfg | Add-Member -NotePropertyName token_encrypted -NotePropertyValue $true -Force
        $cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8 -Force
    }

    $token  = Unprotect-Token $cfg.token
    $mySID  = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

    # ─── 2. MAC primary physical adapter ────────────────────────────────────
    # Берём первую активную физическую карту (Ethernet/Wi-Fi, не виртуальную).
    # MAC шлём как заголовок — сервер запоминает при первом обращении и
    # сравнивает на последующих.
    $adapter  = Get-NetAdapter -Physical -ErrorAction SilentlyContinue |
                Where-Object { $_.Status -eq 'Up' } |
                Sort-Object ifIndex | Select-Object -First 1
    $macRaw   = if ($adapter) { $adapter.MacAddress } else { "" }
    $hostname = $env:COMPUTERNAME

    $headers = @{
        "Authorization"    = "Bearer $token"
        "X-Agent-MAC"      = $macRaw
        "X-Agent-Hostname" = $hostname
    }

    # ─── 3. Poll: нужен ли sync? ──────────────────────────────────────────
    # Лёгкий запрос — сервер возвращает force_sync_at (timestamp). Если он
    # такой же как в state.json — sync не нужен, просто exit. Это убирает
    # ненужные обращения к Vault и записи в реестр (которые провоцируют
    # антивирусы). Полный sync делается ТОЛЬКО когда:
    #   • первый запуск (нет state.json),
    #   • админ нажал «Обновить подпись» в админке,
    #   • админ загрузил/переназначил/отозвал ключ юзера.
    $state = if (Test-Path $statePath) {
        Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    } else {
        $null
    }

    $poll        = Invoke-RestMethod -Uri "$($cfg.server_url)/api/v1/certs/agent/poll" -Headers $headers
    $serverForce = $poll.force_sync_at
    $localForce  = if ($state) { $state.last_force_sync_at } else { $null }

    if ($state -and $state.installed -and ($serverForce -eq $localForce)) {
        Log "Poll: sync not needed (force_sync_at=$serverForce unchanged), exit"
        exit 0
    }

    Log "Sync start (server=$($cfg.server_url), user=$($cfg.username), SID=$mySID, MAC=$macRaw, host=$hostname)"
    Log "  reason: server force_sync_at=$serverForce, local=$localForce"

    # ─── 4. Манифест ───────────────────────────────────────────────────────
    $manifest = Invoke-RestMethod -Uri "$($cfg.server_url)/api/v1/certs/agent/sync" -Headers $headers
    Log "  получено ключей в манифесте: $($manifest.keys.Count)"

    if (-not $state) { $state = [PSCustomObject]@{ installed = @() } }
    if (-not $state.installed) { $state | Add-Member -NotePropertyName installed -NotePropertyValue @() -Force }

    # ─── 5. Diff ────────────────────────────────────────────────────────────
    $manifestByThumb = @{}
    foreach ($k in $manifest.keys) { $manifestByThumb[$k.thumbprint] = $k }
    $stateByThumb = @{}
    foreach ($s in $state.installed) { $stateByThumb[$s.thumbprint] = $s }

    $toInstall = @()
    $toUpdate  = @()
    $toRemove  = @()
    foreach ($k in $manifest.keys) {
        if (-not $stateByThumb.ContainsKey($k.thumbprint)) {
            $toInstall += $k
        } elseif ($stateByThumb[$k.thumbprint].updated_at -ne $k.updated_at) {
            $toUpdate += $k
        }
    }
    foreach ($s in $state.installed) {
        if (-not $manifestByThumb.ContainsKey($s.thumbprint)) { $toRemove += $s }
    }

    Log "  diff: +$($toInstall.Count) ~$($toUpdate.Count) -$($toRemove.Count)"

    # ─── 6. Удаляем то, чего больше нет в манифесте ────────────────────────
    foreach ($s in $toRemove) {
        try {
            $regPath = "HKLM:\SOFTWARE\WOW6432Node\Crypto Pro\Settings\Users\$mySID\Keys\$($s.container_name)"
            Remove-Item $regPath -Recurse -Force -ErrorAction SilentlyContinue
            Get-ChildItem Cert:\CurrentUser\My |
                Where-Object { $_.Thumbprint -eq $s.thumbprint.ToUpper() } |
                Remove-Item -Force -ErrorAction SilentlyContinue
            Log "  - удалён $($s.container_name)"
        } catch {
            Log "  ! не удалось удалить $($s.container_name): $_"
        }
    }

    # ─── 7. Устанавливаем/обновляем ────────────────────────────────────────
    $synced = @()
    $failed = @()
    $newInstalled = @()
    # Сохраняем неизменённые
    foreach ($s in $state.installed) {
        if ($manifestByThumb.ContainsKey($s.thumbprint) -and
            $manifestByThumb[$s.thumbprint].updated_at -eq $s.updated_at) {
            $newInstalled += $s
            $synced       += $s.thumbprint
        }
    }
    foreach ($k in ($toInstall + $toUpdate)) {
        try {
            $tempZip = Join-Path $env:TEMP "podscert_$($k.id).zip"
            $tempDir = Join-Path $env:TEMP "podscert_$($k.id)"
            if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }

            Invoke-WebRequest -Uri "$($cfg.server_url)$($k.container_zip_url)" -Headers $headers -OutFile $tempZip
            Expand-Archive -Path $tempZip -DestinationPath $tempDir -Force
            Remove-Item $tempZip

            $folder = Get-ChildItem $tempDir -Directory | Select-Object -First 1
            if (-not $folder) { throw "В архиве нет папки xxx.000" }

            # Контейнер → HKLM\WOW6432Node\Crypto Pro\Settings\Users\<SID>\Keys\<name>
            $regPath = "HKLM:\SOFTWARE\WOW6432Node\Crypto Pro\Settings\Users\$mySID\Keys\$($k.container_name)"
            Remove-Item $regPath -Recurse -Force -ErrorAction SilentlyContinue
            New-Item -Path $regPath -Force | Out-Null
            Get-ChildItem $folder.FullName -File | ForEach-Object {
                $data = [System.IO.File]::ReadAllBytes($_.FullName)
                New-ItemProperty -Path $regPath -Name $_.Name -PropertyType Binary -Value $data -Force | Out-Null
            }

            # Сертификат → личное хранилище Windows
            $cerPath = Join-Path $env:TEMP "podscert_$($k.id).cer"
            Invoke-WebRequest -Uri "$($cfg.server_url)$($k.cert_url)" -Headers $headers -OutFile $cerPath
            & certutil -user -addstore My $cerPath | Out-Null
            Remove-Item $cerPath
            Remove-Item $tempDir -Recurse -Force

            $newInstalled += [PSCustomObject]@{
                thumbprint     = $k.thumbprint
                container_name = $k.container_name
                updated_at     = $k.updated_at
                registered_at  = (Get-Date).ToUniversalTime().ToString("o")
            }
            $synced += $k.thumbprint
            Log "  ✓ $($k.container_name) ($($k.thumbprint.Substring(0,8))...)"
        } catch {
            $failed += $k.thumbprint
            Log "  ✗ $($k.container_name): $_"
        }
    }

    # ─── 8. Сохраняем новый state ──────────────────────────────────────────
    # last_force_sync_at = серверная отметка, с которой мы синхронизировались.
    # При следующем poll сравним: если сервер вернёт тот же — sync не нужен.
    $newState = [PSCustomObject]@{
        installed          = $newInstalled
        last_sync_at       = (Get-Date).ToUniversalTime().ToString("o")
        last_force_sync_at = $serverForce
    }
    $newState | ConvertTo-Json -Depth 5 | Set-Content -Path $statePath -Encoding UTF8 -Force

    # ─── 9. Heartbeat ──────────────────────────────────────────────────────
    $body = @{
        synced_thumbprints = $synced
        failed_thumbprints = $failed
        agent_version      = "ps1-2.0"
    } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "$($cfg.server_url)/api/v1/certs/agent/heartbeat" `
            -Headers $headers -Method Post -Body $body -ContentType "application/json" | Out-Null
    } catch {
        Log "  heartbeat failed: $_"
    }

    Log "Sync done. synced=$($synced.Count) failed=$($failed.Count)"
} catch {
    Log "FATAL: $_"
    exit 1
}
"""


_README_TEMPLATE = """PODS2 Agent
═══════════════════════════════════════════════════════════════════════════

Пакет для пользователя:    {username}
Сервер:                    {server_url}
Токен действителен до:     {expires_at}
ID токена (для админа):    {token_preview}

УСТАНОВКА — ОДИН КЛИК
───────────────────────────────────────────────────────────────────────────

1. Распакуйте архив в любую временную папку (например, на рабочий стол).
2. Двойной клик по install.bat — Windows запросит подтверждение администратора
   (UAC). Нажмите «Да».
3. Откроется окно установки, дождитесь сообщения «Установка завершена».
4. Готово. КриптоПро видит ваши сертификаты, можно подписывать в Word/Excel/
   КриптоАРМ/электронных торгах как обычно.

КАК ОБНОВЛЯЮТСЯ КЛЮЧИ
───────────────────────────────────────────────────────────────────────────

Агент не делает ничего сам — он только проверяет команды от админа раз
в минуту (легкий запрос, ~200 байт). Когда админ загружает вам новый
сертификат или нажимает «Обновить подпись», агент в течение минуты
подгружает изменения автоматически.

В вашем кабинете на сайте есть кнопка «Обновить сейчас» — нажмите её,
если изменения нужны прямо сейчас.

ВАЖНО О БЕЗОПАСНОСТИ
───────────────────────────────────────────────────────────────────────────

• Токен в config.json зашифрован через DPAPI (LocalMachine scope) — файл
  бесполезен на любой другой машине, расшифровать его невозможно.

• Дополнительно: токен привязан к MAC-адресу вашей сетевой карты. Если
  кто-то скопирует config.json на другой компьютер, токен будет немедленно
  заблокирован, а в админке появится запись «MAC mismatch».

• Не передавайте никому файл config.json даже зашифрованным. Если что-то
  пошло не так — обратитесь к админу, он отзовёт токен через админку.

═══════════════════════════════════════════════════════════════════════════
ДЛЯ АДМИНИСТРАТОРА: НАСТРОЙКА КАСПЕРСКОГО (KSC / KES)
═══════════════════════════════════════════════════════════════════════════

Касперский может блокировать install.bat и/или sync.ps1 из-за того что
скрипты не имеют цифровой подписи и работают с реестром HKLM. Чтобы агент
работал на всех машинах в сети, **один раз** настройте политику KSC:

1. ИСКЛЮЧЕНИЯ для папки и процессов
   ─────────────────────────────────────────────────────────────────────
   KSC → Политики → Антивирусная защита → Исключения сканирования и
   доверенная зона → Параметры:

      Объект:    C:\\Program Files\\PODS2Agent\\*
      Объект:    %TEMP%\\podscert_*
      Угроза:    *
      Компоненты: Файловый антивирус, Веб-антивирус, Защита от
                  программ-вымогателей, Анализ поведения, AMSI-защита

2. ДОВЕРЕННЫЕ ПРОЦЕССЫ
   ─────────────────────────────────────────────────────────────────────
   В тех же исключениях добавьте как «Доверенный процесс»:

      C:\\Program Files\\PODS2Agent\\sync.ps1
      C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe
        (только когда родительский процесс — schtasks.exe / Task Scheduler)

3. РАЗРЕШИТЬ PowerShell ExecutionPolicy=Bypass
   ─────────────────────────────────────────────────────────────────────
   KSC → Контроль программ → если включён whitelisting — добавьте
   sync.ps1 как разрешённый скрипт.

4. ЕСЛИ ИСПОЛЬЗУЕТСЯ HIPS (Host Intrusion Prevention)
   ─────────────────────────────────────────────────────────────────────
   Разрешите powershell.exe запись в:
     HKLM\\SOFTWARE\\WOW6432Node\\Crypto Pro\\Settings\\Users\\*
     Cert:\\CurrentUser\\My

После настройки политики на одной машине — раскатайте её на все ПК
через KSC, install.bat будет проходить без вмешательства антивируса.

ЛОГИ ПРИ ПРОБЛЕМАХ
───────────────────────────────────────────────────────────────────────────

Логи sync:  C:\\Program Files\\PODS2Agent\\sync.log
Состояние:  C:\\Program Files\\PODS2Agent\\state.json
"""
