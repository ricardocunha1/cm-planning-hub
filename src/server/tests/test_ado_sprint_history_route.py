import asyncio
import base64
import json
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from ado_fakes import (
    CHANGED_DATE,
    CLOSED_DATE,
    FAKE_PAT,
    PROJECT_ID,
    PROJECT_NAME,
    RESOLVED_DATE,
    STORY_POINTS,
    FakeAdo,
    history_item,
    mock_http_client,
    synthetic_sprint_history,
)
from app.api.ado_routes import get_ado_http_client
from app.config import Settings, get_settings
from app.main import app
from app.services import ado_sprint_history
from app.services.ado_backlog import CAP_REACHED
from app.services.ado_client import PAT_REJECTED, UNEXPECTED_RESPONSE, AdoClient, AdoError
from app.services.ado_sprint_history import (
    ITERATION_PATH_REQUIRED,
    STORY_POINTS_FIELD_MISSING,
    fetch_sprint_history,
    iteration_path_errors,
    no_items_message,
    normalize_sprint_item,
    utc_iso,
    wiql_query,
)
from app.services.ado_url import parse_project_url

CLOUD_URL = "https://dev.azure.com/contoso/Fabrikam%20Plant"
SETTINGS = Settings(ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0)
PHASE_1 = f"{PROJECT_NAME}\\Phase 1"
ROUTE = "/api/ado/sprint-history"


@pytest.fixture()
def fake():
    return FakeAdo(work_items=synthetic_sprint_history())


@pytest.fixture()
def handler(fake):
    """The MockTransport handler; tests may replace `holder["handler"]`."""
    return {"handler": fake}


@pytest.fixture()
def ado_client(handler):
    async def http_client():
        async with mock_http_client(lambda request: handler["handler"](request)) as http:
            yield http

    app.dependency_overrides[get_ado_http_client] = http_client
    app.dependency_overrides[get_settings] = lambda: SETTINGS
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _body(**overrides):
    body = {"source": "cloud", "projectUrl": CLOUD_URL, "pat": FAKE_PAT, "iterationPath": PHASE_1}
    body.update(overrides)
    return body


def _post(client, **overrides):
    return client.post(ROUTE, json=_body(**overrides))


def _ok(response):
    assert response.status_code == 200, response.text
    _assert_pat_absent(response)
    return response.json()


def _errors(response):
    assert response.status_code == 422, response.text
    _assert_pat_absent(response)
    return response.json()["errors"]


def _assert_pat_absent(response):
    assert FAKE_PAT not in response.text
    assert base64.b64encode(f":{FAKE_PAT}".encode()).decode() not in response.text


def _ids(data):
    return [item["id"] for item in data["workItems"]]


def _raw(fake, endpoint, content: bytes):
    """A handler serving `content` verbatim for `endpoint`, `fake` otherwise."""

    def handler(request):
        if fake._endpoint(request.url.path) == endpoint:
            fake.requests.append(request)
            return httpx.Response(200, content=content, headers={"Content-Type": "application/json"})
        return fake(request)

    return handler


# --- 200: shape, filtering, normalization ------------------------------------------------


def test_sprint_history_returns_contract_shape(ado_client, monkeypatch):
    monkeypatch.setattr(ado_sprint_history, "_utc_now", lambda: datetime(2026, 10, 23, 10, 0, 0, 999, tzinfo=timezone.utc))
    data = _ok(_post(ado_client))
    assert data == {
        "project": {"id": PROJECT_ID, "name": PROJECT_NAME},
        "projectUrl": CLOUD_URL,
        "iterationPath": PHASE_1,
        "fetchedAt": "2026-10-23T10:00:00Z",
        "workItems": [
            {
                "id": 501,
                "type": "User Story",
                "title": "Item 501",
                "state": "Resolved",
                "iterationPath": f"{PHASE_1}\\Sprint 01",
                "resolvedDate": "2026-10-28T10:47:08Z",
                "storyPoints": 3,
            },
            {
                "id": 502,
                "type": "Bug",
                "title": "Item 502",
                "state": "Closed",
                "iterationPath": f"{PHASE_1}\\Sprint 01",
                "resolvedDate": "2026-10-29T09:00:00Z",
                "storyPoints": 0,
            },
            {
                "id": 504,
                "type": "User Story",
                "title": "Item 504",
                "state": "Done",
                "iterationPath": f"{PHASE_1}\\Sprint 02",
                "resolvedDate": "2026-11-11T23:30:00Z",
                "storyPoints": 2.5,
            },
        ],
        "warnings": [],
    }


def test_sprint_history_path_matches_case_insensitively_and_uses_tree_spelling(ado_client, fake):
    data = _ok(_post(ado_client, iterationPath=f"  {PHASE_1.upper()}\\sprint 02 "))
    assert data["iterationPath"] == f"{PHASE_1}\\Sprint 02"
    assert _ids(data) == [504]
    assert f"UNDER '{PHASE_1}\\Sprint 02'" in fake.wiql_queries()[0]


def test_sprint_history_project_root_is_selectable(ado_client):
    data = _ok(_post(ado_client, iterationPath=PROJECT_NAME))
    assert data["iterationPath"] == PROJECT_NAME
    assert _ids(data) == [501, 502, 504, 506]


def test_sprint_history_wiql_text_and_request(ado_client, fake):
    _ok(_post(ado_client))
    (wiql,) = fake.requests_to("wiql")
    assert wiql.url.params["$top"] == "20000"
    assert wiql.url.params["api-version"] == "7.0"
    assert fake.wiql_queries() == [
        "SELECT [System.Id] FROM WorkItems\n"
        "WHERE [System.TeamProject] = @project\n"
        "  AND [System.WorkItemType] IN ('User Story','Bug')\n"
        "  AND [System.State] IN ('Resolved','Done','Closed')\n"
        f"  AND [System.IterationPath] UNDER '{PHASE_1}'\n"
        "ORDER BY [System.Id]"
    ]


def test_sprint_history_request_sequence_and_batch_body(ado_client, fake):
    _ok(_post(ado_client))
    endpoints = [fake._endpoint(r.url.path) for r in fake.requests]
    assert endpoints == ["projects", "nodes", "fields", "fields", "fields", "wiql", "batch"]
    checked = [r.url.path.rsplit("/", 1)[-1] for r in fake.requests_to("fields")]
    assert checked == [STORY_POINTS, RESOLVED_DATE, CLOSED_DATE]
    (body,) = fake.batch_bodies()
    assert body == {
        "ids": [501, 502, 504],
        "fields": [
            "System.Id",
            "System.WorkItemType",
            "System.Title",
            "System.State",
            "System.IterationPath",
            CHANGED_DATE,
            STORY_POINTS,
            RESOLVED_DATE,
            CLOSED_DATE,
        ],
        "errorPolicy": "omit",
    }


def test_sprint_history_escapes_single_quotes_in_the_path(ado_client, fake):
    fake.nodes["value"][1]["children"].append(
        {"id": 20, "name": "It's", "structureType": "iteration", "path": f"\\{PROJECT_NAME}\\Iteration\\It's"}
    )
    fake.work_items = [history_item(601, "Bug", "Done", "It's", resolved="2026-10-01T00:00:00Z")]
    data = _ok(_post(ado_client, iterationPath=f"{PROJECT_NAME}\\it's"))
    assert _ids(data) == [601]
    assert f"UNDER '{PROJECT_NAME}\\It''s'" in fake.wiql_queries()[0]


def test_sprint_history_chunks_batches_to_at_most_200_ids(ado_client, fake):
    fake.work_items = [
        history_item(i, "User Story", "Done", "Phase 1\\Sprint 01", points=1) for i in range(1, 451)
    ]
    data = _ok(_post(ado_client))
    assert [len(body["ids"]) for body in fake.batch_bodies()] == [200, 200, 50]
    assert _ids(data) == list(range(1, 451))


def test_sprint_history_sorts_and_dedupes_ids(ado_client, fake):
    fake.wiql_ids = [504, 501, 504, 502]
    data = _ok(_post(ado_client))
    assert _ids(data) == [501, 502, 504]
    assert fake.batch_bodies()[0]["ids"] == [504, 501, 502]


def test_sprint_history_refilters_types_and_states(ado_client, fake):
    fake.work_items = synthetic_sprint_history() + [
        history_item(507, "User Story", "resolved", "Phase 1", resolved="2026-10-01T00:00:00Z"),
        history_item(508, "Task", "Done", "Phase 1", resolved="2026-10-01T00:00:00Z"),
    ]
    fake.wiql_ids = [501, 503, 505, 507, 508]
    assert _ids(_ok(_post(ado_client))) == [501]


# --- dates and story points -----------------------------------------------------------------


def test_sprint_history_date_falls_back_resolved_closed_changed(ado_client, fake):
    fake.work_items = [
        history_item(1, "Bug", "Done", "Phase 1", resolved="2026-01-01T00:00:00Z", closed="2026-02-01T00:00:00Z"),
        history_item(2, "Bug", "Done", "Phase 1", closed="2026-02-01T00:00:00Z", changed="2026-03-01T00:00:00Z"),
        history_item(3, "Bug", "Done", "Phase 1", changed="2026-03-01T00:00:00"),
        history_item(4, "Bug", "Done", "Phase 1", resolved="garbage", closed="2026-02-02T00:00:00Z"),
        history_item(5, "Bug", "Done", "Phase 1", resolved="", changed=None),
        history_item(6, "Bug", "Done", "Phase 1", resolved="2026-05-05T00:00:00Z", changed=None),
    ]
    dates = {item["id"]: item["resolvedDate"] for item in _ok(_post(ado_client))["workItems"]}
    assert dates == {
        1: "2026-01-01T00:00:00Z",
        2: "2026-02-01T00:00:00Z",
        3: "2026-03-01T00:00:00Z",
        4: "2026-02-02T00:00:00Z",
        6: "2026-05-05T00:00:00Z",
    }


def test_sprint_history_missing_date_fields_are_not_requested(ado_client):
    fake = FakeAdo(work_items=synthetic_sprint_history(), missing_fields={RESOLVED_DATE, CLOSED_DATE})
    app.dependency_overrides[get_ado_http_client] = _override(fake)
    data = _ok(_post(ado_client))
    assert data["warnings"] == []
    (body,) = fake.batch_bodies()
    assert RESOLVED_DATE not in body["fields"] and CLOSED_DATE not in body["fields"]
    assert {item["resolvedDate"] for item in data["workItems"]} == {"2026-10-20T08:00:00Z", "2026-11-11T23:30:00Z"}


def test_sprint_history_missing_story_points_field_warns(ado_client):
    fake = FakeAdo(work_items=synthetic_sprint_history(), missing_fields={STORY_POINTS})
    app.dependency_overrides[get_ado_http_client] = _override(fake)
    data = _ok(_post(ado_client))
    assert data["warnings"] == [STORY_POINTS_FIELD_MISSING]
    assert STORY_POINTS_FIELD_MISSING == (
        "The field Microsoft.VSTS.Scheduling.StoryPoints does not exist in this project; story points are 0."
    )
    assert {item["storyPoints"] for item in data["workItems"]} == {0}
    assert STORY_POINTS not in fake.batch_bodies()[0]["fields"]


def test_sprint_history_odd_story_points_become_zero(ado_client, fake, handler):
    def entry(item_id, points):
        fields = {
            "System.WorkItemType": "User Story",
            "System.State": "Done",
            "System.IterationPath": PHASE_1,
            CHANGED_DATE: "2026-10-01T00:00:00Z",
        }
        if points != "unset":
            fields[STORY_POINTS] = points
        return {"id": item_id, "fields": fields}

    entries = [entry(1, True), entry(2, "3"), entry(3, None), entry(4, 1.0), entry(5, 7), entry(6, "unset"), None]
    fake.wiql_ids = [1, 2, 3, 4, 5, 6, 7]
    handler["handler"] = _raw(fake, "batch", json.dumps({"value": entries}).encode())
    points = {item["id"]: item["storyPoints"] for item in _ok(_post(ado_client))["workItems"]}
    assert points == {1: 0, 2: 0, 3: 0, 4: 1.0, 5: 7, 6: 0}


def test_sprint_history_non_finite_story_points_become_zero(ado_client, fake, handler):
    content = (
        b'{"value": [{"id": 1, "fields": {"System.WorkItemType": "Bug", "System.State": "Done",'
        b' "System.ChangedDate": "2026-10-01T00:00:00Z", "Microsoft.VSTS.Scheduling.StoryPoints": NaN}}]}'
    )
    fake.wiql_ids = [1]
    handler["handler"] = _raw(fake, "batch", content)
    assert _ok(_post(ado_client))["workItems"][0]["storyPoints"] == 0


# --- warnings ---------------------------------------------------------------------------------


def test_sprint_history_cap_warning_at_20000_ids(ado_client, fake):
    fake.wiql_ids = list(range(1, 20001))
    data = _ok(_post(ado_client))
    assert data["warnings"] == [CAP_REACHED]
    assert CAP_REACHED == "Only the first 20000 work items were loaded; narrow the scope."
    assert _ids(data) == [501, 502, 504, 506]


def test_sprint_history_no_cap_warning_below_20000(ado_client, fake):
    fake.wiql_ids = list(range(1, 20000))
    assert _ok(_post(ado_client))["warnings"] == []


def test_sprint_history_both_warnings_in_order(ado_client):
    fake = FakeAdo(work_items=synthetic_sprint_history(), missing_fields={STORY_POINTS}, wiql_ids=list(range(1, 20001)))
    app.dependency_overrides[get_ado_http_client] = _override(fake)
    assert _ok(_post(ado_client))["warnings"] == [STORY_POINTS_FIELD_MISSING, CAP_REACHED]


# --- 422: no items / unknown path --------------------------------------------------------------


def test_sprint_history_with_no_items_is_a_422_with_tree_spelling(ado_client, fake):
    fake.work_items = []
    assert _errors(_post(ado_client, iterationPath=PHASE_1.lower())) == [
        f"No resolved User Stories or Bugs were found under Iteration path: {PHASE_1}."
    ]
    assert fake.requests_to("batch") == []


def test_sprint_history_with_only_filtered_or_undated_items_is_a_422(ado_client, fake):
    fake.work_items = [history_item(1, "Bug", "Done", "Phase 1", changed=None)]
    fake.wiql_ids = [1, 503]
    assert _errors(_post(ado_client)) == [no_items_message(PHASE_1)]


@pytest.mark.parametrize(
    "path, message",
    [
        (f"{PROJECT_NAME}\\Team A", f"Unknown Iteration path: {PROJECT_NAME}\\Team A."),
        (f"\\{PROJECT_NAME}\\Iteration\\Phase 1", f"Unknown Iteration path: \\{PROJECT_NAME}\\Iteration\\Phase 1."),
        ("  Other  ", "Unknown Iteration path: Other."),
    ],
)
def test_sprint_history_unknown_path(ado_client, fake, path, message):
    assert _errors(_post(ado_client, iterationPath=path)) == [message]
    assert [fake._endpoint(r.url.path) for r in fake.requests] == ["projects", "nodes"]


# --- 422: request fields --------------------------------------------------------------------------


def test_sprint_history_all_fields_missing_reports_every_message(ado_client, fake):
    assert _errors(ado_client.post(ROUTE, json={})) == [
        "Choose the Azure DevOps source (On-Prem or Collaboration Hub).",
        "Enter the Azure DevOps project URL.",
        "Choose an Iteration path.",
    ]
    assert fake.requests == []


@pytest.mark.parametrize("path", [None, "", "   ", 5, ["Proj"], {"a": 1}])
def test_sprint_history_iteration_path_message(ado_client, fake, path):
    assert _errors(_post(ado_client, iterationPath=path)) == [ITERATION_PATH_REQUIRED]
    assert fake.requests == []


def test_sprint_history_missing_iteration_path_key(ado_client, fake):
    body = _body()
    del body["iterationPath"]
    assert _errors(ado_client.post(ROUTE, json=body)) == [ITERATION_PATH_REQUIRED]


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"source": "azure"}, "Choose the Azure DevOps source (On-Prem or Collaboration Hub)."),
        ({"projectUrl": "http://dev.azure.com/contoso/P"}, "The URL must start with https://."),
        ({"projectUrl": "https://evil.example.com/a/b"}, "This Azure DevOps host is not allowed: evil.example.com."),
        ({"pat": "bad\npat"}, PAT_REJECTED),
    ],
)
def test_sprint_history_connection_errors_make_no_request(ado_client, fake, overrides, message):
    assert _errors(_post(ado_client, **overrides)) == [message]
    assert fake.requests == []


@pytest.mark.parametrize("content", [b"not json", b"[1]", b"", b"null"])
def test_sprint_history_unreadable_body_reports_field_messages(ado_client, content):
    response = ado_client.post(ROUTE, content=content, headers={"Content-Type": "application/json"})
    assert len(_errors(response)) == 3


# --- 422: ADO errors passed through ------------------------------------------------------------------


@pytest.mark.parametrize(
    "failures, message",
    [
        ({"projects": "401"}, PAT_REJECTED),
        ({"nodes": "timeout"}, "Could not reach Azure DevOps at dev.azure.com."),
        ({"fields": "500"}, "Azure DevOps returned an error (HTTP 500). Something broke on the server."),
        ({"wiql": "403"}, PAT_REJECTED),
        ({"wiql": "502"}, "Azure DevOps returned an error (HTTP 502)."),
        ({"batch": "non_json"}, PAT_REJECTED),
        ({"batch": "connect"}, "Could not reach Azure DevOps at dev.azure.com."),
    ],
)
def test_sprint_history_ado_errors(ado_client, fake, failures, message):
    fake.failures = failures
    assert _errors(_post(ado_client)) == [message]


def test_sprint_history_unknown_project(ado_client):
    response = _post(ado_client, projectUrl="https://dev.azure.com/contoso/Nope")
    assert _errors(response) == ["Project not found: Nope. Check the URL."]


@pytest.mark.parametrize(
    "endpoint, content",
    [
        ("wiql", b"{}"),
        ("wiql", b'{"workItems": [{"id": "1"}]}'),
        ("batch", b'{"value": "x"}'),
        ("batch", b'{"value": [{"id": 501}]}'),
        ("batch", b'{"value": [{"id": true, "fields": {}}]}'),
        ("batch", b"\xff\xfe not utf-8"),
    ],
)
def test_sprint_history_malformed_payloads_are_unexpected_response(ado_client, fake, handler, endpoint, content):
    handler["handler"] = _raw(fake, endpoint, content)
    assert _errors(_post(ado_client)) == [UNEXPECTED_RESPONSE]


def test_sprint_history_unencodable_text_from_ado_is_replaced(ado_client, fake, handler):
    content = (
        b'{"value": [{"id": 1, "fields": {"System.WorkItemType": "Bug", "System.State": "Done",'
        b' "System.Title": "Bad \\ud800", "System.IterationPath": "P\\\\\\ud800",'
        b' "System.ChangedDate": "2026-10-01T00:00:00\\ud800"}}, {"id": 2, "fields": {"System.WorkItemType": "Bug",'
        b' "System.State": "Done", "System.Title": "Bad \\ud800", "System.ChangedDate": "2026-10-01T00:00:00Z"}}]}'
    )
    fake.wiql_ids = [1, 2]
    handler["handler"] = _raw(fake, "batch", content)
    (item,) = _ok(_post(ado_client))["workItems"]
    assert item["id"] == 2 and item["title"] == "Bad ?"


def test_sprint_history_maps_escaping_unicode_and_recursion_errors(ado_client, monkeypatch):
    async def broken(*args):
        raise UnicodeEncodeError("utf-8", "x", 0, 1, "bad")

    monkeypatch.setattr("app.api.ado_routes.fetch_sprint_history", broken)
    assert _errors(_post(ado_client)) == [UNEXPECTED_RESPONSE]


# --- PAT hygiene / OpenAPI ------------------------------------------------------------------------------


def test_sprint_history_pat_is_trimmed_and_never_echoed(ado_client, fake):
    _ok(_post(ado_client, pat=f"  {FAKE_PAT}  "))
    expected_auth = "Basic " + base64.b64encode(f":{FAKE_PAT}".encode()).decode()
    assert {r.headers["Authorization"] for r in fake.requests} == {expected_auth}


def test_openapi_documents_the_sprint_history_route():
    operation = app.openapi()["paths"][ROUTE]["post"]
    body = operation["requestBody"]["content"]["application/json"]["schema"]
    assert {"source", "projectUrl", "pat", "iterationPath"} <= set(body["properties"])
    assert "422" in operation["responses"]


# --- service helpers, called directly -----------------------------------------------------------------


def test_wiql_query_escapes_quotes():
    query = wiql_query("P\\It's")
    assert "  AND [System.IterationPath] UNDER 'P\\It''s'\n" in query
    assert "  AND [System.State] IN ('Resolved','Done','Closed')\n" in query


@pytest.mark.parametrize(
    "data, expected",
    [
        ({"iterationPath": "P"}, []),
        ({"iterationPath": " P "}, []),
        ({}, [ITERATION_PATH_REQUIRED]),
        ({"iterationPath": " "}, [ITERATION_PATH_REQUIRED]),
        ({"iterationPath": 1}, [ITERATION_PATH_REQUIRED]),
    ],
)
def test_iteration_path_errors(data, expected):
    assert iteration_path_errors(data) == expected


@pytest.mark.parametrize(
    "value, expected",
    [
        ("2026-04-09T10:47:08.1234567Z", "2026-04-09T10:47:08Z"),
        ("2026-04-09T10:47:08+01:00", "2026-04-09T09:47:08Z"),
        ("2026-04-09T10:47:08", "2026-04-09T10:47:08Z"),
        ("2026-04-09", "2026-04-09T00:00:00Z"),
        (" 2026-04-09T10:47:08Z ", "2026-04-09T10:47:08Z"),
        ("", None),
        ("April 9 2026", None),
        ("2026-13-01T00:00:00Z", None),
        ("0001-01-01T00:00:00Z", None),
        (20260409, None),
        (None, None),
        ("2026-04-09\ud800", None),
    ],
)
def test_utc_iso(value, expected):
    assert utc_iso(value) == expected


def test_normalize_sprint_item_null_and_undated_are_skipped():
    assert normalize_sprint_item(None) is None
    assert normalize_sprint_item({"id": 1, "fields": {"System.Title": "No date"}}) is None


@pytest.mark.parametrize("raw", [5, {"id": 1}, {"id": 0, "fields": {}}, {"id": "1", "fields": {}}, {"fields": {}}])
def test_normalize_sprint_item_malformed_raises(raw):
    with pytest.raises(AdoError) as exc:
        normalize_sprint_item(raw)
    assert str(exc.value) == UNEXPECTED_RESPONSE


def test_fetch_sprint_history_called_directly():
    fake = FakeAdo(work_items=synthetic_sprint_history())
    project = parse_project_url("cloud", CLOUD_URL, ("dev.azure.com",))

    async def run():
        async with mock_http_client(fake) as http:
            client = AdoClient(http, project.base_url, FAKE_PAT)
            return await fetch_sprint_history(client, project, f"{PHASE_1}\\Sprint 01")

    data = asyncio.run(run())
    assert [item["id"] for item in data["workItems"]] == [501, 502]
    assert data["iterationPath"] == f"{PHASE_1}\\Sprint 01"


def _override(fake):
    async def http_client():
        async with mock_http_client(fake) as http:
            yield http

    return http_client
