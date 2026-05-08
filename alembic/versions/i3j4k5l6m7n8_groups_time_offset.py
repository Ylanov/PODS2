"""add time_offset and duty_day_offset to groups

Revision ID: i3j4k5l6m7n8
Revises: h2i3j4k5l6m7
Create Date: 2026-05-08 11:00:00.000000

Поля group.time_offset и group.duty_day_offset.

* time_offset — свободная строковая метка времени готовности группы
  («Ч+0.10», «Ч+1.00», «Ч+3.00»). Отображается рядом с названием
  группы; одинаковые метки получают одинаковый пастельный цвет в UI.
* duty_day_offset — какой день суточного наряда подставлять при
  автозаполнении: 0 = сегодняшний (event.date), 1 = завтрашний
  (event.date + 1). Для групп с большим временем готовности, где
  к моменту реакции уже сменится суточный наряд.

Идемпотентная: проверяет существование колонок через inspector. В
проекте init_db() запускается раньше alembic upgrade и через
Base.metadata.create_all() уже создаёт колонки на новой БД.
"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy import inspect
import sqlalchemy as sa


revision: str = "i3j4k5l6m7n8"
down_revision: Union[str, Sequence[str], None] = "h2i3j4k5l6m7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns(table)}
    return column in cols


def upgrade() -> None:
    if not _has_column("groups", "time_offset"):
        op.add_column(
            "groups",
            sa.Column("time_offset", sa.String(),
                      nullable=False, server_default=""),
        )
    if not _has_column("groups", "duty_day_offset"):
        op.add_column(
            "groups",
            sa.Column("duty_day_offset", sa.Integer(),
                      nullable=False, server_default="0"),
        )


def downgrade() -> None:
    if _has_column("groups", "duty_day_offset"):
        op.drop_column("groups", "duty_day_offset")
    if _has_column("groups", "time_offset"):
        op.drop_column("groups", "time_offset")
