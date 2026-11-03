"""Integration tests against a real PostgreSQL (marker `db`): the startup
lifespan migration and the `get_session` / `db_client` round trip."""
import asyncio
import logging

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import Base, ReleasePlanRow
from db_helpers import alembic_config, run_sql
from test_db_migrations import query

pytestmark = pytest.mark.db


@pytest.fixture()
def db_env(migrated_db, monkeypatch):
    """Point the app settings (DB_*) at the test database. Leaves the schema at head."""
    url = make_url(migrated_db)
    monkeypatch.setenv("DB_HOST", url.host or "localhost")
    monkeypatch.setenv("DB_PORT", str(url.port or 5432))
    monkeypatch.setenv("DB_USER", url.username or "")
    monkeypatch.setenv("DB_PASSWORD", url.password or "")
    monkeypatch.setenv("DB_MIGRATE_ON_STARTUP", "true")
    monkeypatch.setenv("DB_STARTUP_TIMEOUT_SECONDS", "10")
    get_settings.cache_clear()
    try:
        yield migrated_db
    finally:
        get_settings.cache_clear()
        command.upgrade(alembic_config(migrated_db), "head")


def _tables(url: str) -> list[str]:
    rows = query(url, "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1")
    return [r[0] for r in rows]


def test_lifespan_migrates_empty_schema_to_head_and_is_idempotent(db_env, caplog):
    url = db_env
    command.downgrade(alembic_config(url), "base")
    assert "release_plans" not in _tables(url)

    with caplog.at_level(logging.INFO, logger="app.db"):
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200
    assert "release_plans" in _tables(url)
    assert query(url, "SELECT version_num FROM alembic_version") == [("0001",)]
    assert "Database migrations applied" in caplog.text
    assert ":planninghub@" not in caplog.text and ":***@" in caplog.text

    # Second start: no error, nothing duplicated, data survives.
    run_sql(url, "INSERT INTO release_plans (name, project_type, project_name, state) VALUES ('a','cloud','P','{}')")
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
    assert query(url, "SELECT version_num FROM alembic_version") == [("0001",)]
    assert query(url, "SELECT count(*) FROM release_plans") == [(1,)]
    run_sql(url, "TRUNCATE release_plans RESTART IDENTITY")


def test_lifespan_with_wrong_password_fails_without_leaking_it(db_env, monkeypatch, caplog):
    monkeypatch.setenv("DB_PASSWORD", "definitely-wrong-pw-xyz")
    monkeypatch.setenv("DB_STARTUP_TIMEOUT_SECONDS", "0.3")
    monkeypatch.setattr("app.db.RETRY_DELAY_SECONDS", 0.05)
    get_settings.cache_clear()
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(Exception) as excinfo:
            with TestClient(app):
                pass
    assert "definitely-wrong-pw-xyz" not in caplog.text
    assert "definitely-wrong-pw-xyz" not in str(excinfo.value)


def test_lifespan_disposes_engine_on_shutdown(db_env):
    import app.db as db

    with TestClient(app):
        assert db._engine is not None
    assert db._engine is None and db._sessionmaker is None


def test_models_match_migration_head(migrated_db):
    """No drift between `ReleasePlanRow` and what migration 0001 created."""

    async def _diff():
        engine = create_async_engine(migrated_db, poolclass=NullPool)
        try:
            async with engine.connect() as conn:
                return await conn.run_sync(
                    lambda c: compare_metadata(MigrationContext.configure(c), Base.metadata)
                )
        finally:
            await engine.dispose()

    assert asyncio.run(_diff()) == []


def test_get_session_round_trip_preserves_jsonb_and_db_timestamps(db_client):
    probe = FastAPI()
    state = {"milestones": [{"id": "m1", "name": "Ünï €", "items": [1, 2.5, None, True]}], "nested": {"a": []}}

    @probe.post("/probe")
    async def create(session: AsyncSession = Depends(get_session)):
        row = ReleasePlanRow(name="Plan", project_type="cloud", project_name="Proj", state=state)
        session.add(row)
        await session.commit()
        return {"id": row.id}

    @probe.get("/probe/{plan_id}")
    async def read(plan_id: int, session: AsyncSession = Depends(get_session)):
        row = (await session.execute(select(ReleasePlanRow).where(ReleasePlanRow.id == plan_id))).scalar_one()
        return {
            "state": row.state,
            "created": row.created_at.isoformat(),
            "updated": row.updated_at.isoformat(),
            "tz": row.created_at.tzinfo is not None,
        }

    probe.dependency_overrides = dict(app.dependency_overrides)
    client = TestClient(probe)
    first = client.post("/probe").json()["id"]
    second = client.post("/probe").json()["id"]
    assert (first, second) == (1, 2)  # RESTART IDENTITY in clean_db
    body = client.get(f"/probe/{first}").json()
    assert body["state"] == state
    assert body["tz"] is True
    assert body["created"] == body["updated"]  # both now() in the same insert transaction


def test_table_constraints_reject_nulls(clean_db):
    async def _insert():
        engine = create_async_engine(clean_db, poolclass=NullPool)
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    text("INSERT INTO release_plans (name, project_type, project_name) VALUES ('n','cloud','p')")
                )
        finally:
            await engine.dispose()

    with pytest.raises(IntegrityError):
        asyncio.run(_insert())


def test_index_orders_by_updated_at_desc_then_id_desc(clean_db):
    for i, ts in enumerate(["2026-01-01", "2026-01-03", "2026-01-03"], start=1):
        run_sql(
            clean_db,
            f"INSERT INTO release_plans (name, project_type, project_name, state, updated_at) "
            f"VALUES ('p{i}','cloud','x','{{}}','{ts}')",
        )
    rows = query(clean_db, "SELECT name FROM release_plans ORDER BY updated_at DESC, id DESC")
    assert [r[0] for r in rows] == ["p3", "p2", "p1"]
