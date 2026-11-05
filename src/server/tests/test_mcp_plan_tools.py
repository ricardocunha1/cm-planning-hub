"""Unit tests for the Release Plan MCP tools, through the SDK's in-process
client. Cases that touch the database carry the `db` marker."""

import copy
import logging
from contextlib import asynccontextmanager
from typing import Any

import pytest

from app.config import Settings
from app.db import DB_UNAVAILABLE
from app.mcp_server import ado_tools, deps, plan_tools
from app.mcp_server.errors import UNEXPECTED_ERROR
from app.services.plan_board import board_json_schema
from app.services.plans import NAME_INVALID_CHARS, NAME_REQUIRED, NAME_TOO_LONG
from mcp_helpers import call, db_provider, failure, ok, run_client

URL = "https://dev.azure.com/org/Proj"
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
}


def board(**overrides: Any) -> dict[str, Any]:
    state: dict[str, Any] = {
        "schema": "release-planner-features",
        "source": {"project": "Proj", "kind": "cloud", "projectUrl": URL, "scopeType": "area", "scopePath": "Proj\\Team"},
        "milestones": [{"id": "ms_a", "name": "MVP"}],
        "epics": [{"id": 1, "title": "Epic", "features": [{"id": 10, "title": "F", "milestoneId": "ms_a"}]}],
    }
    state.update(overrides)
    return state


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setattr(plan_tools, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(ado_tools, "get_settings", lambda: SETTINGS)


@pytest.fixture()
def store(clean_db):
    with deps.override_providers(session=db_provider(clean_db)):
        yield clean_db


# --- registration ---------------------------------------------------------------


def test_exactly_the_contract_tools_resource_and_no_prompts():
    async def listing(client):
        return await client.list_tools(), await client.list_resources(), await client.list_prompts()

    tools, resources, prompts = run_client(listing)
    assert {tool.name for tool in tools.tools} == TOOLS
    assert [str(r.uri) for r in resources.resources] == ["release-plan://schema"]
    assert prompts.prompts == []


def test_every_tool_has_an_actionable_description():
    tools = {tool.name: tool for tool in run_client(lambda c: c.list_tools()).tools}
    assert all(len(tool.description or "") > 80 for tool in tools.values())
    assert "close the board" in tools["update_release_plan"].description
    assert "never stored" in tools["ado_fetch_backlog"].description
    assert "never guess" in tools["ado_fetch_backlog"].description


def test_board_schema_is_the_state_input_schema_of_the_three_board_tools():
    tools = {tool.name: tool for tool in run_client(lambda c: c.list_tools()).tools}
    expected = board_json_schema()
    defs = expected.pop("$defs")
    for name in plan_tools.STATE_TOOLS:
        schema = tools[name].input_schema
        assert schema["$defs"] == defs
        assert schema["properties"]["state"]["properties"] == expected["properties"]
        assert "state" in schema["required"]
    assert "state" not in tools["get_release_plan"].input_schema["properties"]


def test_schema_descriptions_explain_unplanned():
    feature = board_json_schema()["$defs"]["Feature"]["properties"]["milestoneId"]
    assert "Unplanned" in feature["description"]


def test_schema_resource_is_the_board_schema():
    import json

    contents = run_client(lambda c: c.read_resource("release-plan://schema")).contents
    assert json.loads(contents[0].text) == board_json_schema()


def test_a_fresh_server_has_the_tools_each_time():
    for _ in range(2):
        assert {t.name for t in run_client(lambda c: c.list_tools()).tools} == TOOLS


# --- validate_release_plan --------------------------------------------------------


def test_validate_returns_the_normalized_board_and_stores_nothing():
    @asynccontextmanager
    async def no_database():
        raise AssertionError("validate must not touch the database")
        yield

    with deps.override_providers(session=no_database):
        result = ok("validate_release_plan", {"state": board()})
    assert result["valid"] is True
    assert result["state"]["mode"] == "releases"
    assert result["state"]["milestones"][0]["color"].startswith("#")


def test_validate_lists_every_error_without_raising():
    state = board(extra=1)
    state["epics"][0]["features"][0]["milestoneId"] = "nope"
    state["milestones"][0]["date"] = "2026-13-01"
    result = ok("validate_release_plan", {"state": state})
    assert result["valid"] is False
    assert len(result["errors"]) == 3
    assert any(e.startswith("epics[0].features[0].milestoneId:") for e in result["errors"])


@pytest.mark.parametrize("state", ["not a board", 5, [], None, {}])
def test_validate_accepts_any_json_and_reports_it(state):
    result = ok("validate_release_plan", {"state": state})
    assert result == {"valid": False, "errors": ["Plan state is not a release plan."]}


def test_validate_parses_a_board_sent_as_a_json_string():
    import json

    assert ok("validate_release_plan", {"state": json.dumps(board())})["valid"] is True


def test_validate_applies_the_host_allowlist():
    state = board()
    state["source"]["projectUrl"] = "https://evil.example.com/org/Proj"
    errors = ok("validate_release_plan", {"state": state})["errors"]
    assert errors and errors[0].startswith("source.projectUrl:")


# --- create_release_plan (no database needed to fail) --------------------------------


@pytest.mark.parametrize(
    ("name", "message"),
    [("", NAME_REQUIRED), ("   ", NAME_REQUIRED), ("x" * 201, NAME_TOO_LONG), ("a\x00b", NAME_INVALID_CHARS)],
)
def test_create_rejects_an_invalid_name(name, message):
    assert message in failure("create_release_plan", {"name": name, "state": board()})


def test_create_lists_every_board_error():
    state = board(extra=1, mode="bad")
    text = failure("create_release_plan", {"name": "P", "state": state})
    assert text.count("\n- ") == 2
    assert "Release plan is invalid:\n- " in text
    assert "extra: unknown key" in text and "mode:" in text


def test_update_rejects_an_invalid_name_and_board():
    assert NAME_TOO_LONG in failure("update_release_plan", {"planId": 1, "name": "x" * 201, "state": board()})
    assert "Release plan is invalid:" in failure("update_release_plan", {"planId": 1, "state": {"schema": "x"}})


def test_list_rejects_a_page_below_one():
    assert plan_tools.PAGE_INVALID in failure("list_release_plans", {"page": 0})


def test_get_rejects_a_non_integer_id():
    assert call("get_release_plan", {"planId": "abc"}).is_error


# --- error mapping ---------------------------------------------------------------


def _broken(exc: Exception):
    @asynccontextmanager
    async def provider():
        raise exc
        yield

    return provider


@pytest.mark.parametrize("exc", [OSError("down"), ConnectionRefusedError("refused")])
def test_database_errors_map_to_db_unavailable(exc):
    with deps.override_providers(session=_broken(exc)):
        for name, args in [
            ("list_release_plans", {}),
            ("get_release_plan", {"planId": 1}),
            ("create_release_plan", {"name": "P", "state": board()}),
            ("update_release_plan", {"planId": 1, "state": board()}),
        ]:
            assert DB_UNAVAILABLE in failure(name, args)


def test_unexpected_errors_are_generic_and_logged(caplog):
    caplog.set_level(logging.ERROR)
    with deps.override_providers(session=_broken(RuntimeError("secret internal detail"))):
        text = failure("get_release_plan", {"planId": 1})
    assert UNEXPECTED_ERROR in text
    assert "secret internal detail" not in text
    record = next(r for r in caplog.records if r.name == "app.mcp_server.errors")
    assert record.exc_info and "secret internal detail" in str(record.exc_info[1])


# --- with the database ---------------------------------------------------------------


@pytest.mark.db
def test_create_derives_project_sets_name_and_returns_board_url(store):
    summary = ok("create_release_plan", {"name": "  My plan ", "state": board()})
    assert summary["name"] == "My plan"
    assert summary["projectType"] == "cloud" and summary["projectName"] == "Proj"
    assert summary["boardUrl"] == f"https://hub.example.com/release-plan/{summary['id']}"
    stored = ok("get_release_plan", {"planId": summary["id"]})
    assert stored["state"]["name"] == "My plan"
    assert stored["state"]["milestones"][0]["color"].startswith("#")
    assert stored["boardUrl"] == summary["boardUrl"]


@pytest.mark.db
def test_board_url_is_relative_without_public_base_url(store, monkeypatch):
    relative = Settings(ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0)
    monkeypatch.setattr(plan_tools, "get_settings", lambda: relative)
    summary = ok("create_release_plan", {"name": "P", "state": board()})
    assert summary["boardUrl"] == f"/release-plan/{summary['id']}"


@pytest.mark.db
def test_validate_stores_nothing(store):
    ok("validate_release_plan", {"state": board()})
    assert ok("list_release_plans", {})["total"] == 0


@pytest.mark.db
def test_list_paginates_and_has_no_board(store):
    for i in range(11):
        ok("create_release_plan", {"name": f"P{i}", "state": board()})
    first = ok("list_release_plans", {})
    assert first["total"] == 11 and first["page"] == 1 and first["pageSize"] == 10
    assert len(first["items"]) == 10 and "state" not in first["items"][0]
    assert first["items"][0]["name"] == "P10"
    assert len(ok("list_release_plans", {"page": 2})["items"]) == 1
    assert ok("list_release_plans", {"page": 3})["items"] == []


@pytest.mark.db
def test_get_and_update_unknown_id(store):
    assert failure("get_release_plan", {"planId": 99}).endswith("Release plan not found: 99.")
    assert "Release plan not found: 99." in failure("update_release_plan", {"planId": 99, "state": board()})
    assert "Release plan not found: 0." in failure("get_release_plan", {"planId": 0})


@pytest.mark.db
def test_update_with_null_name_keeps_the_stored_name(store):
    plan_id = ok("create_release_plan", {"name": "Original", "state": board()})["id"]
    new = board()
    new["milestones"].append({"id": "ms_b", "name": "GA"})
    new["name"] = "ignored"
    summary = ok("update_release_plan", {"planId": plan_id, "state": new})
    assert summary["name"] == "Original"
    stored = ok("get_release_plan", {"planId": plan_id})
    assert stored["state"]["name"] == "Original"
    assert [m["id"] for m in stored["state"]["milestones"]] == ["ms_a", "ms_b"]


@pytest.mark.db
def test_update_with_a_name_renames_and_syncs_state_name(store):
    plan_id = ok("create_release_plan", {"name": "Original", "state": board()})["id"]
    summary = ok("update_release_plan", {"planId": plan_id, "name": " Renamed ", "state": board()})
    assert summary["name"] == "Renamed"
    assert ok("get_release_plan", {"planId": plan_id})["state"]["name"] == "Renamed"
    assert summary["boardUrl"].endswith(f"/release-plan/{plan_id}")


@pytest.mark.db
@pytest.mark.parametrize(
    "mutate",
    [lambda s: s["source"].update(project="Other"), lambda s: s["source"].update(kind="onprem", projectUrl=URL)],
)
def test_update_refuses_a_project_change(store, mutate):
    plan_id = ok("create_release_plan", {"name": "P", "state": board()})["id"]
    changed = copy.deepcopy(board())
    mutate(changed)
    text = failure("update_release_plan", {"planId": plan_id, "state": changed})
    assert "The plan's project cannot be changed (stored: cloud · Proj)." in text
    assert ok("get_release_plan", {"planId": plan_id})["state"]["source"]["project"] == "Proj"
