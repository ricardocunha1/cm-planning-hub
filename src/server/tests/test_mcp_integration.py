"""QA end-to-end: the agent flow over real HTTP `POST /api/mcp` with PostgreSQL.

fake-ADO `ado_fetch_backlog` -> `create_release_plan` with decisions only; the
stored board equals what the client's `planFromBacklog` builds from the same
backlog (src/client/src/lib/releasePlan/fromBacklog.ts) ->
`GET /api/plan/{id}` returns the same board -> `update_release_plan` -> a
UI-style `PUT /api/plan/{id}` still works and the strict validator accepts what
the UI saved (so agents can update UI-created plans).

The agent sends only its decisions; the server fetches the backlog and builds
the board, which must equal the `planFromBacklog` port below.
"""

import copy
from datetime import datetime, timezone

import pytest

from ado_fakes import FakeAdo, synthetic_backlog
from app.mcp_server import deps
from app.services import ado_backlog
from app.services.plan_board import validate_board

# fixtures / helpers shared with the MCP tools integration suite
from test_mcp_tools_integration import _ado_args, _serve, env, mcp, stack  # noqa: F401

HOSTS = ("dev.azure.com",)
MS_COLORS_0 = "#4E98D1"
NO_EPIC_ID = "no-epic"
NO_EPIC_TITLE = "Features without an Epic"


def plan_from_backlog(backlog: dict, args: dict, milestone_id: str = "ms_test001") -> dict:
    """Python port of `planFromBacklog` / `groupBacklog` (fromBacklog.ts)."""
    items = sorted(backlog["workItems"], key=lambda w: w["id"])
    groups = {w["id"]: {"epic": w, "features": []} for w in items if w["type"] == "Epic"}
    orphans = []
    for w in items:
        if w["type"] != "Feature":
            continue
        group = groups.get(w["parentId"]) if w["parentId"] is not None else None
        (group["features"] if group else orphans).append(w)

    def feature(w):
        return {
            "id": w["id"], "title": w["title"], "state": w["state"], "description": w["description"],
            "size": w["size"].strip().upper(), "iterationPath": w["iterationPath"], "milestoneId": milestone_id,
        }

    epics = [
        {"id": g["epic"]["id"], "title": g["epic"]["title"], "state": g["epic"]["state"],
         "description": g["epic"]["description"], "features": [feature(f) for f in g["features"]]}
        for g in groups.values()
    ]
    if orphans:
        epics.append({"id": NO_EPIC_ID, "title": NO_EPIC_TITLE, "state": "", "description": "",
                      "features": [feature(f) for f in orphans]})
    return {
        "schema": "release-planner-features", "version": 1, "mode": "releases",
        "name": f"{backlog['project']['name']} – Feature Release Plan",
        "source": {
            "system": "Azure DevOps", "project": backlog["project"]["name"], "scope": backlog["scope"],
            "fetchedAt": backlog["fetchedAt"], "kind": args["source"], "projectUrl": args["projectUrl"],
            "scopeType": args["scopeType"], "scopePath": args["scopePath"],
        },
        "iterations": [{"path": i["path"], "finishDate": i["finishDate"]} for i in backlog["iterations"]],
        "milestones": [{"id": milestone_id, "name": "MVP", "date": "", "color": MS_COLORS_0}],
        "flags": [],
        "epics": epics,
    }


@pytest.fixture()
def fixed_clock(monkeypatch):
    monkeypatch.setattr(ado_backlog, "_utc_now", lambda: datetime(2026, 10, 23, 10, 0, 0, tzinfo=timezone.utc))


def _fetch(stack):
    args = _ado_args()
    with deps.override_providers(ado_client=_serve(FakeAdo(work_items=synthetic_backlog()))):
        backlog = stack.ok("ado_fetch_backlog", args)
    return backlog, args


def _agent_args(args: dict, **overrides) -> dict:
    """create_release_plan arguments: only the agent's decisions, no titles, states or descriptions."""
    connection = {k: args[k] for k in ("source", "projectUrl", "scopeType", "scopePath")}
    return {
        "name": "Agent plan", "pat": args["pat"], "connection": connection,
        "milestones": [{"id": "ms_test001", "name": "MVP"}],
        "epicOrder": [101, 201, NO_EPIC_ID],
        "assignments": {"102": "ms_test001", "103": "ms_test001", "104": "ms_test001", "105": "ms_test001"},
        **overrides,
    }


@pytest.mark.db
def test_agent_flow_fetch_decide_create_get_update_and_ui_put(stack, fixed_clock):
    backlog, args = _fetch(stack)
    # synthetic backlog: Epic 101 (Feature 102), Epic 201 (parent of Feature 103, fetched as the parent) and
    # orphans 104 (no parent) and 105 (parent is a User Story)
    assert [w["id"] for w in backlog["workItems"] if w["type"] == "Feature"] == [102, 103, 104, 105]

    # the agent sends decisions only; the server builds the board `planFromBacklog` would build
    expected = plan_from_backlog(backlog, args)
    expected["name"] = "Agent plan"
    with deps.override_providers(ado_client=_serve(FakeAdo(work_items=synthetic_backlog()))):
        created = stack.ok("create_release_plan", _agent_args(args))
    plan_id = created["id"]
    assert created["projectType"] == "cloud" and created["projectName"] == backlog["project"]["name"]
    assert created["boardUrl"] == f"https://hub.example.com/release-plan/{plan_id}"

    detail = stack.client.get(f"/api/plan/{plan_id}")
    assert detail.status_code == 200
    assert detail.json()["state"] == expected
    assert stack.ok("get_release_plan", {"planId": plan_id})["state"] == expected
    assert [e["id"] for e in expected["epics"]] == [101, 201, NO_EPIC_ID]
    assert args["pat"] not in detail.text
    # what the server stored passes the strict validator unchanged
    validated = validate_board(copy.deepcopy(expected), HOSTS)
    assert validated.errors == [] and validated.board == expected

    # the agent reorders the Epics, adds a milestone, moves a Feature and renames the plan
    decisions = {
        "milestones": [{"id": "ms_test001", "name": "MVP"}, {"id": "ms_second1", "name": "R2", "date": "2026-12-31"}],
        "epicOrder": [NO_EPIC_ID, 201],
        "assignments": {"102": "ms_second1"},
    }
    with deps.override_providers(ado_client=_serve(FakeAdo(work_items=synthetic_backlog()))):
        updated = stack.ok("update_release_plan", {"planId": plan_id, "pat": args["pat"], "name": "Renamed by agent", **decisions})
    assert updated["name"] == "Renamed by agent"
    stored = stack.client.get(f"/api/plan/{plan_id}").json()
    assert stored["name"] == "Renamed by agent" and stored["state"]["name"] == "Renamed by agent"
    assert [e["id"] for e in stored["state"]["epics"]] == [NO_EPIC_ID, 201, 101]
    assert stored["state"]["milestones"][1]["id"] == "ms_second1"
    by_id = {f["id"]: f["milestoneId"] for e in stored["state"]["epics"] for f in e["features"]}
    assert by_id == {102: "ms_second1", 103: None, 104: None, 105: None}

    # UI-style autosave (shallow validation) still works, with a savedAt the UI adds
    ui_state = copy.deepcopy(stored["state"])
    ui_state["savedAt"] = "2026-10-23T10:05:00.000Z"
    ui_state["epics"][0]["features"][0]["milestoneId"] = None
    put = stack.client.put(f"/api/plan/{plan_id}", json={"name": "Renamed by agent", "state": ui_state})
    assert put.status_code == 200, put.text
    assert put.json()["state"] == ui_state


def test_normalized_board_fixture_is_a_fixed_point_of_validate_board():
    """The fixture the client's Vitest test (`mcpBoard.test.ts`) feeds to `normalizePlan`
    must be exactly what the strict validator emits (both modes, flags, `no-epic` Epic)."""
    import json
    from pathlib import Path

    fixture = json.loads((Path(__file__).parent / "fixtures" / "mcp_board_normalized.json").read_text(encoding="utf-8"))
    assert set(fixture) == {"releases", "sprints"}
    assert fixture["releases"]["mode"] == "releases" and fixture["sprints"]["flags"]
    for board in fixture.values():
        assert board["epics"][-1]["id"] == NO_EPIC_ID
        result = validate_board(copy.deepcopy(board), ("dev.azure.com", "tfs.example.com"))
        assert result.errors == [] and result.board == board
