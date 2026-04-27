# app/api/v1/routers/procurement.py
"""
API контроля гос. закупок отдела (на старте — отдел связи).

Эндпоинты:
  GET    /procurement?year=YYYY              — бюджет + список контрактов + агрегаты
  PUT    /procurement/budget?year=YYYY       — обновить ЛБО (создаёт запись если нет)
  POST   /procurement/contracts?year=YYYY    — создать новый контракт
  PUT    /procurement/contracts/{id}         — обновить
  DELETE /procurement/contracts/{id}         — удалить

Доступ:
  • admin       — может смотреть/править любого отдела (?unit=username)
  • role='unit' — только свой отдел
  • остальные   — 403
"""

import os
import re
import uuid
from datetime import datetime, date as date_type
from decimal import Decimal
from pathlib import Path
from typing import Optional, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session, selectinload

from app.db.database import get_db
from app.models.user import User
from app.models.procurement import (
    CommsBudget, CommsContract, CommsContractAttachment,
    CONTRACT_STATUSES, PROCUREMENT_METHODS,
)
from app.api.dependencies import get_current_user


# ─── Файловое хранилище ─────────────────────────────────────────────────────
# Все вложения лежат под storage/procurement/{contract_id}/{stored_name}.
# Корень — внутри проекта (контейнер монтирует /code на host fs), при
# деплое стоит вынести в volume или S3-совместимое хранилище.
_STORAGE_ROOT = Path(__file__).resolve().parents[4] / "storage" / "procurement"
_MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 МБ — достаточно для PDF договоров и сканов
_ALLOWED_EXTS = {".pdf", ".doc", ".docx", ".xls", ".xlsx",
                 ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".zip"}


router = APIRouter()


# ─── Схемы ──────────────────────────────────────────────────────────────────

class BudgetUpdate(BaseModel):
    """Тело запроса обновления ЛБО."""
    lbo_amount: Decimal = Field(..., ge=0)
    notes:      Optional[str] = None


class BudgetResponse(BaseModel):
    unit_username: str
    year:          int
    lbo_amount:    Decimal
    notes:         Optional[str] = None
    updated_at:    datetime

    model_config = ConfigDict(from_attributes=True)


class ContractIn(BaseModel):
    """Создание/редактирование контракта."""
    contract_number:    Optional[str] = Field(None, max_length=120)
    eis_number:         Optional[str] = Field(None, max_length=50)
    subject:            str           = Field(..., min_length=1)
    supplier_name:      Optional[str] = Field(None, max_length=300)
    supplier_inn:       Optional[str] = Field(None, max_length=20)
    amount:             Decimal       = Field(0, ge=0)
    savings:            Decimal       = Field(0, ge=0)
    # Literal требует литералы значений — поэтому дублируем константы здесь.
    # Если CONTRACT_STATUSES в модели расширится — добавить значение и тут.
    status: Literal[
        "plan", "tender", "awarded", "signed",
        "executing", "completed", "terminated",
    ] = "plan"
    procurement_method: Optional[Literal[
        "e_auction", "tender", "quote_request", "single_supplier", "other",
    ]] = None
    contract_date:      Optional[date_type] = None
    start_date:         Optional[date_type] = None
    end_date:           Optional[date_type] = None
    notes:              Optional[str] = None


class AttachmentResponse(BaseModel):
    id:            int
    original_name: str
    content_type:  Optional[str] = None
    size_bytes:    int
    uploaded_by:   Optional[str] = None
    uploaded_at:   datetime

    model_config = ConfigDict(from_attributes=True)


class ContractResponse(BaseModel):
    id:                 int
    unit_username:      str
    year:               int
    contract_number:    Optional[str]  = None
    eis_number:         Optional[str]  = None
    subject:            str
    supplier_name:      Optional[str]  = None
    supplier_inn:       Optional[str]  = None
    amount:             Decimal
    savings:            Decimal
    status:             str
    procurement_method: Optional[str]  = None
    contract_date:      Optional[date_type] = None
    start_date:         Optional[date_type] = None
    end_date:           Optional[date_type] = None
    notes:              Optional[str]  = None
    created_at:         datetime
    updated_at:         datetime
    attachments:        list[AttachmentResponse] = []

    model_config = ConfigDict(from_attributes=True)


class ProcurementSummary(BaseModel):
    """Агрегаты для дашборда."""
    lbo:           Decimal   # ЛБО на год
    planned:       Decimal   # сумма контрактов в "plan"
    in_tender:     Decimal   # в "tender"
    awarded:       Decimal   # в "awarded" (отыграно, не подписано)
    contracted:    Decimal   # signed + executing + completed (заключённые)
    executed:      Decimal   # в "completed"
    remaining:     Decimal   # lbo - contracted (остаток ЛБО)
    savings_total: Decimal   # сумма экономии по всем контрактам
    contracts_count: int


class ProcurementResponse(BaseModel):
    """Полный снимок закупок отдела за год."""
    unit_username: str
    year:          int
    budget:        BudgetResponse
    contracts:     list[ContractResponse]
    summary:       ProcurementSummary


# ─── Вспомогательные функции ────────────────────────────────────────────────

def _resolve_unit(current_user: User, unit_override: Optional[str]) -> str:
    """admin → ?unit или свой логин; unit → свой; остальные → 403."""
    if current_user.role == "admin":
        return (unit_override or current_user.username).strip()
    if current_user.role == "unit":
        return current_user.username
    raise HTTPException(status_code=403, detail="Доступ только для отдела или админа")


def _get_or_create_budget(db: Session, unit: str, year: int) -> CommsBudget:
    b = (
        db.query(CommsBudget)
          .filter(CommsBudget.unit_username == unit, CommsBudget.year == year)
          .first()
    )
    if b:
        return b
    b = CommsBudget(unit_username=unit, year=year, lbo_amount=Decimal(0))
    db.add(b)
    db.commit()
    db.refresh(b)
    return b


def _compute_summary(budget: CommsBudget, contracts: list[CommsContract]) -> ProcurementSummary:
    """
    Считает агрегаты по списку контрактов:
      planned    — статус 'plan'
      in_tender  — 'tender'
      awarded    — 'awarded'
      contracted — 'signed' + 'executing' + 'completed' (вошедшие в обязательства)
      executed   — 'completed'
    """
    by_status = {st: Decimal(0) for st in CONTRACT_STATUSES}
    savings_total = Decimal(0)
    for c in contracts:
        by_status[c.status] = by_status.get(c.status, Decimal(0)) + Decimal(c.amount or 0)
        savings_total += Decimal(c.savings or 0)

    contracted = by_status["signed"] + by_status["executing"] + by_status["completed"]
    return ProcurementSummary(
        lbo             = budget.lbo_amount,
        planned         = by_status["plan"],
        in_tender       = by_status["tender"],
        awarded         = by_status["awarded"],
        contracted      = contracted,
        executed        = by_status["completed"],
        remaining       = budget.lbo_amount - contracted,
        savings_total   = savings_total,
        contracts_count = len(contracts),
    )


# ─── GET: всё разом ─────────────────────────────────────────────────────────

@router.get("", response_model=ProcurementResponse)
def get_procurement(
        year:         int               = Query(..., ge=2020, le=2100),
        unit:         Optional[str]     = Query(None, max_length=100),
        db:           Session           = Depends(get_db),
        current_user: User              = Depends(get_current_user),
):
    unit_name = _resolve_unit(current_user, unit)
    budget = _get_or_create_budget(db, unit_name, year)
    contracts = (
        db.query(CommsContract)
          .options(selectinload(CommsContract.attachments))
          .filter(CommsContract.unit_username == unit_name,
                  CommsContract.year == year)
          .order_by(CommsContract.contract_date.desc().nullslast(),
                    CommsContract.id.desc())
          .all()
    )
    return ProcurementResponse(
        unit_username = unit_name,
        year          = year,
        budget        = BudgetResponse.model_validate(budget),
        contracts     = [ContractResponse.model_validate(c) for c in contracts],
        summary       = _compute_summary(budget, contracts),
    )


# ─── Бюджет ─────────────────────────────────────────────────────────────────

@router.put("/budget", response_model=BudgetResponse)
def update_budget(
        payload:      BudgetUpdate,
        year:         int               = Query(..., ge=2020, le=2100),
        unit:         Optional[str]     = Query(None, max_length=100),
        db:           Session           = Depends(get_db),
        current_user: User              = Depends(get_current_user),
):
    unit_name = _resolve_unit(current_user, unit)
    b = _get_or_create_budget(db, unit_name, year)
    b.lbo_amount = payload.lbo_amount
    b.notes      = payload.notes
    db.commit()
    db.refresh(b)
    return b


# ─── Контракты ──────────────────────────────────────────────────────────────

def _apply_contract_payload(c: CommsContract, payload: ContractIn) -> None:
    c.contract_number    = payload.contract_number
    c.eis_number         = payload.eis_number
    c.subject            = payload.subject
    c.supplier_name      = payload.supplier_name
    c.supplier_inn       = payload.supplier_inn
    c.amount             = payload.amount
    c.savings            = payload.savings
    c.status             = payload.status
    c.procurement_method = payload.procurement_method
    c.contract_date      = payload.contract_date
    c.start_date         = payload.start_date
    c.end_date           = payload.end_date
    c.notes              = payload.notes


@router.post("/contracts", response_model=ContractResponse, status_code=201)
def create_contract(
        payload:      ContractIn,
        year:         int               = Query(..., ge=2020, le=2100),
        unit:         Optional[str]     = Query(None, max_length=100),
        db:           Session           = Depends(get_db),
        current_user: User              = Depends(get_current_user),
):
    unit_name = _resolve_unit(current_user, unit)
    c = CommsContract(unit_username=unit_name, year=year)
    _apply_contract_payload(c, payload)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


@router.put("/contracts/{contract_id}", response_model=ContractResponse)
def update_contract(
        contract_id:  int,
        payload:      ContractIn,
        db:           Session           = Depends(get_db),
        current_user: User              = Depends(get_current_user),
):
    c = db.query(CommsContract).filter(CommsContract.id == contract_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Контракт не найден")
    # Проверка доступа: unit-юзер видит только свои
    if current_user.role == "unit" and c.unit_username != current_user.username:
        raise HTTPException(status_code=403, detail="Чужой отдел")
    if current_user.role not in ("admin", "unit"):
        raise HTTPException(status_code=403, detail="Доступ запрещён")

    _apply_contract_payload(c, payload)
    db.commit()
    db.refresh(c)
    return c


@router.delete("/contracts/{contract_id}", status_code=204)
def delete_contract(
        contract_id:  int,
        db:           Session           = Depends(get_db),
        current_user: User              = Depends(get_current_user),
):
    c = (
        db.query(CommsContract)
          .options(selectinload(CommsContract.attachments))
          .filter(CommsContract.id == contract_id).first()
    )
    if not c:
        raise HTTPException(status_code=404, detail="Контракт не найден")
    if current_user.role == "unit" and c.unit_username != current_user.username:
        raise HTTPException(status_code=403, detail="Чужой отдел")
    if current_user.role not in ("admin", "unit"):
        raise HTTPException(status_code=403, detail="Доступ запрещён")

    # Сначала чистим файлы на диске — каскад БД удалит записи attachments,
    # но мы должны успеть забрать их пути до того как они исчезнут.
    contract_dir = _STORAGE_ROOT / str(c.id)
    if contract_dir.exists():
        for f in contract_dir.iterdir():
            try: f.unlink()
            except OSError: pass
        try: contract_dir.rmdir()
        except OSError: pass

    db.delete(c)
    db.commit()
    return None


# ─── Вложения (договор, акты, доп. соглашения) ──────────────────────────────

def _check_contract_access(c: CommsContract, current_user: User) -> None:
    if not c:
        raise HTTPException(status_code=404, detail="Контракт не найден")
    if current_user.role == "unit" and c.unit_username != current_user.username:
        raise HTTPException(status_code=403, detail="Чужой отдел")
    if current_user.role not in ("admin", "unit"):
        raise HTTPException(status_code=403, detail="Доступ запрещён")


def _safe_filename(name: str) -> str:
    """
    Очищает пользовательское имя файла: убирает пути, нормализует пробелы,
    режет до 200 символов. Используется ТОЛЬКО для отображения, на диске
    лежит под uuid-префиксом, так что safe_filename — для красоты в UI.
    """
    base = os.path.basename(name)
    base = re.sub(r"[\\/:*?\"<>|]+", "_", base)
    base = re.sub(r"\s+", " ", base).strip()
    return base[:200] or "file"


@router.post("/contracts/{contract_id}/attachments",
             response_model=AttachmentResponse, status_code=201)
async def upload_attachment(
        contract_id:  int,
        file:         UploadFile = File(...),
        db:           Session    = Depends(get_db),
        current_user: User       = Depends(get_current_user),
):
    c = db.query(CommsContract).filter(CommsContract.id == contract_id).first()
    _check_contract_access(c, current_user)

    original = _safe_filename(file.filename or "file")
    ext = os.path.splitext(original)[1].lower()
    if _ALLOWED_EXTS and ext and ext not in _ALLOWED_EXTS:
        raise HTTPException(
            status_code=400,
            detail=f"Недопустимый тип файла: {ext}. "
                   f"Разрешено: {', '.join(sorted(_ALLOWED_EXTS))}",
        )

    # Чтение в память с проверкой размера. Streaming-вариант сложнее
    # из-за необходимости знать размер до commit'а в БД — для 25МБ потолка
    # в RAM это нормальная цена.
    content = await file.read()
    if len(content) > _MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Файл больше {_MAX_UPLOAD_BYTES // (1024 * 1024)} МБ",
        )

    # Запись на диск под уникальным именем
    contract_dir = _STORAGE_ROOT / str(contract_id)
    contract_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_{original}"
    target_path = contract_dir / stored_name
    target_path.write_bytes(content)

    att = CommsContractAttachment(
        contract_id   = contract_id,
        original_name = original,
        stored_name   = stored_name,
        content_type  = file.content_type,
        size_bytes    = len(content),
        uploaded_by   = current_user.username,
    )
    db.add(att)
    db.commit()
    db.refresh(att)
    return att


@router.get("/attachments/{attachment_id}/download")
def download_attachment(
        attachment_id: int,
        db:            Session  = Depends(get_db),
        current_user:  User     = Depends(get_current_user),
):
    att = (
        db.query(CommsContractAttachment)
          .filter(CommsContractAttachment.id == attachment_id)
          .first()
    )
    if not att:
        raise HTTPException(status_code=404, detail="Файл не найден")
    contract = db.query(CommsContract).filter(CommsContract.id == att.contract_id).first()
    _check_contract_access(contract, current_user)

    file_path = _STORAGE_ROOT / str(att.contract_id) / att.stored_name
    if not file_path.exists():
        raise HTTPException(status_code=410, detail="Файл удалён с диска")

    # Корректное имя для скачивания (UTF-8 в RFC 5987)
    return FileResponse(
        path=str(file_path),
        media_type=att.content_type or "application/octet-stream",
        headers={
            "Content-Disposition":
                f"attachment; filename*=UTF-8''{quote(att.original_name)}",
        },
    )


@router.delete("/attachments/{attachment_id}", status_code=204)
def delete_attachment(
        attachment_id: int,
        db:            Session = Depends(get_db),
        current_user:  User    = Depends(get_current_user),
):
    att = (
        db.query(CommsContractAttachment)
          .filter(CommsContractAttachment.id == attachment_id)
          .first()
    )
    if not att:
        raise HTTPException(status_code=404, detail="Файл не найден")
    contract = db.query(CommsContract).filter(CommsContract.id == att.contract_id).first()
    _check_contract_access(contract, current_user)

    file_path = _STORAGE_ROOT / str(att.contract_id) / att.stored_name
    if file_path.exists():
        try: file_path.unlink()
        except OSError: pass

    db.delete(att)
    db.commit()
    return None
