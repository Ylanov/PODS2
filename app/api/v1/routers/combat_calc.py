# app/api/v1/routers/combat_calc.py
"""
API для боевого расчёта.

ИСПРАВЛЕНИЯ:
  1. Роутер разделён на два: admin_router и dept_router.
     main.py подключает их раздельно — больше нет дублирования маршрутов.

  2. _sync_slots убран из GET-эндпоинтов (get_instance_full, get_instance_for_user).
     Теперь вызывается ТОЛЬКО при создании экземпляра (create_instance).
     На каждом чтении не делаем лишний SELECT + потенциальный INSERT.

  3. get_my_instances: добавлен joinedload(template) — убран N+1
     (раньше i.template.title вызывал отдельный SELECT для каждого экземпляра).

Маршруты admin_router (prefix в main.py: /api/v1/admin):
  GET    /combat/templates
  GET    /combat/templates/{id}
  POST   /combat/instances
  GET    /combat/instances
  DELETE /combat/instances/{id}
  GET    /combat/instances/{id}/full
  PATCH  /combat/instances/{id}/status

Маршруты dept_router (prefix в main.py: /api/v1):
  GET    /combat/my/instances
  GET    /combat/instances/{id}/view
  PUT    /combat/slots/{id}
"""

from datetime import date as date_type, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel, Field
from typing import Optional, List

from app.db.database import get_db
from app.models.user import User
from app.models.combat_calc import CombatCalcTemplate, CombatCalcInstance, CombatCalcSlot
from app.api.dependencies import get_current_user, get_current_active_admin, require_permission
from app.core.websockets import manager

# ─── Два отдельных роутера вместо одного ─────────────────────────────────────
admin_router = APIRouter()   # только для администратора
# dept_router требует permission "combat" — admin пропускается автоматически
dept_router  = APIRouter(dependencies=[Depends(require_permission("combat"))])

# Оставляем router как алиас для обратной совместимости если где-то импортируется
router = admin_router


# ─── Схемы ───────────────────────────────────────────────────────────────────

class TemplateResponse(BaseModel):
    id:          int
    title:       str
    description: Optional[str]
    is_active:   bool

    class Config:
        from_attributes = True


class InstanceCreate(BaseModel):
    template_id: int
    calc_date:   date_type


class InstanceResponse(BaseModel):
    id:             int
    template_id:    int
    template_title: str
    calc_date:      date_type
    status:         str

    class Config:
        from_attributes = True


class SlotFill(BaseModel):
    version:   int
    full_name: Optional[str] = Field(default=None, max_length=300)
    rank:      Optional[str] = Field(default=None, max_length=100)
    note:      Optional[str] = Field(default=None, max_length=500)


# ─── Вспомогательная функция: синхронизация слотов ───────────────────────────

def _sync_slots(db: Session, instance: CombatCalcInstance) -> None:
    """
    Создаёт недостающие слоты в CombatCalcSlot по структуре шаблона.

    ВАЖНО: вызывать ТОЛЬКО при создании экземпляра (create_instance),
    НЕ при каждом GET — иначе на каждое чтение выполняется лишний SELECT
    плюс потенциальные INSERT'ы.

    Идемпотентна: уже существующие слоты не трогает.
    """
    structure = instance.template.get_structure()

    # Собираем все (row_key, slot_index) из шаблона
    template_slots = set()
    dept_map = {}   # (row_key, slot_index) → department
    for section in structure.get("sections", []):
        for row in section.get("rows", []):
            key = row["key"]
            for slot in row.get("slots", []):
                idx  = slot["index"]
                dept = slot.get("department", "")
                template_slots.add((key, idx))
                dept_map[(key, idx)] = dept

    # Собираем уже существующие слоты
    existing = {
        (s.row_key, s.slot_index)
        for s in db.query(CombatCalcSlot)
        .filter(CombatCalcSlot.instance_id == instance.id)
        .all()
    }

    # Создаём недостающие
    new_slots = []
    for (key, idx) in template_slots - existing:
        new_slots.append(CombatCalcSlot(
            instance_id=instance.id,
            row_key=key,
            slot_index=idx,
            department=dept_map.get((key, idx), ""),
        ))

    if new_slots:
        db.add_all(new_slots)
        db.commit()


# ─── Вспомогательная функция: построить slots_map из экземпляра ───────────────

def _build_slots_map(inst: CombatCalcInstance) -> dict:
    """Строит dict {row_key: {slot_index: slot_data}} из уже загруженных слотов."""
    slots_map = {}
    for slot in inst.slots:
        if slot.row_key not in slots_map:
            slots_map[slot.row_key] = {}
        slots_map[slot.row_key][slot.slot_index] = {
            "id":         slot.id,
            "full_name":  slot.full_name,
            "rank":       slot.rank,
            "note":       slot.note,
            "department": slot.department,
            "version":    slot.version,
        }
    return slots_map


# ═══════════════════════════════════════════════════════════════════════════════
# ADMIN ROUTER
# ═══════════════════════════════════════════════════════════════════════════════

@admin_router.get("/combat/templates", response_model=List[TemplateResponse])
def list_templates(
    db:    Session = Depends(get_db),
    admin: User    = Depends(get_current_active_admin),
):
    return db.query(CombatCalcTemplate).order_by(CombatCalcTemplate.id).all()


@admin_router.get("/combat/templates/{template_id}")
def get_template(
    template_id: int,
    db:    Session = Depends(get_db),
    admin: User    = Depends(get_current_active_admin),
):
    t = db.query(CombatCalcTemplate).filter(CombatCalcTemplate.id == template_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Шаблон не найден")
    return {
        "id":          t.id,
        "title":       t.title,
        "description": t.description,
        "is_active":   t.is_active,
        "structure":   t.get_structure(),
    }


@admin_router.get("/combat/instances")
def list_instances(
    calc_date: Optional[date_type] = Query(None),
    db:    Session = Depends(get_db),
    admin: User    = Depends(get_current_active_admin),
):
    # ИСПРАВЛЕНО: добавлен joinedload чтобы не делать N+1 при обращении к i.template.title
    q = (
        db.query(CombatCalcInstance)
        .options(joinedload(CombatCalcInstance.template))
        .join(CombatCalcInstance.template)
    )
    if calc_date:
        q = q.filter(CombatCalcInstance.calc_date == calc_date)
    instances = q.order_by(CombatCalcInstance.calc_date.desc()).limit(100).all()
    return [
        {
            "id":             i.id,
            "template_id":    i.template_id,
            "template_title": i.template.title,
            "calc_date":      i.calc_date.isoformat(),
            "status":         i.status,
        }
        for i in instances
    ]


@admin_router.post("/combat/instances", status_code=201)
async def create_instance(
    payload: InstanceCreate,
    db:      Session = Depends(get_db),
    admin:   User    = Depends(get_current_active_admin),
):
    template = db.query(CombatCalcTemplate).filter(
        CombatCalcTemplate.id == payload.template_id
    ).first()
    if not template:
        raise HTTPException(status_code=404, detail="Шаблон не найден")

    # Проверяем дубликат
    existing = db.query(CombatCalcInstance).filter(
        CombatCalcInstance.template_id == payload.template_id,
        CombatCalcInstance.calc_date   == payload.calc_date,
    ).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Расчёт по этому шаблону на {payload.calc_date} уже существует"
        )

    instance = CombatCalcInstance(
        template_id=payload.template_id,
        calc_date=payload.calc_date,
        status="active",
    )
    db.add(instance)
    db.commit()
    db.refresh(instance)

    # _sync_slots вызываем ТОЛЬКО здесь — при создании, не при каждом чтении
    _sync_slots(db, instance)

    await manager.broadcast({"action": "combat_calc_update"})
    return {
        "id":             instance.id,
        "template_id":    instance.template_id,
        "template_title": template.title,
        "calc_date":      instance.calc_date.isoformat(),
        "status":         instance.status,
    }


@admin_router.delete("/combat/instances/{instance_id}", status_code=204)
async def delete_instance(
    instance_id: int,
    db:    Session = Depends(get_db),
    admin: User    = Depends(get_current_active_admin),
):
    inst = db.query(CombatCalcInstance).filter(CombatCalcInstance.id == instance_id).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Экземпляр не найден")
    db.delete(inst)
    db.commit()
    await manager.broadcast({"action": "combat_calc_update"})


@admin_router.get("/combat/instances/{instance_id}/full")
def get_instance_full(
    instance_id: int,
    db:    Session = Depends(get_db),
    admin: User    = Depends(get_current_active_admin),
):
    """
    Возвращает экземпляр с шаблонной структурой и заполненными слотами.

    ИСПРАВЛЕНО: убран вызов _sync_slots — он выполнялся на каждый GET,
    делая лишний SELECT + возможный INSERT. Слоты создаются один раз при
    create_instance. Здесь просто читаем то что есть.
    """
    inst = (
        db.query(CombatCalcInstance)
        .options(joinedload(CombatCalcInstance.template))
        .filter(CombatCalcInstance.id == instance_id)
        .first()
    )
    if not inst:
        raise HTTPException(status_code=404, detail="Экземпляр не найден")

    return {
        "instance": {
            "id":             inst.id,
            "template_id":    inst.template_id,
            "template_title": inst.template.title,
            "calc_date":      inst.calc_date.isoformat(),
            "status":         inst.status,
        },
        "structure": inst.template.get_structure(),
        "slots_map": _build_slots_map(inst),
    }


@admin_router.patch("/combat/instances/{instance_id}/status")
async def set_instance_status(
    instance_id: int,
    db:    Session = Depends(get_db),
    admin: User    = Depends(get_current_active_admin),
):
    inst = db.query(CombatCalcInstance).filter(CombatCalcInstance.id == instance_id).first()
    if not inst:
        raise HTTPException(status_code=404, detail="Экземпляр не найден")
    cycle = {"draft": "active", "active": "closed", "closed": "draft"}
    inst.status = cycle.get(inst.status, "active")
    db.commit()
    await manager.broadcast({"action": "combat_calc_update"})
    return {"status": inst.status}


# ═══════════════════════════════════════════════════════════════════════════════
# DEPT ROUTER (управления)
# ═══════════════════════════════════════════════════════════════════════════════

@dept_router.get("/combat/my/instances")
def get_my_instances(
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Возвращает активные экземпляры расчёта.
    Для управления — только активные. Для администратора — все.

    ИСПРАВЛЕНО: добавлен joinedload(template) — устранён N+1.
    Раньше i.template.title для каждого экземпляра делал отдельный SELECT.
    """
    q = (
        db.query(CombatCalcInstance)
        .options(joinedload(CombatCalcInstance.template))
        .join(CombatCalcInstance.template)
    )

    if current_user.role != "admin":
        q = q.filter(CombatCalcInstance.status == "active")

    instances = q.order_by(CombatCalcInstance.calc_date.desc()).limit(50).all()
    return [
        {
            "id":             i.id,
            "template_id":    i.template_id,
            "template_title": i.template.title,  # теперь без lazy load
            "calc_date":      i.calc_date.isoformat(),
            "status":         i.status,
        }
        for i in instances
    ]


@dept_router.get("/combat/instances/{instance_id}/view")
def get_instance_for_user(
    instance_id:  int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Возвращает полный экземпляр для заполнения пользователем.

    ИСПРАВЛЕНО: убран вызов _sync_slots — не нужен при каждом чтении.
    Слоты уже были созданы при create_instance.
    """
    inst = (
        db.query(CombatCalcInstance)
        .options(joinedload(CombatCalcInstance.template))
        .filter(CombatCalcInstance.id == instance_id)
        .first()
    )
    if not inst:
        raise HTTPException(status_code=404, detail="Расчёт не найден")

    if current_user.role != "admin" and inst.status != "active":
        raise HTTPException(status_code=403, detail="Расчёт не активен")

    return {
        "instance": {
            "id":             inst.id,
            "template_id":    inst.template_id,
            "template_title": inst.template.title,
            "calc_date":      inst.calc_date.isoformat(),
            "status":         inst.status,
        },
        "structure":     inst.template.get_structure(),
        "slots_map":     _build_slots_map(inst),
        "my_department": current_user.username,
    }


@dept_router.put("/combat/slots/{slot_id}")
async def fill_slot(
    slot_id:      int,
    payload:      SlotFill,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    slot = db.query(CombatCalcSlot).filter(CombatCalcSlot.id == slot_id).first()
    if not slot:
        raise HTTPException(status_code=404, detail="Слот не найден")

    # Проверяем статус экземпляра
    inst = db.query(CombatCalcInstance).filter(
        CombatCalcInstance.id == slot.instance_id
    ).first()
    if inst and inst.status == "closed" and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Расчёт закрыт для редактирования")

    if slot.version != payload.version:
        raise HTTPException(
            status_code=409,
            detail="Конфликт версий. Перезагрузите страницу."
        )

    slot.full_name = payload.full_name or None
    slot.rank      = payload.rank      or None
    slot.note      = payload.note      or None
    slot.version  += 1

    # Если не задан department — ставим текущего пользователя
    if not slot.department:
        slot.department = current_user.username

    db.commit()

    await manager.broadcast({
        "action":      "combat_calc_slot_update",
        "instance_id": slot.instance_id,
    })

    return {
        "id":        slot.id,
        "full_name": slot.full_name,
        "rank":      slot.rank,
        "note":      slot.note,
        "version":   slot.version,
    }