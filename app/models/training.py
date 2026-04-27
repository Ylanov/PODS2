# app/models/training.py
"""
Отдел профессиональной подготовки: тестирование сотрудников.

Сотрудники проходят тест по персональной ссылке (или сканируя QR-код).
Логика подключения:
  1. Сотрудник проф.подготовки выбирает человека из общей базы людей и
     генерирует ссылку — создаётся запись TrainingAttempt с уникальным token.
  2. Человек открывает ссылку (находясь в одной локальной сети с платформой),
     видит свою ФИО (предзаполнено по token → person_id) и заполняет форму
     базовых данных (телефон, управление, должность).
  3. Данные уходят в проф.подготовку — там видны входящие заявки.
  4. Дальше идёт сам тест (вопросы по выбранной теме). Сейчас заглушка —
     детали реализации будут позже.

Темы и направления тестирования живут в TrainingTopic. Вопросы пока не
моделируем — пользователь раскроет требования отдельно.
"""

from datetime import datetime, timezone
from sqlalchemy import (
    Column, Integer, String, Text, DateTime,
    ForeignKey, Index,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship
from app.db.database import Base


# ── Статусы попытки ─────────────────────────────────────────────────────────
TRAINING_STATUSES = (
    "created",      # ссылка создана, но человек её ещё не открывал
    "registered",   # человек открыл ссылку и заполнил форму базовых данных
    "in_progress",  # тест идёт (началось прохождение)
    "completed",    # тест завершён, есть результат
    "expired",      # ссылка отозвана/просрочена
)


class TrainingTopic(Base):
    """
    Тема (направление) тестирования с собственным набором вопросов.
    Создаётся и редактируется только отделом проф.подготовки.
    Кол-во вопросов вычисляется автоматически из связанных TrainingQuestion.
    """
    __tablename__ = "training_topics"

    id          = Column(Integer, primary_key=True, index=True)
    name        = Column(String(200), nullable=False, unique=True)
    description = Column(Text, nullable=True)
    # question_count оставляем как cached поле для совместимости со старыми
    # клиентами, но фактическое значение всегда отдаётся из len(questions).
    question_count   = Column(Integer, nullable=True)
    pass_threshold   = Column(Integer, nullable=True)   # % правильных
    duration_minutes = Column(Integer, nullable=True)   # лимит времени
    created_by  = Column(String(100), nullable=False)   # username создателя
    is_active   = Column(String(1),   nullable=False, default="Y")  # Y/N

    created_at  = Column(DateTime(timezone=True),
                         default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at  = Column(DateTime(timezone=True),
                         default=lambda: datetime.now(timezone.utc),
                         onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    questions = relationship(
        "TrainingQuestion",
        back_populates="topic",
        cascade="all, delete-orphan",
        order_by="TrainingQuestion.order_index, TrainingQuestion.id",
    )


class TrainingQuestion(Base):
    """
    Вопрос внутри темы. Варианты ответов хранятся прямо в options
    (JSONB-массив объектов {text, correct}). Это удобнее чем отдельная
    таблица: вариантов мало (2-6), читаются всегда вместе с вопросом,
    редактируются атомарно одной формой.

    points   — вес вопроса (по умолчанию 1)
    order_index — для сохранения порядка показа в UI
    """
    __tablename__ = "training_questions"

    id       = Column(Integer, primary_key=True, index=True)
    topic_id = Column(
        Integer,
        ForeignKey("training_topics.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    text        = Column(Text, nullable=False)
    options     = Column(JSONB, nullable=False)
    points      = Column(Integer, nullable=False, default=1)
    order_index = Column(Integer, nullable=False, default=0)

    created_at  = Column(DateTime(timezone=True),
                         default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at  = Column(DateTime(timezone=True),
                         default=lambda: datetime.now(timezone.utc),
                         onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    topic = relationship("TrainingTopic", back_populates="questions")


class TrainingAttempt(Base):
    """
    Попытка прохождения теста = персональная ссылка на тест.

    Создаётся отделом проф.подготовки для конкретного человека из общей базы.
    Содержит token для публичного доступа без авторизации; токен подбирается
    случайно (32 hex-символа, ~128 бит энтропии).
    """
    __tablename__ = "training_attempts"

    id        = Column(Integer, primary_key=True, index=True)

    # ── Кому предназначена ──────────────────────────────────────────────────
    # FK с ON DELETE SET NULL — если человека удалят из базы, попытка
    # сохранится как архив (уже могут быть результаты).
    person_id = Column(
        Integer,
        ForeignKey("persons.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    person    = relationship("Person", lazy="joined")
    # Snapshot ФИО на момент создания — для аудита, если Person удалят.
    person_full_name = Column(String(300), nullable=True)

    # ── Темы ────────────────────────────────────────────────────────────────
    # topic_id оставлен для бэкворд-совместимости со старыми попытками; новые
    # ссылки используют topic_ids — JSONB-массив id тем, чтобы один тест мог
    # покрывать несколько направлений одновременно.
    topic_id  = Column(
        Integer,
        ForeignKey("training_topics.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    topic     = relationship("TrainingTopic", lazy="joined")
    topic_ids = Column(JSONB, nullable=True)

    # ── Доступ ──────────────────────────────────────────────────────────────
    token      = Column(String(64), unique=True, nullable=False, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)

    # ── Этап 1: регистрация (форма базовых данных) ──────────────────────────
    registered_at    = Column(DateTime(timezone=True), nullable=True)
    form_phone       = Column(String(50),  nullable=True)
    form_department  = Column(String(100), nullable=True)
    form_position    = Column(String(200), nullable=True)
    # JSONB — задел под произвольные доп.поля анкеты в будущем
    form_extra       = Column(JSONB, nullable=True)

    # ── Этап 2: прохождение теста (заглушка под будущее) ────────────────────
    started_at    = Column(DateTime(timezone=True), nullable=True)
    completed_at  = Column(DateTime(timezone=True), nullable=True)
    score         = Column(Integer, nullable=True)
    # answers — массив {question_id, answer, correct}
    answers       = Column(JSONB, nullable=True)

    # ── Метаданные ──────────────────────────────────────────────────────────
    status      = Column(String(20), nullable=False, default="created", index=True)
    created_by  = Column(String(100), nullable=False)   # username проф.подготовки
    notes       = Column(Text, nullable=True)

    created_at  = Column(DateTime(timezone=True),
                         default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at  = Column(DateTime(timezone=True),
                         default=lambda: datetime.now(timezone.utc),
                         onupdate=lambda: datetime.now(timezone.utc), nullable=False)

    __table_args__ = (
        Index("ix_training_attempts_status",   "status"),
        Index("ix_training_attempts_person",   "person_id"),
        Index("ix_training_attempts_creator",  "created_by"),
    )
