import asyncio
import os
from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.db import get_session
from app.main import app
from db_helpers import alembic_config, run_sql
from app.services.data_processing import (
    build_sprint_summary,
    parse_sprint_history,
    summary_to_records,
)

FIXTURE_PATH = Path(__file__).resolve().parents[3] / "notebook" / "Sprint_History.xlsx"


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
    """The migrated test database with `release_plans` emptied for this test."""
    run_sql(migrated_db, "TRUNCATE release_plans RESTART IDENTITY")
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
