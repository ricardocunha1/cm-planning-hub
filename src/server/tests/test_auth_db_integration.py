"""PostgreSQL integration (marker `db`) for migration 0002 and the real user
upsert behind the login callback."""
import asyncio

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.api.auth_routes import get_oidc_client
from app.config import get_settings
from app.db import get_session
from app.main import create_app
from db_helpers import alembic_config, run_sql
from test_auth_routes import CLAIMS, FakeOidc, make_settings
from test_db_migrations import query

pytestmark = pytest.mark.db


def test_migration_0002_creates_users_table_and_downgrades_cleanly(migrated_db):
    config = alembic_config(migrated_db)
    cols = {r[0]: r for r in query(
        migrated_db,
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='users'",
    )}
    assert set(cols) == {"id", "sub", "email", "name", "picture_url", "created_at", "last_login_at"}
    assert cols["picture_url"][2] == "YES"
    assert all(cols[c][2] == "NO" for c in ("sub", "email", "name", "created_at", "last_login_at"))
    unique = query(
        migrated_db,
        "SELECT count(*) FROM pg_indexes WHERE tablename='users' AND indexdef ILIKE '%UNIQUE%(sub)%'",
    )
    assert unique == [(1,)]
    try:
        command.downgrade(config, "0001")
        assert query(migrated_db, "SELECT to_regclass('users')") == [(None,)]
        assert query(migrated_db, "SELECT to_regclass('release_plans')") == [("release_plans",)]
    finally:
        command.upgrade(config, "head")
    assert query(migrated_db, "SELECT to_regclass('users')") == [("users",)]


@pytest.fixture()
def real_db_client(migrated_db):
    run_sql(migrated_db, "TRUNCATE users RESTART IDENTITY CASCADE")
    engine = create_async_engine(migrated_db, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    holder = {"oidc": FakeOidc()}
    settings = make_settings()
    app = create_app(settings)

    async def override():
        async with factory() as session:
            yield session

    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_session] = override
    app.dependency_overrides[get_oidc_client] = lambda: holder["oidc"]
    try:
        yield TestClient(app, base_url="http://localhost:8080"), holder
    finally:
        asyncio.run(engine.dispose())


def sign_in(client):
    client.get("/api/auth/login", follow_redirects=False)
    return client.get("/api/auth/callback?state=abc&code=c", follow_redirects=False)


def test_login_inserts_then_updates_the_same_user_by_sub(real_db_client, migrated_db):
    client, holder = real_db_client
    assert sign_in(client).headers["location"] == "/"
    first = client.get("/api/auth/me").json()
    assert first["name"] == "Ana"
    holder["oidc"] = FakeOidc(claims={**CLAIMS, "name": "Ana Renamed", "email": "new@example.com"})
    assert sign_in(client).headers["location"] == "/"
    second = client.get("/api/auth/me").json()
    assert second["id"] == first["id"]
    assert (second["name"], second["email"]) == ("Ana Renamed", "new@example.com")
    assert query(migrated_db, "SELECT count(*) FROM users") == [(1,)]
    assert query(migrated_db, "SELECT last_login_at >= created_at FROM users") == [(True,)]


def test_deleted_user_row_gets_401_and_session_is_cleared(real_db_client, migrated_db):
    client, _ = real_db_client
    sign_in(client)
    run_sql(migrated_db, "DELETE FROM users")
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/plan").status_code == 401
