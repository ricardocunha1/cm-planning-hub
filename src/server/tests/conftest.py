import asyncio
import os
from pathlib import Path

import pytest
# The tests run without Google credentials: switch authentication off for the
# whole process before the app is imported (the auth tests build their own app
# with explicit settings). Set unconditionally so a developer's shell cannot
# make the suite fail.
os.environ["AUTH_ENABLED"] = "false"

from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.api.deps import require_csrf, require_user
import app.db as app_db
from app.db import get_session
from app.main import app
from db_helpers import alembic_config, run_sql
from fake_session import FakeSession
from app.services.data_processing import (
    build_sprint_summary,
    parse_sprint_history,
    summary_to_records,
)

FIXTURE_PATH = Path(__file__).resolve().parents[3] / "notebook" / "Sprint_History.xlsx"


@pytest.fixture(autouse=True)
def _reset_cached_engine():
    """Drop the process-wide engine/sessionmaker of `app.db` after each test, so
    one built by a test that bypassed the session override (no DB credentials)
    cannot leak into the later database tests."""
    yield
    engine = app_db._engine
    app_db._engine = None
    app_db._sessionmaker = None
    if engine is not None:
        # close=False: connections may belong to a closed event loop.
        engine.sync_engine.dispose(close=False)


@pytest.fixture(autouse=True)
def _bypass_auth():
    """The global `app` requires a session on its protected routes. Every test
    that uses it runs as signed-in user 1 with no CSRF header, against an empty
    fake database (so a route that needs no stored data never connects); the auth tests
    (test_auth_*.py) build their own app with `create_app` instead."""
    app.dependency_overrides[require_user] = lambda: 1
    app.dependency_overrides[require_csrf] = lambda: None

    async def no_database():
        yield FakeSession()  # nothing saved; db tests install their own session

    app.dependency_overrides[get_session] = no_database
    yield
    app.dependency_overrides.pop(require_user, None)
    app.dependency_overrides.pop(require_csrf, None)
    app.dependency_overrides.pop(get_session, None)


@pytest.fixture()
def client():
    return TestClient(app)


@pytest.fixture()
def fixture_summary_records():
    with FIXTURE_PATH.open("rb") as f:
        df = parse_sprint_history(f)
    return summary_to_records(build_sprint_summary(df, exclude_latest=1))


# --- PostgreSQL fixtures (tests marked `db`) -------------------------------
# Skipped unless TEST_DATABASE_URL is set. The helpers are synchronous and use
# `asyncio.run` with NullPool engines, so no asyncpg connection outlives the
# event loop that created it (TestClient runs requests on its own loops).


@pytest.fixture(scope="session")
def db_url() -> str:
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL is not set")
    return url


@pytest.fixture(scope="session")
def migrated_db(db_url: str) -> str:
    """The test database upgraded to the latest revision (once per session)."""
    command.upgrade(alembic_config(db_url), "head")
    return db_url


@pytest.fixture()
def clean_db(migrated_db: str) -> str:
    """The migrated test database emptied for this test, holding only user 1:
    the signed-in user `_bypass_auth` injects, which owns the boards REST tests
    create (`release_plans.owner_id` is a foreign key to `users`)."""
    run_sql(migrated_db, "TRUNCATE release_plans, ado_credentials, users RESTART IDENTITY CASCADE")
    run_sql(migrated_db, "INSERT INTO users (sub, email, name) VALUES ('test-user', 'test@example.com', 'Test User')")
    return migrated_db


@pytest.fixture()
def db_client(clean_db: str):
    """A `TestClient` whose `get_session` dependency uses the test database."""
    engine = create_async_engine(clean_db, poolclass=NullPool)
    app.dependency_overrides[get_session] = _session_override(async_sessionmaker(engine, expire_on_commit=False))
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_session, None)
        asyncio.run(engine.dispose())


def _session_override(factory):
    async def override():
        async with factory() as session:
            yield session

    return override
