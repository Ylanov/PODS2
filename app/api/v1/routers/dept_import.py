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
from typing import Optional, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import text
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


# ─── Поиск кандидатов в Person для неизвестных ФИО ────────────────────────────

# Зеркало логики /persons/suggest, но в админ-режиме (без visibility-фильтра).
# Используется для подбора похожих кандидатов, когда импорт не нашёл точного
# совпадения по ФИО.
_FIND_CANDIDATES_SQL = text("""
    SELECT
        id, full_name, rank, doc_number, department,
        GREATEST(
            LEAST(
                GREATEST(
                    ROUND(similarity(lower(full_name), lower(:q)) * 100)::int,
                    CASE
                        WHEN lower(full_name) LIKE lower(:q) || '%'
                          OR lower(full_name) LIKE '% ' || lower(:q) || '%'
                          THEN 75
                        WHEN lower(full_name) LIKE '%' || lower(:q) || '%'
                          THEN 60
                        ELSE 0
                    END
                ),
                100
            ),
            0
        ) AS score
    FROM persons
    WHERE
        fired_at IS NULL
        AND (
            similarity(lower(full_name), lower(:q)) > 0.20
            OR lower(full_name) LIKE '%' || lower(:q) || '%'
        )
    ORDER BY score DESC, full_name ASC
    LIMIT :lim
""")


def _find_candidates(db: Session, q: str, limit: int = 3) -> list[dict]:
    """Топ-N похожих Person по ФИО (для админ-импорта). Слабые (<35) отсекаем."""
    q = (q or "").strip()
    if len(q) < 2:
        return []
    rows = db.execute(_FIND_CANDIDATES_SQL, {"q": q, "lim": limit}).mappings().all()
    return [
        {
            "id":         r["id"],
            "full_name":  r["full_name"],
            "rank":       r["rank"],
            "doc_number": r["doc_number"],
            "department": r["department"] or "",
            "score":      int(r["score"]),
        }
        for r in rows if r["score"] >= 35
    ]


# ─── Pydantic-схемы ───────────────────────────────────────────────────────────

class ImportChange(BaseModel):
    person_id:  int
    department: str


class ImportUnknownDecision(BaseModel):
    """
    Решение админа по ФИО, которого нет в Person:
      action='merge'  — слить с существующим Person (нужен person_id),
      action='create' — создать нового Person с этим ФИО,
      action='skip'   — пропустить (не импортировать).
    Для всех — нужна department (резолвлено из alias на стороне фронта).
    """
    full_name:   str
    department:  str
    action:      Literal["merge", "create", "skip"]
    person_id:   Optional[int] = None
    rank:        Optional[str] = None
    doc_number:  Optional[str] = None


class ImportApplyPayload(BaseModel):
    changes:     list[ImportChange]
    # Новые сопоставления, которые админ задал в диалоге unknown_aliases.
    # Сохраняем в БД на будущее.
    new_aliases: dict[str, str] = {}
    # Решения по неизвестным ФИО (см. ImportUnknownDecision).
    unknown_decisions: list[ImportUnknownDecision] = []


# ─── Preview ─────────────────────────────────────────────────────────────────

@router.post("/persons/import-departments/preview",
             summary="Распарсить Word и вернуть preview импорта квот людей")
async def preview_import(
        files:        list[UploadFile]    = File(...),
        db:           Session             = Depends(get_db),
        current_admin: User               = Depends(get_current_active_admin),
):
    """
    Принимает один или несколько .docx за раз. Пары (ФИО, alias) сливаются
    в общий список с дедупликацией: один и тот же ФИО, попавшийся в двух
    файлах с одной квотой, не светится в preview дважды.

    Битый файл не валит весь импорт — его ошибка попадает в `per_file`,
    остальные файлы обрабатываются.
    """
    if not files:
        raise HTTPException(status_code=400, detail="Не выбран ни один файл.")

    pairs: list[dict] = []
    per_file: list[dict] = []      # сводка по каждому файлу для UX
    seen_pair: set[tuple] = set()  # (нормализованное ФИО, нормализованный alias)

    for f in files:
        info = {
            "filename": f.filename or "",
            "rows":     0,
            "added":    0,
            "skipped_duplicates": 0,
            "error":    None,
        }
        if not (f.filename or "").lower().endswith(".docx"):
            info["error"] = "Ожидается .docx (не .doc)."
            per_file.append(info)
            continue

        try:
            raw = await f.read()
            file_pairs = _extract_pairs_from_docx(raw)
        except Exception as e:
            info["error"] = f"Не удалось прочитать docx: {e}"
            per_file.append(info)
            continue

        info["rows"] = len(file_pairs)
        for p in file_pairs:
            key = (_normalize(p["full_name"]).lower(),
                   _normalize_alias(p["alias_raw"]))
            if key in seen_pair:
                info["skipped_duplicates"] += 1
                continue
            seen_pair.add(key)
            pairs.append(p)
            info["added"] += 1
        per_file.append(info)

    if not pairs:
        # Нет ни одного валидного парного значения. Сообщение зависит от
        # того, были ли вообще ошибки чтения файлов.
        had_errors = any(x["error"] for x in per_file)
        msg = (
            "Ни в одном файле не найдено таблиц с колонками «ФИО» и «Примечание»."
            if not had_errors
            else "Файлы не удалось обработать. См. подробности в per_file."
        )
        return {
            "matched":          [],
            "unknown_aliases":  [],
            "unknown_persons":  [],
            "total_rows":       0,
            "per_file":         per_file,
            "files_count":      len(files),
            "message":          msg,
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

    matched: list[dict]               = []
    unknown_aliases: set[str]         = set()
    # unknown_persons теперь — список объектов: исходное ФИО, разрешённое
    # управление и кандидаты-похожие из Person для подтверждения админом.
    # Дедуплицируем по (нормализованное ФИО + dept), чтобы один и тот же
    # неизвестный человек не светился по два раза, если в Word его дважды.
    unknown_persons: list[dict]       = []
    seen_unknown: set[tuple]          = set()

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
            key = (_normalize(fio).lower(), dept)
            if key not in seen_unknown:
                seen_unknown.add(key)
                unknown_persons.append({
                    "full_name":  fio,
                    "alias":      alias,
                    "department": dept,
                    "candidates": _find_candidates(db, fio, limit=3),
                })
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
        "per_file":        per_file,
        "files_count":     len(files),
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

    # 3. Решения по неизвестным ФИО
    merged_count   = 0    # action='merge' — слили с существующим
    created_count  = 0    # action='create' — создали нового Person
    skipped_count  = 0    # action='skip' — намеренно пропустили
    for d in (payload.unknown_decisions or []):
        if d.action == "skip":
            skipped_count += 1
            continue

        if d.action == "merge":
            if not d.person_id:
                continue
            p = db.query(Person).filter(Person.id == d.person_id).first()
            if not p:
                continue
            if (p.department or "") != d.department:
                p.department = d.department
                merged_count += 1
            continue

        if d.action == "create":
            new_name = _normalize(d.full_name)
            if not new_name:
                continue
            # Защита от гонки: full_name unique. Если запись уже появилась
            # (например, второй пользователь импортирует параллельно) —
            # просто обновляем department вместо вставки.
            existing = (
                db.query(Person)
                .filter(Person.full_name.ilike(new_name))
                .first()
            )
            if existing:
                if (existing.department or "") != d.department:
                    existing.department = d.department
                    merged_count += 1
                continue
            db.add(Person(
                full_name  = new_name,
                rank       = (d.rank or None),
                doc_number = (d.doc_number or None),
                department = d.department,
            ))
            created_count += 1

    db.commit()

    # WebSocket: обновляем UI базы людей у админа.
    if updated or merged_count or created_count:
        await manager.broadcast({"action": "person_update", "source": "import"})

    return {
        "updated_persons":     updated,
        "merged_persons":      merged_count,
        "created_persons":     created_count,
        "skipped_persons":     skipped_count,
        "saved_aliases":       saved_aliases,
        "message":             (
            f"Применено: {updated} обновлено, "
            f"{created_count} создано, "
            f"{merged_count} слито с базой, "
            f"новых алиасов: {saved_aliases}."
        ),
    }
