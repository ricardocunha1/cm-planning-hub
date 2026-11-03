import asyncio

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from db_helpers import alembic_config

pytestmark = pytest.mark.db


def query(url: str, statement: str) -> list[tuple]:
    async def _run() -> list[tuple]:
        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with engine.connect() as connection:
                return [tuple(row) for row in (await connection.execute(text(statement))).all()]
        finally:
            await engine.dispose()

    return asyncio.run(_run())


COLUMNS_SQL = (
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns "
    "WHERE table_name = 'release_plans' ORDER BY ordinal_position"
)


def test_upgrade_creates_release_plans_columns(migrated_db):
    rows = {r[0]: r for r in query(migrated_db, COLUMNS_SQL)}
    assert list(rows) == ["id", "name", "created_at", "updated_at", "project_type", "project_name", "state"]
    assert rows["id"][1] == "integer"
    assert "nextval" in rows["id"][3]
    for name in ("name", "project_type", "project_name"):
        assert rows[name][1] == "text"
    for name in ("created_at", "updated_at"):
        assert rows[name][1] == "timestamp with time zone"
        assert rows[name][3] == "now()"
    assert rows["state"][1] == "jsonb"
    assert all(r[2] == "NO" for r in rows.values())


def test_upgrade_creates_updated_at_index(migrated_db):
    rows = query(migrated_db, "SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_release_plans_updated_at_id'")
    assert len(rows) == 1
    assert "updated_at DESC, id DESC" in rows[0][0]


def test_downgrade_drops_table_and_upgrade_restores_it(migrated_db):
    config = alembic_config(migrated_db)
    try:
        command.downgrade(config, "base")
        assert query(migrated_db, "SELECT to_regclass('release_plans')") == [(None,)]
    finally:
        command.upgrade(config, "head")
    assert query(migrated_db, "SELECT to_regclass('release_plans')") == [("release_plans",)]
