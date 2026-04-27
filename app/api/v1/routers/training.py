# app/api/v1/routers/training.py
"""
Отдел проф. подготовки — модуль тестирования.

Эндпоинты разделены на две группы:

  Авторизованные (только админ или username из TRAINING_UNIT_USERNAMES):
    POST   /training/topics              — создать тему
    GET    /training/topics              — список тем
    PUT    /training/topics/{id}         — изменить тему
    DELETE /training/topics/{id}         — удалить тему

    POST   /training/attempts            — сгенерировать ссылку для одного человека
    POST   /training/attempts/bulk       — массовая генерация для списка person_id
    GET    /training/attempts            — список попыток с фильтрами
    DELETE /training/attempts/{id}       — отозвать (status=expired)
    GET    /training/attempts/{id}/qr.svg — QR-код в SVG

  Публичные (без auth, доступ по token из URL):
    GET    /training/public/{token}      — получить инфо для предзаполнения формы
    POST   /training/public/{token}/register — отправить базовые данные

Публичные эндпоинты не требуют JWT — авторизация по самому token.
Это нужно, чтобы человек мог пройти тест с личного телефона по QR.
"""

import io
import secrets
from datetime import datetime, timezone, timedelta, date as date_type
from typing import Optional, Literal

import segno
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.models.user import User
from app.models.person import Person
from app.models.training import (
    TrainingTopic, TrainingQuestion, TrainingAttempt, TRAINING_STATUSES,
)
from app.models.person_conflict import PersonDataConflict
from app.api.dependencies import get_current_user


router = APIRouter()


# ─── Доступ ─────────────────────────────────────────────────────────────────

def _require_training_admin(user: User) -> None:
    """
    Доступ к управлению тестированием:
      • role == 'admin'                            — общий доступ
      • role == 'unit' и 'training' в user.modules — доступ
    Источник правды — users.modules (выставляется админом в UI).
    """
    if user.role == "admin":
        return
    if user.role == "unit" and isinstance(user.modules, list) and "training" in user.modules:
        return
    raise HTTPException(
        status_code=403,
        detail="Доступ только для отдела проф. подготовки или администратора",
    )


# ─── Схемы ──────────────────────────────────────────────────────────────────

class TopicIn(BaseModel):
    name:             str = Field(..., min_length=1, max_length=200)
    description:      Optional[str] = None
    # question_count удалён из формы — теперь считается автоматически
    pass_threshold:   Optional[int] = Field(None, ge=0, le=100)
    duration_minutes: Optional[int] = Field(None, ge=0, le=600)
    is_active:        Literal["Y", "N"] = "Y"


class TopicOut(BaseModel):
    id:               int
    name:             str
    description:      Optional[str] = None
    question_count:   int           = 0     # авто: len(topic.questions)
    pass_threshold:   Optional[int] = None
    duration_minutes: Optional[int] = None
    created_by:       str
    is_active:        str
    created_at:       datetime
    updated_at:       datetime


def _topic_to_out(t: TrainingTopic) -> TopicOut:
    return TopicOut(
        id=t.id, name=t.name, description=t.description,
        question_count=len(t.questions or []),
        pass_threshold=t.pass_threshold,
        duration_minutes=t.duration_minutes,
        created_by=t.created_by, is_active=t.is_active,
        created_at=t.created_at, updated_at=t.updated_at,
    )


# ── Вопросы ─────────────────────────────────────────────────────────────────

class OptionIn(BaseModel):
    text:    str  = Field(..., min_length=1, max_length=1000)
    correct: bool = False


class QuestionIn(BaseModel):
    text:        str = Field(..., min_length=1, max_length=2000)
    options:     list[OptionIn] = Field(..., min_length=2, max_length=8)
    points:      int = Field(1, ge=0, le=100)
    order_index: int = 0


class QuestionOut(BaseModel):
    id:          int
    topic_id:    int
    text:        str
    options:     list[OptionIn]
    points:      int
    order_index: int
    created_at:  datetime
    updated_at:  datetime

    model_config = ConfigDict(from_attributes=True)


class AttemptCreate(BaseModel):
    person_id:        int
    topic_ids:        Optional[list[int]] = None
    expires_in_hours: Optional[int] = Field(None, ge=1, le=24 * 30)
    notes:            Optional[str] = None


class AttemptBulkCreate(BaseModel):
    person_ids:       list[int]
    topic_ids:        Optional[list[int]] = None
    expires_in_hours: Optional[int] = Field(None, ge=1, le=24 * 30)


class AttemptAllCreate(BaseModel):
    """Массовая генерация ссылок для всех активных людей в общей базе."""
    topic_ids:        Optional[list[int]] = None
    expires_in_hours: Optional[int] = Field(None, ge=1, le=24 * 30)
    skip_existing:    bool = True   # пропускать тех, у кого уже есть активная ссылка


class PersonWithAttemptCreate(BaseModel):
    """Создать человека в общей базе людей и сразу выдать ему ссылку."""
    full_name:        str = Field(..., min_length=2, max_length=300)
    rank:             Optional[str] = Field(None, max_length=100)
    doc_number:       Optional[str] = Field(None, max_length=100)
    department:       Optional[str] = Field(None, max_length=100)
    position_title:   Optional[str] = Field(None, max_length=200)
    phone:            Optional[str] = Field(None, max_length=50)
    topic_ids:        Optional[list[int]] = None
    expires_in_hours: Optional[int] = Field(None, ge=1, le=24 * 30)


class AttemptOut(BaseModel):
    id:               int
    person_id:        Optional[int]
    person_full_name: Optional[str]
    topic_ids:        list[int] = []
    topic_names:      list[str] = []
    token:            str
    url:              str
    status:           str
    expires_at:       Optional[datetime] = None
    registered_at:    Optional[datetime] = None
    form_phone:       Optional[str] = None
    form_department:  Optional[str] = None
    form_position:    Optional[str] = None
    started_at:       Optional[datetime] = None
    completed_at:     Optional[datetime] = None
    score:            Optional[int]      = None
    created_by:       str
    created_at:       datetime


class AttemptList(BaseModel):
    items: list[AttemptOut]
    total: int


# ── Отчёт по попытке (детальные ответы) ─────────────────────────────────────

class ReportOption(BaseModel):
    text:     str
    correct:  bool
    selected: bool


class ReportAnswer(BaseModel):
    question_id:    int
    question_text:  str
    points:         int
    options:        list[ReportOption]
    is_correct:     bool
    is_unanswered:  bool


class AttemptReport(BaseModel):
    id:               int
    person_full_name: Optional[str] = None
    person_id:        Optional[int] = None

    form_phone:       Optional[str] = None
    form_department:  Optional[str] = None
    form_position:    Optional[str] = None

    topic_names:      list[str] = []
    duration_minutes: Optional[int] = None
    pass_threshold:   Optional[int] = None

    status:           str
    created_by:       str
    created_at:       datetime
    registered_at:    Optional[datetime] = None
    started_at:       Optional[datetime] = None
    completed_at:     Optional[datetime] = None

    # Аггрегаты результата (None если тест ещё не завершён)
    score:            Optional[int]  = None
    total_points:     int
    percent:          Optional[int]  = None
    correct_count:    int            = 0
    questions_count:  int
    passed:           Optional[bool] = None
    duration_seconds: Optional[int]  = None

    answers:          list[ReportAnswer] = []


# ── Сводный отчёт по группе попыток (за подразделение/тему/всех…) ──────────

class GroupRow(BaseModel):
    """Срез статистики по конкретной группе (отдел/тема)."""
    key:           str          # машинное имя группы (department / topic_name / 'all')
    label:         str          # отображаемое имя
    total:         int          # всего ссылок в группе
    completed:     int          # завершённые тесты
    passed:        int          # из completed: прошли проходной балл
    failed:        int          # из completed: не прошли
    avg_percent:   Optional[float] = None   # среднее % по completed
    avg_score:     Optional[float] = None


class TopPerformer(BaseModel):
    person_full_name: Optional[str]
    department:       Optional[str]
    topic_names:      list[str] = []
    percent:          Optional[int]
    score:            Optional[int]
    total_points:     Optional[int]
    completed_at:     Optional[datetime]


class HistogramBucket(BaseModel):
    range: str   # «0–19%», «20–39%»…
    count: int


class ReportSummary(BaseModel):
    filters: dict

    # Общие счётчики попыток (по всем фильтрам)
    total:       int = 0
    created:     int = 0   # ссылка не открывалась
    registered:  int = 0   # анкета заполнена, но тест не пройден
    in_progress: int = 0
    completed:   int = 0
    expired:     int = 0

    # Аггрегаты по completed
    avg_percent:  Optional[float] = None
    passed:       int = 0
    failed:       int = 0   # есть проходной балл, не прошли
    no_threshold: int = 0   # тест без проходного балла — не относим к pass/fail

    histogram:    list[HistogramBucket] = []

    by_department: list[GroupRow] = []
    by_topic:      list[GroupRow] = []

    top_performers:    list[TopPerformer] = []
    bottom_performers: list[TopPerformer] = []


class PublicAttemptInfo(BaseModel):
    """Данные, отдаваемые публично по token — для предзаполнения формы."""
    person_full_name: Optional[str]
    person_department: Optional[str] = None
    person_phone:      Optional[str] = None
    topic_names:       list[str] = []
    status:            str
    # Подсказки для UI: что показывать дальше
    next_step: Literal["register", "test", "completed", "expired"] = "register"


class PublicRegisterIn(BaseModel):
    # Поле «должность» убрано из публичной формы — оператор анкеты собирает
    # только телефон и подразделение. Остальное (звание, документ и т.д.)
    # остаётся в общей базе людей под управлением админа.
    phone:      str  = Field(..., min_length=3, max_length=50)
    department: str  = Field(..., min_length=1, max_length=100)
    extra:      Optional[dict] = None


# ── Прохождение теста (публичные структуры без correct в options) ───────────

class PublicQuestionOption(BaseModel):
    idx:  int                       # 0-based индекс варианта
    text: str


class PublicQuestion(BaseModel):
    id:       int
    topic_id: int
    text:     str
    points:   int
    options:  list[PublicQuestionOption]


class PublicTestData(BaseModel):
    person_full_name: Optional[str]
    topic_names:      list[str]
    duration_minutes: Optional[int] = None
    pass_threshold:   Optional[int] = None
    questions:        list[PublicQuestion]
    started_at:       Optional[datetime] = None


class PublicAnswer(BaseModel):
    question_id: int
    selected:    list[int] = []


class PublicSubmitIn(BaseModel):
    answers: list[PublicAnswer]


class PublicResult(BaseModel):
    score:           int
    total_points:    int
    percent:         int
    correct_count:   int
    questions_count: int
    pass_threshold:  Optional[int]  = None
    passed:          Optional[bool] = None


# ─── Утилиты ────────────────────────────────────────────────────────────────

def _gen_token() -> str:
    """32 hex-символа = 128 бит энтропии. Конфликт практически невозможен."""
    return secrets.token_hex(16)


def _build_url(request: Request, token: str) -> str:
    """Полный URL для QR. Берём host из текущего запроса (он же вернётся
    при сканировании в локальной сети — например staff.app)."""
    base = str(request.base_url).rstrip("/")
    return f"{base}/training/{token}"


def _resolve_topic_ids(a: TrainingAttempt) -> list[int]:
    """Вытаскиваем список тем: новый topic_ids или legacy topic_id."""
    if isinstance(a.topic_ids, list) and a.topic_ids:
        return [int(x) for x in a.topic_ids if isinstance(x, int)]
    if a.topic_id:
        return [a.topic_id]
    return []


def _topic_names(db: Session, ids: list[int]) -> list[str]:
    if not ids:
        return []
    rows = (db.query(TrainingTopic.id, TrainingTopic.name)
              .filter(TrainingTopic.id.in_(ids)).all())
    by_id = {tid: name for tid, name in rows}
    return [by_id[i] for i in ids if i in by_id]


def _attempt_to_out(a: TrainingAttempt, request: Request,
                     db: Optional[Session] = None) -> AttemptOut:
    ids = _resolve_topic_ids(a)
    names = _topic_names(db, ids) if db is not None and ids else (
        [a.topic.name] if a.topic else []
    )
    return AttemptOut(
        id=a.id,
        person_id=a.person_id,
        person_full_name=(a.person.full_name if a.person else a.person_full_name),
        topic_ids=ids,
        topic_names=names,
        token=a.token,
        url=_build_url(request, a.token),
        status=a.status,
        expires_at=a.expires_at,
        registered_at=a.registered_at,
        form_phone=a.form_phone,
        form_department=a.form_department,
        form_position=a.form_position,
        started_at=a.started_at,
        completed_at=a.completed_at,
        score=a.score,
        created_by=a.created_by,
        created_at=a.created_at,
    )


# ─── Темы ───────────────────────────────────────────────────────────────────

@router.post("/topics", response_model=TopicOut, status_code=201)
def create_topic(
        payload: TopicIn,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    if db.query(TrainingTopic.id).filter(TrainingTopic.name == payload.name).first():
        raise HTTPException(status_code=409, detail=f"Тема «{payload.name}» уже существует")
    topic = TrainingTopic(**payload.model_dump(), created_by=current_user.username)
    db.add(topic); db.commit(); db.refresh(topic)
    return _topic_to_out(topic)


@router.get("/topics", response_model=list[TopicOut])
def list_topics(
        only_active: bool = Query(False),
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    q = db.query(TrainingTopic)
    if only_active:
        q = q.filter(TrainingTopic.is_active == "Y")
    topics = q.order_by(TrainingTopic.name.asc()).all()
    return [_topic_to_out(t) for t in topics]


@router.put("/topics/{topic_id}", response_model=TopicOut)
def update_topic(
        topic_id: int,
        payload: TopicIn,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    topic = db.query(TrainingTopic).filter(TrainingTopic.id == topic_id).first()
    if not topic:
        raise HTTPException(status_code=404, detail="Тема не найдена")
    for k, v in payload.model_dump().items():
        setattr(topic, k, v)
    db.commit(); db.refresh(topic)
    return _topic_to_out(topic)


@router.delete("/topics/{topic_id}", status_code=204)
def delete_topic(
        topic_id: int,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    topic = db.query(TrainingTopic).filter(TrainingTopic.id == topic_id).first()
    if not topic:
        raise HTTPException(status_code=404, detail="Тема не найдена")
    db.delete(topic); db.commit()


# ─── Вопросы ────────────────────────────────────────────────────────────────

def _validate_question_options(options: list[OptionIn]) -> None:
    """Должен быть хотя бы один правильный вариант — иначе тест бессмыслен."""
    if not any(o.correct for o in options):
        raise HTTPException(
            status_code=400,
            detail="У вопроса должен быть хотя бы один правильный вариант",
        )


@router.get("/topics/{topic_id}/questions", response_model=list[QuestionOut])
def list_questions(
        topic_id: int,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    topic = db.query(TrainingTopic).filter(TrainingTopic.id == topic_id).first()
    if not topic:
        raise HTTPException(status_code=404, detail="Тема не найдена")
    return [QuestionOut.model_validate(q) for q in topic.questions]


@router.post("/topics/{topic_id}/questions",
             response_model=QuestionOut, status_code=201)
def create_question(
        topic_id: int,
        payload: QuestionIn,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    topic = db.query(TrainingTopic).filter(TrainingTopic.id == topic_id).first()
    if not topic:
        raise HTTPException(status_code=404, detail="Тема не найдена")
    _validate_question_options(payload.options)
    # Если order_index не задан явно — кладём в конец
    if payload.order_index == 0 and topic.questions:
        max_idx = max(q.order_index for q in topic.questions)
        payload.order_index = max_idx + 1
    q = TrainingQuestion(
        topic_id    = topic_id,
        text        = payload.text,
        options     = [o.model_dump() for o in payload.options],
        points      = payload.points,
        order_index = payload.order_index,
    )
    db.add(q); db.commit(); db.refresh(q)
    return QuestionOut.model_validate(q)


@router.put("/questions/{question_id}", response_model=QuestionOut)
def update_question(
        question_id: int,
        payload: QuestionIn,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    q = db.query(TrainingQuestion).filter(TrainingQuestion.id == question_id).first()
    if not q:
        raise HTTPException(status_code=404, detail="Вопрос не найден")
    _validate_question_options(payload.options)
    q.text        = payload.text
    q.options     = [o.model_dump() for o in payload.options]
    q.points      = payload.points
    q.order_index = payload.order_index
    db.commit(); db.refresh(q)
    return QuestionOut.model_validate(q)


@router.delete("/questions/{question_id}", status_code=204)
def delete_question(
        question_id: int,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    q = db.query(TrainingQuestion).filter(TrainingQuestion.id == question_id).first()
    if not q:
        raise HTTPException(status_code=404, detail="Вопрос не найден")
    db.delete(q); db.commit()


# ─── Попытки (генерация ссылок) ─────────────────────────────────────────────

def _validate_topic_ids(db: Session, topic_ids: Optional[list[int]]) -> list[int]:
    """Возвращает чистый список существующих тем. Пустой список = без привязки."""
    if not topic_ids:
        return []
    ids = sorted({int(x) for x in topic_ids})
    found = (db.query(TrainingTopic.id)
               .filter(TrainingTopic.id.in_(ids)).all())
    found_ids = {x[0] for x in found}
    missing = set(ids) - found_ids
    if missing:
        raise HTTPException(
            status_code=404,
            detail=f"Темы не найдены: {sorted(missing)}",
        )
    return [i for i in ids if i in found_ids]


def _create_attempt(
        db: Session,
        person: Person, topic_ids: list[int],
        expires_in_hours: Optional[int], created_by: str,
        notes: Optional[str] = None,
) -> TrainingAttempt:
    expires_at = None
    if expires_in_hours:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)
    # Для бэкворд-сов оставляем topic_id = первая тема (если есть)
    legacy_topic_id = topic_ids[0] if topic_ids else None
    a = TrainingAttempt(
        person_id        = person.id,
        person_full_name = person.full_name,
        topic_id         = legacy_topic_id,
        topic_ids        = topic_ids or None,
        token            = _gen_token(),
        expires_at       = expires_at,
        status           = "created",
        created_by       = created_by,
        notes            = notes,
    )
    db.add(a)
    return a


@router.post("/attempts", response_model=AttemptOut, status_code=201)
def create_attempt(
        payload: AttemptCreate,
        request: Request,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    person = db.query(Person).filter(Person.id == payload.person_id).first()
    if not person:
        raise HTTPException(status_code=404,
                            detail=f"Человек с id={payload.person_id} не найден")
    topic_ids = _validate_topic_ids(db, payload.topic_ids)
    a = _create_attempt(
        db, person, topic_ids,
        expires_in_hours=payload.expires_in_hours,
        created_by=current_user.username,
        notes=payload.notes,
    )
    db.commit(); db.refresh(a)
    return _attempt_to_out(a, request, db)


@router.post("/attempts/bulk", response_model=AttemptList)
def create_attempts_bulk(
        payload: AttemptBulkCreate,
        request: Request,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    if not payload.person_ids:
        raise HTTPException(status_code=400, detail="Не указано ни одного человека")
    if len(payload.person_ids) > 1000:
        raise HTTPException(status_code=400, detail="За один раз — не более 1000 ссылок")

    topic_ids = _validate_topic_ids(db, payload.topic_ids)
    persons = (db.query(Person)
                 .filter(Person.id.in_(payload.person_ids)).all())
    items = []
    for p in persons:
        a = _create_attempt(
            db, p, topic_ids,
            expires_in_hours=payload.expires_in_hours,
            created_by=current_user.username,
        )
        items.append(a)
    db.commit()
    for a in items:
        db.refresh(a)
    out = [_attempt_to_out(a, request, db) for a in items]
    return AttemptList(items=out, total=len(out))


@router.post("/attempts/all", response_model=AttemptList)
def create_attempts_for_all(
        payload: AttemptAllCreate,
        request: Request,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Массовая генерация ссылок для ВСЕХ активных людей в общей базе
    (Person.fired_at IS NULL). Если skip_existing=True (по умолчанию) —
    пропускаем тех, у кого уже есть активная ссылка от текущего юзера
    (status='created' или 'registered'), чтобы не плодить дубликаты.
    """
    _require_training_admin(current_user)
    topic_ids = _validate_topic_ids(db, payload.topic_ids)

    persons = (db.query(Person)
                 .filter(Person.fired_at.is_(None))
                 .order_by(Person.full_name.asc())
                 .all())
    if not persons:
        return AttemptList(items=[], total=0)

    skip_ids: set[int] = set()
    if payload.skip_existing:
        # У кого уже есть «живая» ссылка от этого же юзера
        active = (db.query(TrainingAttempt.person_id)
                    .filter(TrainingAttempt.created_by == current_user.username,
                            TrainingAttempt.status.in_(("created", "registered")))
                    .all())
        skip_ids = {pid for (pid,) in active if pid is not None}

    items = []
    for p in persons:
        if p.id in skip_ids:
            continue
        a = _create_attempt(
            db, p, topic_ids,
            expires_in_hours=payload.expires_in_hours,
            created_by=current_user.username,
        )
        items.append(a)
    db.commit()
    for a in items:
        db.refresh(a)
    out = [_attempt_to_out(a, request, db) for a in items]
    return AttemptList(items=out, total=len(out))


@router.post("/attempts/with-person", response_model=AttemptOut, status_code=201)
def create_attempt_with_person(
        payload: PersonWithAttemptCreate,
        request: Request,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Добавить нового человека в общую базу и сразу выдать ему ссылку.
    Если человек с таким ФИО уже есть — переиспользуем существующую запись
    (просто генерируем новую ссылку). Это безопасно: full_name unique.
    """
    _require_training_admin(current_user)
    full_name = payload.full_name.strip()
    if not full_name:
        raise HTTPException(status_code=400, detail="ФИО не может быть пустым")
    topic_ids = _validate_topic_ids(db, payload.topic_ids)

    person = db.query(Person).filter(Person.full_name == full_name).first()
    if not person:
        person = Person(
            full_name      = full_name,
            rank           = payload.rank,
            doc_number     = payload.doc_number,
            department     = payload.department,
            position_title = payload.position_title,
            phone          = payload.phone,
        )
        db.add(person)
        db.flush()  # получаем id, не коммитим — атомарно с попыткой ниже

    a = _create_attempt(
        db, person, topic_ids,
        expires_in_hours=payload.expires_in_hours,
        created_by=current_user.username,
    )
    db.commit(); db.refresh(a)
    return _attempt_to_out(a, request, db)


@router.get("/attempts", response_model=AttemptList)
def list_attempts(
        request: Request,
        status_filter: Optional[str] = Query(None, alias="status"),
        topic_id:      Optional[int] = Query(None),
        person_id:     Optional[int] = Query(None),
        creator:       Optional[str] = Query(None,
                            description="Фильтр по username создателя ссылки"),
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    _require_training_admin(current_user)
    q = db.query(TrainingAttempt)
    # unit-юзерам показываем только их собственные ссылки, чтобы один отдел
    # проф.подготовки не видел чужие. Админ видит всё.
    if current_user.role != "admin":
        q = q.filter(TrainingAttempt.created_by == current_user.username)
    if status_filter:
        if status_filter not in TRAINING_STATUSES:
            raise HTTPException(status_code=400, detail="Неизвестный статус")
        q = q.filter(TrainingAttempt.status == status_filter)
    if topic_id:
        q = q.filter(TrainingAttempt.topic_id == topic_id)
    if person_id:
        q = q.filter(TrainingAttempt.person_id == person_id)
    if creator:
        q = q.filter(TrainingAttempt.created_by == creator)

    items = q.order_by(TrainingAttempt.created_at.desc()).limit(500).all()
    return AttemptList(
        items = [_attempt_to_out(a, request, db) for a in items],
        total = len(items),
    )


@router.delete("/attempts/{attempt_id}", status_code=204)
def revoke_attempt(
        attempt_id: int,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    «Отозвать» ссылку — переводим status=expired. Запись не удаляем,
    чтобы остался след в журнале (кто сгенерировал, когда).
    """
    _require_training_admin(current_user)
    a = db.query(TrainingAttempt).filter(TrainingAttempt.id == attempt_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Попытка не найдена")
    if current_user.role != "admin" and a.created_by != current_user.username:
        raise HTTPException(status_code=403, detail="Чужая запись")
    a.status = "expired"
    db.commit()


@router.get("/reports/summary", response_model=ReportSummary)
def reports_summary(
        topic_id:   Optional[int] = Query(None),
        department: Optional[str] = Query(None,
                description="Подразделение/управление — точное совпадение по form_department"),
        date_from:  Optional[date_type] = Query(None,
                description="Минимальная дата создания ссылки"),
        date_to:    Optional[date_type] = Query(None,
                description="Максимальная дата создания ссылки"),
        creator:    Optional[str] = Query(None,
                description="Только ссылки этого юзера. Для unit-роли всегда =username"),
        db:         Session = Depends(get_db),
        current_user: User  = Depends(get_current_user),
):
    """
    Сводный отчёт по попыткам с фильтрами. Агрегирует:
      • счётчики по статусам
      • средний %, прошедшие/непрошедшие проходной
      • распределение оценок по корзинам 0-19, 20-39, ..., 80-100%
      • разрезы «по подразделениям» и «по темам»
      • топ-5 лучших / худших

    Доступ: admin или разрешённый unit. Для unit-роли результаты
    автоматически ограничены своими ссылками.
    """
    _require_training_admin(current_user)

    q = db.query(TrainingAttempt)
    if current_user.role != "admin":
        q = q.filter(TrainingAttempt.created_by == current_user.username)
    elif creator:
        q = q.filter(TrainingAttempt.created_by == creator)

    if topic_id:
        # Учитываем и legacy topic_id, и новый topic_ids JSONB
        q = q.filter(or_(
            TrainingAttempt.topic_id == topic_id,
            TrainingAttempt.topic_ids.op("@>")([topic_id]),
        ))
    if department:
        q = q.filter(TrainingAttempt.form_department == department)
    if date_from:
        q = q.filter(TrainingAttempt.created_at >= date_from)
    if date_to:
        # date_to + 1 день, чтобы включить весь день
        q = q.filter(TrainingAttempt.created_at < date_to + timedelta(days=1))

    attempts = q.order_by(TrainingAttempt.created_at.desc()).all()

    # ── Счётчики по статусам ────────────────────────────────────────────────
    counts = {"created": 0, "registered": 0, "in_progress": 0,
              "completed": 0, "expired": 0}
    for a in attempts:
        counts[a.status] = counts.get(a.status, 0) + 1

    # ── Аггрегаты по completed ──────────────────────────────────────────────
    completed_attempts = [a for a in attempts if a.status == "completed"]
    total_points_by_attempt = {}
    percent_by_attempt = {}
    for a in completed_attempts:
        ids = _resolve_topic_ids(a)
        qns = (db.query(TrainingQuestion)
                 .filter(TrainingQuestion.topic_id.in_(ids)).all()) if ids else []
        tp = sum(qn.points for qn in qns)
        total_points_by_attempt[a.id] = tp
        if tp > 0 and a.score is not None:
            percent_by_attempt[a.id] = round(a.score / tp * 100)

    avg_percent = None
    if percent_by_attempt:
        avg_percent = round(sum(percent_by_attempt.values()) / len(percent_by_attempt), 1)

    # Pass/fail: считаем по проходному max-у тем, на которые завязана попытка
    passed = failed = no_threshold = 0
    for a in completed_attempts:
        ids = _resolve_topic_ids(a)
        _, threshold = _topic_meta(db, ids)
        if threshold is None:
            no_threshold += 1
            continue
        p = percent_by_attempt.get(a.id)
        if p is None:
            no_threshold += 1
            continue
        if p >= threshold: passed += 1
        else:              failed += 1

    # ── Гистограмма (по 20%) ────────────────────────────────────────────────
    buckets = [(0, 19), (20, 39), (40, 59), (60, 79), (80, 100)]
    hist = [HistogramBucket(range=f"{lo}–{hi}%", count=0) for lo, hi in buckets]
    for p in percent_by_attempt.values():
        for idx, (lo, hi) in enumerate(buckets):
            if lo <= p <= hi:
                hist[idx].count += 1
                break

    # ── Разрез по подразделениям (form_department) ─────────────────────────
    dept_buckets: dict[str, list[TrainingAttempt]] = {}
    for a in attempts:
        key = (a.form_department or "").strip() or "— не указано —"
        dept_buckets.setdefault(key, []).append(a)

    by_department: list[GroupRow] = []
    for dept, items in dept_buckets.items():
        completed_in = [x for x in items if x.status == "completed"]
        percents = [percent_by_attempt[x.id] for x in completed_in
                    if x.id in percent_by_attempt]
        scores   = [x.score for x in completed_in if x.score is not None]
        p_pass = p_fail = 0
        for x in completed_in:
            ids = _resolve_topic_ids(x)
            _, threshold = _topic_meta(db, ids)
            if threshold is None: continue
            p = percent_by_attempt.get(x.id)
            if p is None: continue
            if p >= threshold: p_pass += 1
            else:              p_fail += 1
        by_department.append(GroupRow(
            key=dept, label=dept,
            total=len(items),
            completed=len(completed_in),
            passed=p_pass, failed=p_fail,
            avg_percent=round(sum(percents)/len(percents), 1) if percents else None,
            avg_score=round(sum(scores)/len(scores), 1) if scores else None,
        ))
    by_department.sort(key=lambda r: -r.completed)

    # ── Разрез по темам ─────────────────────────────────────────────────────
    # Одна попытка может покрывать несколько тем — попадает в каждую группу
    topic_buckets: dict[int, list[TrainingAttempt]] = {}
    for a in attempts:
        for tid in _resolve_topic_ids(a):
            topic_buckets.setdefault(tid, []).append(a)
    topic_id_to_name = {}
    if topic_buckets:
        rows = (db.query(TrainingTopic.id, TrainingTopic.name)
                  .filter(TrainingTopic.id.in_(topic_buckets.keys())).all())
        topic_id_to_name = {tid: name for tid, name in rows}

    by_topic: list[GroupRow] = []
    for tid, items in topic_buckets.items():
        completed_in = [x for x in items if x.status == "completed"]
        percents = [percent_by_attempt[x.id] for x in completed_in
                    if x.id in percent_by_attempt]
        p_pass = p_fail = 0
        for x in completed_in:
            ids = _resolve_topic_ids(x)
            _, threshold = _topic_meta(db, ids)
            if threshold is None: continue
            p = percent_by_attempt.get(x.id)
            if p is None: continue
            if p >= threshold: p_pass += 1
            else:              p_fail += 1
        by_topic.append(GroupRow(
            key=str(tid),
            label=topic_id_to_name.get(tid, f"Тема #{tid}"),
            total=len(items),
            completed=len(completed_in),
            passed=p_pass, failed=p_fail,
            avg_percent=round(sum(percents)/len(percents), 1) if percents else None,
        ))
    by_topic.sort(key=lambda r: -r.completed)

    # ── Топ-5 лучших / худших по % ─────────────────────────────────────────
    def to_top(a: TrainingAttempt) -> TopPerformer:
        return TopPerformer(
            person_full_name=(a.person.full_name if a.person else a.person_full_name),
            department=a.form_department,
            topic_names=_topic_names(db, _resolve_topic_ids(a)),
            percent=percent_by_attempt.get(a.id),
            score=a.score,
            total_points=total_points_by_attempt.get(a.id),
            completed_at=a.completed_at,
        )

    sorted_by_p = sorted(
        [a for a in completed_attempts if a.id in percent_by_attempt],
        key=lambda a: percent_by_attempt[a.id],
        reverse=True,
    )
    top_performers    = [to_top(a) for a in sorted_by_p[:5]]
    bottom_performers = [to_top(a) for a in sorted_by_p[-5:][::-1]] \
                       if len(sorted_by_p) > 5 else []

    return ReportSummary(
        filters={
            "topic_id":   topic_id,
            "department": department,
            "date_from":  str(date_from) if date_from else None,
            "date_to":    str(date_to)   if date_to   else None,
            "creator":    creator if current_user.role == "admin" else current_user.username,
        },
        total=len(attempts),
        created=counts.get("created", 0),
        registered=counts.get("registered", 0),
        in_progress=counts.get("in_progress", 0),
        completed=counts.get("completed", 0),
        expired=counts.get("expired", 0),
        avg_percent=avg_percent,
        passed=passed, failed=failed, no_threshold=no_threshold,
        histogram=hist,
        by_department=by_department,
        by_topic=by_topic,
        top_performers=top_performers,
        bottom_performers=bottom_performers,
    )


@router.get("/attempts/{attempt_id}/report", response_model=AttemptReport)
def attempt_report(
        attempt_id: int,
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Детальный отчёт по попытке: данные участника, агрегаты результата
    и каждый вопрос с подсветкой выбранных/правильных вариантов.
    """
    _require_training_admin(current_user)
    a = db.query(TrainingAttempt).filter(TrainingAttempt.id == attempt_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Попытка не найдена")
    if current_user.role != "admin" and a.created_by != current_user.username:
        raise HTTPException(status_code=403, detail="Чужая запись")

    questions = _load_questions_for_attempt(db, a)
    topic_ids = _resolve_topic_ids(a)
    duration, threshold = _topic_meta(db, topic_ids)

    # Сохранённые ответы участника: список словарей
    # [{question_id, selected: [idx,...], correct: bool}, ...]
    recorded = a.answers if isinstance(a.answers, list) else []
    by_qid = {r.get("question_id"): r for r in recorded if r.get("question_id")}

    total_points  = sum(q.points for q in questions)
    correct_count = 0
    report_answers: list[ReportAnswer] = []

    for q in questions:
        rec = by_qid.get(q.id, {})
        selected = set(int(x) for x in rec.get("selected", []) if isinstance(x, int))
        is_correct = bool(rec.get("correct", False))
        if is_correct:
            correct_count += 1
        opts: list[ReportOption] = []
        for i, o in enumerate(q.options or []):
            opts.append(ReportOption(
                text=o.get("text", ""),
                correct=bool(o.get("correct")),
                selected=(i in selected),
            ))
        report_answers.append(ReportAnswer(
            question_id   = q.id,
            question_text = q.text,
            points        = q.points,
            options       = opts,
            is_correct    = is_correct,
            is_unanswered = (len(selected) == 0 and a.status == "completed"),
        ))

    percent = None
    if total_points > 0 and a.score is not None:
        percent = round(a.score / total_points * 100)
    passed = None
    if percent is not None and threshold is not None:
        passed = (percent >= threshold)

    duration_seconds = None
    if a.started_at and a.completed_at:
        duration_seconds = int((a.completed_at - a.started_at).total_seconds())

    person_name = a.person.full_name if a.person else a.person_full_name
    return AttemptReport(
        id               = a.id,
        person_full_name = person_name,
        person_id        = a.person_id,
        form_phone       = a.form_phone,
        form_department  = a.form_department,
        form_position    = a.form_position,
        topic_names      = _topic_names(db, topic_ids),
        duration_minutes = duration,
        pass_threshold   = threshold,
        status           = a.status,
        created_by       = a.created_by,
        created_at       = a.created_at,
        registered_at    = a.registered_at,
        started_at       = a.started_at,
        completed_at     = a.completed_at,
        score            = a.score,
        total_points     = total_points,
        percent          = percent,
        correct_count    = correct_count,
        questions_count  = len(questions),
        passed           = passed,
        duration_seconds = duration_seconds,
        answers          = report_answers,
    )


@router.get("/attempts/{attempt_id}/qr.svg")
def attempt_qr(
        attempt_id: int,
        request: Request,
        scale: int = Query(6, ge=2, le=20),
        db: Session = Depends(get_db),
        current_user: User = Depends(get_current_user),
):
    """
    Возвращает QR-код в SVG — для встраивания в админ-панель и печати.
    SVG масштабируется без потери качества и весит ≈1-2 КБ.
    """
    _require_training_admin(current_user)
    a = db.query(TrainingAttempt).filter(TrainingAttempt.id == attempt_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="Попытка не найдена")
    if current_user.role != "admin" and a.created_by != current_user.username:
        raise HTTPException(status_code=403, detail="Чужая запись")

    url = _build_url(request, a.token)
    qr  = segno.make(url, error="m")
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=scale, border=2)
    return Response(content=buf.getvalue(), media_type="image/svg+xml")


# ─── Публичные эндпоинты (без auth — авторизация по token) ──────────────────

def _get_attempt_by_token(db: Session, token: str) -> TrainingAttempt:
    a = db.query(TrainingAttempt).filter(TrainingAttempt.token == token).first()
    if not a:
        raise HTTPException(status_code=404, detail="Ссылка недействительна")
    if a.status == "expired":
        raise HTTPException(status_code=410, detail="Ссылка отозвана")
    if a.expires_at and a.expires_at < datetime.now(timezone.utc):
        a.status = "expired"
        db.commit()
        raise HTTPException(status_code=410, detail="Срок действия ссылки истёк")
    return a


def _next_step(a: TrainingAttempt) -> str:
    if a.status == "completed":   return "completed"
    if a.status == "expired":     return "expired"
    if a.status == "in_progress": return "test"
    if a.registered_at:           return "test"
    return "register"


@router.get("/public/{token}", response_model=PublicAttemptInfo)
def public_info(
        token: str,
        db: Session = Depends(get_db),
):
    """
    Открыто без auth — ссылка сама и есть авторизация. Возвращает
    минимум данных для предзаполнения формы регистрации.
    """
    a = _get_attempt_by_token(db, token)
    person_name = a.person.full_name if a.person else a.person_full_name
    person_dept = a.person.department if a.person else None
    person_phone = a.person.phone if a.person else None
    topic_names = _topic_names(db, _resolve_topic_ids(a))
    return PublicAttemptInfo(
        person_full_name=person_name,
        person_department=person_dept,
        person_phone=person_phone,
        topic_names=topic_names,
        status=a.status,
        next_step=_next_step(a),
    )


def _merge_person_field(
        db: Session, person, field: str, new_value: Optional[str],
        attempt_id: Optional[int],
) -> None:
    """
    Синхронизация поля Person с присланным значением:
      • пусто прислали → ничего не делаем
      • у Person пусто → заливаем
      • совпадает → ничего не делаем
      • разные значения → создаём PersonDataConflict для админа
    """
    new_value = (new_value or "").strip()
    if not new_value:
        return
    old_value = (getattr(person, field, "") or "").strip()
    if not old_value:
        setattr(person, field, new_value)
        return
    if old_value == new_value:
        return
    # Перед созданием новой записи проверим — нет ли уже открытого конфликта
    # по этому же полю и значению, чтобы не плодить дубликаты при повторных
    # отправках одной и той же формы.
    existing = (
        db.query(PersonDataConflict.id)
          .filter(
              PersonDataConflict.person_id   == person.id,
              PersonDataConflict.field_name  == field,
              PersonDataConflict.new_value   == new_value,
              PersonDataConflict.resolved_at.is_(None),
          )
          .first()
    )
    if existing:
        return
    db.add(PersonDataConflict(
        person_id   = person.id,
        attempt_id  = attempt_id,
        field_name  = field,
        old_value   = old_value,
        new_value   = new_value,
        source      = "training",
    ))


@router.post("/public/{token}/register", response_model=PublicAttemptInfo)
def public_register(
        token: str,
        payload: PublicRegisterIn,
        db: Session = Depends(get_db),
):
    """
    Этап 1 — участник заполняет анкету. Сохраняем данные на самой попытке
    (form_*) и пытаемся синхронизировать их с общей базой людей:
      • если у Person поле пустое — заполняем
      • если совпадает — ничего не делаем
      • если разное — пишем в person_data_conflicts, чтобы админ выбрал
    Сама попытка переходит в статус 'registered' независимо от исхода
    синхронизации (расхождения никак не блокируют участника).
    """
    a = _get_attempt_by_token(db, token)
    if a.status not in ("created", "registered"):
        raise HTTPException(status_code=409,
                            detail=f"Текущий статус «{a.status}» не позволяет регистрацию")

    a.form_phone      = payload.phone.strip()
    a.form_department = payload.department.strip()
    a.form_position   = None   # поле должности убрано из анкеты
    a.form_extra      = payload.extra
    a.registered_at   = datetime.now(timezone.utc)
    a.status          = "registered"

    # Синхронизация с общей базой людей
    if a.person_id:
        from app.models.person import Person
        person = db.query(Person).filter(Person.id == a.person_id).first()
        if person:
            _merge_person_field(db, person, "department", a.form_department, a.id)
            _merge_person_field(db, person, "phone",      a.form_phone,      a.id)

    db.commit()
    db.refresh(a)

    person_name = a.person.full_name if a.person else a.person_full_name
    topic_names = _topic_names(db, _resolve_topic_ids(a))
    return PublicAttemptInfo(
        person_full_name=person_name,
        topic_names=topic_names,
        status=a.status,
        next_step=_next_step(a),
    )


# ─── Прохождение теста ──────────────────────────────────────────────────────

def _load_questions_for_attempt(db: Session, a: TrainingAttempt) -> list[TrainingQuestion]:
    topic_ids = _resolve_topic_ids(a)
    if not topic_ids:
        return []
    return (db.query(TrainingQuestion)
              .filter(TrainingQuestion.topic_id.in_(topic_ids))
              .order_by(
                  TrainingQuestion.topic_id,
                  TrainingQuestion.order_index,
                  TrainingQuestion.id,
              )
              .all())


def _topic_meta(db: Session, topic_ids: list[int]) -> tuple[Optional[int], Optional[int]]:
    """Длительность и проходной балл — максимум среди привязанных тем
    (если у одной темы лимит 30 мин а у другой 60, даём 60 — больший)."""
    if not topic_ids:
        return None, None
    topics = (db.query(TrainingTopic)
                .filter(TrainingTopic.id.in_(topic_ids)).all())
    durations = [t.duration_minutes for t in topics if t.duration_minutes]
    thresholds = [t.pass_threshold for t in topics if t.pass_threshold]
    return (max(durations) if durations else None,
            max(thresholds) if thresholds else None)


@router.get("/public/{token}/test", response_model=PublicTestData)
def public_test(token: str, db: Session = Depends(get_db)):
    """
    Возвращает вопросы для прохождения. correct-флаги ОТРЕЗАЕМ — варианты
    отдаются только text + idx, чтобы участник физически не мог увидеть
    правильные ответы в DevTools.

    Первый вызов на статусе 'registered' → переводим в 'in_progress' и
    фиксируем started_at.
    """
    a = _get_attempt_by_token(db, token)
    if a.status not in ("registered", "in_progress"):
        raise HTTPException(
            status_code=409,
            detail=f"Текущий статус «{a.status}» не позволяет проходить тест",
        )

    questions = _load_questions_for_attempt(db, a)
    if not questions:
        raise HTTPException(
            status_code=400,
            detail="К ссылке не привязано ни одной темы с вопросами. "
                   "Свяжитесь с организатором.",
        )

    if a.status == "registered":
        a.status     = "in_progress"
        a.started_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(a)

    topic_ids = _resolve_topic_ids(a)
    duration, threshold = _topic_meta(db, topic_ids)

    public_qs = []
    for q in questions:
        opts = []
        for i, o in enumerate(q.options or []):
            opts.append(PublicQuestionOption(idx=i, text=o.get("text", "")))
        public_qs.append(PublicQuestion(
            id=q.id, topic_id=q.topic_id, text=q.text,
            points=q.points, options=opts,
        ))

    person_name = a.person.full_name if a.person else a.person_full_name
    return PublicTestData(
        person_full_name=person_name,
        topic_names=_topic_names(db, topic_ids),
        duration_minutes=duration,
        pass_threshold=threshold,
        questions=public_qs,
        started_at=a.started_at,
    )


@router.post("/public/{token}/submit", response_model=PublicResult)
def public_submit(
        token: str,
        payload: PublicSubmitIn,
        db: Session = Depends(get_db),
):
    """
    Принимает ответы участника. Считает баллы (full match per question:
    выбранный набор индексов = набор правильных), сохраняет в attempt.answers,
    переводит статус в 'completed'.
    """
    a = _get_attempt_by_token(db, token)
    if a.status not in ("in_progress", "registered"):
        raise HTTPException(
            status_code=409,
            detail=f"Текущий статус «{a.status}» — отправка ответов не разрешена",
        )

    questions = _load_questions_for_attempt(db, a)
    if not questions:
        raise HTTPException(status_code=400, detail="Нет вопросов для оценивания")

    answers_by_qid = {ans.question_id: list(ans.selected) for ans in payload.answers}

    score          = 0
    total_points   = 0
    correct_count  = 0
    detailed: list[dict] = []

    for q in questions:
        total_points += q.points
        correct_idxs = {
            i for i, o in enumerate(q.options or []) if o.get("correct")
        }
        selected = set(int(x) for x in answers_by_qid.get(q.id, []))
        is_correct = (correct_idxs == selected and len(selected) > 0)
        if is_correct:
            score += q.points
            correct_count += 1
        detailed.append({
            "question_id": q.id,
            "selected":    sorted(selected),
            "correct":     is_correct,
        })

    percent = round(score / total_points * 100) if total_points > 0 else 0
    _, threshold = _topic_meta(db, _resolve_topic_ids(a))
    passed = (percent >= threshold) if threshold is not None else None

    a.status       = "completed"
    a.completed_at = datetime.now(timezone.utc)
    a.score        = score
    a.answers      = detailed
    db.commit()

    return PublicResult(
        score=score, total_points=total_points, percent=percent,
        correct_count=correct_count, questions_count=len(questions),
        pass_threshold=threshold, passed=passed,
    )
