"""text -> jsonb для всех JSON-колонок

Revision ID: s3t4u5v6w7x8
Revises: r2s3t4u5v6w7
Create Date: 2026-05-10 14:00:00.000000

Под нагрузку 500-1000 онлайн переводим 9 «JSON-в-Text» колонок на JSONB:

  combat_calc_templates.structure_json
  duty_schedules.applicable_template_ids
  duty_marks.substitutes_json
  events.columns_config
  slots.extra_data
  oper_map_zones.polygon_json
  sed_inbox_snapshots.sections_json
  sed_letters.meta_json
  sed_letters.files_json

Эффект:
  • Перестаёт дёргаться json.loads/json.dumps на каждом get/set —
    SQLAlchemy + psycopg2 сами конвертируют JSONB ↔ Python dict/list.
    На «горячих» путях (build_event_summary, _get_substitutes_for_date,
    rendering grid) это много миллионов строк лишнего парсинга в день.
  • Возможны индексы по полям внутри JSON (GIN, btree expression) —
    пригодится в analytics-запросах.
  • WHERE column->>'key' = ... работает нативно.

Миграция атомарная (один ALTER TABLE на колонку через USING column::jsonb).
Идемпотентная — проверяем текущий data_type через information_schema.
"""
from typing import Sequence, Union

from alembic import op


revision: str = "s3t4u5v6w7x8"
down_revision: Union[str, Sequence[str], None] = "r2s3t4u5v6w7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on:    Union[str, Sequence[str], None] = None


# (table, column, default-выражение для нового JSONB)
_CONVERSIONS: list[tuple[str, str, str | None]] = [
    ("combat_calc_templates", "structure_json",          "'{}'::jsonb"),
    ("duty_schedules",        "applicable_template_ids", None),           # nullable
    ("duty_marks",            "substitutes_json",        None),           # nullable
    ("events",                "columns_config",          None),           # nullable
    ("slots",                 "extra_data",              None),           # nullable
    ("oper_map_zones",        "polygon_json",            "'{}'::jsonb"),
    ("sed_inbox_snapshots",   "sections_json",           "'[]'::jsonb"),
    ("sed_letters",           "meta_json",               "'{}'::jsonb"),
    ("sed_letters",           "files_json",              "'[]'::jsonb"),
]


def _convert(table: str, column: str, default_expr: str | None) -> str:
    """
    Возвращает SQL-блок DO $$ который конвертирует Text -> JSONB только если
    колонка ещё не JSONB. Иначе no-op.
    """
    set_default = ""
    if default_expr:
        # Внутри EXECUTE '...' одинарные кавычки нужно удваивать, иначе
        # '{}'::jsonb преждевременно закрывает строку EXECUTE.
        escaped = default_expr.replace("'", "''")
        set_default = f"""
                EXECUTE 'ALTER TABLE {table}
                         ALTER COLUMN {column} SET DEFAULT {escaped}';
        """
    return f"""
        DO $$
        DECLARE
            cur_type TEXT;
        BEGIN
            SELECT data_type INTO cur_type
              FROM information_schema.columns
             WHERE table_name='{table}' AND column_name='{column}';

            IF cur_type IS NULL THEN
                -- Колонки вообще нет (миграция выше не накатилась) — пропускаем.
                RETURN;
            END IF;

            IF cur_type = 'jsonb' THEN
                -- Уже JSONB — повторный прогон, ничего не делаем.
                RETURN;
            END IF;

            -- Сначала чистим default, иначе ALTER TYPE может ругнуться на
            -- несовместимое выражение default по умолчанию (text vs jsonb).
            EXECUTE 'ALTER TABLE {table} ALTER COLUMN {column} DROP DEFAULT';

            -- Конвертация. NULL и валидные JSON-строки уйдут в jsonb без проблем.
            -- Если в БД был мусор/невалидный JSON — упадёт; но за все
            -- предыдущие миграции мы писали туда только через json.dumps,
            -- так что данные валидны.
            EXECUTE 'ALTER TABLE {table}
                     ALTER COLUMN {column} TYPE JSONB
                     USING ' || quote_ident('{column}') || '::jsonb';
            {set_default}
        END $$;
    """


def upgrade() -> None:
    for table, column, default_expr in _CONVERSIONS:
        op.execute(_convert(table, column, default_expr))


def downgrade() -> None:
    # Обратная конвертация JSONB -> TEXT. Можно простой ALTER без USING
    # (Postgres сам делает text(jsonb) → строковая форма).
    for table, column, default_expr in _CONVERSIONS:
        op.execute(f"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                     WHERE table_name='{table}'
                       AND column_name='{column}'
                       AND data_type='jsonb'
                ) THEN
                    EXECUTE 'ALTER TABLE {table} ALTER COLUMN {column} DROP DEFAULT';
                    EXECUTE 'ALTER TABLE {table}
                             ALTER COLUMN {column} TYPE TEXT
                             USING ' || quote_ident('{column}') || '::text';
                END IF;
            END $$;
        """)
