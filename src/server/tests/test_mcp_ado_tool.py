"""Unit tests for the `ado_fetch_backlog` MCP tool: same result as
`POST /api/ado/backlog` for the same fake Azure DevOps, ToolError messages and
a PAT that never leaves the server."""

import base64
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from ado_fakes import PROJECT_NAME, FakeAdo, mock_http_client, synthetic_backlog, work_item
from app.api.ado_routes import get_ado_http_client
from app.config import Settings, get_settings
from app.main import app
from app.mcp_server import ado_tools, deps
from app.mcp_server.errors import UNEXPECTED_ERROR
from app.services import ado_backlog
from app.services.ado_backlog import SCOPE_REQUIRED
from app.services.ado_client import PAT_REJECTED, UNEXPECTED_RESPONSE
from app.services.ado_url import PAT_REQUIRED, SOURCE_REQUIRED, URL_REQUIRED
from mcp_helpers import call, failure, ok, wire

PAT = "SeCrEt-pat-ZZ9-0123456789abcdef"
CLOUD_URL = "https://dev.azure.com/contoso/Fabrikam%20Plant"
SETTINGS = Settings(
    ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0, ado_description_max_chars=10
)
ARGS = {
    "source": "cloud",
    "projectUrl": CLOUD_URL,
    "pat": PAT,
    "scopeType": "area",
    "scopePath": f"{PROJECT_NAME}\\Team A",
}
SECRETS = (PAT, base64.b64encode(f":{PAT}".encode()).decode())


@pytest.fixture(autouse=True)
def fixed(monkeypatch):
    monkeypatch.setattr(ado_tools, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(ado_backlog, "_utc_now", lambda: datetime(2026, 10, 23, 10, 0, 0, tzinfo=timezone.utc))


def use(handler):
    """Serve fake ADO to the tool through the `deps` seam."""

    @asynccontextmanager
    async def provider():
        async with mock_http_client(handler) as http:
            yield http

    return deps.override_providers(ado_client=provider)


def assert_no_pat(text: str) -> None:
    for secret in SECRETS:
        assert secret not in text


def test_same_json_as_the_rest_route_including_a_truncated_description():
    fake = FakeAdo(work_items=[*synthetic_backlog(), work_item(107, "Feature", "Long", "Team A", description="<p>" + "x" * 50 + "</p>")])
    with use(fake):
        tool = ok("ado_fetch_backlog", ARGS)

    async def http_client():
        async with mock_http_client(fake) as http:
            yield http

    app.dependency_overrides[get_ado_http_client] = http_client
    app.dependency_overrides[get_settings] = lambda: SETTINGS
    try:
        rest = TestClient(app).post("/api/ado/backlog", json=ARGS)
    finally:
        app.dependency_overrides.clear()
    assert rest.status_code == 200
    assert tool == rest.json()
    long_item = next(i for i in tool["workItems"] if i["id"] == 107)
    assert long_item["description"].endswith("…") and len(long_item["description"]) <= 11
    assert set(tool) == {"project", "projectUrl", "scope", "fetchedAt", "workItems", "iterations", "warnings"}


def test_success_result_and_logs_have_no_pat(caplog):
    caplog.set_level(logging.DEBUG)
    with use(FakeAdo()):
        result = call("ado_fetch_backlog", ARGS)
    assert not result.is_error
    assert_no_pat(wire(result))
    assert_no_pat(caplog.text)


def test_field_errors_use_the_existing_messages():
    text = failure("ado_fetch_backlog", {"source": "", "projectUrl": " ", "pat": " ", "scopeType": "x", "scopePath": ""})
    assert text.splitlines()[0].endswith(SOURCE_REQUIRED)
    for message in (URL_REQUIRED, PAT_REQUIRED, SCOPE_REQUIRED):
        assert message in text


def test_disallowed_host_is_refused_before_any_request():
    fake = FakeAdo()
    with use(fake):
        text = failure("ado_fetch_backlog", {**ARGS, "projectUrl": "https://evil.example.com/org/Proj"})
    assert "evil.example.com" in text or "allowed" in text.lower()
    assert fake.requests == []


@pytest.mark.parametrize("kind", ["401", "403", "203", "302", "404", "500", "502", "non_json", "timeout", "connect"])
def test_ado_failures_become_tool_errors_without_the_pat(kind, caplog):
    caplog.set_level(logging.DEBUG)
    with use(FakeAdo(failures={"any": kind})):
        result = call("ado_fetch_backlog", ARGS)
    assert result.is_error
    assert UNEXPECTED_ERROR not in wire(result)
    assert_no_pat(wire(result))
    assert_no_pat(caplog.text)


def test_rejected_pat_message_is_the_existing_one():
    with use(FakeAdo(failures={"any": "401"})):
        assert PAT_REJECTED in failure("ado_fetch_backlog", ARGS)


@pytest.mark.parametrize("pat", ["bad\x01pat", "pat-\udcff"])
def test_a_pat_that_can_never_be_valid_is_rejected_without_a_request(pat):
    fake = FakeAdo()
    with use(fake):
        result = call("ado_fetch_backlog", {**ARGS, "pat": pat})
    assert result.is_error
    assert fake.requests == []
    assert pat not in wire(result)


@pytest.mark.parametrize("exc", [UnicodeError("boom"), RecursionError()])
def test_unicode_and_recursion_errors_map_to_unexpected_response(exc, monkeypatch, caplog):
    async def explode(*args, **kwargs):
        raise exc

    monkeypatch.setattr(ado_tools, "fetch_backlog", explode)
    with use(FakeAdo()):
        result = call("ado_fetch_backlog", ARGS)
    assert result.is_error and UNEXPECTED_RESPONSE in wire(result)
    assert_no_pat(wire(result))


def test_an_unexpected_error_is_generic_and_logs_no_secret(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)

    async def explode(*args, **kwargs):
        raise RuntimeError(f"leaked {PAT}")

    monkeypatch.setattr(ado_tools, "fetch_backlog", explode)
    with use(FakeAdo()):
        result = call("ado_fetch_backlog", ARGS)
    assert result.is_error and UNEXPECTED_ERROR in wire(result)
    assert_no_pat(wire(result))
    assert_no_pat(caplog.text)
    assert "RuntimeError" in caplog.text


def test_tool_schema_marks_the_pat_as_a_secret_and_source_as_required():
    from mcp_helpers import run_client

    tool = next(t for t in run_client(lambda c: c.list_tools()).tools if t.name == "ado_fetch_backlog")
    assert set(tool.input_schema["required"]) == {"source", "projectUrl", "pat", "scopeType", "scopePath"}
    assert tool.input_schema["properties"]["pat"]["format"] == "password"
    assert tool.input_schema["properties"]["source"]["enum"] == ["onprem", "cloud"]
