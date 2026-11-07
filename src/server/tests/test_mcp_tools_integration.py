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
from app.services.plan_board import board_json_schema, validate_board
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


def board(**overrides):
    state = {
        "schema": "release-planner-features",
        "source": {"project": "Proj", "kind": "cloud", "projectUrl": URL, "scopeType": "area", "scopePath": "Proj\\Team"},
        "milestones": [{"id": "ms_a", "name": "MVP"}],
        "epics": [{"id": 1, "title": "Epic", "features": [{"id": 10, "title": "F", "milestoneId": "ms_a"}]}],
    }
    state.update(overrides)
    return state


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
        "create_release_plan", "update_release_plan", "ado_fetch_backlog",
    }
    resources = mcp.rpc("resources/list")["result"]["resources"]
    assert [r["uri"] for r in resources] == ["release-plan://schema"]
    assert mcp.rpc("prompts/list")["result"]["prompts"] == []
    assert mcp.rpc("resources/templates/list")["result"]["resourceTemplates"] == []
    init = mcp.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "qa", "version": "0"}})
    assert len(init["result"]["instructions"]) < 400


def test_resource_read_over_http_is_the_board_schema(mcp):
    contents = mcp.rpc("resources/read", {"uri": "release-plan://schema"})["result"]["contents"]
    assert json.loads(contents[0]["text"]) == board_json_schema()


@pytest.mark.parametrize("tool", ["validate_release_plan", "create_release_plan", "update_release_plan"])
def test_advertised_state_schema_is_usable_by_a_json_schema_validator(mcp, tool):
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
    arguments = {"state": validate_board(board(), ("dev.azure.com",)).board, "name": "n", "planId": 1}
    validator = Draft202012Validator(input_schema)
    assert list(validator.iter_errors(arguments)) == []
    broken = {**arguments, "state": {**arguments["state"], "milestones": [{"id": 5}]}}
    assert list(validator.iter_errors(broken))


def test_validate_reports_all_errors_for_a_well_keyed_malformed_state(mcp):
    state = board(
        milestones=[{"id": "a", "name": "A"}, {"id": "a", "name": ""}],
        epics=[{"id": True, "title": 5, "features": [{"id": 1, "title": "x", "milestoneId": "zz"}, {"id": "1", "title": "y"}]}],
        mode="weeks",
    )
    result = mcp.ok("validate_release_plan", {"state": state})
    assert result["valid"] is False
    text = "\n".join(result["errors"])
    for expected in ("mode", "milestones[1].name", "epics[0].id", "epics[0].title", "milestoneId"):
        assert expected in text
    assert len(result["errors"]) >= 5
    # same list reaches the agent as the ToolError text on create / update
    for tool, args in (("create_release_plan", {"name": "x"}), ("update_release_plan", {"planId": 1})):
        message = mcp.fail(tool, {**args, "state": state})
        assert message.count("\n- ") == len(result["errors"])


@pytest.mark.parametrize("state", [5, "not json", [], None, {}, {"schema": 5}, {"schema": "other"}])
def test_non_object_or_unrecognized_state_is_a_clean_error_on_all_tools(mcp, state):
    assert mcp.ok("validate_release_plan", {"state": state})["valid"] is False
    assert "invalid" in mcp.fail("create_release_plan", {"name": "x", "state": state})
    assert "invalid" in mcp.fail("update_release_plan", {"planId": 1, "state": state})


def test_a_json_string_state_is_decoded_by_the_sdk_and_validated_as_an_object(mcp):
    result = mcp.ok("validate_release_plan", {"state": json.dumps(board())})
    assert result == {"valid": True}
    bad = mcp.ok("validate_release_plan", {"state": json.dumps(board(milestones="x"))})
    assert bad["valid"] is False and "milestones" in "\n".join(bad["errors"])


def test_missing_state_argument_is_a_tool_error_not_a_crash(mcp):
    result = mcp.raw("validate_release_plan", {})
    assert result["isError"] is True and "state" in result["content"][0]["text"]


def test_a_state_over_4_mib_reaches_the_tool_and_over_5_mib_is_refused_by_it(mcp):
    big = board()
    big["epics"][0]["features"][0]["description"] = "x" * (4 * 1024 * 1024 + 100_000)
    assert mcp.ok("validate_release_plan", {"state": big})["valid"] is True
    huge = board()
    huge["epics"][0]["features"][0]["description"] = "x" * (5 * 1024 * 1024 + 10)
    result = mcp.ok("validate_release_plan", {"state": huge})
    assert result["valid"] is False and "too large" in result["errors"][0]


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

    monkeypatch.setattr(plan_tools, "validate_board", boom)
    with caplog.at_level(logging.DEBUG):
        message = mcp.fail("validate_release_plan", {"state": board()})
    assert UNEXPECTED_ERROR in message and "secret-internal-detail" not in message
    assert any(r.exc_info for r in caplog.records)


# --- DB down ------------------------------------------------------------------------------


def test_database_down_maps_to_db_unavailable_for_every_db_tool(mcp):
    with deps.override_providers(session=db_provider("postgresql+asyncpg://u:p@127.0.0.1:1/none")):
        assert mcp.fail("list_release_plans", {}) == f"Error executing tool list_release_plans: {DB_UNAVAILABLE}"
        assert DB_UNAVAILABLE in mcp.fail("get_release_plan", {"planId": 1})
        assert DB_UNAVAILABLE in mcp.fail("create_release_plan", {"name": "n", "state": board()})
        assert DB_UNAVAILABLE in mcp.fail("update_release_plan", {"planId": 1, "state": board()})
        # validate does not need the database
        assert mcp.ok("validate_release_plan", {"state": board()})["valid"] is True


# --- plans with PostgreSQL ---------------------------------------------------------------------


@pytest.mark.db
def test_create_get_list_update_and_ui_style_put_round_trip(stack):
    created = stack.ok("create_release_plan", {"name": "  Plan A ", "state": board(name="ignored", savedAt="2026-01-01T00:00:00Z")})
    assert created["name"] == "Plan A"
    assert created["projectType"] == "cloud" and created["projectName"] == "Proj"
    assert created["boardUrl"] == f"https://hub.example.com/release-plan/{created['id']}"
    plan_id = created["id"]

    rest = stack.client.get(f"/api/plan/{plan_id}")
    assert rest.status_code == 200
    detail = rest.json()
    assert detail["name"] == "Plan A" and detail["state"]["name"] == "Plan A"
    assert detail["state"]["milestones"][0]["color"]  # defaults filled
    assert detail["state"]["source"]["system"] == "Azure DevOps"
    via_mcp = stack.ok("get_release_plan", {"planId": plan_id})
    assert {k: v for k, v in via_mcp.items() if k != "boardUrl"} == detail
    listed = stack.ok("list_release_plans", {})
    assert listed["total"] == 1 and listed["page"] == 1 and listed["pageSize"] == 10
    assert listed["items"][0]["id"] == plan_id and "state" not in listed["items"][0]
    assert listed["items"][0]["boardUrl"] == created["boardUrl"] and via_mcp["id"] == plan_id

    # null name keeps the stored name; state.name follows the column
    new_state = copy.deepcopy(detail["state"])
    new_state["name"] = "typed by agent"
    new_state["epics"][0]["features"][0]["title"] = "Changed"
    updated = stack.ok("update_release_plan", {"planId": plan_id, "state": new_state})
    assert updated["name"] == "Plan A"
    after = stack.client.get(f"/api/plan/{plan_id}").json()
    assert after["state"]["name"] == "Plan A" and after["state"]["epics"][0]["features"][0]["title"] == "Changed"
    renamed = stack.ok("update_release_plan", {"planId": plan_id, "state": new_state, "name": " Plan B "})
    assert renamed["name"] == "Plan B"
    after = stack.client.get(f"/api/plan/{plan_id}").json()
    assert after["name"] == "Plan B" and after["state"]["name"] == "Plan B"

    # a UI-style PUT (shallow validation) still works on an MCP-stored plan, and MCP can read it back
    ui_state = after["state"]
    ui_state["epics"][0]["title"] = "From the UI"
    put = stack.client.put(f"/api/plan/{plan_id}", json={"name": "Plan C", "state": {**ui_state, "name": "Plan C"}})
    assert put.status_code == 200, put.text
    assert stack.ok("get_release_plan", {"planId": plan_id})["state"]["epics"][0]["title"] == "From the UI"
    # a board saved by the UI is accepted by the strict validator
    again = stack.ok("update_release_plan", {"planId": plan_id, "state": stack.ok("get_release_plan", {"planId": plan_id})["state"]})
    assert again["name"] == "Plan C"


@pytest.mark.db
def test_update_errors_unknown_id_and_project_change(stack):
    plan_id = stack.ok("create_release_plan", {"name": "P", "state": board()})["id"]
    assert stack.fail("update_release_plan", {"planId": 999, "state": board()}).endswith("Release plan not found: 999.")
    assert stack.fail("get_release_plan", {"planId": 999}).endswith("Release plan not found: 999.")
    assert stack.fail("get_release_plan", {"planId": 2**40}).endswith(f"Release plan not found: {2**40}.")
    assert stack.fail("get_release_plan", {"planId": -1}).endswith("Release plan not found: -1.")
    other = board()
    other["source"]["project"] = "Other"
    message = stack.fail("update_release_plan", {"planId": plan_id, "state": other})
    assert message.endswith("The plan's project cannot be changed (stored: cloud · Proj).")
    onprem = board()
    onprem["source"] = {**onprem["source"], "kind": "onprem", "projectUrl": "https://dev.azure.com/org/Proj"}
    message = stack.fail("update_release_plan", {"planId": plan_id, "state": onprem})
    assert "project cannot be changed" in message or "invalid" in message
    padded = board()
    padded["source"]["project"] = "  Proj  "
    assert stack.ok("update_release_plan", {"planId": plan_id, "state": padded})["projectName"] == "Proj"
    # refused updates changed nothing: the title is still the original one
    assert stack.client.get(f"/api/plan/{plan_id}").json()["state"]["epics"][0]["title"] == "Epic"


@pytest.mark.db
@pytest.mark.parametrize("name,message", [("", "required"), ("   ", "required"), ("x" * 201, "at most 200"), ("a\x00b", "invalid characters")])
def test_name_errors_use_the_existing_texts(stack, name, message):
    assert message in stack.fail("create_release_plan", {"name": name, "state": board()})
    assert message in stack.fail("update_release_plan", {"planId": 1, "state": board(), "name": name})
    assert stack.ok("list_release_plans", {})["total"] == 0


@pytest.mark.db
def test_invalid_board_stores_nothing_and_validate_stores_nothing(stack):
    bad = board(milestones="x")
    assert "Release plan is invalid:" in stack.fail("create_release_plan", {"name": "n", "state": bad})
    assert stack.ok("validate_release_plan", {"state": board()})["valid"] is True
    assert stack.ok("list_release_plans", {})["total"] == 0


@pytest.mark.db
def test_a_big_valid_board_is_stored_through_http(stack):
    big = board()
    big["epics"][0]["features"][0]["description"] = "y" * (4 * 1024 * 1024 + 50_000)
    created = stack.ok("create_release_plan", {"name": "big", "state": big})
    assert len(stack.client.get(f"/api/plan/{created['id']}").json()["state"]["epics"][0]["features"][0]["description"]) > 4 * 1024 * 1024


@pytest.mark.db
def test_list_pages_and_concurrent_creates_use_separate_sessions(stack):
    errors: list[str] = []

    def create(index: int) -> None:
        try:
            result = Mcp(stack.client).raw("create_release_plan", {"name": f"P{index}", "state": board()})
            if result["isError"]:
                errors.append(result["content"][0]["text"])
        except Exception as exc:  # noqa: BLE001
            errors.append(repr(exc))

    threads = [threading.Thread(target=create, args=(i,)) for i in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
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
