import asyncio
import base64
import json

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from ado_fakes import FAKE_PAT, PROJECT_ID, PROJECT_NAME, FakeAdo, mock_http_client
from app.api import ado_routes
from app.api.ado_routes import get_ado_http_client
from app.config import Settings, get_settings
from app.main import app
from app.services import ado_url
from app.services.ado_client import PAT_REJECTED, UNEXPECTED_RESPONSE

ONPREM_HOST = "tfs-projects.cmf.criticalmanufacturing.com"
CLOUD_URL = "https://dev.azure.com/contoso/Fabrikam%20Plant"
SETTINGS = Settings(
    ado_allowed_hosts=("dev.azure.com", "*.visualstudio.com", ONPREM_HOST),
    ado_timeout_seconds=5.0,
)


@pytest.fixture()
def fake():
    return FakeAdo()


@pytest.fixture()
def ado_client(fake):
    async def http_client():
        async with mock_http_client(fake) as http:
            yield http

    app.dependency_overrides[get_ado_http_client] = http_client
    app.dependency_overrides[get_settings] = lambda: SETTINGS
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _body(**overrides):
    body = {"source": "cloud", "projectUrl": CLOUD_URL, "pat": FAKE_PAT}
    body.update(overrides)
    return body


def _assert_pat_absent(response):
    text = response.text
    assert FAKE_PAT not in text
    assert base64.b64encode(f":{FAKE_PAT}".encode()).decode() not in text


def _errors(response):
    assert response.status_code == 422
    return response.json()["errors"]


# --- 200 --------------------------------------------------------------------


def test_connect_returns_contract_shape(ado_client, fake):
    response = ado_client.post("/api/ado/connect", json=_body())
    assert response.status_code == 200
    data = response.json()
    assert set(data) == {"project", "projectUrl", "areas", "iterations"}
    assert data["project"] == {"id": PROJECT_ID, "name": PROJECT_NAME}
    assert data["projectUrl"] == CLOUD_URL

    areas = data["areas"]
    assert areas == {
        "name": PROJECT_NAME,
        "path": PROJECT_NAME,
        "children": [
            {
                "name": "Team A",
                "path": f"{PROJECT_NAME}\\Team A",
                "children": [{"name": "Squad 1", "path": f"{PROJECT_NAME}\\Team A\\Squad 1", "children": []}],
            },
            {"name": "Team B", "path": f"{PROJECT_NAME}\\Team B", "children": []},
        ],
    }

    iterations = data["iterations"]
    assert iterations["path"] == PROJECT_NAME and iterations["finishDate"] == ""
    phase, backlog = iterations["children"]
    assert phase["path"] == f"{PROJECT_NAME}\\Phase 1" and phase["finishDate"] == "2026-11-30"
    assert phase["children"][1] == {
        "name": "Sprint 01",
        "path": f"{PROJECT_NAME}\\Phase 1\\Sprint 01",
        "finishDate": "2026-10-30",
        "children": [],
    }
    assert backlog["finishDate"] == ""
    _assert_pat_absent(response)


def test_connect_requests_carry_auth_and_api_version_but_never_the_pat_in_urls(ado_client, fake):
    ado_client.post("/api/ado/connect", json=_body())
    assert len(fake.requests) == 2
    expected_auth = "Basic " + base64.b64encode(f":{FAKE_PAT}".encode()).decode()
    for request in fake.requests:
        assert request.url.scheme == "https"
        assert request.url.params["api-version"] == "7.0"
        assert request.headers["Authorization"] == expected_auth
        assert FAKE_PAT not in str(request.url)


def test_connect_onprem_url_with_board_suffix(ado_client, fake):
    url = f"https://{ONPREM_HOST}/ImplementationProjects/Fabrikam%20Plant/_boards/board/t/Team/Features?x=1"
    response = ado_client.post("/api/ado/connect", json=_body(source="onprem", projectUrl=url))
    assert response.status_code == 200
    assert response.json()["projectUrl"] == f"https://{ONPREM_HOST}/ImplementationProjects/Fabrikam%20Plant"
    assert fake.requests[0].url.host == ONPREM_HOST


def test_connect_canonical_name_from_ado(ado_client):
    response = ado_client.post("/api/ado/connect", json=_body(projectUrl="https://dev.azure.com/contoso/fabrikam%20PLANT/"))
    assert response.json()["project"]["name"] == PROJECT_NAME
    assert response.json()["projectUrl"] == CLOUD_URL


def test_connect_trims_pat_whitespace(ado_client, fake):
    ado_client.post("/api/ado/connect", json=_body(pat=f"  {FAKE_PAT}\n"))
    expected_auth = "Basic " + base64.b64encode(f":{FAKE_PAT}".encode()).decode()
    assert fake.requests[0].headers["Authorization"] == expected_auth


# --- 422: request fields ---------------------------------------------------------


def test_connect_all_fields_missing_reports_every_message(ado_client, fake):
    assert _errors(ado_client.post("/api/ado/connect", json={})) == [
        "Choose the Azure DevOps source (On-Prem or Collaboration Hub).",
        "Enter the Azure DevOps project URL.",
    ]
    assert fake.requests == []


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"source": ""}, "Choose the Azure DevOps source (On-Prem or Collaboration Hub)."),
        ({"source": "azure"}, "Choose the Azure DevOps source (On-Prem or Collaboration Hub)."),
        ({"projectUrl": "   "}, "Enter the Azure DevOps project URL."),
        ({"projectUrl": None}, "Enter the Azure DevOps project URL."),
        ({"pat": ""}, "A Personal Access Token is required: enter one, or save one for this project in Settings."),
        ({"pat": 123}, "Enter a Personal Access Token."),
    ],
)
def test_connect_blank_field_messages(ado_client, fake, overrides, message):
    assert _errors(ado_client.post("/api/ado/connect", json=_body(**overrides))) == [message]
    assert fake.requests == []


@pytest.mark.parametrize("content", [b"not json", b"[1, 2]", b"", b'"text"'])
def test_connect_unreadable_body_reports_field_messages(ado_client, content):
    response = ado_client.post("/api/ado/connect", content=content, headers={"Content-Type": "application/json"})
    assert len(_errors(response)) == 2


# --- 422: URL rules ----------------------------------------------------------------


@pytest.mark.parametrize(
    "source, url, message",
    [
        ("cloud", "http://dev.azure.com/contoso/P", "The URL must start with https://."),
        ("cloud", "https://dev.azure.com/contoso", "Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>."),
        ("onprem", f"https://{ONPREM_HOST}/OnlyCollection", "On-Prem URLs look like https://<server>/<collection>/<project>."),
        ("cloud", "https://evil.example.com/a/b", "This Azure DevOps host is not allowed: evil.example.com."),
        ("onprem", "https://169.254.169.254/latest/meta", "This Azure DevOps host is not allowed: 169.254.169.254."),
        ("onprem", "https://xn--zz.visualstudio.com/Coll/Proj", "On-Prem URLs look like https://<server>/<collection>/<project>."),
        ("onprem", "https://evil.com%2f.visualstudio.com/Coll/Proj", "On-Prem URLs look like https://<server>/<collection>/<project>."),
        ("cloud", "https://x\u0000.visualstudio.com/Proj", "Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>."),
        ("cloud", "https://dev.azure.com/../x", "Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>."),
    ],
)
def test_connect_url_errors_make_no_request(ado_client, fake, source, url, message):
    response = ado_client.post("/api/ado/connect", json=_body(source=source, projectUrl=url))
    assert _errors(response) == [message]
    assert fake.requests == []
    _assert_pat_absent(response)


def test_connect_uses_the_settings_allowlist(ado_client, fake):
    app.dependency_overrides[get_settings] = lambda: Settings(ado_allowed_hosts=("tfs.example.com",), ado_timeout_seconds=5.0)
    response = ado_client.post("/api/ado/connect", json=_body())
    assert _errors(response) == ["This Azure DevOps host is not allowed: dev.azure.com."]
    assert fake.requests == []


# --- 422: ADO errors ---------------------------------------------------------------


@pytest.mark.parametrize(
    "failures, message",
    [
        ({"projects": "401"}, PAT_REJECTED),
        ({"projects": "403"}, PAT_REJECTED),
        ({"projects": "203"}, PAT_REJECTED),
        ({"projects": "302"}, PAT_REJECTED),
        ({"projects": "non_json"}, PAT_REJECTED),
        ({"projects": "timeout"}, "Could not reach Azure DevOps at dev.azure.com."),
        ({"projects": "connect"}, "Could not reach Azure DevOps at dev.azure.com."),
        ({"projects": "500"}, "Azure DevOps returned an error (HTTP 500). Something broke on the server."),
        ({"nodes": "502"}, "Azure DevOps returned an error (HTTP 502)."),
    ],
)
def test_connect_ado_errors(ado_client, fake, failures, message):
    fake.failures = failures
    response = ado_client.post("/api/ado/connect", json=_body())
    assert _errors(response) == [message]
    _assert_pat_absent(response)


def test_connect_unknown_project(ado_client):
    response = ado_client.post("/api/ado/connect", json=_body(projectUrl="https://dev.azure.com/contoso/No%20Such"))
    assert _errors(response) == ["Project not found: No Such. Check the URL."]
    _assert_pat_absent(response)


def test_default_http_client_dependency_yields_and_closes():
    async def go():
        gen = get_ado_http_client(SETTINGS)
        http = await gen.__anext__()
        timeout = http.timeout.read
        follow = http.follow_redirects
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()
        return timeout, follow, http.is_closed

    assert asyncio.run(go()) == (5.0, False, True)


# --- route helpers and the defensive mapping, called directly ------------------------


def _request(body: bytes) -> Request:
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {"type": "http", "method": "POST", "path": "/api/ado/connect", "headers": [(b"content-type", b"application/json")]}
    return Request(scope, receive)


def test_read_json_object_too_deeply_nested_body_is_empty():
    assert asyncio.run(ado_routes._read_json_object(_request(b"[" * 5000 + b"]" * 5000))) == {}


def test_errors_replaces_characters_that_cannot_be_encoded():
    response = ado_routes._errors(["bad \ud800 text", "fine"])
    assert response.status_code == 422
    assert json.loads(response.body) == {"errors": ["bad ? text", "fine"]}


@pytest.mark.parametrize(
    "raw_url, raw_pat, message",
    [
        ("https://dev.azure.com/contoso/Fab\\ud800rikam", FAKE_PAT, ado_url.CLOUD_SHAPE),
        ("https://dev.azure.com/con\\ud800toso/Fabrikam%20Plant", FAKE_PAT, ado_url.CLOUD_SHAPE),
        (CLOUD_URL, "fake-pat-\\ud800", PAT_REJECTED),
        (CLOUD_URL, "fake\\u0000pat", PAT_REJECTED),
    ],
)
def test_connect_non_encodable_input_is_a_contract_422_without_a_request(raw_url, raw_pat, message):
    fake = FakeAdo()
    body = ('{"source": "cloud", "projectUrl": "%s", "pat": "%s"}' % (raw_url, raw_pat)).encode()

    async def go():
        async with mock_http_client(fake) as http:
            return await ado_routes.connect(_request(body), SETTINGS, http)

    response = asyncio.run(go())
    assert response.status_code == 422
    assert json.loads(response.body) == {"errors": [message]}
    assert fake.requests == []


@pytest.mark.parametrize("exc", [UnicodeEncodeError("utf-8", "\ud800", 0, 1, "surrogates not allowed"), RecursionError()])
def test_connect_maps_escaped_unicode_and_recursion_errors_to_unexpected_response(monkeypatch, exc):
    async def broken_connect(client, project):
        raise exc

    monkeypatch.setattr(ado_routes, "ado_connect", broken_connect)
    body = json.dumps(_body()).encode()

    async def go():
        async with mock_http_client(FakeAdo()) as http:
            return await ado_routes.connect(_request(body), SETTINGS, http)

    response = asyncio.run(go())
    assert response.status_code == 422
    assert json.loads(response.body) == {"errors": [UNEXPECTED_RESPONSE]}
    assert FAKE_PAT not in response.body.decode()
