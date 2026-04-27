# app/api/v1/routers/tasks.py
"""
Личные календари пользователей — задачи и планы.

Маршруты:
    GET    /tasks                       — свои задачи (или по фильтру owner_id для админа)
    POST   /tasks                       — создать задачу
    GET    /tasks/{task_id}             — одна задача
    PATCH  /tasks/{task_id}             — обновить
    DELETE /tasks/{task_id}             — удалить
    GET    /tasks/admin/summary         — агрегированный отчёт по всем
                                          пользователям (только админ)

Правила доступа:
    • Управления видят / редактируют только свои задачи.
    • Админ видит все задачи и может фильтровать по owner_id.
"""

from datetime import date as date_type
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func, and_
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel, ConfigDict

from app.db.database import get_db
from app.models.user import User
from app.models.task import Task
from app.schemas.task import TaskCreate, TaskUpdate, TaskResponse
from app.api.dependencies import get_current_user, get_current_active_admin, require_permission

# Весь роутер задач требует permission "tasks" (admin пропускается автоматически
# в require_permission). /admin/summary дополнительно защищён get_current_active_admin.
router = APIRouter(dependencies=[Depends(require_permission("tasks"))])


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _serialize(task: Task, include_owner: bool = False) -> dict:
    """Превращает Task в словарь, опционально добавляя owner_username."""
    out = {
        "id":          task.id,
        "owner_id":    task.owner_id,
        "title":       task.title,
        "description": task.description,
        "due_date":    task.due_date,
        "time_from":   task.time_from,
        "time_to":     task.time_to,
        "priority":    task.priority,
        "status":      task.status,
        "category":    task.category,
        "color":       task.color,
        "created_at":  task.created_at,
        "updated_at":  task.updated_at,
    }
    if include_owner:
        out["owner_username"] = task.owner.username if task.owner else None
    return out


def _get_owned_task(db: Session, task_id: int, user: User) -> Task:
    task = (
        db.query(Task)
        .options(joinedload(Task.owner))
        .filter(Task.id == task_id)
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="Задача не найдена")
    if user.role != "admin" and task.owner_id != user.id:
        raise HTTPException(status_code=403, detail="Эта задача принадлежит другому пользователю")
    return task


# ─── Список задач ─────────────────────────────────────────────────────────────

@router.get("", response_model=List[TaskResponse], summary="Список задач (свои или всех — для админа)")
def list_tasks(
    date_from: Optional[date_type] = Query(None, description="Дата начала диапазона"),
    date_to:   Optional[date_type] = Query(None, description="Дата конца диапазона"),
    owner_id:  Optional[int]       = Query(None, description="Только для админа: фильтр по владельцу"),
    status_f:  Optional[str]       = Query(None, alias="status", description="pending | in_progress | done"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(Task).options(joinedload(Task.owner))

    # Управления видят только свои задачи, админ — всё (можно фильтровать по owner_id)
    if current_user.role != "admin":
        query = query.filter(Task.owner_id == current_user.id)
    elif owner_id is not None:
        query = query.filter(Task.owner_id == owner_id)

    if date_from is not None:
        query = query.filter(Task.due_date >= date_from)
    if date_to is not None:
        query = query.filter(Task.due_date <= date_to)
    if status_f:
        query = query.filter(Task.status == status_f)

    tasks = query.order_by(Task.due_date.asc(), Task.id.asc()).all()
    include_owner = current_user.role == "admin"
    return [_serialize(t, include_owner=include_owner) for t in tasks]


# ─── Создание ─────────────────────────────────────────────────────────────────

@router.post("", response_model=TaskResponse, status_code=201, summary="Создать задачу")
def create_task(
    payload: TaskCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    new_task = Task(
        owner_id    = current_user.id,
        title       = payload.title,
        description = payload.description,
        due_date    = payload.due_date,
        time_from   = payload.time_from,
        time_to     = payload.time_to,
        priority    = payload.priority,
        status      = payload.status,
        category    = payload.category,
        color       = payload.color,
    )
    db.add(new_task)
    db.commit()
    db.refresh(new_task)
    # Подгружаем owner чтобы отдать username
    db.refresh(new_task, attribute_names=None)
    return _serialize(new_task, include_owner=(current_user.role == "admin"))


# ─── Одна задача ──────────────────────────────────────────────────────────────

@router.get("/{task_id}", response_model=TaskResponse)
def get_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = _get_owned_task(db, task_id, current_user)
    return _serialize(task, include_owner=(current_user.role == "admin"))


# ─── Обновление ───────────────────────────────────────────────────────────────

@router.patch("/{task_id}", response_model=TaskResponse)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = _get_owned_task(db, task_id, current_user)

    data = payload.model_dump(exclude_unset=True)
    for key, val in data.items():
        setattr(task, key, val)

    db.commit()
    db.refresh(task)
    return _serialize(task, include_owner=(current_user.role == "admin"))


# ─── Удаление ─────────────────────────────────────────────────────────────────

@router.delete("/{task_id}", status_code=status.HTTP_200_OK)
def delete_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = _get_owned_task(db, task_id, current_user)
    db.delete(task)
    db.commit()
    return {"message": "Задача удалена"}


# ─── Админ: сводка по всем пользователям ──────────────────────────────────────

class OwnerSummary(BaseModel):
    owner_id:           int
    owner_username:     str
    total:              int
    pending:            int
    in_progress:        int
    done:               int
    overdue:            int
    upcoming_7d:        int
    model_config = ConfigDict(from_attributes=True)


@router.get(
    "/admin/summary",
    response_model=List[OwnerSummary],
    summary="Сводка по всем пользователям (только админ)",
)
def admin_summary(
    db: Session = Depends(get_db),
    admin: User = Depends(get_current_active_admin),
):
    # ИСПРАВЛЕНО: раньше для каждого пользователя было 6 отдельных COUNT'ов.
    # При 2к пользователей × 6 запросов = 12 000 round-trip'ов + TABLE SCAN'ов
    # каждый раз. Теперь — ОДИН запрос с агрегацией через CASE WHEN.
    # PostgreSQL проходит по tasks один раз с групировкой по owner_id и считает
    # сразу все нужные срезы. Время ответа: секунды → миллисекунды.
    from datetime import timedelta
    today = date_type.today()
    in_7d = today + timedelta(days=7)

    # Один SUM(CASE WHEN ...) на каждый срез — аналог FILTER (WHERE ...)
    # но работает и на старых Postgres, и на SQLite в тестах.
    pending_expr    = func.sum(case((Task.status == "pending",     1), else_=0))
    in_prog_expr    = func.sum(case((Task.status == "in_progress", 1), else_=0))
    done_expr       = func.sum(case((Task.status == "done",        1), else_=0))
    overdue_expr    = func.sum(case(
        (and_(Task.status != "done", Task.due_date < today), 1), else_=0
    ))
    upcoming_expr   = func.sum(case(
        (and_(
            Task.status != "done",
            Task.due_date >= today,
            Task.due_date <= in_7d,
        ), 1), else_=0
    ))

    # LEFT JOIN от users к tasks — пользователи без задач тоже попадают
    # в результат (total=0), если это не admin (их скрываем дальше).
    rows = (
        db.query(
            User.id,
            User.username,
            User.role,
            func.count(Task.id).label("total"),
            pending_expr.label("pending"),
            in_prog_expr.label("in_prog"),
            done_expr.label("done"),
            overdue_expr.label("overdue"),
            upcoming_expr.label("upcoming"),
        )
        .outerjoin(Task, Task.owner_id == User.id)
        .group_by(User.id, User.username, User.role)
        .order_by(User.id)
        .all()
    )

    result: List[dict] = []
    for r in rows:
        total = r.total or 0
        # Админа без задач не показываем, чтобы не шумел
        if total == 0 and r.role == "admin":
            continue
        result.append({
            "owner_id":       r.id,
            "owner_username": r.username,
            "total":          total,
            "pending":        int(r.pending    or 0),
            "in_progress":    int(r.in_prog    or 0),
            "done":           int(r.done       or 0),
            "overdue":        int(r.overdue    or 0),
            "upcoming_7d":    int(r.upcoming   or 0),
        })
    return result
