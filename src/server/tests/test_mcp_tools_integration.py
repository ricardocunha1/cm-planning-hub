"""QA integration: the Release Plan MCP tools over real HTTP (`POST /api/mcp`,
stateless JSON mode) through the app lifespan, with PostgreSQL (tests marked
`db`) and fake Azure DevOps. REST (`/api/plan`, `/api/ado/backlog`) is used to
cross-check what the tools stored and returned."""

import copy
import json
import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from ado_fakes import PROJECT_NAME, FakeAdo, mock_http_client, work_item
from app.api.ado_routes import get_ado_http_client
from app.config import Settings, get_settings
from app.db import DB_UNAVAILABLE, get_session
from app.main import app
from app.mcp_server import deps
from app.mcp_server.errors import UNEXPECTED_ERROR
from app.services import ado_backlog
from app.services.plan_from_backlog import decisions_json_schema
from mcp_helpers import db_provider

HEADERS = {"Accept": "application/json, text/event-stream"}
URL = "https://dev.azure.com/org/Proj"
PAT = "QaSecretPat-7f3a9c1d2e4b5a60-ZZ"
LOCAL_SETTINGS = Settings(
    ado_allowed_hosts=("dev.azure.com",),
    ado_timeout_seconds=5.0,
    ado_description_max_chars=40,
    public_base_url="https://hub.example.com",
)


def decisions(**overrides):
    """The agent's decisions for `_fake_ado()`: Epic 1 with Feature 2."""
    data = {
        "milestones": [{"id": "ms_a", "name": "MVP"}],
        "epicOrder": [1],
        "assignments": {"2": "ms_a"},
    }
    data.update(overrides)
    return data


def connection():
    return {
        "source": "cloud",
        "projectUrl": f"https://dev.azure.com/contoso/{PROJECT_NAME.replace(' ', '%20')}",
        "scopeType": "area",
        "scopePath": f"{PROJECT_NAME}\\Team A",
    }


def create_args(**overrides):
    return {"name": "Plan", "pat": PAT, "connection": connection(), **decisions(), **overrides}


def update_args(plan_id, **overrides):
    return {"planId": plan_id, "pat": PAT, **decisions(), **overrides}


class Mcp:
    def __init__(self, client: TestClient):
        self.client = client
        self._id = 0

    def rpc(self, method, params=None):
        self._id += 1
        response = self.client.post(
            "/api/mcp", json={"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or {}}, headers=HEADERS
        )
        assert response.status_code == 200, response.text
        return response.json()

    def raw(self, name, arguments):
        return self.rpc("tools/call", {"name": name, "arguments": arguments})["result"]

    def ok(self, name, arguments):
        result = self.raw(name, arguments)
        assert result["isError"] is False, result
        return result["structuredContent"]

    def fail(self, name, arguments) -> str:
        result = self.raw(name, arguments)
        assert result["isError"] is True, result
        return "\n".join(block["text"] for block in result["content"])


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("DB_MIGRATE_ON_STARTUP", "false")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://hub.example.com/")
    monkeypatch.setenv("ADO_ALLOWED_HOSTS", "dev.azure.com")
    monkeypatch.setenv("ADO_DESCRIPTION_MAX_CHARS", "40")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture()
def mcp(env):
    with TestClient(app, base_url="http://localhost") as client:
        yield Mcp(client)


@pytest.fixture()
def stack(env, clean_db):
    """MCP tools and REST routes on the same test database."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from sqlalchemy.pool import NullPool

    factory = async_sessionmaker(create_async_engine(clean_db, poolclass=NullPool), expire_on_commit=False)

    async def override():
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    try:
        with deps.override_providers(session=db_provider(clean_db)):
            with TestClient(app, base_url="http://localhost") as client:
                yield Mcp(client)
    finally:
        app.dependency_overrides.pop(get_session, None)


# --- discovery and schema (no database) -----------------------------------------------


def test_tools_list_over_http_is_exactly_the_contract(mcp):
    tools = {t["name"]: t for t in mcp.rpc("tools/list")["result"]["tools"]}
    assert set(tools) == {
        "list_release_plans", "get_release_plan", "validate_release_plan",
        "create_release_plan", "update_release_plan", "ado_fetch_backlog", "get_release_plan_schema",
    }
    resources = mcp.rpc("resources/list")["result"]["resources"]
    assert resources == []
    assert mcp.rpc("prompts/list")["result"]["prompts"] == []
    assert mcp.rpc("resources/templates/list")["result"]["resourceTemplates"] == []
    init = mcp.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "qa", "version": "0"}})
    assert len(init["result"]["instructions"]) < 400


def test_get_release_plan_schema_over_http_is_the_decisions_schema(mcp):
    assert mcp.ok("get_release_plan_schema", {}) == decisions_json_schema()


@pytest.mark.parametrize("tool", ["validate_release_plan", "create_release_plan", "update_release_plan"])
def test_advertised_input_schema_is_usable_by_a_json_schema_validator(mcp, tool):
    """`$defs` are at the root of the tool's input schema and every `$ref` resolves."""
    tools = {t["name"]: t for t in mcp.rpc("tools/list")["result"]["tools"]}
    input_schema = tools[tool]["inputSchema"]
    Draft202012Validator.check_schema(input_schema)
    refs = set()

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "$ref":
                    refs.add(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(input_schema)
    assert refs and all(ref.startswith("#/$defs/") and ref.split("/")[-1] in input_schema["$defs"] for ref in refs)
    arguments = {"name": "n", "planId": 1, "pat": PAT, "connection": connection(), **decisions()}
    arguments = {k: v for k, v in arguments.items() if k in input_schema["properties"]}
    validator = Draft202012Validator(input_schema)
    assert list(validator.iter_errors(arguments)) == []
    broken = {**arguments, "milestones": [{"id": 5}]}
    assert list(validator.iter_errors(broken))


def test_validate_reports_all_reference_errors_and_create_lists_the_same(mcp):
    args = decisions(
        milestones=[{"id": "a", "name": "A"}, {"id": "a", "name": "B"}],
        epicOrder=[1, 1],
        assignments={"2": "zz"},
    )
    result = mcp.ok("validate_release_plan", {"connection": connection(), **args})
    assert result["valid"] is False
    text = "\n".join(result["errors"])
    for expected in ("duplicate milestone id", "epicOrder[1]", "assignments['2']"):
        assert expected in text
    message = mcp.fail("create_release_plan", create_args(**args))
    assert message.count("\n- ") == len(result["errors"])


@pytest.mark.parametrize("value", [5, "not json", [], None])
def test_malformed_decisions_are_a_clean_error_on_all_tools(mcp, value):
    assert mcp.ok("validate_release_plan", {"connection": connection(), **decisions(milestones=value)})["valid"] is False
    assert "invalid" in mcp.fail("create_release_plan", create_args(milestones=value))
    assert "invalid" in mcp.fail("update_release_plan", update_args(1, milestones=value))


def test_missing_required_argument_is_a_tool_error_not_a_crash(mcp):
    result = mcp.raw("validate_release_plan", {})
    assert result["isError"] is True and "connection" in result["content"][0]["text"]


def test_unknown_tool_and_bad_arguments_do_not_500(mcp):
    for name, args in (("delete_release_plan", {"planId": 1}), ("ado_connect", {})):
        response = mcp.client.post(
            "/api/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}, headers=HEADERS
        )
        assert response.status_code == 200
        body = response.json()
        assert "error" in body or body["result"]["isError"] is True
    assert mcp.fail("list_release_plans", {"page": 0})
    assert mcp.fail("get_release_plan", {"planId": "abc"})


def test_unexpected_error_is_generic_and_logged_server_side(mcp, monkeypatch, caplog):
    from app.mcp_server import plan_tools

    def boom(*a, **k):
        raise RuntimeError("secret-internal-detail")

    monkeypatch.setattr(plan_tools, "parse_decisions", boom)
    with caplog.at_level(logging.DEBUG):
        message = mcp.fail("validate_release_plan", {"connection": connection(), **decisions()})
    assert UNEXPECTED_ERROR in message and "secret-internal-detail" not in message
    assert any(r.exc_info for r in caplog.records)


# --- DB down ------------------------------------------------------------------------------


def test_database_down_maps_to_db_unavailable_for_every_db_tool(mcp):
    with deps.override_providers(session=db_provider("postgresql+asyncpg://u:p@127.0.0.1:1/none")):
        assert mcp.fail("list_release_plans", {}) == f"Error executing tool list_release_plans: {DB_UNAVAILABLE}"
        assert DB_UNAVAILABLE in mcp.fail("get_release_plan", {"planId": 1})
        assert DB_UNAVAILABLE in mcp.fail("update_release_plan", update_args(1))
        with deps.override_providers(ado_client=_serve(_fake_ado())):
            assert DB_UNAVAILABLE in mcp.fail("create_release_plan", create_args())
        # validate does not need the database
        assert mcp.ok("validate_release_plan", {"connection": connection(), **decisions()})["valid"] is True


# --- plans with PostgreSQL ---------------------------------------------------------------------


@pytest.mark.db
def test_create_get_list_update_and_ui_style_put_round_trip(stack):
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        created = stack.ok("create_release_plan", create_args(name="  Plan A "))
    assert created["name"] == "Plan A"
    assert created["projectType"] == "cloud" and created["projectName"] == PROJECT_NAME
    assert created["boardUrl"] == f"https://hub.example.com/release-plan/{created['id']}"
    plan_id = created["id"]

    rest = stack.client.get(f"/api/plan/{plan_id}")
    assert rest.status_code == 200
    detail = rest.json()
    assert detail["name"] == "Plan A" and detail["state"]["name"] == "Plan A"
    assert detail["state"]["milestones"][0]["color"]  # defaults filled
    assert detail["state"]["source"]["system"] == "Azure DevOps"
    assert detail["state"]["epics"][0]["features"][0]["milestoneId"] == "ms_a"
    assert detail["state"]["epics"][0]["description"].endswith("…")  # truncated at 40 characters
    assert PAT not in rest.text
    via_mcp = stack.ok("get_release_plan", {"planId": plan_id})
    assert {k: v for k, v in via_mcp.items() if k != "boardUrl"} == detail
    listed = stack.ok("list_release_plans", {})
    assert listed["total"] == 1 and listed["page"] == 1 and listed["pageSize"] == 10
    assert listed["items"][0]["id"] == plan_id and "state" not in listed["items"][0]
    assert listed["items"][0]["boardUrl"] == created["boardUrl"] and via_mcp["id"] == plan_id

    # null name keeps the stored name; state.name follows the column
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        updated = stack.ok("update_release_plan", update_args(plan_id, assignments={}))
    assert updated["name"] == "Plan A"
    after = stack.client.get(f"/api/plan/{plan_id}").json()
    assert after["state"]["name"] == "Plan A" and after["state"]["epics"][0]["features"][0]["milestoneId"] is None
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        renamed = stack.ok("update_release_plan", update_args(plan_id, name=" Plan B "))
    assert renamed["name"] == "Plan B"
    after = stack.client.get(f"/api/plan/{plan_id}").json()
    assert after["name"] == "Plan B" and after["state"]["name"] == "Plan B"

    # a UI-style PUT (shallow validation) still works on an MCP-stored plan, and MCP can read it back
    ui_state = after["state"]
    ui_state["epics"][0]["title"] = "From the UI"
    put = stack.client.put(f"/api/plan/{plan_id}", json={"name": "Plan C", "state": {**ui_state, "name": "Plan C"}})
    assert put.status_code == 200, put.text
    assert stack.ok("get_release_plan", {"planId": plan_id})["state"]["epics"][0]["title"] == "From the UI"
    # and an agent can update what the UI saved: the next update refreshes the title from Azure DevOps
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        again = stack.ok("update_release_plan", update_args(plan_id))
    assert again["name"] == "Plan C"
    assert stack.client.get(f"/api/plan/{plan_id}").json()["state"]["epics"][0]["title"] == "E"


@pytest.mark.db
def test_update_errors_unknown_id_and_project_change(stack):
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        plan_id = stack.ok("create_release_plan", create_args(name="P"))["id"]
        assert stack.fail("update_release_plan", update_args(999)).endswith("Release plan not found: 999.")
    assert stack.fail("get_release_plan", {"planId": 999}).endswith("Release plan not found: 999.")
    assert stack.fail("get_release_plan", {"planId": 2**40}).endswith(f"Release plan not found: {2**40}.")
    assert stack.fail("get_release_plan", {"planId": -1}).endswith("Release plan not found: -1.")
    # the stored project name no longer matches the one Azure DevOps reports
    stored = stack.client.get(f"/api/plan/{plan_id}").json()
    run_sql_project(stack, plan_id, "Other")
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        message = stack.fail("update_release_plan", update_args(plan_id))
    assert message.endswith("The plan's project cannot be changed (stored: cloud · Other).")
    # refused updates changed nothing
    assert stack.client.get(f"/api/plan/{plan_id}").json()["state"] == stored["state"]


def run_sql_project(stack, plan_id, project_name):
    """Change the stored project name of a plan through REST-independent SQL."""
    import os

    from db_helpers import run_sql

    run_sql(os.environ["TEST_DATABASE_URL"], f"UPDATE release_plans SET project_name = '{project_name}' WHERE id = {int(plan_id)}")


@pytest.mark.db
@pytest.mark.parametrize("name,message", [("", "required"), ("   ", "required"), ("x" * 201, "at most 200"), ("a\x00b", "invalid characters")])
def test_name_errors_use_the_existing_texts(stack, name, message):
    assert message in stack.fail("create_release_plan", create_args(name=name))
    assert message in stack.fail("update_release_plan", update_args(1, name=name))
    assert stack.ok("list_release_plans", {})["total"] == 0


@pytest.mark.db
def test_invalid_decisions_and_ado_failures_store_nothing_and_validate_stores_nothing(stack):
    bad = create_args(milestones="x")
    assert "Release plan is invalid:" in stack.fail("create_release_plan", bad)
    with deps.override_providers(ado_client=_serve(_fake_ado(failures={"any": "500"}))):
        assert PAT not in stack.fail("create_release_plan", create_args())
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        assert "unknown Feature id" in stack.fail("create_release_plan", create_args(assignments={"99": None}))
    assert stack.ok("validate_release_plan", {"connection": connection(), **decisions()})["valid"] is True
    assert stack.ok("list_release_plans", {})["total"] == 0


@pytest.mark.db
def test_list_pages_and_concurrent_creates_use_separate_sessions(stack):
    errors: list[str] = []
    ado = deps.override_providers(ado_client=_serve(_fake_ado()))
    ado.__enter__()

    def create(index: int) -> None:
        try:
            result = Mcp(stack.client).raw("create_release_plan", create_args(name=f"P{index}"))
            if result["isError"]:
                errors.append(result["content"][0]["text"])
        except Exception as exc:  # noqa: BLE001
            errors.append(repr(exc))

    threads = [threading.Thread(target=create, args=(i,)) for i in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    ado.__exit__(None, None, None)
    assert errors == []
    first = stack.ok("list_release_plans", {})
    second = stack.ok("list_release_plans", {"page": 2})
    assert first["total"] == 12 and len(first["items"]) == 10 and len(second["items"]) == 2
    assert len({i["id"] for i in first["items"] + second["items"]}) == 12
    assert stack.ok("list_release_plans", {"page": 99})["items"] == []
    # MCP list equals REST list
    rest = stack.client.get("/api/plan", params={"page": 1}).json()
    assert [i["id"] for i in rest["items"]] == [i["id"] for i in first["items"]]


# --- ado_fetch_backlog --------------------------------------------------------------------------------


def _fake_ado(**kwargs):
    return FakeAdo(
        work_items=[
            work_item(1, "Epic", "E", "Team A", description="<p>" + "word " * 100 + "</p>"),
            work_item(2, "Feature", "F", "Team A", parent=1, size="m"),
        ],
        **kwargs,
    )


def _ado_args(**overrides):
    args = {
        "source": "cloud",
        "projectUrl": f"https://dev.azure.com/contoso/{PROJECT_NAME.replace(' ', '%20')}",
        "pat": PAT,
        "scopeType": "area",
        "scopePath": f"{PROJECT_NAME}\\Team A",
    }
    args.update(overrides)
    return args


def _serve(handler):
    @asynccontextmanager
    async def provider():
        async with mock_http_client(handler) as http:
            yield http

    return provider


@pytest.fixture()
def fixed_clock(monkeypatch):
    monkeypatch.setattr(ado_backlog, "_utc_now", lambda: datetime(2026, 10, 23, 10, 0, 0, tzinfo=timezone.utc))


def test_ado_fetch_backlog_over_http_equals_the_rest_route(mcp, fixed_clock):
    async def rest_client():
        async with mock_http_client(_fake_ado()) as http:
            yield http

    with deps.override_providers(ado_client=_serve(_fake_ado())):
        result = mcp.ok("ado_fetch_backlog", _ado_args())
    app.dependency_overrides[get_ado_http_client] = rest_client
    try:
        rest = mcp.client.post("/api/ado/backlog", json=_ado_args())
    finally:
        app.dependency_overrides.pop(get_ado_http_client, None)
    assert rest.status_code == 200, rest.text
    assert result == rest.json()
    assert result["workItems"][0]["description"].endswith("…") and len(result["workItems"][0]["description"]) <= 41
    assert PAT not in json.dumps(result)


def test_ado_fetch_backlog_allowlist_and_field_errors(mcp):
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        blocked = mcp.fail("ado_fetch_backlog", _ado_args(projectUrl="https://evil.example.com/org/Proj"))
        assert "evil.example.com" in blocked or "allowed" in blocked.lower() or "host" in blocked.lower()
        assert mcp.fail("ado_fetch_backlog", _ado_args(source="other"))
        assert mcp.fail("ado_fetch_backlog", _ado_args(scopePath=" "))
        assert mcp.fail("ado_fetch_backlog", _ado_args(pat=" "))


def test_pat_is_in_no_result_error_or_log_at_any_level(mcp, fixed_clock, caplog):
    import base64

    secrets = (PAT, base64.b64encode(f":{PAT}".encode()).decode())
    caplog.set_level(logging.DEBUG)
    logging.getLogger().setLevel(logging.DEBUG)
    texts = []
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        texts.append(json.dumps(mcp.ok("ado_fetch_backlog", _ado_args())))
        for kind in ("401", "403", "404", "500", "non_json"):
            fake = _fake_ado(failures={"any": kind})
            with deps.override_providers(ado_client=_serve(fake)):
                texts.append(mcp.fail("ado_fetch_backlog", _ado_args()))
    texts.append(mcp.fail("ado_fetch_backlog", _ado_args(projectUrl="https://evil.example.com/o/P")))
    texts.append(mcp.fail("ado_fetch_backlog", _ado_args(scopePath="")))

    def explode(*a, **k):
        raise RuntimeError(f"boom {PAT}")

    with deps.override_providers(ado_client=_serve(_fake_ado())):
        import app.mcp_server.ado_tools as ado_tools

        original = ado_tools.fetch_backlog
        ado_tools.fetch_backlog = explode
        try:
            texts.append(mcp.fail("ado_fetch_backlog", _ado_args()))
        finally:
            ado_tools.fetch_backlog = original
    logs = "\n".join(r.getMessage() + str(r.exc_text or "") + str(r.args) for r in caplog.records)
    for secret in secrets:
        for text in texts:
            assert secret not in text
        assert secret not in logs
