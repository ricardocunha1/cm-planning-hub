"""QA integration: the Release Plan MCP tools that build the board from Azure
DevOps (`create_release_plan` / `update_release_plan` / `validate_release_plan`,
decisions only), over real HTTP through the app lifespan, with fake Azure
DevOps. Tests marked `db` need PostgreSQL (TEST_DATABASE_URL). Parity is
checked against `ado_fetch_backlog` (the source of truth for work item data)
and the rules of the client's lib/releasePlan/fromBacklog.ts."""

import json
import logging
import os
import threading

import pytest

from ado_fakes import FakeAdo, work_item
from app.mcp_server import deps
from db_helpers import run_sql
from test_mcp_tools_integration import (  # noqa: F401  (fixtures)
    PAT,
    URL,
    Mcp,
    _ado_args,
    _fake_ado,
    _serve,
    connection,
    create_args,
    decisions,
    env,
    fixed_clock,
    mcp,
    stack,
    update_args,
)

MS = [{"id": "ms_a", "name": "R1"}, {"id": "ms_b", "name": "R2", "date": "2026-12-01"}]


def full_args(**overrides):
    """Decisions over the default synthetic backlog (scope Team A): Epic 101
    with Feature 102; Epic 201 (Team B, returned as the parent of 103); orphans
    104 (no parent), 105 (parent is a User Story); 106 is Removed."""
    base = {"milestones": MS, "epicOrder": [101, "no-epic"], "assignments": {"102": "ms_a", "104": "ms_b"}}
    base.update(overrides)
    return base


def stored(stack, plan_id):
    return stack.client.get(f"/api/plan/{plan_id}").json()


def ids(epics):
    return [e["id"] for e in epics]


# --- parity of the built board with the backlog / client planFromBacklog ------------------------------


@pytest.mark.db
def test_built_board_matches_the_backlog_and_the_client_grouping_rules(stack, fixed_clock):
    ado = FakeAdo()
    with deps.override_providers(ado_client=_serve(ado)):
        backlog = stack.ok("ado_fetch_backlog", _ado_args())
        created = stack.ok("create_release_plan", create_args(**full_args()))
    board = stored(stack, created["id"])["state"]
    items = {i["id"]: i for i in backlog["workItems"]}

    assert board["schema"] and board["version"] == 1 and board["mode"] == "releases"
    # source: project, scope, fetchedAt, connection; never the PAT
    src = board["source"]
    assert src == {
        "system": "Azure DevOps",
        "project": backlog["project"]["name"],
        "scope": backlog["scope"],
        "fetchedAt": backlog["fetchedAt"],
        "kind": "cloud",
        "projectUrl": connection()["projectUrl"],
        "scopeType": "area",
        "scopePath": connection()["scopePath"],
    }
    assert board["iterations"] == [{"path": i["path"], "finishDate": i["finishDate"]} for i in backlog["iterations"]]
    assert PAT not in json.dumps(board)

    # Epic 101 and no-epic as ordered by the agent, then the omitted Epic 201 (parent of 103)
    assert ids(board["epics"]) == [101, "no-epic", 201]
    epic, noepic, other = board["epics"]
    assert [f["id"] for f in other["features"]] == [103] and other["title"] == items[201]["title"]
    assert (epic["title"], epic["state"], epic["description"]) == tuple(items[101][k] for k in ("title", "state", "description"))
    assert noepic["title"] == "Features without an Epic" and noepic["state"] == "" and noepic["description"] == ""
    assert [f["id"] for f in epic["features"]] == [102]
    # orphans: no parent (104), parent not an Epic (105); Removed 106 absent
    assert [f["id"] for f in noepic["features"]] == [104, 105]
    for feature in epic["features"] + noepic["features"] + other["features"]:
        item = items[feature["id"]]
        assert feature["title"] == item["title"] and feature["state"] == item["state"]
        assert feature["description"] == item["description"]
        assert feature["size"] == item["size"].strip().upper()
        assert feature["iterationPath"] == item["iterationPath"]
    assert {f["id"]: f["milestoneId"] for e in board["epics"] for f in e["features"]} == {
        102: "ms_a", 103: None, 104: "ms_b", 105: None,
    }
    assert epic["features"][0]["size"] == "M"  # " m " trimmed and upper-cased


@pytest.mark.db
def test_epic_order_variants_and_integer_vs_string_ids(stack):
    ado = FakeAdo(
        work_items=[
            work_item(1, "Epic", "E1", "Team A"),
            work_item(5, "Epic", "E5", "Team A"),
            work_item(9, "Epic", "E9", "Team A"),
            work_item(2, "Feature", "F2", "Team A", parent=1),
            work_item(6, "Feature", "F6", "Team A", parent=5),
            work_item(7, "Feature", "F7", "Team A"),
        ]
    )

    def create(name, **kw):
        with deps.override_providers(ado_client=_serve(ado)):
            return stack.ok("create_release_plan", create_args(name=name, milestones=MS, **kw))

    def order(plan):
        return ids(stored(stack, plan["id"])["state"]["epics"])

    # missing Epics appended by ascending id, no-epic last
    assert order(create("a", epicOrder=[5], assignments={})) == [5, 1, 9, "no-epic"]
    # no-epic anywhere the agent puts it
    assert order(create("b", epicOrder=["no-epic", 9], assignments={})) == ["no-epic", 9, 1, 5]
    # integer and numeric-string ids are the same Epic / Feature
    plan = create("c", epicOrder=["9", " 5 "], assignments={" 6 ": "ms_a", "2": None})
    state = stored(stack, plan["id"])["state"]
    assert ids(state["epics"]) == [9, 5, 1, "no-epic"]
    assert {f["id"]: f["milestoneId"] for e in state["epics"] for f in e["features"]} == {2: None, 6: "ms_a", 7: None}
    # empty order = all in id order
    assert order(create("d", epicOrder=[], assignments={})) == [1, 5, 9, "no-epic"]
    # ids are never invented: the stored Epic ids stay integers
    assert all(isinstance(e["id"], int) for e in state["epics"][:3])


@pytest.mark.db
def test_no_epic_in_order_without_orphans_is_a_noop(stack):
    ado = FakeAdo(work_items=[work_item(1, "Epic", "E", "Team A"), work_item(2, "Feature", "F", "Team A", parent=1)])
    with deps.override_providers(ado_client=_serve(ado)):
        plan = stack.ok("create_release_plan", create_args(milestones=MS, epicOrder=["no-epic", 1], assignments={}))
    assert ids(stored(stack, plan["id"])["state"]["epics"]) == [1]


@pytest.mark.db
def test_backlog_without_epics_or_features_builds_an_empty_board(stack):
    with deps.override_providers(ado_client=_serve(FakeAdo(work_items=[]))):
        plan = stack.ok("create_release_plan", create_args(milestones=[], epicOrder=[], assignments={}))
    state = stored(stack, plan["id"])["state"]
    assert state["epics"] == [] and state["milestones"] == []


@pytest.mark.db
def test_sprints_mode_with_flags_is_stored_normalized(stack):
    sprint_ms = [{"id": "s1", "name": "S1"}, {"id": "s2", "name": "S2"}]
    flags = [{"afterMsId": "s1"}, {"id": "fl_x", "name": "Freeze", "date": "2026-11-01", "afterMsId": "s2"}]
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan = stack.ok(
            "create_release_plan",
            create_args(mode="sprints", milestones=sprint_ms, flags=flags, epicOrder=[101], assignments={"102": "s2"}),
        )
    state = stored(stack, plan["id"])["state"]
    assert state["mode"] == "sprints"
    assert len(state["flags"]) == 2 and state["flags"][0]["id"].startswith("fl_") and state["flags"][0]["name"]
    assert state["flags"][1]["id"] == "fl_x" and all(m["color"] for m in state["milestones"])
    # releases mode (the default) refuses flags and stores nothing
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        message = stack.fail("create_release_plan", create_args(name="two", milestones=sprint_ms, flags=flags))
    assert 'flags: must be empty in "releases" mode' in message
    assert stack.ok("list_release_plans", {})["total"] == 1


# --- errors: nothing is stored, all reported at once ---------------------------------------------------


@pytest.mark.db
def test_unknown_and_duplicate_ids_are_listed_at_once_and_store_nothing(stack):
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        message = stack.fail(
            "create_release_plan",
            create_args(milestones=MS, epicOrder=[101, 77, "78"], assignments={"888": "ms_a", "999": None, "106": None}),
        )
        # Epic 77/78 and Features 888/999 do not exist; 106 is Removed (not in the backlog)
        assert "unknown Epic id(s) not in the backlog: 77, 78" in message
        assert "unknown Feature id(s) not in the backlog: 888, 999, 106" in message
        # a Feature id used as Epic and an Epic id used as Feature are unknown too
        message = stack.fail("create_release_plan", create_args(milestones=MS, epicOrder=[102], assignments={"101": None}))
        assert "Epic id(s) not in the backlog: 102" in message and "Feature id(s) not in the backlog: 101" in message
        # the same Feature as 2 and " 2 " is a duplicate, not a silent override
        message = stack.fail("create_release_plan", create_args(milestones=MS, epicOrder=[], assignments={"102": "ms_a", " 102 ": None}))
        assert "duplicate Feature id" in message
        # structural errors win over reference errors; ids mixing types are rejected
        for bad_order in ([True], [1.5], [None], [""], [[1]]):
            assert "epicOrder" in stack.fail("create_release_plan", create_args(milestones=MS, epicOrder=bad_order, assignments={}))
        for bad_assign in ({"102": 5}, {"102": ""}, [], {"": None}):
            assert stack.fail("create_release_plan", create_args(milestones=MS, epicOrder=[], assignments=bad_assign))
    assert stack.ok("list_release_plans", {})["total"] == 0


@pytest.mark.db
def test_validate_is_offline_and_agrees_with_create_on_offline_errors(stack):
    ado = FakeAdo()
    with deps.override_providers(ado_client=_serve(ado)):
        args = {"connection": connection(), **full_args(assignments={"102": "nope"})}
        result = stack.ok("validate_release_plan", args)
        assert result["valid"] is False and "unknown milestone id 'nope'" in "\n".join(result["errors"])
        # unknown backlog ids are not validate's business
        assert stack.ok("validate_release_plan", {"connection": connection(), **full_args(epicOrder=[12345], assignments={"999": None})}) == {"valid": True}
    assert ado.requests == []  # validate never calls Azure DevOps
    # disallowed host is reported offline
    bad = {**connection(), "projectUrl": "https://evil.example.com/org/Proj"}
    result = stack.ok("validate_release_plan", {"connection": bad, **full_args()})
    assert result["valid"] is False and "connection.projectUrl" in result["errors"][0]


@pytest.mark.db
@pytest.mark.parametrize("kind", ["401", "403", "404", "500", "502", "non_json", "timeout", "connect"])
def test_ado_failures_on_create_store_nothing_and_never_echo_the_pat(stack, caplog, kind):
    with caplog.at_level(logging.DEBUG), deps.override_providers(ado_client=_serve(FakeAdo(failures={"any": kind}))):
        message = stack.fail("create_release_plan", create_args(**full_args()))
    assert PAT not in message
    assert stack.ok("list_release_plans", {})["total"] == 0
    assert all(PAT not in r.getMessage() and PAT not in str(r.exc_info) for r in caplog.records)


@pytest.mark.db
def test_unexpected_failure_while_building_is_generic_and_does_not_log_the_pat(stack, monkeypatch, caplog):
    from app.mcp_server import plan_tools
    from app.mcp_server.errors import UNEXPECTED_ERROR

    def boom(*args, **kwargs):
        raise RuntimeError(f"internal {PAT}")

    monkeypatch.setattr(plan_tools, "build_board", boom)
    with caplog.at_level(logging.DEBUG), deps.override_providers(ado_client=_serve(FakeAdo())):
        message = stack.fail("create_release_plan", create_args(**full_args()))
    assert UNEXPECTED_ERROR in message and PAT not in message
    assert all(PAT not in r.getMessage() and PAT not in str(r.exc_info) and PAT not in str(r.__dict__) for r in caplog.records)
    assert stack.ok("list_release_plans", {})["total"] == 0


@pytest.mark.parametrize("tool,args", [
    ("create_release_plan", {"name": "n", "pat": PAT}),
    ("update_release_plan", {"planId": 1, "pat": PAT}),
    ("ado_fetch_backlog", {"pat": PAT}),
])
def test_pat_is_not_echoed_when_required_arguments_are_missing(mcp, tool, args):
    result = mcp.raw(tool, args)
    assert result["isError"] is True
    text = "\n".join(block["text"] for block in result["content"])
    assert PAT not in text and PAT[-12:] not in text  # not even the tail pydantic shows in input_value


# --- update: sync, partial writes, stored connection -------------------------------------------------


@pytest.mark.db
def test_update_is_a_sync_items_lost_from_ado_disappear_and_stale_assignments_are_refused(stack):
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan_id = stack.ok("create_release_plan", create_args(name="P", **full_args()))["id"]
    before = stored(stack, plan_id)
    assert {f["id"] for e in before["state"]["epics"] for f in e["features"]} == {102, 103, 104, 105}

    # ADO now lacks Feature 102 and 104, retitled 103, and Epic 101 is renamed
    items = [i for i in FakeAdo().work_items if i["id"] not in (102, 104)]
    for item in items:
        if item["id"] == 103:
            item["fields"]["System.Title"] = "Reports v2"
        if item["id"] == 101:
            item["fields"]["System.Title"] = "Platform v2"
    gone = FakeAdo(work_items=items)

    # resending the assignments of vanished Features is an error and writes nothing
    with deps.override_providers(ado_client=_serve(gone)):
        message = stack.fail("update_release_plan", update_args(plan_id, **full_args()))
    assert "unknown Feature id(s) not in the backlog: 104, 102" in message or "102" in message and "104" in message
    assert stored(stack, plan_id) == before

    with deps.override_providers(ado_client=_serve(gone)):
        stack.ok("update_release_plan", update_args(plan_id, milestones=MS, epicOrder=["no-epic", 101], assignments={"103": "ms_b"}))
    after = stored(stack, plan_id)
    state = after["state"]
    assert after["name"] == "P" and ids(state["epics"]) == ["no-epic", 101, 201]
    assert state["epics"][1]["title"] == "Platform v2" and state["epics"][1]["features"] == []
    features = [f for e in state["epics"] for f in e["features"]]
    assert {f["id"] for f in features} == {103, 105}
    assert {f["id"]: f["title"] for f in features}[103] == "Reports v2"
    assert {f["id"]: f["milestoneId"] for f in features} == {103: "ms_b", 105: None}
    assert PAT not in json.dumps(after)


@pytest.mark.db
def test_update_failures_leave_the_stored_plan_untouched(stack):
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan_id = stack.ok("create_release_plan", create_args(name="P", **full_args()))["id"]
    before = stored(stack, plan_id)
    listed = stack.ok("list_release_plans", {})["items"][0]
    cases = [
        ("ado", FakeAdo(failures={"batch": "500"}), update_args(plan_id, **full_args())),
        ("ado-auth", FakeAdo(failures={"projects": "401"}), update_args(plan_id, **full_args())),
        ("ids", FakeAdo(), update_args(plan_id, **full_args(epicOrder=[4242]))),
        ("milestone", FakeAdo(), update_args(plan_id, **full_args(assignments={"102": "zz"}))),
        ("name", FakeAdo(), update_args(plan_id, name="x" * 201, **full_args())),
        ("flags", FakeAdo(), update_args(plan_id, **full_args(flags=[{"afterMsId": "ms_a"}]))),
    ]
    for label, ado, args in cases:
        with deps.override_providers(ado_client=_serve(ado)):
            message = stack.fail("update_release_plan", args)
        assert PAT not in message, label
        assert stored(stack, plan_id) == before, label
    assert stack.ok("list_release_plans", {})["items"][0]["updatedAt"] == listed["updatedAt"]


@pytest.mark.db
def test_update_rejects_a_changed_project_and_keeps_name_and_board(stack):
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan_id = stack.ok("create_release_plan", create_args(name="P", **full_args()))["id"]
    before = stored(stack, plan_id)
    run_sql(os.environ["TEST_DATABASE_URL"], f"UPDATE release_plans SET project_type = 'onprem' WHERE id = {plan_id}")
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        message = stack.fail("update_release_plan", update_args(plan_id, name="Renamed", **full_args()))
    assert "project cannot be changed" in message
    after = stored(stack, plan_id)
    assert after["name"] == "P" and after["state"] == before["state"]


@pytest.mark.db
@pytest.mark.parametrize("drop", ["whole", "projectUrl", "kind", "scopePath"])
def test_update_of_a_plan_without_a_usable_connection_is_a_clean_error(stack, drop):
    """A plan saved by the UI from a JSON file has no Azure DevOps connection."""
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan_id = stack.ok("create_release_plan", create_args(name="P", **full_args()))["id"]
    state = stored(stack, plan_id)["state"]
    if drop == "whole":
        del state["source"]
    else:
        del state["source"][drop]
    put = stack.client.put(f"/api/plan/{plan_id}", json={"name": "P", "state": state})
    assert put.status_code == 200, put.text
    ado = FakeAdo()
    with deps.override_providers(ado_client=_serve(ado)):
        message = stack.fail("update_release_plan", update_args(plan_id, **full_args()))
    assert "no usable Azure DevOps connection" in message
    assert ado.requests == []  # failed before calling Azure DevOps with the PAT
    assert stored(stack, plan_id)["state"] == state


@pytest.mark.db
def test_update_uses_the_stored_connection_not_one_sent_by_the_agent(stack):
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan_id = stack.ok("create_release_plan", create_args(name="P", **full_args()))["id"]
    ado = FakeAdo()
    with deps.override_providers(ado_client=_serve(ado)):
        # `connection` is not an update argument: the call must not silently re-point the plan
        result = stack.raw("update_release_plan", update_args(plan_id, connection={**connection(), "scopePath": "Other"}, **full_args()))
    state = stored(stack, plan_id)["state"]
    assert state["source"]["scopePath"] == connection()["scopePath"], result


@pytest.mark.db
def test_update_after_the_ui_saved_a_sprints_board_with_flags(stack):
    sprint_ms = [{"id": "s1", "name": "S1"}, {"id": "s2", "name": "S2"}]
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan_id = stack.ok(
            "create_release_plan",
            create_args(name="P", mode="sprints", milestones=sprint_ms, flags=[{"id": "fl_1", "afterMsId": "s1"}], epicOrder=[101], assignments={"102": "s1"}),
        )["id"]
    state = stored(stack, plan_id)["state"]
    state["epics"][0]["title"] = "Edited in the UI"
    state["flags"][0]["name"] = "Edited flag"
    assert stack.client.put(f"/api/plan/{plan_id}", json={"name": "P", "state": state}).status_code == 200
    read = stack.ok("get_release_plan", {"planId": plan_id})["state"]
    keep = {
        "mode": read["mode"],
        "milestones": read["milestones"],
        "flags": read["flags"],
        "epicOrder": [e["id"] for e in read["epics"]],
        "assignments": {str(f["id"]): f["milestoneId"] for e in read["epics"] for f in e["features"]},
    }
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        stack.ok("update_release_plan", update_args(plan_id, **keep))
    after = stored(stack, plan_id)["state"]
    assert after["mode"] == "sprints" and after["flags"] == read["flags"]
    assert after["epics"][0]["title"] == "Platform"  # refreshed from Azure DevOps
    assert [e["id"] for e in after["epics"]] == keep["epicOrder"]


@pytest.mark.db
def test_concurrent_updates_both_succeed_and_the_last_write_wins_whole(stack):
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan_id = stack.ok("create_release_plan", create_args(name="P", **full_args()))["id"]
    results: list[object] = []

    def update(target):
        try:
            res = Mcp(stack.client).raw("update_release_plan", update_args(plan_id, **full_args(assignments={"102": target})))
            results.append(res["isError"])
        except Exception as exc:  # noqa: BLE001
            results.append(repr(exc))

    ado = deps.override_providers(ado_client=_serve(FakeAdo()))
    ado.__enter__()
    try:
        threads = [threading.Thread(target=update, args=(t,)) for t in ["ms_a", "ms_b"] * 4]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        ado.__exit__(None, None, None)
    assert results == [False] * 8
    state = stored(stack, plan_id)["state"]
    assert state["epics"][0]["features"][0]["milestoneId"] in ("ms_a", "ms_b")
    assert len(state["milestones"]) == 2 and ids(state["epics"]) == [101, "no-epic", 201]


@pytest.mark.db
def test_update_of_a_plan_deleted_during_the_call_is_not_found_not_a_crash(stack):
    with deps.override_providers(ado_client=_serve(FakeAdo())):
        plan_id = stack.ok("create_release_plan", create_args(name="P", **full_args()))["id"]

    class Deleting(FakeAdo):
        """Deletes the plan while the ADO call is in flight (the tool holds no session then)."""

        def __call__(self, request):
            if not getattr(self, "done", False):
                self.done = True
                # run_sql starts its own event loop: do it on another thread
                worker = threading.Thread(
                    target=run_sql, args=(os.environ["TEST_DATABASE_URL"], f"DELETE FROM release_plans WHERE id = {plan_id}")
                )
                worker.start()
                worker.join()
            return super().__call__(request)

    with deps.override_providers(ado_client=_serve(Deleting())):
        message = stack.fail("update_release_plan", update_args(plan_id, **full_args()))
    assert message.endswith(f"Release plan not found: {plan_id}.")
    assert stack.ok("list_release_plans", {})["total"] == 0


@pytest.mark.db
def test_description_is_truncated_like_the_rest_route_and_oversized_boards_are_refused(stack, monkeypatch):
    long_epic = FakeAdo(work_items=[work_item(1, "Epic", "E", "Team A", description="<p>" + "word " * 100 + "</p>")])
    with deps.override_providers(ado_client=_serve(long_epic)):
        plan = stack.ok("create_release_plan", create_args(name="P", milestones=MS, epicOrder=[1], assignments={}))
    desc = stored(stack, plan["id"])["state"]["epics"][0]["description"]
    assert desc.endswith("…") and len(desc) <= 41  # ADO_DESCRIPTION_MAX_CHARS=40

    # a built board over 5 MiB is refused cleanly (the replaced client-side size tests)
    from app.config import get_settings

    monkeypatch.setenv("ADO_DESCRIPTION_MAX_CHARS", "6000000")
    get_settings.cache_clear()
    big = FakeAdo(
        work_items=[
            work_item(1, "Epic", "E", "Team A"),
            work_item(2, "Feature", "F", "Team A", parent=1, description="y" * (5 * 1024 * 1024 + 10)),
        ]
    )
    with deps.override_providers(ado_client=_serve(big)):
        message = stack.fail("create_release_plan", create_args(name="Big", milestones=MS, epicOrder=[1], assignments={}))
    assert "too large" in message
    assert stack.ok("list_release_plans", {})["total"] == 1


# --- advertised schemas ---------------------------------------------------------------------------------


def test_tool_input_schemas_advertise_the_decisions_and_update_has_no_connection(mcp):
    tools = {t["name"]: t["inputSchema"] for t in mcp.rpc("tools/list")["result"]["tools"]}
    for name in ("create_release_plan", "validate_release_plan"):
        assert "connection" in tools[name]["required"]
        assert {"milestones", "epicOrder", "assignments"} <= set(tools[name]["required"])
    update = tools["update_release_plan"]
    assert "connection" not in update["properties"] and "pat" in update["required"] and "planId" in update["required"]
    assert "pat" in tools["create_release_plan"]["required"] and "name" in tools["create_release_plan"]["required"]
    for name in ("create_release_plan", "update_release_plan", "validate_release_plan"):
        for forbidden in ("state", "epics", "iterations"):
            assert forbidden not in tools[name]["properties"]
        assert tools[name]["properties"]["assignments"]["additionalProperties"]
    published = mcp.ok("get_release_plan_schema", {})
    assert published["properties"]["epicOrder"] and published["properties"]["assignments"]
    assert "never stored" in mcp_tool_description(mcp, "create_release_plan")


def mcp_tool_description(mcp, name):
    return next(t["description"] for t in mcp.rpc("tools/list")["result"]["tools"] if t["name"] == name)


# --- argument handling: no echo of the PAT / inputs, no ADO call, no write -------------------------------


def _leaks(text):
    return [p for p in (PAT, PAT[:8], PAT[-12:], PAT[8:20]) if p in text]


DECOY = "DecoyValue-not-a-secret"


def _bad_argument_cases():
    good = {**decisions(), "milestones": MS, "epicOrder": [101], "assignments": {}}
    c = connection()
    cases = []
    for tool, base in (
        ("create_release_plan", {"name": "n", "pat": PAT, "connection": c, **good}),
        ("update_release_plan", {"planId": 1, "pat": PAT, **good}),
    ):
        for key, value in [
            ("pat", 5), ("pat", True), ("pat", {"x": PAT}), ("pat", [PAT]), ("pat", None), ("pat", 1.5),
            ("name", 5), ("name", [DECOY]), ("name", {"n": DECOY}),
            ("milestones", DECOY), ("milestones", {"id": DECOY}), ("milestones", [DECOY]), ("milestones", [{"id": DECOY}]),
            ("epicOrder", DECOY), ("epicOrder", [[DECOY]]), ("epicOrder", [{"a": DECOY}]),
            ("assignments", DECOY), ("assignments", {DECOY: DECOY}), ("assignments", {"102": [DECOY]}), ("assignments", [DECOY]),
            ("mode", DECOY), ("mode", 5), ("flags", DECOY), ("flags", [{"afterMsId": DECOY}]), ("flags", [DECOY]),
        ]:
            cases.append((tool, {**base, key: value}))
        cases.append((tool, {k: v for k, v in base.items() if k != "milestones"}))
    for key, value in [
        ("connection", DECOY), ("connection", [DECOY]), ("connection", {"pat": DECOY}), ("connection", {**c, "pat": DECOY}),
        ("connection", {**c, "source": DECOY}), ("connection", {**c, "projectUrl": DECOY}), ("connection", {**c, "scopePath": 5}),
        ("connection", {**c, "scopeType": DECOY}), ("connection", {**c, "projectUrl": 5}), ("connection", {DECOY: 1}),
    ]:
        cases.append(("create_release_plan", {"name": "n", "pat": PAT, "connection": c, **good, key: value}))
    update_only = {"planId": 1, "pat": PAT, **good}
    for pid in ("1", 1.5, True, None, [DECOY], {"a": DECOY}, DECOY):
        cases.append(("update_release_plan", {**update_only, "planId": pid}))
    ado = {"source": "cloud", "projectUrl": c["projectUrl"], "pat": PAT, "scopeType": "area", "scopePath": c["scopePath"]}
    for key, value in [("source", 5), ("source", DECOY), ("projectUrl", DECOY), ("projectUrl", [DECOY]), ("scopeType", DECOY),
                       ("scopePath", {"p": DECOY}), ("scopePath", 5), ("pat", 5), ("pat", [PAT]), ("pat", None), ("source", None)]:
        cases.append(("ado_fetch_backlog", {**ado, key: value}))
        return cases


@pytest.mark.parametrize("tool,args", _bad_argument_cases())
def test_bad_arguments_never_echo_the_pat_call_ado_or_touch_the_database(mcp, caplog, tool, args):
    from app.db import DB_UNAVAILABLE

    ado = FakeAdo()
    with caplog.at_level(logging.DEBUG), deps.override_providers(
        ado_client=_serve(ado), session=_dead_db()
    ):
        result = mcp.raw(tool, args)
    text = "\n".join(block["text"] for block in result["content"])
    assert result["isError"] is True, text
    assert not _leaks(text), text
    assert "input_value" not in text and "validation error" not in text, text
    assert DB_UNAVAILABLE not in text, "the database was reached before the arguments were checked"
    assert ado.requests == []
    assert all(not _leaks(r.getMessage() + str(r.exc_info)) for r in caplog.records)


def _dead_db():
    from mcp_helpers import db_provider

    return db_provider("postgresql+asyncpg://u:p@127.0.0.1:1/none")


def test_argument_errors_are_listed_together_in_a_stable_order(mcp):
    text = mcp.fail("create_release_plan", {"name": 5, "pat": 5, "connection": connection(), "milestones": 3, "epicOrder": [], "assignments": {}})
    lines = text.splitlines()
    assert lines[0].endswith("Release plan is invalid:")
    body = [line for line in lines if line.startswith("- ")]
    assert body[0].startswith("- name:") and body[1].startswith("- pat:") and any("milestones" in line for line in body[2:])
    text = mcp.fail("update_release_plan", {"planId": "x", "pat": None, "milestones": MS, "epicOrder": [], "assignments": {}})
    body = [line for line in text.splitlines() if line.startswith("- ")]
    assert body[0].startswith("- planId:") and body[1].startswith("- pat:")
    # nothing is a stack trace or SDK text
    assert "validation error" not in text and "pydantic" not in text


@pytest.mark.db
def test_name_pat_and_planid_errors_precede_any_lookup(stack):
    ado = FakeAdo()
    with deps.override_providers(ado_client=_serve(ado)):
        assert "planId: must be an integer" in stack.fail("update_release_plan", update_args("7"))
        assert "Release plan not found: 999" in stack.fail("update_release_plan", update_args(999))
        assert "pat: must be a string" in stack.fail("create_release_plan", create_args(pat=5))
    assert ado.requests == [] or all("/999" not in str(r.url) for r in ado.requests)
    assert stack.ok("list_release_plans", {})["total"] == 0


def test_ado_fetch_backlog_arguments_and_output_are_unchanged(mcp, fixed_clock):
    tools = {t["name"]: t for t in mcp.rpc("tools/list")["result"]["tools"]}
    schema = tools["ado_fetch_backlog"]["inputSchema"]
    assert schema["required"] == ["source", "projectUrl", "pat", "scopeType", "scopePath"]
    props = schema["properties"]
    assert props["source"]["enum"] == ["onprem", "cloud"] and props["scopeType"]["enum"] == ["area", "iteration"]
    for name in ("create_release_plan", "update_release_plan", "ado_fetch_backlog"):
        pat = tools[name]["inputSchema"]["properties"]["pat"]
        assert pat["type"] == "string" and pat["format"] == "password" and pat["writeOnly"] is True and pat["description"]
        assert "pat" in tools[name]["inputSchema"]["required"]
    for name, schema in ((n, t["inputSchema"]) for n, t in tools.items()):
        for prop, spec in schema["properties"].items():
            if name in ("create_release_plan", "update_release_plan", "ado_fetch_backlog", "validate_release_plan"):
                assert spec.get("description") or "$ref" in spec or "anyOf" in spec, (name, prop)
    assert tools["update_release_plan"]["inputSchema"]["properties"]["name"]["anyOf"]
    assert tools["update_release_plan"]["inputSchema"]["properties"]["planId"]["type"] == "integer"
    assert "default" not in tools["create_release_plan"]["inputSchema"]["properties"]["pat"]
    # output still equals the REST route
    with deps.override_providers(ado_client=_serve(_fake_ado())):
        out = mcp.ok("ado_fetch_backlog", _ado_args())
    assert set(out) == {"project", "projectUrl", "scope", "fetchedAt", "workItems", "iterations", "warnings"}
    # a blank PAT still reaches the existing connection check
    message = mcp.fail("ado_fetch_backlog", _ado_args(pat="  "))
    assert "arguments" not in message and "validation error" not in message


def test_all_tool_schemas_are_valid_json_schema(mcp):
    from jsonschema import Draft202012Validator

    for tool in mcp.rpc("tools/list")["result"]["tools"]:
        Draft202012Validator.check_schema(tool["inputSchema"])


def test_unknown_extra_arguments_are_ignored_without_echo(mcp):
    ado = FakeAdo(failures={"any": "401"})
    with deps.override_providers(ado_client=_serve(ado)):
        for tool, args in (
            ("create_release_plan", create_args(bogus=DECOY, **{"pat": PAT})),
            ("update_release_plan", update_args(1, bogus=DECOY)),
            ("ado_fetch_backlog", {**_ado_args(), "bogus": DECOY}),
        ):
            result = mcp.raw(tool, args)
            text = "\n".join(b["text"] for b in result["content"])
            assert result["isError"] is True and not _leaks(text) and "input_value" not in text
