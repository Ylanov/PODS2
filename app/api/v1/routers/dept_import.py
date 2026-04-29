# app/api/v1/routers/dept_import.py
"""
Импорт привязки людей к управлениям (Person.department) из Word-файла.

Сценарий:
  1. Админ загружает .docx со штатным составом (как «Отряд РХБ защиты»).
  2. Бэк парсит таблицы, извлекает пары (ФИО, метка-подразделение).
  3. Каждая метка («5 упр.», «НУ-3», ...) пробуется по таблице
     department_aliases — если есть, подставляем реальное username.
  4. Для меток, которых нет в БД, возвращаем список — фронт спрашивает
     админа из dropdown'а («что такое 5 упр.?»). Админ отвечает один раз;
     при следующем импорте система знает.
  5. Применение делается отдельным вызовом — после того как админ
     подтвердил неизвестные метки.

Endpoint'ы:
  POST /admin/persons/import-departments/preview  (multipart .docx)
  POST /admin/persons/import-departments/apply    (JSON: changes + new_aliases)
"""
import io
import re
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.user import User
from app.models.person import Person
from app.models.department_alias import DepartmentAlias
from app.api.dependencies import get_current_active_admin
from app.core.websockets import manager


router = APIRouter()


# ─── Парсер таблиц Word ───────────────────────────────────────────────────────

# Заголовки колонок, которые ищем в первой строке таблицы (нормализованно).
_FIO_HEADERS  = {"фио", "ф.и.о.", "фамилия имя отчество", "фамилия"}
_DEPT_HEADERS = {"примечание", "квота", "подразделение"}


def _normalize(text: str) -> str:
    """Schiehrt → schiehrt; collapse whitespace; strip ZW chars."""
    if not text:
        return ""
    s = text.replace("​", "").replace("‎", "").replace(" ", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _normalize_alias(alias: str) -> str:
    """Алиас сравниваем без регистра — «5 упр.», «5 УПР», «5 упр» это одно."""
    return _normalize(alias).lower()


def _extract_pairs_from_docx(file_bytes: bytes) -> list[dict]:
    """
    Возвращает список {full_name, alias_raw} из всех таблиц документа.
    Пропускает шапку, group-row (когда все ячейки одинаковые) и пустые строки.
    """
    from docx import Document

    doc = Document(io.BytesIO(file_bytes))
    out: list[dict] = []

    for t in doc.tables:
        if not t.rows:
            continue

        # Определяем индексы колонок по заголовку (1-я строка)
        header_cells = [_normalize(c.text).lower() for c in t.rows[0].cells]
        fio_idx = next(
            (i for i, h in enumerate(header_cells)
             if any(key in h for key in _FIO_HEADERS)),
            None,
        )
        dept_idx = next(
            (i for i, h in enumerate(header_cells)
             if any(key in h for key in _DEPT_HEADERS)),
            None,
        )
        if fio_idx is None or dept_idx is None:
            continue   # таблица не из тех, что мы парсим

        for row in t.rows[1:]:
            cells = [_normalize(c.text) for c in row.cells]
            # group-row: все ячейки одинаковые — пропускаем
            if len(set(cells)) == 1:
                continue
            full_name = cells[fio_idx] if fio_idx < len(cells) else ""
            alias_raw = cells[dept_idx] if dept_idx < len(cells) else ""
            if not full_name or not alias_raw:
                continue
            out.append({"full_name": full_name, "alias_raw": alias_raw})

    return out


# ─── Pydantic-схемы ───────────────────────────────────────────────────────────

class ImportChange(BaseModel):
    person_id:  int
    department: str


class ImportApplyPayload(BaseModel):
    changes:     list[ImportChange]
    # Новые сопоставления, которые админ задал в диалоге unknown_aliases.
    # Сохраняем в БД на будущее.
    new_aliases: dict[str, str] = {}


# ─── Preview ─────────────────────────────────────────────────────────────────

@router.post("/persons/import-departments/preview",
             summary="Распарсить Word и вернуть preview импорта квот людей")
async def preview_import(
        file:         UploadFile          = File(...),
        db:           Session             = Depends(get_db),
        current_admin: User               = Depends(get_current_active_admin),
):
    if not file.filename.lower().endswith(".docx"):
        raise HTTPException(status_code=400, detail="Ожидается .docx (не .doc).")

    raw = await file.read()
    try:
        pairs = _extract_pairs_from_docx(raw)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Не удалось прочитать docx: {e}")

    if not pairs:
        return {
            "matched":          [],
            "unknown_aliases":  [],
            "unknown_persons":  [],
            "total_rows":       0,
            "message":          "В документе не найдено таблиц с колонками «ФИО» и «Примечание».",
        }

    # Известные алиасы — нормализуем для сравнения
    known_aliases = {
        a.alias: a.department
        for a in db.query(DepartmentAlias).all()
    }
    # Также добавляем «тривиальные» совпадения: alias == username управления
    # (если в Word уже стоит реальное название) — без явного маппинга.
    known_usernames = {u.username for u in db.query(User).all()}

    # Загружаем всех людей для матча по ФИО (case-insensitive).
    persons_by_name = {
        _normalize(p.full_name).lower(): p
        for p in db.query(Person).filter(Person.fired_at.is_(None)).all()
    }

    matched: list[dict]          = []
    unknown_aliases: set[str]    = set()
    unknown_persons: list[str]   = []

    for pair in pairs:
        fio   = pair["full_name"]
        alias = pair["alias_raw"]
        nalias = _normalize_alias(alias)

        # Резолвим alias → department
        if nalias in known_aliases:
            dept = known_aliases[nalias]
        elif alias in known_usernames:           # точное совпадение с username
            dept = alias
        else:
            unknown_aliases.add(alias)
            continue   # ждём пока админ разрулит

        # Находим человека в Person
        p = persons_by_name.get(_normalize(fio).lower())
        if not p:
            unknown_persons.append(fio)
            continue

        matched.append({
            "person_id":  p.id,
            "full_name":  p.full_name,
            "alias":      alias,
            "department": dept,
            "current":    p.department or "",
            "changed":    (p.department or "") != dept,
        })

    return {
        "matched":         matched,
        "unknown_aliases": sorted(unknown_aliases),
        "unknown_persons": unknown_persons,
        "total_rows":      len(pairs),
        "departments":     sorted(known_usernames),
    }


# ─── Apply ───────────────────────────────────────────────────────────────────

@router.post("/persons/import-departments/apply",
             summary="Применить импорт + сохранить новые алиасы")
async def apply_import(
        payload:       ImportApplyPayload,
        db:            Session             = Depends(get_db),
        current_admin: User                = Depends(get_current_active_admin),
):
    # 1. Сохраняем новые алиасы (на будущее)
    saved_aliases = 0
    for raw_alias, dept in (payload.new_aliases or {}).items():
        nalias = _normalize_alias(raw_alias)
        if not nalias or not dept:
            continue
        existing = db.query(DepartmentAlias).filter(DepartmentAlias.alias == nalias).first()
        if existing:
            if existing.department != dept:
                existing.department = dept
        else:
            db.add(DepartmentAlias(alias=nalias, department=dept))
            saved_aliases += 1

    # 2. Применяем изменения к Person
    updated = 0
    for change in payload.changes:
        p = db.query(Person).filter(Person.id == change.person_id).first()
        if not p:
            continue
        if (p.department or "") != change.department:
            p.department = change.department
            updated += 1

    db.commit()

    # WebSocket: обновляем UI базы людей у админа.
    if updated:
        await manager.broadcast({"action": "person_update", "source": "import"})

    return {
        "updated_persons":     updated,
        "saved_aliases":       saved_aliases,
        "message":             f"Применено: {updated} людей, новых алиасов: {saved_aliases}.",
    }
