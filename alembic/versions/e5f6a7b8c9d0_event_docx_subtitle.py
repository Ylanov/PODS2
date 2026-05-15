"""events.docx_subtitle — multiline-описание для шапки .docx

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-05-15 14:00:00.000000

Шапка выгружаемого .docx-документа сейчас формируется как:
    Состав
    <event.title>
    на <event.date>

Для штатных списков (АМГ, эшелоны и пр.) принят описательный подзаголовок
вида:
    1 эшелона аэромобильной группировки ФГКУ «ЦСООР «Лидер»
который не выводится автоматически из event.title (например, «АМГ 1 эшелон»).

Добавляем поле docx_subtitle (TEXT, nullable) — админ заполняет в редакторе
списка многострочный текст; в .docx он подставится между «Состав» и датой.
Если NULL — fallback на event.title (как было раньше).
"""
from typing import Sequence, Union

from alembic import op


revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, Sequence[str], None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE events
            ADD COLUMN IF NOT EXISTS docx_subtitle TEXT;
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE events
            DROP COLUMN IF EXISTS docx_subtitle;
    """)
