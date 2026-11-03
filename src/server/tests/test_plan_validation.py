import json

import pytest

from app.schemas import PlanCreateRequest, PlanUpdateRequest
from app.services.plans import (
    NAME_REQUIRED,
    NAME_TOO_LONG,
    PLAN_STATE_MAX_BYTES,
    PROJECT_NAME_REQUIRED,
    PROJECT_NAME_TOO_LONG,
    STATE_INVALID,
    STATE_TOO_LARGE,
    plan_field_errors,
)

STATE = {"schema": "release-planner-features", "milestones": []}


def body(**overrides):
    return {"name": "Plan", "projectType": "onprem", "projectName": "Proj", "state": STATE, **overrides}


def test_valid_body_has_no_errors():
    assert plan_field_errors(body(), with_project=True) == []


@pytest.mark.parametrize("name", [None, 5, "", "   ", "\t\n"])
def test_name_required(name):
    assert plan_field_errors(body(name=name), with_project=True) == [NAME_REQUIRED]


def test_name_missing():
    data = body()
    del data["name"]
    assert plan_field_errors(data, with_project=False) == [NAME_REQUIRED]


def test_name_length_is_checked_after_trim():
    assert plan_field_errors(body(name=" " + "a" * 200 + " "), with_project=True) == []
    assert plan_field_errors(body(name="a" * 201), with_project=True) == [NAME_TOO_LONG]


@pytest.mark.parametrize("value", [None, 1, "  "])
def test_project_name_required(value):
    assert plan_field_errors(body(projectName=value), with_project=True) == [PROJECT_NAME_REQUIRED]


def test_project_name_too_long():
    assert plan_field_errors(body(projectName="p" * 201), with_project=True) == [PROJECT_NAME_TOO_LONG]


def test_project_name_ignored_on_update():
    assert plan_field_errors(body(projectName=""), with_project=False) == []


@pytest.mark.parametrize(
    "state", [None, [], "x", 3, {}, {"schema": "other"}, {"schema": None}]
)
def test_state_must_be_a_release_plan(state):
    assert plan_field_errors(body(state=state), with_project=True) == [STATE_INVALID]


def test_state_size_limit():
    overhead = len(json.dumps({"schema": "release-planner-features", "x": ""}))
    at_limit = {"schema": "release-planner-features", "x": "a" * (PLAN_STATE_MAX_BYTES - overhead)}
    assert len(json.dumps(at_limit)) == PLAN_STATE_MAX_BYTES
    assert plan_field_errors(body(state=at_limit), with_project=True) == []
    over = {**at_limit, "x": at_limit["x"] + "a"}
    assert plan_field_errors(body(state=over), with_project=True) == [STATE_TOO_LARGE]


def test_all_failing_fields_reported_in_order():
    errors = plan_field_errors({}, with_project=True)
    assert errors == [NAME_REQUIRED, PROJECT_NAME_REQUIRED, STATE_INVALID]


def test_create_model_uses_camel_case_aliases():
    model = PlanCreateRequest.model_validate(body())
    assert (model.project_type, model.project_name) == ("onprem", "Proj")


def test_create_model_rejects_unknown_project_type():
    with pytest.raises(ValueError):
        PlanCreateRequest.model_validate(body(projectType="hybrid"))


def test_update_model_ignores_extra_keys():
    model = PlanUpdateRequest.model_validate(body(projectType="cloud"))
    assert not hasattr(model, "project_type")


from app.services.plans import (  # noqa: E402
    MAX_PLAN_ID,
    NAME_INVALID_CHARS,
    PROJECT_NAME_INVALID_CHARS,
    STATE_INVALID_CHARS,
    delete_plan,
    get_plan,
    update_plan,
)


def test_nul_in_names_is_rejected():
    errors = plan_field_errors(body(name="a\x00b", projectName="p\x00"), with_project=True)
    assert errors == [NAME_INVALID_CHARS, PROJECT_NAME_INVALID_CHARS]
    assert plan_field_errors(body(name="a\x00b", projectName="p\x00"), with_project=False) == [NAME_INVALID_CHARS]


@pytest.mark.parametrize(
    "state",
    [
        {**STATE, "k\x00": 1},
        {**STATE, "k": "v\x00"},
        {**STATE, "a": [1, {"b": ["x", {"c\x00": 0}]}]},
        {**STATE, "a": {"b": {"c": ["\x00"]}}},
    ],
)
def test_nul_anywhere_in_state_is_rejected(state):
    assert plan_field_errors(body(state=state), with_project=True) == [STATE_INVALID_CHARS]


def test_literal_backslash_u0000_text_is_allowed():
    assert plan_field_errors(body(state={**STATE, "k": "\\u0000"}), with_project=True) == []


def test_other_state_errors_win_over_nul():
    assert plan_field_errors(body(state={"schema": "x", "k": "\x00"}), with_project=True) == [STATE_INVALID]


def test_deeply_nested_state_does_not_blow_up():
    deep: list = []
    for _ in range(100_000):
        deep = [deep]
    errors = plan_field_errors(body(state={**STATE, "d": deep}), with_project=True)
    assert errors == [STATE_INVALID]


@pytest.mark.parametrize("plan_id", [0, -1, MAX_PLAN_ID + 1, 99999999999])
def test_out_of_range_ids_are_unknown_without_a_query(plan_id):
    import asyncio

    async def main():
        assert await get_plan(None, plan_id) is None
        assert await update_plan(None, plan_id, "n", STATE) is None
        assert await delete_plan(None, plan_id) is False

    asyncio.run(main())
