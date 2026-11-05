"""QA end-to-end: the agent flow over real HTTP `POST /api/mcp` with PostgreSQL.

fake-ADO `ado_fetch_backlog` -> the test builds a board from the returned
`workItems` exactly as the client's `planFromBacklog` does
(src/client/src/lib/releasePlan/fromBacklog.ts) -> `create_release_plan` ->
`GET /api/plan/{id}` returns the same board -> `update_release_plan` -> a
UI-style `PUT /api/plan/{id}` still works and the strict validator accepts what
the UI saved (so agents can update UI-created plans).

Tasks 3 (UI-saved boards pass `validate_board` unchanged) is already covered for
hand-built Releases and Sprints boards by test_plan_board_integration.py; here it
is additionally checked on a `planFromBacklog`-shaped board fetched from fake ADO.
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


@pytest.mark.db
def test_agent_flow_fetch_build_create_get_update_and_ui_put(stack, fixed_clock):
    backlog, args = _fetch(stack)
    # synthetic backlog: Epic 101 (Feature 102), Epic 201 (parent of Feature 103, fetched as the parent) and
    # orphans 104 (no parent) and 105 (parent is a User Story)
    assert [w["id"] for w in backlog["workItems"] if w["type"] == "Feature"] == [102, 103, 104, 105]

    built = plan_from_backlog(backlog, args)
    assert [e["id"] for e in built["epics"]] == [101, 201, NO_EPIC_ID]
    assert [f["id"] for f in built["epics"][1]["features"]] == [103]
    assert [f["id"] for f in built["epics"][2]["features"]] == [104, 105]
    assert built["epics"][0]["features"][0]["size"] == "M"  # " m " trimmed and upper-cased

    # what the UI would save passes the strict validator unchanged
    validated = validate_board(copy.deepcopy(built), HOSTS)
    assert validated.errors == [] and validated.board == built

    # the agent validates, then stores
    check = stack.ok("validate_release_plan", {"state": built})
    assert check == {"valid": True, "state": built}
    created = stack.ok("create_release_plan", {"name": built["name"], "state": built})
    plan_id = created["id"]
    assert created["projectType"] == "cloud" and created["projectName"] == backlog["project"]["name"]
    assert created["boardUrl"] == f"https://hub.example.com/release-plan/{plan_id}"

    # GET /api/plan/{id} returns the same board (as stored: name equals the column)
    detail = stack.client.get(f"/api/plan/{plan_id}")
    assert detail.status_code == 200
    assert detail.json()["state"] == built
    assert stack.ok("get_release_plan", {"planId": plan_id})["state"] == built

    # no PAT anywhere in the stored board
    assert args["pat"] not in detail.text

    # the agent moves every Feature of the first Epic to a new dated milestone and renames the plan
    edited = copy.deepcopy(built)
    edited["milestones"].append({"id": "ms_second1", "name": "R2", "date": "2026-12-31", "color": "#60C5B5"})
    edited["epics"][0]["features"][0]["milestoneId"] = "ms_second1"
    updated = stack.ok("update_release_plan", {"planId": plan_id, "state": edited, "name": "Renamed by agent"})
    assert updated["name"] == "Renamed by agent"
    stored = stack.client.get(f"/api/plan/{plan_id}").json()
    assert stored["name"] == "Renamed by agent" and stored["state"]["name"] == "Renamed by agent"
    assert stored["state"]["milestones"][1]["id"] == "ms_second1"
    assert stored["state"]["epics"][0]["features"][0]["milestoneId"] == "ms_second1"

    # UI-style autosave (shallow validation) still works, with a savedAt the UI adds
    ui_state = copy.deepcopy(stored["state"])
    ui_state["savedAt"] = "2026-10-23T10:05:00.000Z"
    ui_state["epics"][2]["features"][0]["milestoneId"] = None  # unplanned
    put = stack.client.put(f"/api/plan/{plan_id}", json={"name": "Renamed by agent", "state": ui_state})
    assert put.status_code == 200, put.text
    assert put.json()["state"] == ui_state

    # and the agent can update what the UI saved, unchanged
    ui_saved = stack.ok("get_release_plan", {"planId": plan_id})["state"]
    assert validate_board(copy.deepcopy(ui_saved), HOSTS).board == ui_saved
    again = stack.ok("update_release_plan", {"planId": plan_id, "state": ui_saved})
    assert again["name"] == "Renamed by agent"
    assert stack.client.get(f"/api/plan/{plan_id}").json()["state"] == ui_saved


@pytest.mark.db
def test_ui_saved_sprints_board_with_flags_can_be_updated_by_an_agent(stack, fixed_clock):
    """A Sprints-mode board with flags saved through REST (as the UI does) is accepted unchanged by the MCP tools."""
    backlog, args = _fetch(stack)
    board = plan_from_backlog(backlog, args)
    board["mode"] = "sprints"
    board["milestones"] = [
        {"id": "ms_s1", "name": "Sprint 01", "date": "2026-10-30", "color": "#4E98D1"},
        {"id": "ms_s2", "name": "Sprint 02", "date": "2026-11-13", "color": "#60C5B5"},
    ]
    board["flags"] = [{"id": "fl_abc1234", "name": "Freeze", "date": "2026-11-01", "afterMsId": "ms_s1"}]
    for epic in board["epics"]:
        for f in epic["features"]:
            f["milestoneId"] = "ms_s1"
    board["savedAt"] = "2026-10-23T10:00:00.000Z"

    created = stack.client.post(
        "/api/plan", json={"name": board["name"], "projectType": "cloud", "projectName": board["source"]["project"], "state": board}
    )
    assert created.status_code in (200, 201), created.text
    plan_id = created.json()["id"]
    got = stack.ok("get_release_plan", {"planId": plan_id})["state"]
    assert got == board
    assert stack.ok("validate_release_plan", {"state": got}) == {"valid": True, "state": board}
    stack.ok("update_release_plan", {"planId": plan_id, "state": got})
    assert stack.client.get(f"/api/plan/{plan_id}").json()["state"] == board


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
