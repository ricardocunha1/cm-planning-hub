"""Unit tests for the Release Plan MCP tools, through the SDK's in-process
client, with fake Azure DevOps and an in-memory plan store (no database)."""

import base64
import copy
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import pytest

from ado_fakes import PROJECT_NAME, FakeAdo, mock_http_client, synthetic_backlog, work_item
from app.config import Settings
from app.db import DB_UNAVAILABLE
from app.mcp_server import ado_tools, deps, plan_tools
from app.mcp_server.errors import UNEXPECTED_ERROR
from app.schemas import PlanDetail, PlanSummary
from app.services.ado_client import PAT_REJECTED
from app.services.ado_url import PAT_REQUIRED
from app.services.plan_from_backlog import decisions_json_schema
from app.services.plans import NAME_INVALID_CHARS, NAME_REQUIRED, NAME_TOO_LONG
from mcp_helpers import call, failure, ok, run_client, wire

PAT = "SeCrEt-pat-ZZ9-0123456789abcdef"
SECRETS = (PAT, base64.b64encode(f":{PAT}".encode()).decode())
URL = "https://dev.azure.com/contoso/Fabrikam%20Plant"
SCOPE = f"{PROJECT_NAME}\\Team A"
SETTINGS = Settings(
    ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0, public_base_url="https://hub.example.com"
)
TOOLS = {
    "list_release_plans",
    "get_release_plan",
    "validate_release_plan",
    "create_release_plan",
    "update_release_plan",
    "ado_fetch_backlog",
    "get_release_plan_schema",
}
CONNECTION = {"source": "cloud", "projectUrl": URL, "scopeType": "area", "scopePath": SCOPE}
# synthetic_backlog(): Epics 101 (Feature 102) and 201 (Feature 103), orphan Features 104 and 105
DECISIONS = {
    "milestones": [{"id": "ms_a", "name": "MVP"}, {"id": "ms_b", "name": "GA"}],
    "epicOrder": [201, 101],
    "assignments": {"102": "ms_a", "103": "ms_b"},
}


def create_args(**overrides: Any) -> dict[str, Any]:
    return {"name": "My plan", "pat": PAT, "connection": dict(CONNECTION), **copy.deepcopy(DECISIONS), **overrides}


def update_args(plan_id: int = 1, **overrides: Any) -> dict[str, Any]:
    return {"planId": plan_id, "pat": PAT, **copy.deepcopy(DECISIONS), **overrides}


def validate_args(**overrides: Any) -> dict[str, Any]:
    return {"connection": dict(CONNECTION), **copy.deepcopy(DECISIONS), **overrides}


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setattr(plan_tools, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(ado_tools, "get_settings", lambda: SETTINGS)


class Store:
    """In-memory stand-in for the `plans` service functions."""

    def __init__(self) -> None:
        self.rows: dict[int, PlanDetail] = {}
        self.writes = 0

    def add(self, state: dict[str, Any], *, name: str = "Stored", kind: str = "cloud", project: str = PROJECT_NAME) -> int:
        plan_id = len(self.rows) + 1
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.rows[plan_id] = PlanDetail(
            id=plan_id, name=name, projectType=kind, projectName=project, createdAt=now, updatedAt=now, state=state
        )
        return plan_id

    async def create_plan(self, session, name, project_type, project_name, state):
        self.writes += 1
        plan_id = self.add(state, name=name.strip(), kind=project_type, project=project_name.strip())
        return self.rows[plan_id]

    async def get_plan(self, session, plan_id):
        return self.rows.get(plan_id)

    async def update_plan(self, session, plan_id, name, state):
        if plan_id not in self.rows:
            return None
        self.writes += 1
        self.rows[plan_id] = self.rows[plan_id].model_copy(update={"name": name.strip(), "state": state})
        return self.rows[plan_id]


@asynccontextmanager
async def _fake_session():
    yield object()


@pytest.fixture()
def store(monkeypatch):
    fake = Store()
    monkeypatch.setattr(plan_tools.plans, "create_plan", fake.create_plan)
    monkeypatch.setattr(plan_tools.plans, "get_plan", fake.get_plan)
    monkeypatch.setattr(plan_tools.plans, "update_plan", fake.update_plan)
    with deps.override_providers(session=_fake_session):
        yield fake


def use(fake: FakeAdo | None = None):
    """Serve fake ADO to the tools through the `deps` seam."""
    handler = fake or FakeAdo()

    @asynccontextmanager
    async def provider():
        async with mock_http_client(handler) as http:
            yield http

    return deps.override_providers(ado_client=provider)


def assert_no_pat(text: str) -> None:
    for secret in SECRETS:
        assert secret not in text


def tools_by_name() -> dict[str, Any]:
    return {tool.name: tool for tool in run_client(lambda c: c.list_tools()).tools}


# --- registration -----------------------------------------------------------------


def test_exactly_the_contract_tools_and_no_resources_or_prompts():
    async def listing(client):
        return await client.list_tools(), await client.list_resources(), await client.list_prompts()

    tools, resources, prompts = run_client(listing)
    assert {tool.name for tool in tools.tools} == TOOLS
    assert resources.resources == []
    assert prompts.prompts == []


def test_every_tool_has_an_actionable_description():
    tools = tools_by_name()
    assert all(len(tool.description or "") > 80 for tool in tools.values())
    assert "close the board" in tools["update_release_plan"].description
    assert "never stored" in tools["ado_fetch_backlog"].description
    assert "never guess" in tools["ado_fetch_backlog"].description


def test_create_and_update_descriptions_explain_the_slim_contract():
    tools = tools_by_name()
    for name in ("create_release_plan", "update_release_plan"):
        text = tools[name].description
        assert "never retype" in text and "ado_fetch_backlog" in text and "Personal Access Token" in text
    update = tools["update_release_plan"].description
    assert "get_release_plan first" in update and "Unplanned" in update and "full replace" in update
    assert "Epic and Feature ids can only be checked" in tools["validate_release_plan"].description


@pytest.mark.parametrize("tool", sorted(plan_tools.DECISION_TOOLS))
def test_decision_tools_advertise_the_slim_input_schema(tool):
    schema = tools_by_name()[tool].input_schema
    properties = schema["properties"]
    assert "state" not in properties
    assert set(plan_tools.DECISION_TOOLS[tool]) <= set(properties)
    assert all(properties[argument].get("description") for argument in properties)
    assert properties["mode"]["enum"] == ["releases", "sprints"]
    assert properties["milestones"]["items"] == {"$ref": "#/$defs/Milestone"}
    assert {"Milestone", "Flag", "Connection"} <= set(schema["$defs"])
    assert ("connection" in properties) == (tool != "update_release_plan")
    if "connection" in properties:
        assert properties["connection"]["$ref"] == "#/$defs/Connection"
        assert schema["$defs"]["Connection"]["properties"]["scopeType"]["enum"] == ["area", "iteration"]
    for required in ("milestones", "epicOrder", "assignments"):
        assert required in schema["required"]
    assert "mode" not in schema["required"] and "flags" not in schema["required"]


def test_create_and_update_take_a_secret_pat():
    tools = tools_by_name()
    for name in ("create_release_plan", "update_release_plan"):
        assert tools[name].input_schema["properties"]["pat"]["format"] == "password"
        assert "pat" in tools[name].input_schema["required"]
    assert "pat" not in tools["validate_release_plan"].input_schema["properties"]
    assert "planId" in tools["update_release_plan"].input_schema["required"]
    assert "name" not in tools["update_release_plan"].input_schema["required"]


def test_get_release_plan_schema_returns_the_decisions_schema():
    schema = ok("get_release_plan_schema", {})
    assert schema == decisions_json_schema()
    assert set(schema["properties"]) == {"connection", "mode", "milestones", "flags", "epicOrder", "assignments"}


def test_schema_descriptions_explain_unplanned():
    assert "Unplanned" in decisions_json_schema()["properties"]["assignments"]["description"]


def test_a_fresh_server_has_the_tools_each_time():
    for _ in range(2):
        assert {t.name for t in run_client(lambda c: c.list_tools()).tools} == TOOLS


# --- validate_release_plan ----------------------------------------------------------


def test_validate_returns_only_valid_true_without_ado_or_database():
    @asynccontextmanager
    async def refuse():
        raise AssertionError("validate must not call the database or Azure DevOps")
        yield

    with deps.override_providers(session=refuse, ado_client=refuse):
        assert ok("validate_release_plan", validate_args()) == {"valid": True}


def test_validate_lists_every_error_without_raising():
    args = validate_args(
        mode="sprints",
        milestones=[{"id": "a", "name": "A"}, {"id": "a", "name": "B"}],
        epicOrder=[1, 1],
        assignments={"1": "zz"},
        flags=[{"afterMsId": "nope"}],
    )
    result = ok("validate_release_plan", args)
    assert result["valid"] is False
    text = "\n".join(result["errors"])
    for part in ("duplicate milestone id", "epicOrder[1]", "assignments['1']", "flags[0].afterMsId"):
        assert part in text


@pytest.mark.parametrize("connection", ["not an object", 5, [], None, {}])
def test_validate_reports_a_bad_connection(connection):
    result = ok("validate_release_plan", validate_args(connection=connection))
    assert result["valid"] is False and result["errors"]


def test_validate_requires_the_connection_and_applies_the_host_allowlist():
    args = validate_args()
    bad_host = {**CONNECTION, "projectUrl": "https://evil.example.com/org/Proj"}
    errors = ok("validate_release_plan", {**args, "connection": bad_host})["errors"]
    assert errors and errors[0].startswith("connection.projectUrl:")
    assert call("validate_release_plan", {k: v for k, v in args.items() if k != "connection"}).is_error


def test_validate_flags_need_sprints_mode():
    flags = [{"name": "Freeze", "afterMsId": "ms_a"}]
    assert ok("validate_release_plan", validate_args(flags=flags))["valid"] is False
    assert ok("validate_release_plan", validate_args(flags=flags, mode="sprints")) == {"valid": True}


def test_validate_does_not_check_ids_against_the_backlog():
    assert ok("validate_release_plan", validate_args(epicOrder=[99999], assignments={"88888": None}))["valid"] is True


def test_validate_accepts_int_assignment_keys_in_a_json_string_argument():
    import json

    result = ok("validate_release_plan", validate_args(assignments=json.dumps({"102": "ms_a"})))
    assert result == {"valid": True}


def test_validate_unexpected_error_is_generic(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(plan_tools, "parse_decisions", boom)
    text = failure("validate_release_plan", validate_args())
    assert UNEXPECTED_ERROR in text and "secret internal detail" not in text


# --- create_release_plan -------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "message"),
    [("", NAME_REQUIRED), ("   ", NAME_REQUIRED), ("x" * 201, NAME_TOO_LONG), ("a\x00b", NAME_INVALID_CHARS)],
)
def test_create_rejects_an_invalid_name_before_any_request(name, message, store):
    fake = FakeAdo()
    with use(fake):
        assert message in failure("create_release_plan", create_args(name=name))
    assert fake.requests == [] and store.writes == 0


def test_create_lists_every_decision_error_before_any_request(store):
    fake = FakeAdo()
    args = create_args(epicOrder=[1, 1], assignments={"102": "zz"}, flags=[{"afterMsId": "ms_a"}])
    with use(fake):
        text = failure("create_release_plan", args)
        structural = failure("create_release_plan", create_args(mode="bad", milestones="x"))
    assert "Release plan is invalid:\n- " in text
    assert text.count("\n- ") == 3
    assert "epicOrder[1]" in text and "assignments['102']" in text and "flags:" in text
    assert "mode:" in structural and "milestones:" in structural
    assert fake.requests == [] and store.writes == 0


def test_create_refuses_a_disallowed_host_and_a_blank_pat_before_any_request(store):
    fake = FakeAdo()
    with use(fake):
        bad_host = {**CONNECTION, "projectUrl": "https://evil.example.com/org/Proj"}
        assert "connection.projectUrl" in failure("create_release_plan", create_args(connection=bad_host))
        assert PAT_REQUIRED in failure("create_release_plan", create_args(pat="  "))
    assert fake.requests == [] and store.writes == 0


def test_create_builds_the_full_board_from_ado_and_stores_it(store):
    with use():
        summary = ok("create_release_plan", create_args(name="  My plan "))
    assert summary["name"] == "My plan"
    assert summary["projectType"] == "cloud" and summary["projectName"] == PROJECT_NAME
    assert summary["boardUrl"] == f"https://hub.example.com/release-plan/{summary['id']}"
    board = store.rows[summary["id"]].state
    assert board["name"] == "My plan" and board["mode"] == "releases" and board["flags"] == []
    assert [e["id"] for e in board["epics"]] == [201, 101, "no-epic"]
    assert [m["color"] for m in board["milestones"]] == ["#4E98D1", "#60C5B5"]
    by_id = {f["id"]: f for e in board["epics"] for f in e["features"]}
    assert by_id[102]["milestoneId"] == "ms_a" and by_id[103]["milestoneId"] == "ms_b"
    assert by_id[104]["milestoneId"] is None and by_id[105]["milestoneId"] is None
    assert (by_id[102]["title"], by_id[102]["size"], by_id[102]["iterationPath"]) == (
        "Login", "M", f"{PROJECT_NAME}\\Phase 1\\Sprint 02")
    assert board["epics"][1]["description"] == "<p>Platform epic</p>"
    assert board["source"]["project"] == PROJECT_NAME and board["source"]["kind"] == "cloud"
    assert board["source"]["scopePath"] == SCOPE and board["source"]["system"] == "Azure DevOps"
    assert board["iterations"]
    assert not any(key in board["source"] for key in ("pat", "token"))


def test_create_default_mode_and_sprints_with_flags(store):
    with use():
        summary = ok(
            "create_release_plan",
            create_args(mode="sprints", flags=[{"name": "Freeze", "date": "2026-11-01", "afterMsId": "ms_a"}]),
        )
    board = store.rows[summary["id"]].state
    assert board["mode"] == "sprints" and board["flags"][0]["name"] == "Freeze"
    assert board["flags"][0]["id"].startswith("fl_")


def test_create_with_null_optional_arguments_uses_the_defaults(store):
    with use():
        summary = ok("create_release_plan", create_args(mode=None, flags=None))
    assert store.rows[summary["id"]].state["mode"] == "releases"


def test_create_appends_omitted_epics_in_id_order(store):
    with use():
        summary = ok("create_release_plan", create_args(epicOrder=["no-epic"]))
    assert [e["id"] for e in store.rows[summary["id"]].state["epics"]] == ["no-epic", 101, 201]


def test_create_lists_unknown_epic_and_feature_ids_and_stores_nothing(store):
    with use():
        text = failure("create_release_plan", create_args(epicOrder=[101, 777], assignments={"102": "ms_a", "888": None}))
    assert "unknown Epic id(s) not in the backlog: 777" in text
    assert "unknown Feature id(s) not in the backlog: 888" in text
    assert store.writes == 0


def test_create_truncates_descriptions_like_the_backlog_tool(store, monkeypatch):
    monkeypatch.setattr(plan_tools, "get_settings", lambda: Settings(
        ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0, ado_description_max_chars=10))
    items = [*synthetic_backlog(), work_item(107, "Feature", "Long", "Team A", parent=101, description="<p>" + "x" * 50 + "</p>")]
    with use(FakeAdo(work_items=items)):
        summary = ok("create_release_plan", create_args())
    board = store.rows[summary["id"]].state
    long_item = next(f for e in board["epics"] for f in e["features"] if f["id"] == 107)
    assert long_item["description"].endswith("…") and len(long_item["description"]) <= 11


@pytest.mark.parametrize("kind", ["401", "403", "404", "500", "502", "non_json", "timeout", "connect"])
def test_create_ado_failures_store_nothing_and_leak_no_pat(kind, store, caplog):
    caplog.set_level(logging.DEBUG)
    with use(FakeAdo(failures={"any": kind})):
        result = call("create_release_plan", create_args())
    assert result.is_error and UNEXPECTED_ERROR not in wire(result)
    assert_no_pat(wire(result))
    assert_no_pat(caplog.text)
    assert store.writes == 0


def test_create_rejected_pat_message_is_the_existing_one(store):
    with use(FakeAdo(failures={"any": "401"})):
        assert PAT_REJECTED in failure("create_release_plan", create_args())


def test_create_unknown_scope_path_is_an_ado_error(store):
    with use():
        text = failure("create_release_plan", create_args(connection={**CONNECTION, "scopePath": "Nope"}))
    assert "Unknown Area path" in text and store.writes == 0


def test_pat_is_in_no_result_log_or_stored_board(store, caplog):
    caplog.set_level(logging.DEBUG)
    with use():
        result = call("create_release_plan", create_args())
    assert not result.is_error
    assert_no_pat(wire(result))
    assert_no_pat(caplog.text)
    assert_no_pat(repr(store.rows[1].state))


def test_unexpected_errors_in_create_are_generic_and_log_no_secret(store, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)

    async def explode(*args, **kwargs):
        raise RuntimeError(f"leaked {PAT}")

    monkeypatch.setattr(plan_tools, "fetch_backlog", explode)
    with use():
        result = call("create_release_plan", create_args())
    assert result.is_error and UNEXPECTED_ERROR in wire(result)
    assert_no_pat(wire(result))
    assert_no_pat(caplog.text)
    assert "RuntimeError" in caplog.text


def test_the_strict_validator_is_the_safety_net(store):
    items = [work_item(101, "Epic", "   ", "Team A"), work_item(102, "Feature", "F", "Team A", parent=101)]
    with use(FakeAdo(work_items=items)):
        text = failure("create_release_plan", create_args(epicOrder=[], assignments={}))
    assert "Release plan is invalid:" in text and "epics[0].title" in text
    assert store.writes == 0


# --- update_release_plan -------------------------------------------------------------


def stored_board(**source: Any) -> dict[str, Any]:
    return {
        "schema": "release-planner-features", "version": 1, "mode": "releases", "name": "Stored",
        "source": {
            "system": "Azure DevOps", "project": PROJECT_NAME, "kind": "cloud", "projectUrl": URL,
            "scopeType": "area", "scopePath": SCOPE, **source,
        },
        "iterations": [], "flags": [],
        "milestones": [{"id": "ms_old", "name": "Old", "date": "", "color": "#4E98D1"}],
        "epics": [{"id": 999, "title": "Gone Epic", "state": "", "description": "", "features": [
            {"id": 998, "title": "Gone", "state": "", "description": "", "size": "", "iterationPath": "", "milestoneId": "ms_old"}]}],
    }


def test_update_rebuilds_from_ado_and_drops_items_no_longer_in_scope(store):
    plan_id = store.add(stored_board())
    with use():
        summary = ok("update_release_plan", update_args(plan_id))
    assert summary["id"] == plan_id and summary["name"] == "Stored"
    board = store.rows[plan_id].state
    assert [e["id"] for e in board["epics"]] == [201, 101, "no-epic"]  # Epic 999 is gone
    assert [m["id"] for m in board["milestones"]] == ["ms_a", "ms_b"]
    assert board["name"] == "Stored"
    titles = {f["id"]: f["title"] for e in board["epics"] for f in e["features"]}
    assert titles[102] == "Login" and 998 not in titles
    assert board["source"]["fetchedAt"]


def test_update_refreshes_ado_fields_each_time(store):
    plan_id = store.add(stored_board())
    renamed = [work_item(101, "Epic", "Renamed epic", "Team A", state="Closed"),
               work_item(102, "Feature", "Renamed feature", "Team A", parent=101, size="xl")]
    with use(FakeAdo(work_items=renamed)):
        ok("update_release_plan", update_args(plan_id, epicOrder=[101], assignments={"102": "ms_b"}))
    epic = store.rows[plan_id].state["epics"][0]
    assert (epic["title"], epic["state"]) == ("Renamed epic", "Closed")
    assert epic["features"][0] == {
        "id": 102, "title": "Renamed feature", "state": "New", "description": "", "size": "XL",
        "iterationPath": PROJECT_NAME, "milestoneId": "ms_b",
    }


def test_update_name_rules(store):
    plan_id = store.add(stored_board(), name="Original")
    with use():
        assert ok("update_release_plan", update_args(plan_id))["name"] == "Original"
        assert store.rows[plan_id].state["name"] == "Original"
        summary = ok("update_release_plan", update_args(plan_id, name=" Renamed "))
    assert summary["name"] == "Renamed" and store.rows[plan_id].state["name"] == "Renamed"
    assert summary["boardUrl"].endswith(f"/release-plan/{plan_id}")


def test_update_rejects_an_invalid_name_and_invalid_decisions_before_any_request(store):
    plan_id = store.add(stored_board())
    fake = FakeAdo()
    with use(fake):
        assert NAME_TOO_LONG in failure("update_release_plan", update_args(plan_id, name="x" * 201))
        assert "Release plan is invalid:" in failure("update_release_plan", update_args(plan_id, assignments={"1": "zz"}))
    assert fake.requests == [] and store.writes == 0


def test_update_unknown_plan_is_reported_before_any_request(store):
    fake = FakeAdo()
    with use(fake):
        assert "Release plan not found: 99." in failure("update_release_plan", update_args(99))
    assert fake.requests == []


def test_update_uses_the_stored_connection_even_if_one_is_sent(store):
    plan_id = store.add(stored_board())
    fake = FakeAdo()
    other = {**CONNECTION, "projectUrl": "https://dev.azure.com/other/Elsewhere"}
    with use(fake):
        ok("update_release_plan", {**update_args(plan_id), "connection": other})
    assert store.rows[plan_id].state["source"]["projectUrl"] == URL
    assert all("Elsewhere" not in str(request.url) for request in fake.requests)


@pytest.mark.parametrize(
    "stored",
    [
        dict(kind="onprem", project=PROJECT_NAME),  # kind differs
        dict(kind="cloud", project="Other"),  # project name differs
    ],
)
def test_update_refuses_a_project_change(stored, store):
    plan_id = store.add(stored_board(), kind=stored["kind"], project=stored["project"])
    with use():
        text = failure("update_release_plan", update_args(plan_id))
    assert f"The plan's project cannot be changed (stored: {stored['kind']} · {stored['project']})." in text
    assert store.writes == 0


@pytest.mark.parametrize("state", [{}, {"source": 5}, {"source": {"kind": "cloud"}}, {"source": {"kind": "x", "projectUrl": "u"}}])
def test_update_needs_a_usable_stored_connection(state, store):
    plan_id = store.add(state)
    fake = FakeAdo()
    with use(fake):
        assert plan_tools.STORED_CONNECTION_INVALID in failure("update_release_plan", update_args(plan_id))
    assert fake.requests == []


def test_update_with_a_stored_host_no_longer_allowed_is_refused(store):
    plan_id = store.add(stored_board(projectUrl="https://evil.example.com/org/Proj"))
    fake = FakeAdo()
    with use(fake):
        text = failure("update_release_plan", update_args(plan_id))
    assert "evil.example.com" in text or "allowed" in text.lower()
    assert fake.requests == []


@pytest.mark.parametrize("kind", ["401", "404", "500", "timeout"])
def test_update_ado_failures_write_nothing_and_leak_no_pat(kind, store, caplog):
    plan_id = store.add(stored_board())
    caplog.set_level(logging.DEBUG)
    with use(FakeAdo(failures={"any": kind})):
        result = call("update_release_plan", update_args(plan_id))
    assert result.is_error
    assert_no_pat(wire(result))
    assert_no_pat(caplog.text)
    assert store.writes == 0 and store.rows[plan_id].state["epics"][0]["id"] == 999


def test_update_lists_unknown_ids_and_writes_nothing(store):
    plan_id = store.add(stored_board())
    with use():
        text = failure("update_release_plan", update_args(plan_id, epicOrder=[5], assignments={"998": "ms_a"}))
    assert "unknown Epic id(s) not in the backlog: 5" in text
    assert "unknown Feature id(s) not in the backlog: 998" in text
    assert store.writes == 0


def test_update_success_result_and_logs_have_no_pat(store, caplog):
    plan_id = store.add(stored_board())
    caplog.set_level(logging.DEBUG)
    with use():
        result = call("update_release_plan", update_args(plan_id))
    assert not result.is_error
    assert_no_pat(wire(result))
    assert_no_pat(caplog.text)


# --- reads --------------------------------------------------------------------------


def test_list_rejects_a_page_below_one():
    assert plan_tools.PAGE_INVALID in failure("list_release_plans", {"page": 0})


def test_get_rejects_a_non_integer_id():
    assert call("get_release_plan", {"planId": "abc"}).is_error


def test_get_returns_the_full_stored_board_with_descriptions(store):
    state = stored_board()
    state["epics"][0]["description"] = "<p>kept</p>"
    plan_id = store.add(state)
    result = ok("get_release_plan", {"planId": plan_id})
    assert {"id", "state", "boardUrl"} <= result.keys()
    assert result["state"]["epics"][0]["description"] == "<p>kept</p>"
    assert result["boardUrl"].endswith(f"/release-plan/{plan_id}")


# --- error mapping ---------------------------------------------------------------


def _broken(exc: Exception):
    @asynccontextmanager
    async def provider():
        raise exc
        yield

    return provider


@pytest.mark.parametrize("exc", [OSError("down"), ConnectionRefusedError("refused")])
def test_database_errors_map_to_db_unavailable(exc):
    with deps.override_providers(session=_broken(exc)), use():
        for name, args in [
            ("list_release_plans", {}),
            ("get_release_plan", {"planId": 1}),
            ("create_release_plan", create_args()),
            ("update_release_plan", update_args()),
        ]:
            assert DB_UNAVAILABLE in failure(name, args), name


def test_unexpected_errors_are_generic_and_logged(caplog):
    caplog.set_level(logging.ERROR)
    with deps.override_providers(session=_broken(RuntimeError("secret internal detail"))):
        text = failure("get_release_plan", {"planId": 1})
    assert UNEXPECTED_ERROR in text
    assert "secret internal detail" not in text
    record = next(r for r in caplog.records if r.name == "app.mcp_server.errors")
    assert record.exc_info and "secret internal detail" in str(record.exc_info[1])


def test_list_items_have_id_and_board_url_and_no_board_from_the_service(monkeypatch):
    async def fake_list(session, page):
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        detail = PlanDetail(id=7, name="P", projectType="cloud", projectName="Proj", createdAt=now, updatedAt=now, state={})
        return [PlanSummary(**detail.model_dump(exclude={"state"}))], 1

    monkeypatch.setattr(plan_tools.plans, "list_plans", fake_list)
    with deps.override_providers(session=_fake_session):
        result = ok("list_release_plans", {})
    item = result["items"][0]
    assert {"id", "boardUrl"} <= item.keys() and "state" not in item
    assert item["id"] == 7 and item["boardUrl"].endswith("/release-plan/7")


def test_board_url_is_relative_without_public_base_url(store, monkeypatch):
    relative = Settings(ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0)
    monkeypatch.setattr(plan_tools, "get_settings", lambda: relative)
    with use():
        summary = ok("create_release_plan", create_args())
    assert summary["boardUrl"] == f"/release-plan/{summary['id']}"


def test_descriptions_tell_the_agent_the_id_is_internal_and_to_give_the_board_url():
    tools = tools_by_name()
    for name in ("list_release_plans", "get_release_plan", "update_release_plan"):
        description = tools[name].description or ""
        assert "never show" in description and "`id`" in description, name
    for name in ("list_release_plans", "get_release_plan"):
        assert "`boardUrl`" in tools[name].description and "name and project" in tools[name].description
    assert "planId" in tools["list_release_plans"].description
    assert "{valid: true}" in tools["validate_release_plan"].description


# --- the SDK never sees a bad PAT-bearing call ------------------------------------------------


@pytest.mark.parametrize(
    "args",
    [
        {"pat": PAT},
        {"name": "n", "pat": PAT},
        {"name": "n", "pat": PAT, "connection": dict(CONNECTION)},
        {"name": 5, "pat": PAT, "connection": dict(CONNECTION), **DECISIONS},
        {"name": "n", "pat": PAT, "connection": 7, "milestones": 1, "epicOrder": 2, "assignments": 3},
        {"name": "n", "pat": [PAT], **DECISIONS},
        {"name": "n", "pat": {"x": PAT}, "connection": dict(CONNECTION), **DECISIONS},
        {"name": "n", "connection": dict(CONNECTION), **DECISIONS},
    ],
)
def test_create_with_missing_or_malformed_arguments_never_echoes_the_pat(args, store, caplog):
    caplog.set_level(logging.DEBUG)
    with use():
        result = call("create_release_plan", args)
    assert result.is_error
    text = wire(result)
    assert "Release plan is invalid:" in text and "input_value" not in text
    assert_no_pat(text)
    assert PAT[-12:] not in text and PAT[:3] + "..." not in text
    assert_no_pat(caplog.text)
    assert store.writes == 0


@pytest.mark.parametrize(
    "args",
    [
        {"planId": 1, "pat": PAT},
        {"pat": PAT, **DECISIONS},
        {"planId": "abc", "pat": PAT, **DECISIONS},
        {"planId": True, "pat": PAT, **DECISIONS},
        {"planId": 1, "pat": PAT, "name": 3, **DECISIONS},
        {"planId": 1, "pat": 12345, **DECISIONS},
        {"planId": 1, **DECISIONS},
    ],
)
def test_update_with_missing_or_malformed_arguments_never_echoes_the_pat(args, store, caplog):
    store.add(stored_board())
    caplog.set_level(logging.DEBUG)
    fake = FakeAdo()
    with use(fake):
        result = call("update_release_plan", args)
    assert result.is_error
    text = wire(result)
    assert "Release plan is invalid:" in text and "input_value" not in text
    assert_no_pat(text)
    assert PAT[-12:] not in text
    assert_no_pat(caplog.text)
    assert fake.requests == [] and store.writes == 0


def test_argument_errors_name_the_argument():
    text = failure("update_release_plan", {"planId": "x", "pat": PAT})
    for part in ("planId: must be an integer", "milestones: is required", "epicOrder: is required", "assignments: is required"):
        assert part in text
    text = failure("create_release_plan", {"pat": 5})
    assert "name: is required" in text and "pat: must be a string" in text and "connection: is required" in text


def test_ado_fetch_backlog_with_missing_or_malformed_arguments_never_echoes_the_pat():
    for args in ({"pat": PAT}, {"pat": PAT, "source": 5, "projectUrl": URL}, {"source": "cloud"}):
        result = call("ado_fetch_backlog", args)
        assert result.is_error
        assert "input_value" not in wire(result)
        assert_no_pat(wire(result))
        assert PAT[-12:] not in wire(result)


def test_update_description_tells_the_agent_to_drop_stale_assignments():
    text = tools_by_name()["update_release_plan"].description
    assert "drop the assignments of Features that left the backlog" in text
    assert "unknown Feature ids" in text
