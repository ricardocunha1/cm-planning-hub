"""Integration checks for the strict board validator against UI-shaped boards
and the (deliberately shallow) REST field checks."""

import copy

from app.services.plan_board import validate_board
from app.services.plans import plan_field_errors

HOSTS = ["dev.azure.com"]

SOURCE = {
    "system": "Azure DevOps",
    "project": "Proj",
    "scope": "Proj\\Area",
    "fetchedAt": "2026-01-02T03:04:05.000Z",
    "kind": "cloud",
    "projectUrl": "https://dev.azure.com/org/Proj",
    "scopeType": "area",
    "scopePath": "Proj\\Area",
}


def _feature(fid, milestone=None, size=""):
    return {"id": fid, "title": f"F{fid}", "state": "New", "description": "<p>d</p>",
            "size": size, "iterationPath": "Proj\\S1", "milestoneId": milestone}


def _ui_board(mode, flags):
    return {
        "schema": "release-planner-features", "version": 1, "mode": mode, "name": "Plan",
        "savedAt": "2026-01-02T03:04:05.000Z", "source": SOURCE,
        "iterations": [{"path": "Proj\\S1", "finishDate": "2026-01-16"}, {"path": "Proj\\S2", "finishDate": ""}],
        "milestones": [
            {"id": "ms_a1", "name": "S1", "date": "2026-01-16", "color": "#4E98D1"},
            {"id": "ms_b2", "name": "S2", "date": "", "color": "#60C5B5"},
        ],
        "flags": flags,
        "epics": [
            {"id": 10, "title": "E", "state": "Active", "description": "",
             "features": [_feature(11, "ms_a1", "M"), _feature(12, None)]},
            {"id": "no-epic", "title": "Features without an Epic", "state": "", "description": "",
             "features": [_feature(13, "ms_b2", "XL")]},
        ],
    }


def test_ui_saved_boards_pass_unchanged():
    flags = [{"id": "fl_abc1234", "name": "Freeze", "date": "2026-01-10", "afterMsId": "ms_a1"}]
    for board in (_ui_board("releases", []), _ui_board("sprints", flags)):
        result = validate_board(copy.deepcopy(board), HOSTS)
        assert result.errors == []
        assert result.board == board


def test_validation_does_not_mutate_input():
    board = _ui_board("sprints", [{"id": "", "name": "", "date": "", "afterMsId": "ms_a1"}])
    before = copy.deepcopy(board)
    result = validate_board(board, HOSTS)
    assert board == before
    assert result.board["flags"][0]["id"].startswith("fl_")
    assert result.board["flags"][0]["name"] == "Milestone"


def test_rest_field_checks_stay_shallow_where_strict_validator_rejects():
    board = _ui_board("releases", [])
    board["epics"][0]["features"][0]["milestoneId"] = "ghost"
    board["epics"][0]["features"][1]["id"] = 11  # duplicate id
    board["extra"] = 1
    board["milestones"][0]["color"] = "#123456"
    assert validate_board(board, HOSTS).errors
    assert plan_field_errors({"name": "n", "projectName": "p", "state": board}, with_project=True) == []
