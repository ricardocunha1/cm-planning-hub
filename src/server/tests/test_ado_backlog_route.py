import asyncio
import base64
import json
from datetime import datetime, timezone
from functools import partial

import httpx
import pytest
from fastapi.testclient import TestClient

from ado_fakes import (
    FAKE_PAT,
    PROJECT_ID,
    PROJECT_NAME,
    FakeAdo,
    classification_nodes,
    error_response,
    mock_http_client,
    synthetic_backlog,
    work_item,
)
from app.api.ado_routes import get_ado_http_client
from app.config import Settings, get_settings
from app.main import app
from app.services import ado_backlog
from app.services.ado_backlog import (
    CAP_REACHED,
    SCOPE_REQUIRED,
    SIZE_FIELD_MISSING,
    SIZE_FIELDS,
    fetch_backlog,
    flatten_iterations,
    normalize_work_item,
    scope_field_errors,
    wiql_query,
)
from app.services.ado_client import PAT_REJECTED, UNEXPECTED_RESPONSE, AdoClient, AdoError
from app.services.ado_url import parse_project_url

ONPREM_HOST = "tfs-projects.cmf.criticalmanufacturing.com"
CLOUD_URL = "https://dev.azure.com/contoso/Fabrikam%20Plant"
SETTINGS = Settings(
    ado_allowed_hosts=("dev.azure.com", "*.visualstudio.com", ONPREM_HOST),
    ado_timeout_seconds=5.0,
)
TEAM_A = f"{PROJECT_NAME}\\Team A"
SIZE_FIELD = "Custom.EstimatedSize"
FEATURE_SIZE_FIELD = "Custom.FeatureSize"


@pytest.fixture()
def fake():
    return FakeAdo()


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
    body = {"source": "cloud", "projectUrl": CLOUD_URL, "pat": FAKE_PAT, "scopeType": "area", "scopePath": TEAM_A}
    body.update(overrides)
    return body


def _post(client, **overrides):
    return client.post("/api/ado/backlog", json=_body(**overrides))


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


def _items(data):
    return {item["id"]: item for item in data["workItems"]}


def _raw(fake, endpoint, content: bytes, status=200, content_type="application/json"):
    """A handler serving `content` verbatim for `endpoint`, `fake` otherwise
    (for payloads httpx's own `json=` refuses to encode)."""

    def handler(request):
        if fake._endpoint(request.url.path) == endpoint:
            fake.requests.append(request)
            return httpx.Response(status, content=content, headers={"Content-Type": content_type})
        return fake(request)

    return handler


# --- 200: shape, ordering, normalization -----------------------------------------


def test_backlog_returns_contract_shape(ado_client, monkeypatch):
    monkeypatch.setattr(ado_backlog, "_utc_now", lambda: datetime(2026, 10, 23, 10, 0, 0, 123456, tzinfo=timezone.utc))
    data = _ok(_post(ado_client))
    assert set(data) == {"project", "projectUrl", "scope", "fetchedAt", "workItems", "iterations", "warnings"}
    assert data["project"] == {"id": PROJECT_ID, "name": PROJECT_NAME}
    assert data["projectUrl"] == CLOUD_URL
    assert data["scope"] == f"Area Path: {TEAM_A}"
    assert data["fetchedAt"] == "2026-10-23T10:00:00Z"
    assert data["warnings"] == []
    assert data["workItems"][0] == {
        "id": 101,
        "type": "Epic",
        "title": "Platform",
        "state": "Active",
        "description": "<p>Platform epic</p>",
        "size": "",
        "iterationPath": PROJECT_NAME,
        "parentId": None,
    }
    assert data["workItems"][1] == {
        "id": 102,
        "type": "Feature",
        "title": "Login",
        "state": "New",
        "description": "",
        "size": "M",
        "iterationPath": f"{PROJECT_NAME}\\Phase 1\\Sprint 02",
        "parentId": 101,
    }


def test_backlog_fetched_at_is_real_utc_iso_with_z(ado_client):
    fetched = _ok(_post(ado_client))["fetchedAt"]
    parsed = datetime.strptime(fetched, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert abs((datetime.now(timezone.utc) - parsed).total_seconds()) < 60


def test_backlog_items_in_ascending_id_order_epics_and_features_only(ado_client):
    data = _ok(_post(ado_client))
    # 106 is Removed, 202 is out of scope (and not a parent), 301 is a User Story.
    assert [item["id"] for item in data["workItems"]] == [101, 102, 103, 104, 105, 201]
    assert {item["type"] for item in data["workItems"]} == {"Epic", "Feature"}


def test_backlog_sorts_by_id_even_when_ado_does_not(ado_client, fake):
    fake.wiql_ids = [105, 102, 104, 101, 103]
    assert [item["id"] for item in _ok(_post(ado_client))["workItems"]] == [101, 102, 103, 104, 105, 201]


def test_backlog_size_description_and_parent_normalization(ado_client):
    items = _items(_ok(_post(ado_client)))
    assert items[102]["size"] == "M"  # " m " trimmed + upper-cased
    assert items[103]["size"] == "L"
    assert items[105]["size"] == "XS"
    assert items[104]["size"] == "" and items[104]["description"] == "" and items[104]["parentId"] is None
    assert items[104]["iterationPath"] == PROJECT_NAME


def test_backlog_iteration_scope_uses_iteration_path(ado_client, fake):
    data = _ok(_post(ado_client, scopeType="iteration", scopePath=f"{PROJECT_NAME}\\Phase 1"))
    assert data["scope"] == f"Iteration Path: {PROJECT_NAME}\\Phase 1"
    assert "[System.IterationPath] UNDER 'Fabrikam Plant\\Phase 1'" in fake.wiql_queries()[0]
    # 102 and 103 are in Phase 1 sprints; 103's out-of-scope parent Epic 201 is added.
    assert [item["id"] for item in data["workItems"]] == [101, 102, 103, 201]


def test_backlog_project_root_is_a_valid_scope(ado_client):
    data = _ok(_post(ado_client, scopePath=PROJECT_NAME))
    assert data["scope"] == f"Area Path: {PROJECT_NAME}"
    assert [item["id"] for item in data["workItems"]] == [101, 102, 103, 104, 105, 201, 202]


def test_backlog_scope_path_matches_case_insensitively_and_uses_tree_spelling(ado_client, fake):
    data = _ok(_post(ado_client, scopePath="  fabrikam plant\\TEAM a  "))
    assert data["scope"] == f"Area Path: {TEAM_A}"
    assert f"UNDER '{TEAM_A}'" in fake.wiql_queries()[0]


def test_backlog_uses_the_canonical_project_name(ado_client):
    data = _ok(_post(ado_client, projectUrl="https://dev.azure.com/contoso/fabrikam%20plant"))
    assert data["project"]["name"] == PROJECT_NAME
    assert data["projectUrl"] == CLOUD_URL


# --- requests made ----------------------------------------------------------------


def test_backlog_wiql_text_and_request(ado_client, fake):
    _ok(_post(ado_client))
    (request,) = fake.requests_to("wiql")
    assert request.method == "POST"
    assert request.url.raw_path.split(b"?")[0] == b"/contoso/Fabrikam%20Plant/_apis/wit/wiql"
    assert request.url.params["$top"] == "20000"
    assert request.url.params["api-version"] == "7.0"
    assert json.loads(request.content)["query"] == (
        "SELECT [System.Id] FROM WorkItems\n"
        "WHERE [System.TeamProject] = @project\n"
        "  AND [System.WorkItemType] IN ('Epic','Feature')\n"
        "  AND [System.State] <> 'Removed'\n"
        "  AND [System.AreaPath] UNDER 'Fabrikam Plant\\Team A'\n"
        "ORDER BY [System.Id]"
    )


def test_backlog_request_sequence_and_auth(ado_client, fake):
    _ok(_post(ado_client))
    endpoints = [fake._endpoint(r.url.path) for r in fake.requests]
    assert endpoints == ["projects", "nodes", "fields", "fields", "wiql", "batch", "batch"]
    assert [r.url.path for r in fake.requests_to("fields")] == [
        "/contoso/_apis/wit/fields/Custom.EstimatedSize",
        "/contoso/_apis/wit/fields/Custom.FeatureSize",
    ]
    expected_auth = "Basic " + base64.b64encode(f":{FAKE_PAT}".encode()).decode()
    for request in fake.requests:
        assert request.headers["Authorization"] == expected_auth
        assert request.url.params["api-version"] == "7.0"
        assert FAKE_PAT not in str(request.url)
        assert FAKE_PAT.encode() not in request.content


def test_backlog_batch_body(ado_client, fake):
    _ok(_post(ado_client))
    first, parents = fake.batch_bodies()
    assert first == {
        "ids": [101, 102, 103, 104, 105],
        "fields": [
            "System.Id",
            "System.WorkItemType",
            "System.Title",
            "System.State",
            "System.Parent",
            "System.IterationPath",
            "System.Description",
            SIZE_FIELD,
        ],
        "errorPolicy": "omit",
    }
    assert parents["ids"] == [201, 301]
    assert parents["fields"] == first["fields"] and parents["errorPolicy"] == "omit"
    (request,) = fake.requests_to("batch")[:1]
    assert request.url.raw_path.split(b"?")[0] == b"/contoso/Fabrikam%20Plant/_apis/wit/workitemsbatch"


def test_backlog_escapes_single_quotes_in_the_scope_path(ado_client, fake):
    nodes = classification_nodes()
    area = nodes["value"][0]
    area["children"].append({"name": "O'Brien's", "path": f"{area['path']}\\O'Brien's"})
    fake.nodes = nodes
    fake.work_items = [work_item(1, "Feature", "Quoted", "O'Brien's")]
    data = _ok(_post(ado_client, scopePath=f"{PROJECT_NAME}\\O'Brien's"))
    assert "UNDER 'Fabrikam Plant\\O''Brien''s'\n" in fake.wiql_queries()[0]
    assert [item["id"] for item in data["workItems"]] == [1]
    assert data["scope"] == f"Area Path: {PROJECT_NAME}\\O'Brien's"


def test_backlog_chunks_batches_to_at_most_200_ids(ado_client, fake):
    fake.work_items = [work_item(1, "Epic", "Big", "Team A")] + [
        work_item(i, "Feature", f"F{i}", "Team A", parent=1, size="s") for i in range(2, 452)
    ]
    data = _ok(_post(ado_client))
    sizes = [len(body["ids"]) for body in fake.batch_bodies()]
    assert sizes == [200, 200, 51]
    assert [body["ids"][0] for body in fake.batch_bodies()] == [1, 201, 401]
    assert len(data["workItems"]) == 451
    assert all(item["size"] == "S" for item in data["workItems"][1:])


def test_backlog_with_no_items_makes_no_batch_call(ado_client, fake):
    fake.work_items = []
    data = _ok(_post(ado_client))
    assert data["workItems"] == []
    assert fake.requests_to("batch") == []


def test_backlog_duplicate_wiql_ids_are_fetched_once(ado_client, fake):
    fake.wiql_ids = [104, 104, 104]
    data = _ok(_post(ado_client))
    assert fake.batch_bodies()[0]["ids"] == [104]
    assert [item["id"] for item in data["workItems"]] == [104]


# --- parent completion ----------------------------------------------------------------


def test_backlog_includes_out_of_scope_parent_epic_but_not_other_parents(ado_client):
    items = _items(_ok(_post(ado_client)))
    assert items[201]["type"] == "Epic" and items[201]["description"] == "<b>Out of scope</b>"
    assert 301 not in items
    assert items[105]["parentId"] == 301  # kept: the client treats it as an orphan


def test_backlog_parent_completion_stops_after_three_levels(ado_client, fake):
    fake.work_items = [
        work_item(10, "Feature", "Leaf", "Team A", parent=501),
        work_item(501, "Epic", "L1", "Team B", parent=502),
        work_item(502, "Epic", "L2", "Team B", parent=503),
        work_item(503, "Epic", "L3", "Team B", parent=504),
        work_item(504, "Epic", "L4", "Team B"),
    ]
    data = _ok(_post(ado_client))
    assert [item["id"] for item in data["workItems"]] == [10, 501, 502, 503]
    assert [body["ids"] for body in fake.batch_bodies()] == [[10], [501], [502], [503]]


def test_backlog_parent_cycles_terminate(ado_client, fake):
    fake.work_items = [
        work_item(10, "Feature", "Leaf", "Team A", parent=501),
        work_item(501, "Epic", "A", "Team B", parent=502),
        work_item(502, "Epic", "B", "Team B", parent=501),
        work_item(20, "Epic", "Self", "Team A", parent=20),
    ]
    data = _ok(_post(ado_client))
    assert [item["id"] for item in data["workItems"]] == [10, 20, 501, 502]
    assert [body["ids"] for body in fake.batch_bodies()] == [[10, 20], [501], [502]]


def test_backlog_non_epic_parents_are_not_followed(ado_client, fake):
    fake.work_items = [
        work_item(10, "Feature", "Leaf", "Team A", parent=600),
        work_item(600, "Feature", "Feature parent", "Team B", parent=700),
        work_item(700, "Epic", "Grandparent", "Team B"),
    ]
    data = _ok(_post(ado_client))
    assert [item["id"] for item in data["workItems"]] == [10]
    assert [body["ids"] for body in fake.batch_bodies()] == [[10], [600]]


def test_backlog_missing_parent_omitted_by_ado_is_skipped(ado_client, fake):
    fake.work_items = [work_item(10, "Feature", "Leaf", "Team A", parent=999)]
    data = _ok(_post(ado_client))
    assert [item["id"] for item in data["workItems"]] == [10]
    assert data["workItems"][0]["parentId"] == 999


def test_backlog_more_than_200_missing_parents_are_chunked(ado_client, fake):
    features = [work_item(i, "Feature", f"F{i}", "Team A", parent=1000 + i) for i in range(1, 251)]
    epics = [work_item(1000 + i, "Epic", f"E{i}", "Team B") for i in range(1, 251)]
    fake.work_items = features + epics
    data = _ok(_post(ado_client))
    assert [len(body["ids"]) for body in fake.batch_bodies()] == [200, 50, 200, 50]
    assert len(data["workItems"]) == 500


# --- warnings ------------------------------------------------------------------------


def test_backlog_missing_size_field_warns_and_omits_the_field(ado_client):
    fake = FakeAdo(size_fields=set())
    app.dependency_overrides[get_ado_http_client] = _override(fake)
    data = _ok(_post(ado_client))
    assert data["warnings"] == [SIZE_FIELD_MISSING]
    assert data["warnings"] == [
        "Neither Custom.EstimatedSize nor Custom.FeatureSize exists in this project; sizes are empty."
    ]
    assert {item["size"] for item in data["workItems"]} == {""}
    assert all(SIZE_FIELD not in body["fields"] for body in fake.batch_bodies())
    assert all(FEATURE_SIZE_FIELD not in body["fields"] for body in fake.batch_bodies())
    assert len(data["workItems"]) == 6


def test_backlog_legacy_size_field_false_means_no_size_field(ado_client):
    fake = FakeAdo(size_field=False)
    app.dependency_overrides[get_ado_http_client] = _override(fake)
    assert _ok(_post(ado_client))["warnings"] == [SIZE_FIELD_MISSING]


# --- size fields: Custom.EstimatedSize, then Custom.FeatureSize ------------------------


def _size_backlog():
    """Features 1-8 in Team A covering every EstimatedSize / FeatureSize combination."""
    w = partial(work_item, area="Team A")
    return [
        w(1, "Feature", "Both", size=" m ", feature_size="xl"),
        w(2, "Feature", "Feature size only", feature_size=" s "),
        w(3, "Feature", "Blank estimated", size="", feature_size="l"),
        w(4, "Feature", "Whitespace estimated", size="   ", feature_size="xs"),
        w(5, "Feature", "Non-string estimated", size=2.5, feature_size="m"),
        w(6, "Feature", "Integer feature size", feature_size=8),
        w(7, "Feature", "Estimated only", size="L"),
        w(8, "Feature", "Neither"),
    ]


def _size_run(ado_client, size_fields):
    fake = FakeAdo(size_fields=size_fields, work_items=_size_backlog())
    app.dependency_overrides[get_ado_http_client] = _override(fake)
    data = _ok(_post(ado_client))
    return fake, data, {item["id"]: item["size"] for item in data["workItems"]}


def test_backlog_only_estimated_size_exists(ado_client):
    fake, data, sizes = _size_run(ado_client, {SIZE_FIELD})
    assert data["warnings"] == []
    assert sizes == {1: "M", 2: "", 3: "", 4: "", 5: "", 6: "", 7: "L", 8: ""}
    (body,) = fake.batch_bodies()
    assert SIZE_FIELD in body["fields"] and FEATURE_SIZE_FIELD not in body["fields"]


def test_backlog_only_feature_size_exists(ado_client):
    fake, data, sizes = _size_run(ado_client, {FEATURE_SIZE_FIELD})
    assert data["warnings"] == []
    assert sizes == {1: "XL", 2: "S", 3: "L", 4: "XS", 5: "M", 6: "8", 7: "", 8: ""}
    (body,) = fake.batch_bodies()
    assert body["fields"][-1] == FEATURE_SIZE_FIELD and SIZE_FIELD not in body["fields"]


def test_backlog_both_size_fields_exist_estimated_size_wins(ado_client):
    fake, data, sizes = _size_run(ado_client, {SIZE_FIELD, FEATURE_SIZE_FIELD})
    assert data["warnings"] == []
    # 1 and 7: EstimatedSize; 2-6: blank / missing / whitespace / non-string → FeatureSize.
    assert sizes == {1: "M", 2: "S", 3: "L", 4: "XS", 5: "M", 6: "8", 7: "L", 8: ""}
    (body,) = fake.batch_bodies()
    assert body["fields"][-2:] == [SIZE_FIELD, FEATURE_SIZE_FIELD]


def test_backlog_neither_size_field_exists(ado_client):
    fake, data, sizes = _size_run(ado_client, set())
    assert data["warnings"] == [SIZE_FIELD_MISSING]
    assert set(sizes.values()) == {""}
    (body,) = fake.batch_bodies()
    assert not {SIZE_FIELD, FEATURE_SIZE_FIELD} & set(body["fields"])


@pytest.mark.parametrize("size_fields", [set(), {SIZE_FIELD}, {FEATURE_SIZE_FIELD}, {SIZE_FIELD, FEATURE_SIZE_FIELD}])
def test_backlog_checks_both_size_fields_in_priority_order(ado_client, size_fields):
    fake, _, _ = _size_run(ado_client, size_fields)
    assert [r.url.path.rsplit("/", 1)[-1] for r in fake.requests_to("fields")] == [SIZE_FIELD, FEATURE_SIZE_FIELD]
    endpoints = [fake._endpoint(r.url.path) for r in fake.requests]
    assert endpoints == ["projects", "nodes", "fields", "fields", "wiql", "batch"]


def test_backlog_fake_batch_rejects_a_non_existent_size_field():
    # Guards the fake itself: requesting an absent field must fail like ADO does.
    fake = FakeAdo(size_fields={FEATURE_SIZE_FIELD})
    request = httpx.Request(
        "POST",
        "https://dev.azure.com/contoso/P/_apis/wit/workitemsbatch",
        json={"ids": [101], "fields": ["System.Id", SIZE_FIELD], "errorPolicy": "omit"},
    )
    assert fake(request).status_code == 400


@pytest.mark.parametrize("kind", ["500", "403", "timeout"])
@pytest.mark.parametrize("failing", [SIZE_FIELD, FEATURE_SIZE_FIELD])
def test_backlog_size_field_check_errors_other_than_404_are_422(ado_client, fake, handler, failing, kind):
    def failing_handler(request):
        if request.url.path.endswith(f"/_apis/wit/fields/{failing}"):
            fake.requests.append(request)
            return error_response(kind, request)
        return fake(request)

    handler["handler"] = failing_handler
    expected = {
        "500": "Azure DevOps returned an error (HTTP 500). Something broke on the server.",
        "403": PAT_REJECTED,
        "timeout": "Could not reach Azure DevOps at dev.azure.com.",
    }[kind]
    assert _errors(_post(ado_client)) == [expected]
    assert fake.requests_to("wiql") == []


def test_backlog_cap_warning_at_20000_ids(ado_client, fake):
    fake.wiql_ids = list(range(1, 20001))
    data = _ok(_post(ado_client))
    assert data["warnings"] == [CAP_REACHED]
    assert CAP_REACHED == "Only the first 20000 work items were loaded; narrow the scope."
    bodies = fake.batch_bodies()
    assert max(len(body["ids"]) for body in bodies) == 200
    assert sum(len(body["ids"]) for body in bodies[:100]) == 20000


def test_backlog_no_cap_warning_below_20000(ado_client, fake):
    fake.wiql_ids = list(range(1, 20000))
    assert _ok(_post(ado_client))["warnings"] == []


def test_backlog_both_warnings_in_order(ado_client):
    fake = FakeAdo(size_field=False, wiql_ids=list(range(1, 20001)))
    app.dependency_overrides[get_ado_http_client] = _override(fake)
    assert _ok(_post(ado_client))["warnings"] == [SIZE_FIELD_MISSING, CAP_REACHED]


def _override(fake):
    async def http_client():
        async with mock_http_client(fake) as http:
            yield http

    return http_client


# --- iterations -------------------------------------------------------------------------


def test_backlog_iterations_flattened_root_excluded_with_dates(ado_client):
    assert _ok(_post(ado_client))["iterations"] == [
        {"path": f"{PROJECT_NAME}\\Phase 1", "finishDate": "2026-11-30"},
        {"path": f"{PROJECT_NAME}\\Phase 1\\Sprint 02", "finishDate": "2026-11-13"},
        {"path": f"{PROJECT_NAME}\\Phase 1\\Sprint 01", "finishDate": "2026-10-30"},
        {"path": f"{PROJECT_NAME}\\Backlog", "finishDate": ""},
    ]


@pytest.mark.parametrize(
    "finish, expected",
    [
        ("2026-10-30T00:00:00Z", "2026-10-30"),
        ("2026-10-30", "2026-10-30"),
        ("2026-02-30T00:00:00Z", ""),  # not a real date
        ("2026-13-01", ""),
        ("not a date at all", ""),
        ("2026-1-5", ""),
        ("20261030", ""),
        ("", ""),
        (20261030, ""),
        (None, ""),
    ],
)
def test_backlog_iteration_finish_dates_are_validated(ado_client, fake, finish, expected):
    fake.nodes["value"][1]["children"][1]["attributes"] = {"finishDate": finish}
    iterations = _ok(_post(ado_client))["iterations"]
    assert iterations[-1] == {"path": f"{PROJECT_NAME}\\Backlog", "finishDate": expected}


def test_connect_tree_uses_the_same_finish_date_validation():
    fake = FakeAdo()
    fake.nodes["value"][1]["children"][1]["attributes"] = {"finishDate": "2026-02-30T00:00:00Z"}
    app.dependency_overrides[get_ado_http_client] = _override(fake)
    app.dependency_overrides[get_settings] = lambda: SETTINGS
    try:
        response = TestClient(app).post("/api/ado/connect", json={"source": "cloud", "projectUrl": CLOUD_URL, "pat": FAKE_PAT})
    finally:
        app.dependency_overrides.clear()
    assert response.json()["iterations"]["children"][1]["finishDate"] == ""


# --- 422: request fields --------------------------------------------------------------


def test_backlog_all_fields_missing_reports_every_message(ado_client, fake):
    assert _errors(ado_client.post("/api/ado/backlog", json={})) == [
        "Choose the Azure DevOps source (On-Prem or Collaboration Hub).",
        "Enter the Azure DevOps project URL.",
        "Enter a Personal Access Token.",
        "Choose an Area path or an Iteration path.",
    ]
    assert fake.requests == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"scopeType": None},
        {"scopeType": ""},
        {"scopeType": "Area"},
        {"scopeType": "team"},
        {"scopeType": ["area"]},
        {"scopePath": ""},
        {"scopePath": "   "},
        {"scopePath": None},
        {"scopePath": 5},
        {"scopePath": ["Proj"]},
    ],
)
def test_backlog_scope_message(ado_client, fake, overrides):
    assert _errors(_post(ado_client, **overrides)) == [SCOPE_REQUIRED]
    assert SCOPE_REQUIRED == "Choose an Area path or an Iteration path."
    assert fake.requests == []


def test_backlog_missing_scope_keys(ado_client, fake):
    body = _body()
    del body["scopeType"], body["scopePath"]
    assert _errors(ado_client.post("/api/ado/backlog", json=body)) == [SCOPE_REQUIRED]
    assert fake.requests == []


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"source": "azure"}, "Choose the Azure DevOps source (On-Prem or Collaboration Hub)."),
        ({"projectUrl": " "}, "Enter the Azure DevOps project URL."),
        ({"pat": None}, "Enter a Personal Access Token."),
        ({"projectUrl": "http://dev.azure.com/contoso/P"}, "The URL must start with https://."),
        ({"projectUrl": "https://dev.azure.com/contoso"}, "Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>."),
        (
            {"source": "onprem", "projectUrl": f"https://{ONPREM_HOST}/Coll"},
            "On-Prem URLs look like https://<server>/<collection>/<project>.",
        ),
        ({"projectUrl": "https://evil.example.com/a/b"}, "This Azure DevOps host is not allowed: evil.example.com."),
        ({"pat": "bad\npat"}, PAT_REJECTED),
    ],
)
def test_backlog_connection_errors_make_no_request(ado_client, fake, overrides, message):
    assert _errors(_post(ado_client, **overrides)) == [message]
    assert fake.requests == []


@pytest.mark.parametrize("content", [b"not json", b"[1]", b"", b"null"])
def test_backlog_unreadable_body_reports_field_messages(ado_client, content):
    response = ado_client.post("/api/ado/backlog", content=content, headers={"Content-Type": "application/json"})
    assert len(_errors(response)) == 4


# --- 422: unknown scope path ----------------------------------------------------------


@pytest.mark.parametrize(
    "scope_type, path, message",
    [
        ("area", f"{PROJECT_NAME}\\Team Z", f"Unknown Area path: {PROJECT_NAME}\\Team Z."),
        ("iteration", f"{PROJECT_NAME}\\Team A", f"Unknown Iteration path: {PROJECT_NAME}\\Team A."),
        ("area", f"{PROJECT_NAME}\\Phase 1", f"Unknown Area path: {PROJECT_NAME}\\Phase 1."),
        ("area", f"\\{PROJECT_NAME}\\Area\\Team A", f"Unknown Area path: \\{PROJECT_NAME}\\Area\\Team A."),
        ("area", "  Other  ", "Unknown Area path: Other."),
    ],
)
def test_backlog_unknown_scope_path(ado_client, fake, scope_type, path, message):
    assert _errors(_post(ado_client, scopeType=scope_type, scopePath=path)) == [message]
    assert [fake._endpoint(r.url.path) for r in fake.requests] == ["projects", "nodes"]


def test_backlog_unknown_scope_path_with_unencodable_text_is_a_422(ado_client, fake):
    raw = json.dumps(_body(scopePath="X")).replace('"X"', '"X\\ud800"').encode()
    response = ado_client.post("/api/ado/backlog", content=raw, headers={"Content-Type": "application/json"})
    assert _errors(response) == ["Unknown Area path: X?."]


# --- 422: ADO errors ------------------------------------------------------------------


@pytest.mark.parametrize(
    "failures, message",
    [
        ({"projects": "401"}, PAT_REJECTED),
        ({"projects": "203"}, PAT_REJECTED),
        ({"nodes": "timeout"}, "Could not reach Azure DevOps at dev.azure.com."),
        ({"fields": "500"}, "Azure DevOps returned an error (HTTP 500). Something broke on the server."),
        ({"fields": "403"}, PAT_REJECTED),
        ({"wiql": "401"}, PAT_REJECTED),
        ({"wiql": "502"}, "Azure DevOps returned an error (HTTP 502)."),
        ({"wiql": "non_json"}, PAT_REJECTED),
        ({"batch": "timeout"}, "Could not reach Azure DevOps at dev.azure.com."),
        ({"batch": "500"}, "Azure DevOps returned an error (HTTP 500). Something broke on the server."),
    ],
)
def test_backlog_ado_errors(ado_client, fake, failures, message):
    fake.failures = failures
    assert _errors(_post(ado_client)) == [message]


def test_backlog_unknown_project(ado_client):
    response = _post(ado_client, projectUrl="https://dev.azure.com/contoso/Nope")
    assert _errors(response) == ["Project not found: Nope. Check the URL."]


def test_backlog_wiql_404_is_an_http_error_not_project_not_found(ado_client, fake):
    fake.failures = {"wiql": "404"}
    assert _errors(_post(ado_client)) == [
        "Azure DevOps returned an error (HTTP 404). TF200016: The following project does not exist."
    ]


# --- 422: malformed ADO payloads (never a 500) -----------------------------------------


@pytest.mark.parametrize(
    "endpoint, content",
    [
        ("wiql", b"{}"),
        ("wiql", b'{"workItems": null}'),
        ("wiql", b'{"workItems": {"id": 1}}'),
        ("wiql", b"[]"),
        ("wiql", b'{"workItems": [{"id": "101"}]}'),
        ("wiql", b'{"workItems": [{"id": 1.5}]}'),
        ("wiql", b'{"workItems": [{"id": true}]}'),
        ("wiql", b'{"workItems": [{"id": -3}]}'),
        ("wiql", b'{"workItems": [{"id": NaN}]}'),
        ("wiql", b'{"workItems": [{"id": Infinity}]}'),
        ("wiql", b'{"workItems": [{}]}'),
        ("wiql", b'{"workItems": [5]}'),
        ("wiql", b'{"workItems": [{"id": 1}'),  # truncated JSON
        ("batch", b"{}"),
        ("batch", b'{"value": "x"}'),
        ("batch", b'{"value": [5]}'),
        ("batch", b'{"value": [{"id": 101}]}'),
        ("batch", b'{"value": [{"id": 101, "fields": null}]}'),
        ("batch", b'{"value": [{"id": "101", "fields": {}}]}'),
        ("batch", b'{"value": [{"id": 0, "fields": {}}]}'),
        ("batch", b'{"value": [{"fields": {"System.Id": 101}}]}'),
        ("batch", b"\xff\xfe not utf-8"),
    ],
)
def test_backlog_malformed_payloads_are_unexpected_response(ado_client, fake, handler, endpoint, content):
    handler["handler"] = _raw(fake, endpoint, content)
    assert _errors(_post(ado_client)) == [UNEXPECTED_RESPONSE]


def test_backlog_odd_field_types_are_normalized(ado_client, fake, handler):
    entries = [
        {
            "id": 101,
            "fields": {
                "System.WorkItemType": "Epic",
                "System.Title": {"nested": True},
                "System.State": 7,
                "System.Description": None,
                "System.IterationPath": ["x"],
                "System.Parent": "5",
                SIZE_FIELD: 3,
            },
        },
        {
            "id": 102,
            "fields": {
                "System.WorkItemType": "Feature",
                "System.Title": "T",
                "System.Parent": True,
                SIZE_FIELD: False,
            },
        },
        {"id": 103, "fields": {"System.WorkItemType": "Feature", "System.Parent": 1.0, SIZE_FIELD: 2.5}},
        {"id": 104, "fields": {"System.WorkItemType": None}},
        {"id": 105, "fields": {"System.WorkItemType": "Test Case"}},
        None,
    ]
    fake.wiql_ids = [101, 102, 103, 104, 105, 106]
    handler["handler"] = _raw(fake, "batch", json.dumps({"value": entries}).encode())
    data = _ok(_post(ado_client))
    assert data["workItems"] == [
        {"id": 101, "type": "Epic", "title": "", "state": "", "description": "", "size": "3", "iterationPath": "", "parentId": None},
        {"id": 102, "type": "Feature", "title": "T", "state": "", "description": "", "size": "", "iterationPath": "", "parentId": None},
        {"id": 103, "type": "Feature", "title": "", "state": "", "description": "", "size": "", "iterationPath": "", "parentId": None},
    ]


def test_backlog_unencodable_text_from_ado_is_replaced(ado_client, fake, handler):
    content = (
        b'{"value": [{"id": 101, "fields": {"System.WorkItemType": "Epic", "System.Title": "Bad \\ud800 title",'
        b' "System.Description": "<p>\\udfff</p>", "System.IterationPath": "P\\\\\\ud800", "Custom.EstimatedSize": "m\\ud800"}}]}'
    )
    fake.wiql_ids = [101]
    handler["handler"] = _raw(fake, "batch", content)
    (item,) = _ok(_post(ado_client))["workItems"]
    assert item["title"] == "Bad ? title"
    assert item["description"] == "<p>?</p>"
    assert item["iterationPath"] == "P\\?"
    assert item["size"] == "M?"


def test_backlog_drops_wiql_hits_of_other_types(ado_client, fake):
    fake.work_items = synthetic_backlog() + [work_item(900, "User Story", "Story", "Team A")]
    fake.wiql_ids = [101, 900]
    assert [item["id"] for item in _ok(_post(ado_client))["workItems"]] == [101]


def test_backlog_maps_escaping_unicode_and_recursion_errors(ado_client, monkeypatch):
    async def broken(*args):
        raise RecursionError()

    monkeypatch.setattr("app.api.ado_routes.fetch_backlog", broken)
    assert _errors(_post(ado_client)) == [UNEXPECTED_RESPONSE]


# --- PAT hygiene ------------------------------------------------------------------------


def test_backlog_pat_is_trimmed_and_never_echoed(ado_client, fake):
    response = _post(ado_client, pat=f"  {FAKE_PAT}  ")
    _ok(response)
    expected_auth = "Basic " + base64.b64encode(f":{FAKE_PAT}".encode()).decode()
    assert {r.headers["Authorization"] for r in fake.requests} == {expected_auth}


def test_openapi_documents_the_backlog_route():
    schema = app.openapi()
    operation = schema["paths"]["/api/ado/backlog"]["post"]
    body = operation["requestBody"]["content"]["application/json"]["schema"]
    assert {"source", "projectUrl", "pat", "scopeType", "scopePath"} <= set(body["properties"])
    assert "422" in operation["responses"]


# --- service helpers, called directly ---------------------------------------------------


def test_wiql_query_escapes_quotes_and_uses_the_field():
    query = wiql_query("System.IterationPath", "P\\It's")
    assert "  AND [System.IterationPath] UNDER 'P\\It''s'\n" in query
    assert query.startswith("SELECT [System.Id] FROM WorkItems\n")
    assert query.endswith("ORDER BY [System.Id]")


def test_flatten_iterations_is_depth_first_and_iterative():
    root = {"name": "P", "path": "P", "finishDate": "", "children": []}
    node = root
    for i in range(3000):  # deeper than the recursion limit
        child = {"name": f"n{i}", "path": f"P\\n{i}", "finishDate": "", "children": []}
        node["children"].append(child)
        node = child
    flat = flatten_iterations(root)
    assert len(flat) == 3000 and flat[0]["path"] == "P\\n0" and flat[-1]["path"] == "P\\n2999"


def test_flatten_iterations_empty_root():
    assert flatten_iterations({"name": "P", "path": "P", "finishDate": "", "children": []}) == []


@pytest.mark.parametrize(
    "data, expected",
    [
        ({"scopeType": "area", "scopePath": "P"}, []),
        ({"scopeType": "iteration", "scopePath": " P "}, []),
        ({"scopeType": "area"}, [SCOPE_REQUIRED]),
        ({"scopePath": "P"}, [SCOPE_REQUIRED]),
        ({}, [SCOPE_REQUIRED]),
    ],
)
def test_scope_field_errors(data, expected):
    assert scope_field_errors(data) == expected


def test_normalize_work_item_null_is_skipped():
    assert normalize_work_item(None) is None


@pytest.mark.parametrize("raw", [5, "x", [], {"id": 1}, {"fields": {}}, {"id": True, "fields": {}}])
def test_normalize_work_item_malformed_raises(raw):
    with pytest.raises(AdoError) as info:
        normalize_work_item(raw)
    assert str(info.value) == UNEXPECTED_RESPONSE


def test_size_fields_priority_order():
    assert SIZE_FIELDS == (SIZE_FIELD, FEATURE_SIZE_FIELD)


def _raw_item(**fields):
    return {"id": 7, "fields": {"System.WorkItemType": "Feature", **fields}}


@pytest.mark.parametrize(
    "fields, expected",
    [
        ({SIZE_FIELD: " m ", FEATURE_SIZE_FIELD: "xl"}, "M"),
        ({FEATURE_SIZE_FIELD: " xl "}, "XL"),
        ({SIZE_FIELD: "", FEATURE_SIZE_FIELD: "s"}, "S"),
        ({SIZE_FIELD: " \t ", FEATURE_SIZE_FIELD: "s"}, "S"),
        ({SIZE_FIELD: None, FEATURE_SIZE_FIELD: "s"}, "S"),
        ({SIZE_FIELD: 2.5, FEATURE_SIZE_FIELD: "s"}, "S"),
        ({SIZE_FIELD: True, FEATURE_SIZE_FIELD: "s"}, "S"),
        ({SIZE_FIELD: {"v": "m"}, FEATURE_SIZE_FIELD: 5}, "5"),
        ({SIZE_FIELD: 3, FEATURE_SIZE_FIELD: "s"}, "3"),
        ({SIZE_FIELD: "", FEATURE_SIZE_FIELD: "  "}, ""),
        ({SIZE_FIELD: False, FEATURE_SIZE_FIELD: 1.0}, ""),
        ({}, ""),
    ],
)
def test_normalize_work_item_size_priority(fields, expected):
    assert normalize_work_item(_raw_item(**fields))["size"] == expected


def test_normalize_work_item_only_reads_the_given_size_fields():
    raw = _raw_item(**{SIZE_FIELD: "m", FEATURE_SIZE_FIELD: "xl"})
    assert normalize_work_item(raw, (FEATURE_SIZE_FIELD,))["size"] == "XL"
    assert normalize_work_item(raw, (SIZE_FIELD,))["size"] == "M"
    assert normalize_work_item(raw, ())["size"] == ""


def test_fetch_backlog_called_directly():
    fake = FakeAdo()
    project = parse_project_url("onprem", f"https://{ONPREM_HOST}/Coll/{PROJECT_NAME}", [ONPREM_HOST])

    async def go():
        async with mock_http_client(fake) as http:
            return await fetch_backlog(AdoClient(http, project.base_url, FAKE_PAT), project, "area", f"{PROJECT_NAME}\\Team B")

    result = asyncio.run(go())
    assert result["projectUrl"] == f"https://{ONPREM_HOST}/Coll/Fabrikam%20Plant"
    assert [item["id"] for item in result["workItems"]] == [201, 202]
    assert fake.requests_to("wiql")[0].url.raw_path.split(b"?")[0] == b"/Coll/Fabrikam%20Plant/_apis/wit/wiql"


# --- description limit ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "limit", "expected"),
    [
        ("abcde", 5, "abcde"),  # at the limit
        ("abc", 5, "abc"),  # below
        ("abcdef", 5, "abcde…"),  # above
        ("", 5, ""),
        ("<p>hello</p>", 5, "<p>he…"),  # a complete tag survives
        ("ab<p class='x'>text", 8, "ab…"),  # cut inside a tag
        ("ab<b>cd</b>", 9, "ab<b>cd…"),  # cut inside the closing tag
        ("fish &amp; chips", 8, "fish…"),  # cut inside an entity, whitespace trimmed
        ("a&amp;bcdef", 6, "a&amp;…"),  # a complete entity survives
        ("abc   def", 6, "abc…"),  # trailing whitespace before the ellipsis
        ("ñandú ñandú", 5, "ñandú…"),  # non-ASCII counts characters
        ("日本語のテキスト", 3, "日本語…"),
        ("Tom & Jerry " + "word " * 20, 60, "Tom & Jerry " + "word " * 9 + "wor…"),  # bare &
        ("a < b and a lot more text", 12, "a < b and a…"),  # bare <
        ("x <b>y</b> a < b tail", 17, "x <b>y</b> a < b…"),
        ("<p>ok</p> fish &am", 17, "<p>ok</p> fish…"),  # entity cut at the end
        ("<p>ok</p> fish &#12;x", 18, "<p>ok</p> fish…"),
        ("<p>ok</p><a href='x'>link</a>", 14, "<p>ok</p>…"),  # tag cut at the end after a complete one
        ("abc<", 4, "abc<"),
        ("abcd<ef", 5, "abcd…"),  # '<' as last char
    ],
)
def test_truncate_description(text, limit, expected):
    result = ado_backlog.truncate_description(text, limit)
    assert result == expected
    assert len(result) <= limit + 1


def test_backlog_route_truncates_descriptions_with_the_setting(ado_client, handler):
    long_description = "<p>" + "x" * 100 + "</p>"
    fake = FakeAdo(work_items=[work_item(101, "Epic", "Platform", "Team A", description=long_description)])
    handler["handler"] = fake
    app.dependency_overrides[get_settings] = lambda: Settings(
        ado_allowed_hosts=SETTINGS.ado_allowed_hosts, ado_timeout_seconds=5.0, ado_description_max_chars=10
    )
    data = _ok(_post(ado_client))
    assert _items(data)[101]["description"] == "<p>xxxxxxx…"


def test_backlog_route_keeps_short_descriptions(ado_client):
    data = _ok(_post(ado_client))
    assert _items(data)[101]["description"] == "<p>Platform epic</p>"

