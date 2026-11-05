import copy
import json
from typing import Any

import pytest

from app.services import plan_board
from app.services.plan_board import (
    ADO_SYSTEM,
    MS_COLORS,
    NO_EPIC_ID,
    NO_EPIC_TITLE,
    BoardResult,
    board_json_schema,
    validate_board,
)
from app.services.plans import PLAN_STATE_MAX_BYTES, STATE_INVALID, STATE_INVALID_CHARS, STATE_TOO_LARGE

HOSTS = ["dev.azure.com", "*.visualstudio.com"]
URL = "https://dev.azure.com/org/Proj"


def board(**overrides: Any) -> dict[str, Any]:
    state: dict[str, Any] = {
        "schema": "release-planner-features",
        "source": {
            "project": "Proj",
            "kind": "cloud",
            "projectUrl": URL,
            "scopeType": "area",
            "scopePath": "Proj\\Team",
        },
        "milestones": [{"id": "ms_a", "name": "MVP"}],
        "epics": [
            {
                "id": 1,
                "title": "Epic",
                "features": [{"id": 10, "title": "F", "milestoneId": "ms_a"}],
            }
        ],
    }
    state.update(overrides)
    return state


def check(state: Any, hosts: list[str] = HOSTS) -> BoardResult:
    return validate_board(state, hosts)


def errors_of(state: Any) -> list[str]:
    result = check(state)
    assert result.errors, "expected errors"
    assert result.board is None
    return result.errors


def test_minimal_board_is_filled_with_defaults() -> None:
    result = check(board())
    assert result.valid
    assert result.board == {
        "schema": "release-planner-features",
        "version": 1,
        "mode": "releases",
        "name": "Feature Release Plan",
        "source": {
            "system": ADO_SYSTEM,
            "project": "Proj",
            "kind": "cloud",
            "projectUrl": URL,
            "scopeType": "area",
            "scopePath": "Proj\\Team",
        },
        "iterations": [],
        "milestones": [{"id": "ms_a", "name": "MVP", "date": "", "color": MS_COLORS[0]}],
        "flags": [],
        "epics": [
            {
                "id": 1,
                "title": "Epic",
                "state": "",
                "description": "",
                "features": [
                    {
                        "id": 10,
                        "title": "F",
                        "state": "",
                        "description": "",
                        "size": "",
                        "iterationPath": "",
                        "milestoneId": "ms_a",
                    }
                ],
            }
        ],
    }
    json.dumps(result.board)
    assert "savedAt" not in result.board
    assert "scope" not in result.board["source"] and "fetchedAt" not in result.board["source"]


def test_input_is_not_mutated() -> None:
    state = board()
    before = copy.deepcopy(state)
    check(state)
    assert state == before


def test_optional_keys_kept_when_given() -> None:
    state = board(savedAt="2026-01-01T00:00:00Z", name="Plan", version=1, mode="releases")
    state["source"].update(system="Other", scope="Area Path: Proj", fetchedAt="2026-01-01T00:00:00Z")
    result = check(state)
    assert result.board["savedAt"] == "2026-01-01T00:00:00Z"
    assert result.board["name"] == "Plan"
    assert result.board["source"]["system"] == "Other"
    assert result.board["source"]["scope"] == "Area Path: Proj"
    assert result.board["source"]["fetchedAt"] == "2026-01-01T00:00:00Z"


# ---- unknown keys, schema, version, mode, name, savedAt ----


@pytest.mark.parametrize(
    ("mutate", "path"),
    [
        (lambda s: s.update(extra=1), "extra"),
        (lambda s: s["source"].update(pat="x"), "source.pat"),
        (lambda s: s["milestones"][0].update(colour="x"), "milestones[0].colour"),
        (lambda s: s["epics"][0].update(foo=1), "epics[0].foo"),
        (lambda s: s["epics"][0]["features"][0].update(sizes="M"), "epics[0].features[0].sizes"),
    ],
)
def test_unknown_keys_rejected_at_any_level(mutate: Any, path: str) -> None:
    state = board()
    mutate(state)
    assert errors_of(state) == [f"{path}: unknown key (not part of the board format)"]


@pytest.mark.parametrize("state", [None, [], "x", {}, {"schema": "release-planner"}])
def test_schema_required(state: Any) -> None:
    assert check(state).errors == [STATE_INVALID]


@pytest.mark.parametrize("version", [2, 0, "1", True, 1.5])
def test_version_must_be_one(version: Any) -> None:
    errors = errors_of(board(version=version))
    assert len(errors) == 1 and errors[0].startswith("version: ")


@pytest.mark.parametrize("mode", ["Releases", "other", 1, None])
def test_mode_must_be_known(mode: Any) -> None:
    errors = errors_of(board(mode=mode))
    assert len(errors) == 1 and errors[0].startswith("mode: ")


def test_mode_sprints_accepted() -> None:
    assert check(board(mode="sprints")).board["mode"] == "sprints"


@pytest.mark.parametrize("name", [5, None, ["a"]])
def test_name_must_be_text(name: Any) -> None:
    assert errors_of(board(name=name)) == ["name: must be a string"]


def test_blank_name_gets_default() -> None:
    assert check(board(name="")).board["name"] == "Feature Release Plan"


def test_saved_at_must_be_string() -> None:
    assert errors_of(board(savedAt=5)) == ["savedAt: must be a string"]


# ---- source ----


def test_source_required() -> None:
    state = board()
    del state["source"]
    assert errors_of(state) == ["source: is required"]


def test_source_must_be_object() -> None:
    assert errors_of(board(source="x")) == ["source: must be an object"]


@pytest.mark.parametrize("key", ["kind", "projectUrl", "scopeType", "scopePath", "project"])
def test_source_fields_required(key: str) -> None:
    state = board()
    del state["source"][key]
    assert errors_of(state) == [f"source.{key}: is required"]


@pytest.mark.parametrize("key", ["projectUrl", "scopePath", "project"])
def test_source_text_must_not_be_blank(key: str) -> None:
    state = board()
    state["source"][key] = "  "
    assert errors_of(state)[0] == f"source.{key}: must not be blank"


@pytest.mark.parametrize(("key", "value"), [("kind", "x"), ("scopeType", "team")])
def test_source_enums(key: str, value: str) -> None:
    errors = errors_of(_with_source(key, value))
    assert len(errors) == 1 and errors[0].startswith(f"source.{key}: must be ")


def _with_source(key: str, value: Any) -> dict[str, Any]:
    state = board()
    state["source"][key] = value
    return state


@pytest.mark.parametrize("key", ["system", "scope", "fetchedAt"])
def test_source_optional_strings_must_be_strings(key: str) -> None:
    assert errors_of(_with_source(key, 5)) == [f"source.{key}: must be a string"]


@pytest.mark.parametrize(
    ("kind", "url", "fragment"),
    [
        ("cloud", "http://dev.azure.com/org/Proj", "https://"),
        ("cloud", "https://evil.example/org/Proj", "not allowed"),
        ("cloud", "https://dev.azure.com/Proj", "Collaboration Hub URLs look like"),
        ("onprem", "https://dev.azure.com", "On-Prem URLs look like"),
    ],
)
def test_project_url_uses_ado_url_rules(kind: str, url: str, fragment: str) -> None:
    state = board()
    state["source"].update(kind=kind, projectUrl=url)
    errors = errors_of(state)
    assert len(errors) == 1
    assert errors[0].startswith("source.projectUrl: ") and fragment in errors[0]


def test_project_url_allowlist_comes_from_the_caller() -> None:
    state = board()
    assert check(state, ["other.example"]).errors[0].startswith("source.projectUrl: This Azure DevOps host is not allowed")
    assert check(state, ["dev.azure.com"]).valid


# ---- iterations ----


def test_iterations_kept_and_default_empty() -> None:
    result = check(board(iterations=[{"path": "Proj\\S1", "finishDate": "2026-02-28"}, {"path": "Proj\\S2"}]))
    assert result.board["iterations"] == [
        {"path": "Proj\\S1", "finishDate": "2026-02-28"},
        {"path": "Proj\\S2", "finishDate": ""},
    ]


@pytest.mark.parametrize("finish", ["2026-02-30", "26-02-01", "2026-2-1", "2026/02/01", "", 5])
def test_iteration_finish_date_format(finish: Any) -> None:
    result = check(board(iterations=[{"path": "p", "finishDate": finish}]))
    if finish == "":
        assert result.valid
    else:
        assert result.errors[0].startswith("iterations[0].finishDate: ")


def test_iteration_path_required_and_array_type() -> None:
    assert errors_of(board(iterations=[{"finishDate": ""}])) == ["iterations[0].path: is required"]
    assert errors_of(board(iterations="x")) == ["iterations: must be an array"]


# ---- milestones ----


def test_milestones_required_and_may_be_empty() -> None:
    state = board(milestones=[])
    state["epics"][0]["features"][0]["milestoneId"] = None
    assert check(state).valid
    del state["milestones"]
    assert errors_of(state) == ["milestones: is required"]


def test_milestone_id_non_blank_string() -> None:
    state = board(milestones=[{"id": " ", "name": "A"}, {"id": 5, "name": "B"}, {"name": "C"}])
    state["epics"][0]["features"][0]["milestoneId"] = None
    errors = errors_of(state)
    assert "milestones[0].id: must not be blank" in errors
    assert "milestones[1].id: must be a string" in errors
    assert "milestones[2].id: is required" in errors


def test_milestone_ids_unique() -> None:
    state = board(milestones=[{"id": "a", "name": "A"}, {"id": "a", "name": "B"}])
    state["epics"][0]["features"][0]["milestoneId"] = None
    assert errors_of(state) == ["milestones[1].id: duplicate milestone id 'a' (already used by milestones[0])"]


def test_milestone_name_non_blank() -> None:
    state = board(milestones=[{"id": "a", "name": ""}])
    state["epics"][0]["features"][0]["milestoneId"] = None
    assert errors_of(state) == ["milestones[0].name: must not be blank"]


@pytest.mark.parametrize("value", ["2026-13-01", "2025-02-29", "2026-1-01", "x", 5, "２０２６-01-01"])
def test_milestone_date_must_be_real(value: Any) -> None:
    state = board()
    state["milestones"][0]["date"] = value
    assert errors_of(state)[0].startswith("milestones[0].date: ")


def test_milestone_date_leap_day_and_empty() -> None:
    state = board()
    state["milestones"][0]["date"] = "2028-02-29"
    assert check(state).valid
    state["milestones"][0]["date"] = ""
    assert check(state).valid


def test_milestone_color_default_cycles_and_rejects_unknown() -> None:
    ms = [{"id": f"m{i}", "name": f"M{i}"} for i in range(10)]
    state = board(milestones=ms)
    state["epics"][0]["features"][0]["milestoneId"] = None
    colors = [m["color"] for m in check(state).board["milestones"]]
    assert colors == [MS_COLORS[i % 8] for i in range(10)]
    state["milestones"][0]["color"] = "#4e98d1"
    assert errors_of(state)[0].startswith("milestones[0].color: must be ")
    state["milestones"][0]["color"] = MS_COLORS[3]
    assert check(state).board["milestones"][0]["color"] == MS_COLORS[3]


# ---- flags ----


def _sprints() -> dict[str, Any]:
    return board(mode="sprints", milestones=[{"id": "a", "name": "S1"}, {"id": "b", "name": "S2"}])


def test_flags_only_in_sprints_mode() -> None:
    state = board(flags=[{"afterMsId": "ms_a"}])
    assert errors_of(state) == ['flags: must be empty in "releases" mode; set mode to "sprints" to use flags']
    assert check(board(flags=[])).valid
    state["mode"] = "sprints"
    assert check(state).valid


def test_flag_defaults_filled() -> None:
    state = _sprints()
    state["epics"][0]["features"][0]["milestoneId"] = None
    state["flags"] = [{"afterMsId": "a"}, {"afterMsId": "b", "id": "f", "name": "Go", "date": "2026-05-01"}]
    flags = check(state).board["flags"]
    assert flags[0]["id"].startswith("fl_") and len(flags[0]["id"]) == 10
    assert flags[0]["name"] == "Milestone" and flags[0]["date"] == ""
    assert flags[1] == {"id": "f", "name": "Go", "date": "2026-05-01", "afterMsId": "b"}


def test_flag_after_ms_id_must_exist() -> None:
    state = _sprints()
    state["flags"] = [{"afterMsId": "zzz"}, {}]
    errors = errors_of(state)
    assert "flags[0].afterMsId: unknown milestone id 'zzz'; use the id of an entry in milestones" in errors
    assert "flags[1].afterMsId: is required" in errors


def test_flag_ids_unique_and_dates_checked() -> None:
    state = _sprints()
    state["flags"] = [{"id": "f", "afterMsId": "a"}, {"id": "f", "afterMsId": "a", "date": "2026-02-30"}]
    errors = errors_of(state)
    assert "flags[1].id: duplicate flag id 'f' (already used by flags[0])" in errors
    assert any(e.startswith("flags[1].date: ") for e in errors)


# ---- epics, features ----


def test_epics_required() -> None:
    state = board()
    del state["epics"]
    assert errors_of(state) == ["epics: is required"]


@pytest.mark.parametrize("bad", [True, False, 1.5, None, "", "  ", [1], {"a": 1}])
def test_ids_reject_booleans_and_non_ids(bad: Any) -> None:
    state = board()
    state["epics"][0]["id"] = bad
    state["epics"][0]["features"][0]["id"] = bad
    assert errors_of(state) == [
        "epics[0].id: must be an integer or a non-blank string",
        "epics[0].features[0].id: must be an integer or a non-blank string",
    ]


def test_string_ids_and_no_epic_accepted() -> None:
    state = board()
    state["epics"].append({"id": NO_EPIC_ID, "title": NO_EPIC_TITLE, "features": []})
    state["epics"][0]["id"] = "E-1"
    assert check(state).valid


def test_epic_ids_unique_text_compare() -> None:
    state = board()
    state["epics"] = [{"id": 123, "title": "A"}, {"id": "123", "title": "B"}, {"id": 5, "title": "C"}]
    assert errors_of(state) == ["epics[1].id: duplicate Epic id '123' (already used by epics[0])"]


def test_feature_ids_unique_across_epics() -> None:
    state = board()
    state["epics"] = [
        {"id": 1, "title": "A", "features": [{"id": 7, "title": "x"}, {"id": 8, "title": "y"}]},
        {"id": 2, "title": "B", "features": [{"id": "7", "title": "z"}, {"id": 8, "title": "w"}]},
    ]
    errors = errors_of(state)
    assert len(errors) == 2
    assert errors[0].startswith("epics[1].features[0].id: duplicate Feature id '7' (already used by epics[0].features[0])")
    assert errors[1].startswith("epics[1].features[1].id: duplicate Feature id '8'")


def test_epic_and_feature_may_share_an_id() -> None:
    state = board()
    state["epics"] = [{"id": 1, "title": "A", "features": [{"id": 1, "title": "x"}]}]
    assert check(state).valid


@pytest.mark.parametrize("bad", ["", "  ", 5, None])
def test_titles_non_blank(bad: Any) -> None:
    state = board()
    state["epics"][0]["title"] = bad
    state["epics"][0]["features"][0]["title"] = bad
    errors = errors_of(state)
    assert [e.split(":")[0] for e in errors] == ["epics[0].title", "epics[0].features[0].title"]


def test_missing_titles_required() -> None:
    state = board()
    del state["epics"][0]["title"]
    del state["epics"][0]["features"][0]["title"]
    assert errors_of(state) == ["epics[0].title: is required", "epics[0].features[0].title: is required"]


@pytest.mark.parametrize("key", ["state", "description", "iterationPath", "size"])
def test_text_fields_no_coercion(key: str) -> None:
    state = board()
    state["epics"][0]["features"][0][key] = 5
    assert errors_of(state) == [f"epics[0].features[0].{key}: must be a string"]


def test_epic_text_fields_no_coercion() -> None:
    state = board()
    state["epics"][0]["state"] = 5
    state["epics"][0]["description"] = None
    assert errors_of(state) == ["epics[0].state: must be a string", "epics[0].description: must be a string"]


def test_size_trimmed_and_uppercased() -> None:
    state = board()
    state["epics"][0]["features"][0]["size"] = "\u00a0 xl\ufeff "
    assert check(state).board["epics"][0]["features"][0]["size"] == "XL"


def test_feature_milestone_id_null_or_existing() -> None:
    state = board()
    feature = state["epics"][0]["features"][0]
    feature["milestoneId"] = None
    assert check(state).board["epics"][0]["features"][0]["milestoneId"] is None
    del feature["milestoneId"]
    assert check(state).board["epics"][0]["features"][0]["milestoneId"] is None
    feature["milestoneId"] = "nope"
    assert errors_of(state) == [
        "epics[0].features[0].milestoneId: unknown milestone id 'nope'; "
        "use the id of an entry in milestones, or null for Unplanned"
    ]
    feature["milestoneId"] = 5
    assert errors_of(state)[0].startswith("epics[0].features[0].milestoneId: ")


# ---- all errors at once, cross-references next to structural errors ----


def test_several_errors_in_one_call() -> None:
    state = board(mode="x", version=3)
    state["source"]["kind"] = "nope"
    state["epics"][0]["title"] = ""
    errors = errors_of(state)
    assert len(errors) >= 4
    assert any(e.startswith("mode: ") for e in errors)
    assert any(e.startswith("version: ") for e in errors)
    assert any(e.startswith("source.kind: ") for e in errors)
    assert "epics[0].title: must not be blank" in errors


def test_cross_reference_checks_run_alongside_structural_errors() -> None:
    state = board(version=9)
    state["epics"] = [
        {"id": 1, "title": "", "features": [{"id": 7, "title": "x", "milestoneId": "nope"}]},
        {"id": "1", "title": "B", "features": [{"id": 7, "title": "y"}]},
    ]
    state["flags"] = [{"afterMsId": "ms_a"}]
    errors = errors_of(state)
    assert any(e.startswith("version: ") for e in errors)
    assert "epics[0].title: must not be blank" in errors
    assert any(e.startswith("epics[0].features[0].milestoneId: unknown milestone") for e in errors)
    assert any(e.startswith("epics[1].id: duplicate Epic id") for e in errors)
    assert any(e.startswith("epics[1].features[0].id: duplicate Feature id") for e in errors)
    assert any(e.startswith("flags: must be empty") for e in errors)
    assert len(errors) == len(set(errors))


def test_project_url_checked_alongside_structural_errors() -> None:
    state = board(version=9)
    state["source"]["projectUrl"] = "http://dev.azure.com/org/Proj"
    errors = errors_of(state)
    assert any(e.startswith("source.projectUrl: ") for e in errors)
    assert any(e.startswith("version: ") for e in errors)


def test_malformed_entries_do_not_crash_reference_checks() -> None:
    state = board(milestones=[1, None], epics=[7, {"id": 1, "title": "A", "features": [None, 3]}], flags="x")
    errors = errors_of(state)
    assert "milestones[0]: must be an object" in errors
    assert "epics[0]: must be an object" in errors
    assert "flags: must be an array" in errors


# ---- limits ----


def test_size_limit_checked_first() -> None:
    state = board()
    state["epics"][0]["description"] = "x" * (PLAN_STATE_MAX_BYTES + 1)
    state["bogus"] = 1
    assert check(state).errors == [STATE_TOO_LARGE]


def test_nul_character_rejected_first() -> None:
    state = board()
    state["epics"][0]["title"] = "a\x00b"
    state["bogus"] = 1
    assert check(state).errors == [STATE_INVALID_CHARS]


# ---- schema ----


def test_board_json_schema_is_self_contained() -> None:
    schema = board_json_schema()
    json.dumps(schema)
    assert schema["type"] == "object"
    assert set(schema["properties"]) == {
        "schema", "version", "mode", "name", "savedAt", "source", "iterations", "milestones", "flags", "epics",
    }
    assert set(schema["required"]) == {"schema", "source", "milestones", "epics"}
    assert schema["additionalProperties"] is False
    assert schema["properties"]["schema"]["const"] == "release-planner-features"

    refs = _refs(schema)
    assert refs and all(ref.startswith("#/$defs/") for ref in refs)
    assert all(ref.split("/")[-1] in schema["$defs"] for ref in refs)
    assert {"Milestone", "Flag", "Epic", "Feature", "Iteration", "Source"} <= set(schema["$defs"])
    assert schema["$defs"]["Milestone"]["properties"]["color"]["enum"] == list(MS_COLORS)
    assert schema["$defs"]["Source"]["required"] == ["project", "kind", "projectUrl", "scopeType", "scopePath"]


def _refs(node: Any) -> list[str]:
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref":
                found.append(value)
            else:
                found.extend(_refs(value))
    elif isinstance(node, list):
        for item in node:
            found.extend(_refs(item))
    return found


def test_constants_match_client() -> None:
    assert plan_board.SCHEMA == "release-planner-features"
    assert plan_board.VERSION == 1
    assert len(plan_board.MS_COLORS) == 8
    assert plan_board.DEFAULT_MILESTONE_NAME == "Milestone"


# ---- planFromBacklog-shaped board ----


def test_plan_from_backlog_shape_passes_unchanged() -> None:
    def feature(fid: int, ms: str) -> dict[str, Any]:
        return {
            "id": fid,
            "title": f"Feature {fid}",
            "state": "New",
            "description": "<p>d</p>",
            "size": "M",
            "iterationPath": "Proj\\Sprint 1",
            "milestoneId": ms,
        }

    plan = {
        "schema": "release-planner-features",
        "version": 1,
        "mode": "releases",
        "name": "Proj – Feature Release Plan",
        "source": {
            "system": "Azure DevOps",
            "project": "Proj",
            "scope": "Area Path: Proj\\Team",
            "fetchedAt": "2026-11-05T10:00:00Z",
            "kind": "cloud",
            "projectUrl": URL,
            "scopeType": "area",
            "scopePath": "Proj\\Team",
        },
        "iterations": [{"path": "Proj\\Sprint 1", "finishDate": "2026-01-15"}, {"path": "Proj\\S2", "finishDate": ""}],
        "milestones": [{"id": "ms_abc1234", "name": "MVP", "date": "", "color": MS_COLORS[0]}],
        "flags": [],
        "epics": [
            {"id": 1, "title": "E1", "state": "Active", "description": "", "features": [feature(10, "ms_abc1234")]},
            {"id": 2, "title": "E2", "state": "New", "description": "x", "features": []},
            {
                "id": NO_EPIC_ID,
                "title": NO_EPIC_TITLE,
                "state": "",
                "description": "",
                "features": [feature(30, "ms_abc1234")],
            },
        ],
    }
    result = check(plan)
    assert result.errors == []
    assert result.board == plan
