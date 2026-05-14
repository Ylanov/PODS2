# app/services/vault_client.py
"""
Хранилище контейнеров КриптоПро.

Бэкенды:
  • vault  — HashiCorp Vault (KV-engine v2). Основной путь для prod.
  • file   — JSON-файлы на диске, шифрованные Fernet (SECRET_KEY).
             Для dev/PoC без Vault. В prod не используется.

Выбор: если в .env заданы VAULT_URL и VAULT_TOKEN — используется Vault.
Если они пустые, но CRYPTO_KEYS_FALLBACK_DIR непустой — используется file.
Иначе при попытке записи/чтения — RuntimeError.

Контракт:
  • store(thumbprint, container_files, cert_bytes) → str (storage_path для БД)
  • load(storage_path) → (dict[filename, bytes], cert_bytes)
  • delete(storage_path) → None

Формат секрета (Vault KV-v2):
  path = "<VAULT_KV_PATH_PREFIX>/<thumbprint>"
  data = {
      "container_name": "buh_2026",
      "container_files": {"header.key": "<b64>", "masks.key": "<b64>", ...},
      "cert": "<b64>",
  }
"""

import base64
import hashlib
import json
import logging
from pathlib import Path
from typing import Tuple

from app.core.config import settings


logger = logging.getLogger(__name__)


# ─── Внутренние утилиты ───────────────────────────────────────────────────────

def _b64encode_files(files: dict[str, bytes]) -> dict[str, str]:
    return {name: base64.b64encode(data).decode("ascii") for name, data in files.items()}


def _b64decode_files(files: dict[str, str]) -> dict[str, bytes]:
    return {name: base64.b64decode(b64.encode("ascii")) for name, b64 in files.items()}


def _fernet():
    """
    Lazy-init Fernet для file-backend. Ключ — производный от SECRET_KEY:
    SHA256(SECRET_KEY) → 32 байта → base64-urlsafe → ключ Fernet.

    Lazy, чтобы не падать при import'е модуля если cryptography не установлена
    или SECRET_KEY дефолтный (в Vault-режиме Fernet не нужен).
    """
    from cryptography.fernet import Fernet
    digest = hashlib.sha256(settings.SECRET_KEY.encode("utf-8")).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


# ─── Vault backend ────────────────────────────────────────────────────────────

class _VaultBackend:
    def __init__(self):
        # Lazy-import hvac: если его нет в окружении dev — не падаем при запуске,
        # а получим понятную ошибку при первой реальной попытке использования.
        import hvac
        self._client = hvac.Client(url=settings.VAULT_URL, token=settings.VAULT_TOKEN)
        if not self._client.is_authenticated():
            raise RuntimeError(
                "Vault: токен не валиден или сервер недоступен. "
                "Проверьте VAULT_URL / VAULT_TOKEN в .env."
            )

    def _path(self, thumbprint: str) -> str:
        return f"{settings.VAULT_KV_PATH_PREFIX}/{thumbprint}"

    def store(self, thumbprint: str, container_name: str,
              container_files: dict[str, bytes], cert_bytes: bytes) -> str:
        path = self._path(thumbprint)
        self._client.secrets.kv.v2.create_or_update_secret(
            path=path,
            secret={
                "container_name":  container_name,
                "container_files": _b64encode_files(container_files),
                "cert":            base64.b64encode(cert_bytes).decode("ascii"),
            },
            mount_point=settings.VAULT_MOUNT,
        )
        # storage_path для БД: используется только как «адрес» (читаем по нему
        # обратно). Префикс vault:// помогает отличить от file:// в логах/БД.
        return f"vault://{settings.VAULT_MOUNT}/{path}"

    def load(self, storage_path: str) -> Tuple[str, dict[str, bytes], bytes]:
        # storage_path = "vault://<mount>/<path>"
        prefix = f"vault://{settings.VAULT_MOUNT}/"
        if not storage_path.startswith(prefix):
            raise RuntimeError(f"Невалидный vault-путь: {storage_path}")
        path = storage_path[len(prefix):]

        resp = self._client.secrets.kv.v2.read_secret_version(
            path=path,
            mount_point=settings.VAULT_MOUNT,
            raise_on_deleted_version=True,
        )
        data = resp["data"]["data"]
        return (
            data.get("container_name", ""),
            _b64decode_files(data["container_files"]),
            base64.b64decode(data["cert"].encode("ascii")),
        )

    def delete(self, storage_path: str) -> None:
        prefix = f"vault://{settings.VAULT_MOUNT}/"
        if not storage_path.startswith(prefix):
            return  # молча игнорируем — путь не наш
        path = storage_path[len(prefix):]
        # destroy_secret_versions делает hard-delete всех версий — то что нужно
        # при отзыве ключа. delete_metadata_and_all_versions ещё чище.
        self._client.secrets.kv.v2.delete_metadata_and_all_versions(
            path=path,
            mount_point=settings.VAULT_MOUNT,
        )


# ─── File backend (Fernet-шифрование) ─────────────────────────────────────────

class _FileBackend:
    def __init__(self):
        self._dir = Path(settings.CRYPTO_KEYS_FALLBACK_DIR)
        self._dir.mkdir(parents=True, exist_ok=True)

    def _path(self, thumbprint: str) -> Path:
        return self._dir / f"{thumbprint}.enc"

    def store(self, thumbprint: str, container_name: str,
              container_files: dict[str, bytes], cert_bytes: bytes) -> str:
        payload = {
            "container_name":  container_name,
            "container_files": _b64encode_files(container_files),
            "cert":            base64.b64encode(cert_bytes).decode("ascii"),
        }
        plaintext = json.dumps(payload).encode("utf-8")
        ciphertext = _fernet().encrypt(plaintext)
        path = self._path(thumbprint)
        path.write_bytes(ciphertext)
        return f"file://{path}"

    def load(self, storage_path: str) -> Tuple[str, dict[str, bytes], bytes]:
        prefix = "file://"
        if not storage_path.startswith(prefix):
            raise RuntimeError(f"Невалидный file-путь: {storage_path}")
        path = Path(storage_path[len(prefix):])
        ciphertext = path.read_bytes()
        payload = json.loads(_fernet().decrypt(ciphertext).decode("utf-8"))
        return (
            payload.get("container_name", ""),
            _b64decode_files(payload["container_files"]),
            base64.b64decode(payload["cert"].encode("ascii")),
        )

    def delete(self, storage_path: str) -> None:
        prefix = "file://"
        if not storage_path.startswith(prefix):
            return
        path = Path(storage_path[len(prefix):])
        path.unlink(missing_ok=True)


# ─── Фасад ────────────────────────────────────────────────────────────────────

class CryptoStorage:
    """Единая точка входа: выбирает бэкенд один раз и проксирует вызовы."""

    def __init__(self):
        self._backend = None  # lazy-init при первом вызове

    def _ensure(self):
        if self._backend is not None:
            return
        if settings.VAULT_URL and settings.VAULT_TOKEN:
            logger.info("CryptoStorage: используется Vault (%s)", settings.VAULT_URL)
            self._backend = _VaultBackend()
        elif settings.CRYPTO_KEYS_FALLBACK_DIR:
            logger.warning(
                "CryptoStorage: Vault не настроен — используется file-backend (%s). "
                "Подходит для dev/PoC. В prod задайте VAULT_URL и VAULT_TOKEN.",
                settings.CRYPTO_KEYS_FALLBACK_DIR,
            )
            self._backend = _FileBackend()
        else:
            raise RuntimeError(
                "CryptoStorage не сконфигурирован. Задайте VAULT_URL+VAULT_TOKEN "
                "(production) или CRYPTO_KEYS_FALLBACK_DIR (dev) в .env."
            )

    def store(self, thumbprint: str, container_name: str,
              container_files: dict[str, bytes], cert_bytes: bytes) -> str:
        self._ensure()
        return self._backend.store(thumbprint, container_name, container_files, cert_bytes)

    def load(self, storage_path: str) -> Tuple[str, dict[str, bytes], bytes]:
        self._ensure()
        return self._backend.load(storage_path)

    def delete(self, storage_path: str) -> None:
        self._ensure()
        return self._backend.delete(storage_path)


# Singleton для импорта из роутеров.
storage = CryptoStorage()
