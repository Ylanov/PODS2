# app/services/cert_parser.py
"""
Парсинг X.509-сертификатов (.cer) от КриптоПро / УЦ Казначейства.

cryptography.x509 НЕ умеет проверять подпись ГОСТ-сертификатов (нужен
gost-engine для OpenSSL), но УМЕЕТ парсить метаданные: subject, issuer,
not_valid_before/after, serial, thumbprint. Это всё что нужно нам для UI
и БД — проверка подписи (валидность цепочки УЦ) не задача PODS2.

Российские OID'ы (RFC 9215 + приказы ФНС):
  • 1.2.643.3.131.1.1  — ИНН физлица / организации
  • 1.2.643.100.3      — СНИЛС
  • 1.2.643.100.1      — ОГРН
  • 1.2.643.100.5      — ОГРНИП
  • 1.2.643.7.1.1.1.1  — ГОСТ Р 34.10-2012 ключ 256 бит
  • 1.2.643.7.1.1.1.2  — ГОСТ Р 34.10-2012 ключ 512 бит
"""

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import NameOID


logger = logging.getLogger(__name__)


# OID'ы российских реквизитов в subject сертификата.
OID_INN_INDIVIDUAL = "1.2.643.3.131.1.1"
OID_INN_ORG        = "1.2.643.100.4"   # ИНН организации
OID_SNILS          = "1.2.643.100.3"
OID_OGRN           = "1.2.643.100.1"
OID_OGRNIP         = "1.2.643.100.5"

# Распознаваемые алгоритмы подписи (для UI). Если OID не в списке —
# показываем как есть.
_ALGORITHM_LABELS = {
    "1.2.643.7.1.1.1.1":  "ГОСТ Р 34.10-2012 (256 бит)",
    "1.2.643.7.1.1.1.2":  "ГОСТ Р 34.10-2012 (512 бит)",
    "1.2.643.2.2.19":     "ГОСТ Р 34.10-2001",
    "1.2.643.2.2.3":      "ГОСТ Р 34.11/34.10-2001",
    "1.2.840.113549.1.1.11": "RSA SHA-256",
    "1.2.840.113549.1.1.5":  "RSA SHA-1",
}


@dataclass
class ParsedCertificate:
    """Распарсенные метаданные .cer для отображения в UI и записи в БД."""
    subject_cn:     Optional[str]
    subject_o:      Optional[str]
    subject_inn:    Optional[str]
    subject_snils:  Optional[str]
    subject_ogrn:   Optional[str]
    issuer_cn:      Optional[str]
    serial_number:  str            # hex без префикса 0x
    valid_from:     datetime       # timezone-aware UTC
    valid_to:       datetime
    thumbprint:     str            # SHA1 hex (40 символов), lowercase
    algorithm:      str            # человекочитаемое название

    def to_dict(self) -> dict:
        """Для JSON-ответа API (datetime → ISO 8601)."""
        return {
            "subject_cn":    self.subject_cn,
            "subject_o":     self.subject_o,
            "subject_inn":   self.subject_inn,
            "subject_snils": self.subject_snils,
            "subject_ogrn":  self.subject_ogrn,
            "issuer_cn":     self.issuer_cn,
            "serial_number": self.serial_number,
            "valid_from":    self.valid_from.isoformat(),
            "valid_to":      self.valid_to.isoformat(),
            "thumbprint":    self.thumbprint,
            "algorithm":     self.algorithm,
        }


def parse_certificate(cer_bytes: bytes) -> ParsedCertificate:
    """
    Принимает байты сертификата в PEM или DER, возвращает ParsedCertificate.
    Бросает ValueError если данные не похожи на X.509.
    """
    cert = _load_cert(cer_bytes)

    subject_attrs = _name_to_dict(cert.subject)
    issuer_attrs  = _name_to_dict(cert.issuer)

    der_bytes = cert.public_bytes(serialization.Encoding.DER)
    thumbprint = hashlib.sha1(der_bytes).hexdigest()

    # not_valid_before/after устарели в cryptography 42.x — заменены на _utc.
    # Берём _utc если есть, иначе fallback на старый API и проставляем UTC.
    valid_from = getattr(cert, "not_valid_before_utc", None) or \
                 cert.not_valid_before.replace(tzinfo=timezone.utc)
    valid_to   = getattr(cert, "not_valid_after_utc", None) or \
                 cert.not_valid_after.replace(tzinfo=timezone.utc)

    algorithm_oid = cert.signature_algorithm_oid.dotted_string
    algorithm     = _ALGORITHM_LABELS.get(algorithm_oid, algorithm_oid)

    # ИНН может лежать под двумя OID'ами — физлицо/организация. Берём первый
    # непустой, чтобы UI всегда показывал что-то осмысленное в одном поле.
    inn = subject_attrs.get(OID_INN_INDIVIDUAL) or subject_attrs.get(OID_INN_ORG)
    ogrn = subject_attrs.get(OID_OGRN) or subject_attrs.get(OID_OGRNIP)

    return ParsedCertificate(
        subject_cn    = subject_attrs.get(NameOID.COMMON_NAME.dotted_string),
        subject_o     = subject_attrs.get(NameOID.ORGANIZATION_NAME.dotted_string),
        subject_inn   = inn,
        subject_snils = subject_attrs.get(OID_SNILS),
        subject_ogrn  = ogrn,
        issuer_cn     = issuer_attrs.get(NameOID.COMMON_NAME.dotted_string),
        serial_number = format(cert.serial_number, "X"),  # hex uppercase
        valid_from    = valid_from,
        valid_to      = valid_to,
        thumbprint    = thumbprint,
        algorithm     = algorithm,
    )


# ─── Внутренние утилиты ───────────────────────────────────────────────────────

def _load_cert(cer_bytes: bytes):
    """
    Пытается распарсить как PEM, если не получилось — как DER.
    PEM начинается с '-----BEGIN CERTIFICATE-----', DER — бинарный ASN.1.
    """
    try:
        return x509.load_pem_x509_certificate(cer_bytes)
    except ValueError:
        try:
            return x509.load_der_x509_certificate(cer_bytes)
        except ValueError as exc:
            raise ValueError(
                "Не удалось распарсить файл как X.509-сертификат (ни PEM, ни DER). "
                f"Внутренняя ошибка: {exc}"
            )


def _name_to_dict(name: x509.Name) -> dict[str, str]:
    """
    Преобразует x509.Name (subject/issuer) в dict {OID: значение}.
    Если один OID встречается несколько раз — берём ПЕРВОЕ. Для типовых
    российских сертификатов дубликатов не бывает.
    """
    result: dict[str, str] = {}
    for attr in name:
        oid = attr.oid.dotted_string
        if oid not in result:
            result[oid] = str(attr.value)
    return result
