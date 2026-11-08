"""Unit tests for `app.services.plan_from_backlog`: validating the agent's
decisions and building the board from an in-memory backlog (the grouping
mirrors `groupBacklog` / `planFromBacklog` in fromBacklog.ts)."""

import copy
from typing import Any

import pytest

from app.services.plan_board import NO_EPIC_ID, NO_EPIC_TITLE, validate_board
from app.services.plan_from_backlog import (
    build_board,
    decisions_json_schema,
    group_backlog,
    parse_decisions,
)

HOSTS = ("dev.azure.com",)
URL = "https://dev.azure.com/org/Proj"
CONNECTION = {"source": "cloud", "projectUrl": URL, "scopeType": "area", "scopePath": "Proj\\Team"}


def item(item_id: int, kind: str, title: str, parent: int | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "id": item_id, "type": kind, "title": title, "state": "New", "description": "", "size": "",
        "iterationPath": "", "parentId": parent, **extra,
    }


def backlog(*items: dict[str, Any]) -> dict[str, Any]:
    return {
        "project": {"id": "p", "name": "Proj"},
        "projectUrl": URL,
        "scope": "Area Path: Proj\\Team",
        "fetchedAt": "2026-10-23T10:00:00Z",
        "workItems": list(items),
        "iterations": [{"path": "Proj\\Sprint 1", "finishDate": "2026-11-01"}, {"path": "Proj\\S2", "finishDate": ""}],
        "warnings": [],
    }


BACKLOG = backlog(
    item(30, "Feature", "Orphan B"),
    item(20, "Epic", "Second", state="Active", description="<p>e2</p>"),
    item(10, "Epic", "First"),
    item(12, "Feature", "F12", parent=10, size=" m ", iterationPath="Proj\\Sprint 1", description="<b>d</b>", state="Active"),
    item(11, "Feature", "F11", parent=10, size="xl"),
    item(21, "Feature", "F21", parent=20),
    item(25, "Feature", "Orphan A", parent=999),
    item(40, "User Story", "ignored", parent=10),
)


def raw(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "connection": dict(CONNECTION),
        "milestones": [{"id": "ms_a", "name": "MVP"}, {"id": "ms_b", "name": "GA"}],
        "epicOrder": [],
        "assignments": {},
    }
    data.update(overrides)
    return data


def decisions(**overrides: Any):
    result = parse_decisions(raw(**overrides), HOSTS, with_connection=True)
    assert result.errors == []
    assert result.decisions is not None
    return result.decisions


def build(**overrides: Any):
    return build_board(BACKLOG, "Plan", decisions(**overrides), CONNECTION)


def epic_ids(board: dict[str, Any]) -> list[Any]:
    return [e["id"] for e in board["epics"]]


# --- group_backlog ---------------------------------------------------------------


def test_group_backlog_groups_features_under_epics_in_id_order():
    grouped = group_backlog(BACKLOG["workItems"])
    assert [(e["id"], [f["id"] for f in fs]) for e, fs in grouped.epics] == [(10, [11, 12]), (20, [21])]
    assert [f["id"] for f in grouped.orphans] == [25, 30]  # unknown parent and no parent; user story ignored


def test_group_backlog_without_items():
    grouped = group_backlog([])
    assert grouped.epics == [] and grouped.orphans == []


def test_a_feature_whose_parent_is_a_feature_is_an_orphan():
    grouped = group_backlog([item(1, "Feature", "A"), item(2, "Feature", "B", parent=1)])
    assert [f["id"] for f in grouped.orphans] == [1, 2]


# --- build_board ----------------------------------------------------------------


def test_default_order_is_epics_by_id_then_the_orphans_epic():
    board, errors = build()
    assert errors == [] and board is not None
    assert epic_ids(board) == [10, 20, NO_EPIC_ID]
    orphans = board["epics"][2]
    assert (orphans["title"], orphans["state"], orphans["description"]) == (NO_EPIC_TITLE, "", "")
    assert [f["id"] for f in orphans["features"]] == [25, 30]
    assert [f["id"] for f in board["epics"][0]["features"]] == [11, 12]


def test_epic_and_feature_fields_come_from_the_backlog():
    board, _ = build()
    assert board is not None
    epic = board["epics"][1]
    assert (epic["title"], epic["state"], epic["description"]) == ("Second", "Active", "<p>e2</p>")
    assert board["epics"][0]["features"][1] == {
        "id": 12, "title": "F12", "state": "Active", "description": "<b>d</b>", "size": "M",
        "iterationPath": "Proj\\Sprint 1", "milestoneId": None,
    }
    assert board["epics"][0]["features"][0]["size"] == "XL"


def test_source_iterations_milestones_and_mode_flags_from_input():
    board, _ = build(mode="sprints", flags=[{"name": "Freeze", "afterMsId": "ms_a"}])
    assert board is not None
    assert board["source"] == {
        "system": "Azure DevOps", "project": "Proj", "scope": "Area Path: Proj\\Team",
        "fetchedAt": "2026-10-23T10:00:00Z", "kind": "cloud", "projectUrl": URL,
        "scopeType": "area", "scopePath": "Proj\\Team",
    }
    assert board["iterations"] == BACKLOG["iterations"]
    assert board["mode"] == "sprints" and board["name"] == "Plan"
    assert board["milestones"] == [{"id": "ms_a", "name": "MVP"}, {"id": "ms_b", "name": "GA"}]
    assert board["flags"] == [{"name": "Freeze", "afterMsId": "ms_a"}]


def test_the_built_board_passes_the_strict_validator_and_gets_defaults():
    board, _ = build(assignments={"11": "ms_a"})
    result = validate_board(board, HOSTS)
    assert result.errors == []
    assert result.board is not None
    assert [m["color"] for m in result.board["milestones"]] == ["#4E98D1", "#60C5B5"]
    assert result.board["flags"] == []
    assert "scope" in result.board["source"]


def test_epic_order_places_columns_and_appends_the_omitted_ones():
    board, _ = build(epicOrder=[20])
    assert board is not None and epic_ids(board) == [20, 10, NO_EPIC_ID]
    board, _ = build(epicOrder=[NO_EPIC_ID, "20"])  # text ids match; no-epic can go anywhere
    assert board is not None and epic_ids(board) == [NO_EPIC_ID, 20, 10]


def test_no_epic_in_the_order_is_a_no_op_without_orphans():
    only_epics = backlog(item(1, "Epic", "E"), item(2, "Feature", "F", parent=1))
    board, errors = build_board(only_epics, "P", decisions(epicOrder=[NO_EPIC_ID, 1]), CONNECTION)
    assert errors == [] and board is not None and epic_ids(board) == [1]


def test_unknown_epic_ids_are_listed_together():
    board, errors = build(epicOrder=[10, 77, "x"])
    assert board is None
    assert len(errors) == 1 and errors[0].startswith("epicOrder: unknown Epic id(s) not in the backlog: 77, x.")


def test_assignments_set_milestones_and_normalize_int_keys():
    board, errors = build(assignments={"11": "ms_a", 12: "ms_b", " 25 ": "ms_a", "21": None})
    assert errors == [] and board is not None
    by_id = {f["id"]: f["milestoneId"] for e in board["epics"] for f in e["features"]}
    assert by_id == {11: "ms_a", 12: "ms_b", 21: None, 25: "ms_a", 30: None}


def test_unknown_feature_ids_including_epics_are_listed_together():
    board, errors = build(assignments={"11": "ms_a", "999": None, "10": "ms_a", "abc": None})
    assert board is None
    assert errors == [
        "assignments: unknown Feature id(s) not in the backlog: 999, 10, abc. "
        "Use the ids of the Features returned by ado_fetch_backlog."
    ]


def test_unknown_epic_and_feature_errors_are_reported_at_once():
    _, errors = build(epicOrder=[5], assignments={"6": None})
    assert len(errors) == 2


def test_items_gone_from_the_backlog_are_dropped_and_input_is_not_mutated():
    data = raw(assignments={"11": "ms_a"})
    before = copy.deepcopy(data)
    result = parse_decisions(data, HOSTS, with_connection=True)
    assert data == before
    smaller = backlog(item(10, "Epic", "First"), item(11, "Feature", "F11", parent=10))
    board, errors = build_board(smaller, "P", result.decisions, CONNECTION)
    assert errors == [] and board is not None
    assert [(e["id"], [f["id"] for f in e["features"]]) for e in board["epics"]] == [(10, [11])]


def test_empty_backlog_gives_an_empty_board():
    board, errors = build_board(backlog(), "P", decisions(), CONNECTION)
    assert errors == [] and board is not None and board["epics"] == []


# --- parse_decisions -------------------------------------------------------------


def errors_of(**overrides: Any) -> list[str]:
    return parse_decisions(raw(**overrides), HOSTS, with_connection=True).errors


def test_valid_decisions_have_defaults():
    parsed = parse_decisions(raw(), HOSTS, with_connection=True)
    assert parsed.errors == [] and parsed.decisions is not None
    assert parsed.decisions.mode == "releases" and parsed.decisions.flags == []


def test_connection_is_required_only_when_asked():
    data = raw()
    del data["connection"]
    assert parse_decisions(data, HOSTS, with_connection=True).errors == ["connection: is required"]
    assert parse_decisions(data, HOSTS, with_connection=False).errors == []


def test_structural_errors_are_all_reported_with_paths():
    errors = errors_of(
        mode="weeks", milestones=[{"id": "a", "name": ""}, 5], epicOrder="x", assignments={"1": 3},
        connection={"source": "x", "projectUrl": "", "scopeType": "area", "extra": 1},
    )
    text = "\n".join(errors)
    for part in ("mode:", "milestones[0].name", "milestones[1]", "epicOrder", "assignments.1", "connection.source",
                 "connection.projectUrl", "connection.scopePath", "connection.extra"):
        assert part in text, part


@pytest.mark.parametrize("value", [5, "no", [], None])
def test_non_object_assignments_and_missing_fields_are_errors_not_crashes(value):
    assert errors_of(assignments=value)
    data = {"connection": CONNECTION}
    assert len(parse_decisions(data, HOSTS, with_connection=True).errors) == 3  # milestones, epicOrder, assignments


def test_duplicate_milestone_and_flag_ids_and_flag_references():
    errors = errors_of(
        mode="sprints",
        milestones=[{"id": "a", "name": "A"}, {"id": "a", "name": "B"}],
        flags=[{"id": "f", "afterMsId": "a"}, {"id": "f", "afterMsId": "zz"}],
    )
    assert any("milestones[1].id: duplicate milestone id 'a'" in e for e in errors)
    assert any("flags[1].id: duplicate flag id 'f'" in e for e in errors)
    assert any("flags[1].afterMsId: unknown milestone id 'zz'" in e for e in errors)


def test_flags_need_sprints_mode():
    errors = errors_of(flags=[{"afterMsId": "ms_a"}])
    assert errors == ['flags: must be empty in "releases" mode; set mode to "sprints" to use flags']
    assert errors_of(mode="sprints", flags=[{"afterMsId": "ms_a"}]) == []


def test_assignment_milestone_references_are_checked():
    errors = errors_of(assignments={"11": "nope", "12": None, "13": "ms_a"})
    assert len(errors) == 1 and errors[0].startswith("assignments['11']: unknown milestone id 'nope'")


def test_duplicate_assignment_keys_and_epic_order_entries():
    errors = errors_of(assignments={"11": "ms_a", 11: "ms_b"}, epicOrder=[1, "1", 2])
    assert "assignments: duplicate Feature id '11'" in errors
    assert "epicOrder[1]: duplicate Epic id '1'" in errors


def test_bool_epic_id_and_blank_string_are_rejected():
    assert errors_of(epicOrder=[True]) and errors_of(epicOrder=["  "])


def test_connection_host_allowlist():
    errors = errors_of(connection={**CONNECTION, "projectUrl": "https://evil.example.com/org/Proj"})
    assert len(errors) == 1 and errors[0].startswith("connection.projectUrl:")


def test_decisions_json_schema_describes_the_slim_input():
    schema = decisions_json_schema()
    assert set(schema["properties"]) == {"connection", "mode", "milestones", "flags", "epicOrder", "assignments"}
    assert schema["properties"]["mode"]["enum"] == ["releases", "sprints"]
    assert schema["$defs"]["Connection"]["properties"]["source"]["enum"] == ["onprem", "cloud"]
    assert set(schema["required"]) == {"milestones", "epicOrder", "assignments"}
    assert all("description" in p for p in schema["properties"].values())


def test_size_is_trimmed_with_the_javascript_whitespace_set():
    items = backlog(
        item(1, "Epic", "E"),
        item(2, "Feature", "F", parent=1, size="﻿  l　"),
        item(3, "Feature", "G", parent=1, size="\x1cm\x1c"),  # not whitespace for JS trim()
    )
    board, errors = build_board(items, "P", decisions(), CONNECTION)
    assert errors == [] and board is not None
    assert [f["size"] for f in board["epics"][0]["features"]] == ["L", "\x1cM\x1c"]
