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


MCP_INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
}
MCP_HEADERS = {"Accept": "application/json, text/event-stream"}


def test_lifespan_can_run_twice_on_the_same_app(env):
    env.setenv("DB_MIGRATE_ON_STARTUP", "false")
    for _ in range(2):
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200


def test_mcp_initialize_answers_200_without_redirect(env):
    env.setenv("DB_MIGRATE_ON_STARTUP", "false")
    with TestClient(app, base_url="http://localhost") as client:
        response = client.post("/api/mcp", json=MCP_INITIALIZE, headers=MCP_HEADERS, follow_redirects=False)
    assert response.status_code == 200
    assert response.json()["result"]["serverInfo"]["name"] == "Planning Hub Release Plan"
    assert "release-plan://schema" in response.json()["result"]["instructions"]


def test_mcp_refuses_a_host_that_is_not_allowed(env):
    env.setenv("DB_MIGRATE_ON_STARTUP", "false")
    with TestClient(app, base_url="http://evil.example") as client:
        response = client.post("/api/mcp", json=MCP_INITIALIZE, headers=MCP_HEADERS)
    assert response.status_code == 421


def test_mcp_without_lifespan_answers_503():
    assert TestClient(app).post("/api/mcp", json=MCP_INITIALIZE, headers=MCP_HEADERS).status_code == 503
