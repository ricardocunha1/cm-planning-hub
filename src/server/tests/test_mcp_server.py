"""The MCP ASGI app built by `app.mcp_server.server`, run on its own (no
database, no tools yet): host allowlist, body limit and the test seam."""
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.mcp_server import deps
from app.mcp_server.server import MAX_REQUEST_BODY_BYTES, MCP_PATH, create_mcp_app, create_mcp_server, transport_security

HEADERS = {"Accept": "application/json, text/event-stream"}
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}},
}


def _settings(hosts: tuple[str, ...]) -> Settings:
    return Settings(ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0, mcp_allowed_hosts=hosts)


def _client(hosts: tuple[str, ...], host: str) -> TestClient:
    return TestClient(create_mcp_app(_settings(hosts), create_mcp_server()), base_url=f"http://{host}")


def test_transport_security_derives_origins_from_hosts():
    security = transport_security(_settings(("hub.example.com", "localhost:*")))
    assert security.enable_dns_rebinding_protection is True
    assert security.allowed_hosts == ["hub.example.com", "localhost:*"]
    assert security.allowed_origins == [
        "http://hub.example.com",
        "https://hub.example.com",
        "http://localhost:*",
        "https://localhost:*",
    ]


@pytest.mark.parametrize("host", ["hub.example.com", "localhost", "localhost:8080"])
def test_allowed_hosts_are_accepted(host):
    with _client(("hub.example.com", "localhost", "localhost:*"), host) as client:
        response = client.post(MCP_PATH, json=INITIALIZE, headers=HEADERS)
    assert response.status_code == 200


def test_other_hosts_get_421():
    with _client(("hub.example.com",), "evil.example") as client:
        response = client.post(MCP_PATH, json=INITIALIZE, headers=HEADERS)
    assert response.status_code == 421


def test_body_between_4_and_6_mib_is_not_refused_as_too_large():
    padded = {**INITIALIZE, "params": {**INITIALIZE["params"], "padding": "x" * (5 * 1024 * 1024)}}
    assert 4 * 1024 * 1024 < len(str(padded)) < MAX_REQUEST_BODY_BYTES
    with _client(("localhost",), "localhost") as client:
        response = client.post(MCP_PATH, json=padded, headers=HEADERS)
    assert response.status_code != 413


def test_body_over_6_mib_is_refused():
    padded = {**INITIALIZE, "params": {**INITIALIZE["params"], "padding": "x" * (MAX_REQUEST_BODY_BYTES + 1)}}
    with _client(("localhost",), "localhost") as client:
        response = client.post(MCP_PATH, json=padded, headers=HEADERS)
    assert response.status_code == 413


def test_override_providers_replaces_and_restores():
    sentinel_session, sentinel_ado = object(), object()
    original = (deps._session_provider, deps._ado_client_provider)
    with deps.override_providers(session=lambda: sentinel_session, ado_client=lambda: sentinel_ado):
        assert deps.db_session() is sentinel_session
        assert deps.ado_http() is sentinel_ado
    assert (deps._session_provider, deps._ado_client_provider) == original
