"""QA integration: the real `app` through its lifespan, `/api/mcp` over HTTP
next to the REST routes, and description truncation end to end through
`POST /api/ado/backlog` with fake Azure DevOps."""
import pytest
from fastapi.testclient import TestClient

from ado_fakes import FAKE_PAT, PROJECT_NAME, FakeAdo, mock_http_client, work_item
from app.api.ado_routes import get_ado_http_client
from app.config import Settings, get_settings
from app.main import app
from app.services.ado_backlog import truncate_description

HEADERS = {"Accept": "application/json, text/event-stream"}


def _rpc(method, id_=1, params=None):
    return {"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}


INIT = _rpc(
    "initialize",
    params={"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "qa", "version": "0"}},
)


@pytest.fixture()
def running(monkeypatch):
    monkeypatch.setenv("DB_MIGRATE_ON_STARTUP", "false")
    get_settings.cache_clear()
    with TestClient(app, base_url="http://localhost") as client:
        yield client
    get_settings.cache_clear()


def test_mcp_and_rest_coexist_in_one_lifespan(running):
    first = running.post("/api/mcp", json=INIT, headers=HEADERS, follow_redirects=False)
    assert first.status_code == 200
    assert first.json()["result"]["serverInfo"]["name"]
    listed = running.post("/api/mcp", json=_rpc("tools/list", 2), headers=HEADERS)
    assert listed.status_code == 200
    assert "tools" in listed.json()["result"]
    assert running.get("/api/health").status_code == 200
    # REST validation 422 contract untouched by the extra route
    bad = running.post("/api/validate", json={})
    assert bad.status_code == 422 and "errors" in bad.json()
    assert running.get("/api/nope").status_code == 404


def test_mcp_malformed_json_and_other_methods_do_not_crash(running):
    assert running.post("/api/mcp", content=b"{not json", headers={**HEADERS, "Content-Type": "application/json"}).status_code in (400, 422)
    # GET with Accept: text/event-stream opens an idle SSE stream (SDK behavior), so only test the refusal
    assert running.get("/api/mcp", headers={"Accept": "application/json"}).status_code in (405, 406)
    assert running.delete("/api/mcp", headers=HEADERS).status_code in (405, 404)
    assert running.post("/api/mcp", json=INIT, headers=HEADERS).status_code == 200


def test_mcp_not_running_without_lifespan_is_503_errors():
    response = TestClient(app, base_url="http://localhost").post("/api/mcp", json=INIT, headers=HEADERS)
    assert response.status_code == 503
    assert response.json() == {"errors": ["The MCP endpoint is not running."]}


def test_mcp_disallowed_origin_is_refused(running):
    response = running.post("/api/mcp", json=INIT, headers={**HEADERS, "Origin": "https://evil.example"})
    assert response.status_code == 403


def test_backlog_route_truncates_descriptions_end_to_end():
    long = "<p>" + "word " * 100 + "</p>"
    fake = FakeAdo(
        work_items=[
            work_item(1, "Epic", "E", "Team A", description=long),
            work_item(2, "Feature", "F", "Team A", parent=1, description="<p>short</p>"),
        ]
    )

    async def http_client():
        async with mock_http_client(fake) as http:
            yield http

    settings = Settings(
        ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0, ado_description_max_chars=40
    )
    app.dependency_overrides[get_ado_http_client] = http_client
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        response = TestClient(app).post(
            "/api/ado/backlog",
            json={
                "source": "cloud",
                "projectUrl": f"https://dev.azure.com/contoso/{PROJECT_NAME.replace(' ', '%20')}",
                "pat": FAKE_PAT,
                "scopeType": "area",
                "scopePath": f"{PROJECT_NAME}\\Team A",
            },
        )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 200, response.text
    items = {i["id"]: i for i in response.json()["workItems"]}
    assert len(items[1]["description"]) <= 41 and items[1]["description"].endswith("…")
    assert items[2]["description"] == "<p>short</p>"
    assert FAKE_PAT not in response.text


@pytest.mark.parametrize(
    "text,limit",
    [("a" * 10, 1), ("abc", 1), ("<", 0 + 1), ("ab&amp;cd", 5), ("ab&amp;cd", 4), ("x <b>y</b> z", 8)],
)
def test_truncate_description_edge_cases_bounded(text, limit):
    out = truncate_description(text, limit)
    assert len(out) <= limit + 1
    if len(text) <= limit:
        assert out == text


def test_truncate_keeps_earlier_complete_markup_and_bare_ampersand():
    # a legitimate "&" earlier in the text (no ';' after it) must not swallow the rest
    text = "Tom & Jerry " + "word " * 20
    out = truncate_description(text, 60)
    assert out.startswith("Tom & Jerry word word")
    assert len(out) > 40
