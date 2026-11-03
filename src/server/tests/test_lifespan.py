"""Startup/shutdown behaviour of the app. No database needed: the app is
started with `with TestClient(app)`, which (unlike the plain `TestClient(app)`
used elsewhere) runs the lifespan."""
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


@pytest.fixture()
def env(monkeypatch):
    get_settings.cache_clear()
    yield monkeypatch
    get_settings.cache_clear()


def test_lifespan_without_migration_starts_and_serves_health(env):
    env.setenv("DB_MIGRATE_ON_STARTUP", "false")
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200


def test_lifespan_fails_when_database_unreachable(env):
    env.setenv("DB_MIGRATE_ON_STARTUP", "true")
    env.setenv("DB_HOST", "127.0.0.1")
    env.setenv("DB_PORT", "1")
    env.setenv("DB_STARTUP_TIMEOUT_SECONDS", "0.2")
    env.setattr("app.db.RETRY_DELAY_SECONDS", 0.05)
    with pytest.raises(Exception):
        with TestClient(app):
            pass
