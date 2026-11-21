"""Integration tests for `POST /api/ado/connect` and `POST /api/ado/backlog`
through the full FastAPI app.

Unlike test_ado_connect_route.py / test_ado_backlog_route.py (which override
`get_ado_http_client`),
these keep the **real** dependency chain (`get_settings` → `get_ado_http_client`
→ route → services) and only swap the network at the transport boundary: the
`httpx.AsyncClient` the dependency constructs gets an `httpx.MockTransport`
serving the synthetic `FakeAdo`. No real network call is ever made.
"""

import base64
import logging
import re

import httpx
import pytest
from fastapi.testclient import TestClient

from ado_fakes import FAKE_PAT, PROJECT_ID, PROJECT_NAME, FakeAdo, classification_nodes, work_item
from app.api import ado_routes
from app.api.ado_routes import get_ado_http_client
from app.config import get_settings
from app.main import app
from app.schemas import AdoBacklogResponse
from app.services.ado_client import PAT_REJECTED

ONPREM_HOST = "tfs-projects.cmf.criticalmanufacturing.com"
CLOUD_URL = "https://dev.azure.com/contoso/Fabrikam%20Plant"
PAT_B64 = base64.b64encode(f":{FAKE_PAT}".encode()).decode()
RealAsyncClient = httpx.AsyncClient


class TransportPatch:
    """Records how the real `get_ado_http_client` builds its client and which
    clients were closed, while serving `handler` through a MockTransport."""

    def __init__(self, handler):
        self.handler = handler
        self.kwargs: list[dict] = []
        self.clients: list[httpx.AsyncClient] = []

    def __call__(self, **kwargs):
        self.kwargs.append(kwargs)
        client = RealAsyncClient(transport=httpx.MockTransport(self.handler), **kwargs)
        self.clients.append(client)
        return client


@pytest.fixture()
def fake():
    return FakeAdo()


@pytest.fixture()
def env_settings(monkeypatch):
    """Real settings read from the process environment (no override)."""

    def apply(**env):
        for key in ("ADO_ALLOWED_HOSTS", "ADO_TIMEOUT_SECONDS"):
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()

    apply()
    yield apply
    get_settings.cache_clear()


@pytest.fixture()
def transport(monkeypatch, fake, env_settings):
    patch = TransportPatch(fake)
    monkeypatch.setattr(ado_routes.httpx, "AsyncClient", patch)
    # Drop only the overrides other modules may leak; keep the autouse auth/session bypass.
    app.dependency_overrides.pop(get_ado_http_client, None)
    app.dependency_overrides.pop(get_settings, None)
    return patch


@pytest.fixture()
def client(transport):
    return TestClient(app)


@pytest.fixture()
def lenient_client(transport):
    """Reports server-side crashes as HTTP 500 instead of re-raising them."""
    return TestClient(app, raise_server_exceptions=False)


def _body(**overrides):
    body = {"source": "cloud", "projectUrl": CLOUD_URL, "pat": FAKE_PAT}
    body.update(overrides)
    return body


def _assert_no_pat(text: str):
    assert FAKE_PAT not in text
    assert PAT_B64 not in text


# --- real dependency chain ---------------------------------------------------


def test_real_dependency_builds_one_client_per_request_and_closes_it(client, transport, fake):
    first = client.post("/api/ado/connect", json=_body())
    second = client.post("/api/ado/connect", json=_body())

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert len(transport.clients) == 2
    assert transport.clients[0] is not transport.clients[1]
    assert all(c.is_closed for c in transport.clients)
    for kwargs in transport.kwargs:
        assert kwargs["follow_redirects"] is False
        assert kwargs["timeout"] == 30.0
    assert len(fake.requests) == 4


def test_timeout_comes_from_the_environment(env_settings, client, transport):
    env_settings(ADO_TIMEOUT_SECONDS="7.5")
    assert client.post("/api/ado/connect", json=_body()).status_code == 200
    assert transport.kwargs[0]["timeout"] == 7.5
    assert transport.clients[0].timeout.read == 7.5


def test_allowlist_comes_from_the_environment(env_settings, client, fake):
    env_settings(ADO_ALLOWED_HOSTS="tfs.example.com")

    refused = client.post("/api/ado/connect", json=_body())
    assert refused.status_code == 422
    assert refused.json() == {"errors": ["This Azure DevOps host is not allowed: dev.azure.com."]}
    assert fake.requests == []

    allowed = client.post(
        "/api/ado/connect",
        json=_body(source="onprem", projectUrl="https://TFS.example.com/Coll/Fabrikam%20Plant"),
    )
    assert allowed.status_code == 200
    assert allowed.json()["projectUrl"] == "https://tfs.example.com/Coll/Fabrikam%20Plant"
    assert {r.url.host for r in fake.requests} == {"tfs.example.com"}


def test_disallowed_host_never_builds_a_request(client, transport, fake):
    response = client.post("/api/ado/connect", json=_body(projectUrl="https://evil.example.com/a/b"))
    assert response.status_code == 422
    assert fake.requests == []
    # The per-request client may be constructed, but nothing is sent through it.
    assert all(c.is_closed for c in transport.clients)


def test_full_success_payload_through_the_real_stack(client, fake):
    response = client.post("/api/ado/connect", json=_body())
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    data = response.json()
    assert data["project"] == {"id": PROJECT_ID, "name": PROJECT_NAME}
    assert data["projectUrl"] == CLOUD_URL
    assert "finishDate" not in data["areas"]
    assert all("finishDate" not in child for child in data["areas"]["children"])
    assert data["iterations"]["finishDate"] == ""
    sprint_paths = [c["path"] for c in data["iterations"]["children"][0]["children"]]
    assert sprint_paths == [f"{PROJECT_NAME}\\Phase 1\\Sprint 02", f"{PROJECT_NAME}\\Phase 1\\Sprint 01"]
    # Second call uses the canonical name and $depth=50.
    nodes_request = fake.requests[1]
    assert nodes_request.url.raw_path.startswith(b"/contoso/Fabrikam%20Plant/_apis/wit/classificationnodes?")
    assert nodes_request.url.params["$depth"] == "50"
    assert nodes_request.headers["Accept"] == "application/json"
    _assert_no_pat(response.text)


def test_visualstudio_cloud_form_end_to_end(client, fake):
    response = client.post(
        "/api/ado/connect",
        json=_body(projectUrl="https://Contoso.VisualStudio.com/Fabrikam%20Plant/_workitems/recentlyupdated/"),
    )
    assert response.status_code == 200
    assert response.json()["projectUrl"] == "https://contoso.visualstudio.com/Fabrikam%20Plant"
    assert fake.requests[0].url.raw_path.startswith(b"/_apis/projects/Fabrikam%20Plant?")


def test_onprem_port_is_kept_on_every_request(client, fake):
    url = f"https://{ONPREM_HOST}:8443/ImplementationProjects/Fabrikam%20Plant"
    response = client.post("/api/ado/connect", json=_body(source="onprem", projectUrl=url))
    assert response.status_code == 200
    assert response.json()["projectUrl"] == url
    assert {(r.url.host, r.url.port) for r in fake.requests} == {(ONPREM_HOST, 8443)}


def test_unicode_project_name_round_trips(client, fake):
    name = "Ünïcode Plant & Co #1"
    fake.project_name = name
    fake.nodes = classification_nodes(name)
    response = client.post(
        "/api/ado/connect",
        json=_body(projectUrl="https://dev.azure.com/contoso/%C3%9Cn%C3%AFcode%20Plant%20%26%20Co%20%231"),
    )
    assert response.status_code == 200
    data = response.json()
    assert data["project"]["name"] == name
    assert data["projectUrl"] == "https://dev.azure.com/contoso/%C3%9Cn%C3%AFcode%20Plant%20%26%20Co%20%231"
    assert data["areas"]["children"][0]["path"] == f"{name}\\Team A"
    # Reserved characters never leak into the path structure / query.
    assert all("&" not in r.url.raw_path.decode().split("?")[0] for r in fake.requests)


def test_each_request_uses_only_its_own_pat(client, fake):
    other = "another-fake-pat-zzz"
    client.post("/api/ado/connect", json=_body())
    client.post("/api/ado/connect", json=_body(pat=other))
    auths = [r.headers["Authorization"] for r in fake.requests]
    expected_first = "Basic " + PAT_B64
    expected_second = "Basic " + base64.b64encode(f":{other}".encode()).decode()
    assert auths == [expected_first, expected_first, expected_second, expected_second]


# --- redirects / SSRF ----------------------------------------------------------


def test_redirect_to_another_host_is_not_followed(client, transport):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data"})

    transport.handler = handler
    response = client.post("/api/ado/connect", json=_body())
    assert response.status_code == 422
    assert response.json() == {"errors": [PAT_REJECTED]}
    assert [r.url.host for r in seen] == ["dev.azure.com"]


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.com\\.visualstudio.com/a/b",
        "https://evil.com%2f.visualstudio.com/a/b",
        "https://evil.com%23.visualstudio.com/a/b",
        "https://evil.com\\@dev.azure.com/a/b",
        "https://user:pw@dev.azure.com/a/b",
        "https://dev.azure.com@evil.com/a/b",
        "https://evil.com#@dev.azure.com/a/b",
        "https://evil.com?.visualstudio.com/a/b",
        "https://dev.azure.com./a/b",
        "https://dev.azure.com.evil.com/a/b",
        "https://evil。com.visualstudio.com/a/b",
        "https://evil.com℀.visualstudio.com/a/b",
    ],
)
def test_odd_hosts_never_reach_a_host_outside_the_allowlist(client, fake, url):
    response = client.post("/api/ado/connect", json=_body(source="onprem", projectUrl=url))
    assert response.status_code in (200, 422)
    for request in fake.requests:
        host = request.url.host
        assert host == "dev.azure.com" or host.endswith(".visualstudio.com"), host
    _assert_no_pat(response.text)


@pytest.mark.parametrize(
    "url",
    [
        "https://xn--zz.visualstudio.com/Coll/Proj",  # invalid punycode label (IDNAError)
        "https://x\u0000.visualstudio.com/Coll/Proj",  # NUL in host (httpx.InvalidURL)
    ],
)
def test_malformed_host_under_a_wildcard_is_a_422_not_a_500(lenient_client, url):
    # API contract: every failure is 422 {errors: [str]}.
    response = lenient_client.post("/api/ado/connect", json=_body(source="onprem", projectUrl=url))
    assert response.status_code == 422, response.text
    assert len(response.json()["errors"]) == 1
    _assert_no_pat(response.text)


def test_undecodable_response_body_is_a_422_not_a_500(lenient_client, transport):
    # A proxy that claims gzip but sends garbage makes httpx raise
    # httpx.DecodingError (a RequestError, not a TransportError).
    transport.handler = lambda request: httpx.Response(
        200, headers={"Content-Encoding": "gzip", "Content-Type": "application/json"}, content=b"not gzip"
    )
    response = lenient_client.post("/api/ado/connect", json=_body())
    assert response.status_code == 422, response.text
    _assert_no_pat(response.text)


# --- request body handling ---------------------------------------------------------


def test_form_encoded_body_gets_the_field_messages(client, fake):
    response = client.post("/api/ado/connect", data={"source": "cloud", "projectUrl": CLOUD_URL, "pat": FAKE_PAT})
    assert response.status_code == 422
    assert len(response.json()["errors"]) == 2  # source and URL; the PAT is optional now
    assert fake.requests == []
    _assert_no_pat(response.text)


def test_json_without_content_type_is_still_read(client):
    import json

    response = client.post("/api/ado/connect", content=json.dumps(_body()).encode())
    assert response.status_code == 200


def test_extra_fields_are_ignored_and_not_echoed(client):
    response = client.post("/api/ado/connect", json=_body(extra="SHOULD-NOT-ECHO", pat=FAKE_PAT))
    assert response.status_code == 200
    assert "SHOULD-NOT-ECHO" not in response.text


def test_get_is_not_allowed(client):
    assert client.get("/api/ado/connect").status_code == 405


# --- PAT hygiene in logs ------------------------------------------------------------


@pytest.mark.parametrize("failures", [{}, {"projects": "401"}, {"projects": "500"}, {"nodes": "timeout"}])
def test_pat_never_appears_in_logs(client, fake, caplog, failures):
    fake.failures = failures
    with caplog.at_level(logging.DEBUG):
        response = client.post("/api/ado/connect", json=_body())
    assert response.status_code in (200, 422)
    _assert_no_pat(caplog.text)
    _assert_no_pat(response.text)


# --- OpenAPI + interplay with the existing routes -------------------------------------


def test_openapi_documents_the_connect_route(client):
    spec = client.get("/openapi.json").json()
    operation = spec["paths"]["/api/ado/connect"]["post"]
    body_schema = operation["requestBody"]["content"]["application/json"]["schema"]
    assert set(body_schema["required"]) == {"source", "projectUrl"}
    assert body_schema["properties"]["source"]["enum"] == ["onprem", "cloud"]
    assert any(option.get("writeOnly") for option in body_schema["properties"]["pat"]["anyOf"])
    assert operation["responses"]["422"]["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorResponse")
    response_ref = operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    response_schema = spec["components"]["schemas"][response_ref.rsplit("/", 1)[-1]]
    assert set(response_schema["required"]) == {"project", "projectUrl", "areas", "iterations"}
    tree = spec["components"]["schemas"]["AdoTreeNode"]
    assert {"name", "path", "finishDate", "children"} <= set(tree["properties"])
    # The PAT must not be part of any response schema.
    assert "pat" not in str(spec["components"]["schemas"].get("AdoConnectResponse"))


def test_existing_routes_unaffected(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    simulate = client.post("/api/simulate", json={})
    assert simulate.status_code == 422
    assert set(simulate.json()) == {"errors"}
    assert all(isinstance(e, str) for e in simulate.json()["errors"])
    validate = client.post("/api/validate", data={})
    assert validate.status_code == 422
    assert set(validate.json()) == {"errors"}


def test_unknown_ado_route_is_404(client):
    assert client.post("/api/ado/nope", json=_body()).status_code == 404


# --- cycle 2: edge cases around the host-syntax / error-mapping fix -------------------


def _post_raw(client, raw_json: str):
    """POST a hand-written JSON text, so escapes like `\\ud800` (valid JSON, a
    lone surrogate once decoded) reach the route untouched."""
    return client.post("/api/ado/connect", content=raw_json.encode(), headers={"content-type": "application/json"})


@pytest.mark.parametrize(
    "project_url, pat",
    [
        ("https://dev.azure.com/contoso/Fab\\ud800rikam", FAKE_PAT),  # lone surrogate in the project
        ("https://dev.azure.com/con\\ud800toso/Fabrikam%20Plant", FAKE_PAT),  # ... in the organization
        (CLOUD_URL, "fake-pat-\\ud800"),  # ... in the PAT
    ],
    ids=["project", "organization", "pat"],
)
def test_lone_surrogate_in_body_is_a_422_not_a_500(lenient_client, fake, project_url, pat):
    # API contract: every failure is 422 {errors: [str]}. A JSON "\ud800"
    # escape is valid JSON but cannot be UTF-8 encoded (quote() and the
    # base64 of the PAT raise UnicodeEncodeError).
    raw = '{"source": "cloud", "projectUrl": "%s", "pat": "%s"}' % (project_url, pat)
    response = _post_raw(lenient_client, raw)
    assert response.status_code == 422, response.text
    assert len(response.json()["errors"]) == 1
    assert fake.requests == []


def test_lone_surrogate_in_host_is_the_shape_message(client, fake):
    raw = '{"source": "onprem", "projectUrl": "https://a\\ud800.visualstudio.com/c/p", "pat": "x"}'
    response = _post_raw(client, raw)
    assert response.status_code == 422
    assert response.json() == {"errors": ["On-Prem URLs look like https://<server>/<collection>/<project>."]}
    assert fake.requests == []


@pytest.mark.parametrize(
    "url, expected_org",
    [
        ("https://dev.azure.com/o%ZZ/Fabrikam%20Plant", "o%25ZZ"),  # stray % is re-encoded
        ("https://dev.azure.com/o%3F%23/Fabrikam%20Plant", "o%3F%23"),  # ? and # stay in the path
        ("https://dev.azure.com/a%5C..%5Cb/Fabrikam%20Plant", "a%5C..%5Cb"),  # backslashes stay encoded
    ],
)
def test_odd_encodings_stay_inside_one_path_segment(client, fake, url, expected_org):
    response = client.post("/api/ado/connect", json=_body(projectUrl=url))
    assert response.status_code == 200
    assert fake.requests
    for request in fake.requests:
        assert request.url.host == "dev.azure.com"
        assert request.url.raw_path.startswith(f"/{expected_org}/".encode())
        assert list(request.url.params.keys())[-1] == "api-version"


def test_control_characters_stripped_by_urlsplit_do_not_change_the_called_host(client, fake):
    # urlsplit drops \t; the allowlist check and the request use the same host.
    response = client.post("/api/ado/connect", json=_body(projectUrl="https://dev.azu\tre.com/contoso/Fabrikam%20Plant"))
    assert response.status_code == 200
    assert {r.url.host for r in fake.requests} == {"dev.azure.com"}


def test_idna_mapped_host_is_checked_and_called_in_its_ascii_form(client, fake):
    response = client.post(
        "/api/ado/connect",
        json=_body(source="onprem", projectUrl="https://STRAßE.visualstudio.com/Coll/Fabrikam%20Plant"),
    )
    assert response.status_code == 200
    assert {r.url.host for r in fake.requests} == {"strasse.visualstudio.com"}


@pytest.mark.parametrize(
    "url",
    [
        "https://dev.azure.com:99999/contoso/p",  # out-of-range port
        "https://dev.azure.com:+443/contoso/p",  # non-numeric port
        "https://[::1]/contoso/p",  # IPv6 literal
        "https://dev.azure.com/contoso/%2E%2E",  # encoded dot segment
    ],
)
def test_malformed_urls_are_the_shape_message_without_a_request(client, fake, url):
    response = client.post("/api/ado/connect", json=_body(projectUrl=url))
    assert response.status_code == 422
    assert response.json() == {
        "errors": ["Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>."]
    }
    assert fake.requests == []


def test_url_too_long_for_httpx_is_a_422(lenient_client, fake):
    url = "https://dev.azure.com/" + "a" * 70000 + "/Fabrikam%20Plant"
    response = lenient_client.post("/api/ado/connect", json=_body(projectUrl=url))
    assert response.status_code == 422
    assert len(response.json()["errors"]) == 1
    _assert_no_pat(response.text)


def _nested_nodes_json(depth: int) -> bytes:
    node = '{"name":"x","path":"\\\\P\\\\Area\\\\x"}'
    for _ in range(depth):
        node = '{"name":"x","path":"\\\\P\\\\Area\\\\x","children":[' + node + "]}"
    area = node[:-1] + ',"structureType":"area"}'
    iteration = '{"name":"P","path":"\\\\P\\\\Iteration","structureType":"iteration"}'
    return ('{"value":[' + area + "," + iteration + "]}").encode()


def _serve_nodes(transport, body: bytes):
    def handler(request):
        if "/_apis/projects/" in request.url.path:
            return httpx.Response(200, json={"id": PROJECT_ID, "name": "P"})
        return httpx.Response(200, content=body, headers={"Content-Type": "application/json"})

    transport.handler = handler


def test_classification_tree_at_the_requested_depth_is_returned(client, transport):
    _serve_nodes(transport, _nested_nodes_json(60))
    response = client.post("/api/ado/connect", json=_body())
    assert response.status_code == 200
    depth, node = 0, response.json()["areas"]
    while node["children"]:
        depth, node = depth + 1, node["children"][0]
    assert depth == 60
    assert node["path"] == "P\\x"


def test_absurdly_deep_classification_tree_is_a_422_not_a_500(lenient_client, transport):
    # Only a hostile/broken allowlisted host can send this ($depth=50 caps real ADO).
    _serve_nodes(transport, _nested_nodes_json(3000))
    response = lenient_client.post("/api/ado/connect", json=_body())
    assert response.status_code == 422


# --- cycle 3: non-encodable / control / deep input through the full stack ------------

CLOUD_SHAPE_ERRORS = {"errors": ["Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>."]}
UNEXPECTED = {"errors": ["Azure DevOps returned an unexpected response."]}


def test_classification_tree_at_the_max_depth_bound_is_returned_and_one_deeper_is_a_422(client, transport):
    _serve_nodes(transport, _nested_nodes_json(100))
    at_bound = client.post("/api/ado/connect", json=_body())
    assert at_bound.status_code == 200, at_bound.text

    _serve_nodes(transport, _nested_nodes_json(101))
    too_deep = client.post("/api/ado/connect", json=_body())
    assert too_deep.status_code == 422
    assert too_deep.json() == UNEXPECTED


def test_request_body_nested_beyond_the_decoder_limit_gets_the_field_messages(lenient_client, fake):
    raw = "[" * 200_000 + "]" * 200_000
    response = _post_raw(lenient_client, raw)
    assert response.status_code == 422, response.text[:200]
    assert len(response.json()["errors"]) == 2
    assert fake.requests == []


@pytest.mark.parametrize(
    "url",
    [
        "https://dev.azure.com/contoso/Fab%00rikam",  # encoded NUL
        "https://dev.azure.com/con%0Atoso/Fabrikam",  # encoded newline
        "https://dev.azure.com/contoso/Fab%7Frikam",  # encoded DEL
        "https://dev.azure.com/contoso/Fab\u0001rikam",  # raw control char (not stripped by urlsplit)
        "https://dev.azure.com/contoso/%FF",  # invalid UTF-8
        "https://dev.azure.com/contoso/%C3",  # truncated UTF-8 sequence
        "https://dev.azure.com/contoso/%ED%A0%80",  # UTF-8-encoded surrogate
    ],
)
def test_unusable_path_segments_are_the_shape_message_without_a_request(client, fake, url):
    response = client.post("/api/ado/connect", json=_body(projectUrl=url))
    assert response.status_code == 422
    assert response.json() == CLOUD_SHAPE_ERRORS
    assert fake.requests == []


@pytest.mark.parametrize("pat", ["fake\u0000pat", "fake\npat", "fake\tpat", "fake\u007fpat"])
def test_pat_with_control_characters_is_rejected_without_a_request(client, fake, pat):
    response = client.post("/api/ado/connect", json=_body(pat=pat))
    assert response.status_code == 422
    assert response.json() == {"errors": [PAT_REJECTED]}
    assert fake.requests == []


def test_pat_with_lone_surrogate_gets_the_pat_message(client, fake):
    raw = '{"source": "cloud", "projectUrl": "%s", "pat": "fake-pat-\\udfff"}' % CLOUD_URL
    response = _post_raw(client, raw)
    assert response.status_code == 422
    assert response.json() == {"errors": [PAT_REJECTED]}
    assert fake.requests == []


def test_non_ascii_pat_is_trimmed_and_sent_utf8_base64(client, fake):
    response = client.post("/api/ado/connect", json=_body(pat="  pät-ünï  "))
    assert response.status_code == 200
    expected = "Basic " + base64.b64encode(":pät-ünï".encode()).decode()
    assert {r.headers["Authorization"] for r in fake.requests} == {expected}


def _raw_json_handler(project_json: str, nodes_json: str | None = None):
    def handler(request):
        if "/_apis/projects/" in request.url.path:
            return httpx.Response(200, content=project_json.encode(), headers={"Content-Type": "application/json"})
        if nodes_json is None:
            return httpx.Response(200, json=classification_nodes("P"))
        return httpx.Response(200, content=nodes_json.encode(), headers={"Content-Type": "application/json"})

    return handler


def test_ado_project_name_with_lone_surrogate_is_unexpected_response(lenient_client, transport):
    transport.handler = _raw_json_handler('{"id": "g", "name": "P\\ud800"}')
    response = lenient_client.post("/api/ado/connect", json=_body())
    assert response.status_code == 422, response.text
    assert response.json() == UNEXPECTED


def test_ado_node_name_with_lone_surrogate_is_unexpected_response(lenient_client, transport):
    nodes = (
        '{"value":[{"name":"P\\udc00","path":"\\\\P\\\\Area","structureType":"area"},'
        '{"name":"P","path":"\\\\P\\\\Iteration","structureType":"iteration"}]}'
    )
    transport.handler = _raw_json_handler('{"id": "g", "name": "P"}', nodes)
    response = lenient_client.post("/api/ado/connect", json=_body())
    assert response.status_code == 422, response.text
    assert response.json() == UNEXPECTED


def test_ado_finish_date_with_lone_surrogate_becomes_blank(client, transport):
    nodes = (
        '{"value":[{"name":"P","path":"\\\\P\\\\Area","structureType":"area"},'
        '{"name":"P","path":"\\\\P\\\\Iteration","structureType":"iteration",'
        '"attributes":{"finishDate":"2026\\ud800-01-01"}}]}'
    )
    transport.handler = _raw_json_handler('{"id": "g", "name": "P"}', nodes)
    response = client.post("/api/ado/connect", json=_body())
    assert response.status_code == 200
    assert response.json()["iterations"]["finishDate"] == ""


def test_ado_error_message_with_lone_surrogate_is_dropped(lenient_client, transport):
    transport.handler = lambda request: httpx.Response(
        500, content=b'{"message": "boom \\ud800"}', headers={"Content-Type": "application/json"}
    )
    response = lenient_client.post("/api/ado/connect", json=_body())
    assert response.status_code == 422, response.text
    assert response.json() == {"errors": ["Azure DevOps returned an error (HTTP 500)."]}


# --- Phase 2: POST /api/ado/backlog through the real dependency chain -------------------

WORK_ITEM_KEYS = {"id", "type", "title", "state", "description", "size", "iterationPath", "parentId"}
BACKLOG_KEYS = {"project", "projectUrl", "scope", "fetchedAt", "workItems", "iterations", "warnings"}
TEAM_A = f"{PROJECT_NAME}\\Team A"


def _find_node(node: dict, name: str) -> dict | None:
    if node["name"] == name:
        return node
    for child in node["children"]:
        found = _find_node(child, name)
        if found:
            return found
    return None


def _flatten(node: dict) -> list[dict]:
    """What the client expects in `backlog.iterations`: every node below the root."""
    out = []
    for child in node["children"]:
        out.append({"path": child["path"], "finishDate": child["finishDate"]})
        out.extend(_flatten(child))
    return out


def test_connect_then_backlog_flow_feeds_the_client_shape(client, transport, fake):
    connected = client.post("/api/ado/connect", json=_body())
    assert connected.status_code == 200
    tree = connected.json()
    team_a = _find_node(tree["areas"], "Team A")
    assert team_a["path"] == TEAM_A

    # The client posts the connect body + the node path the user picked in the tree.
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=team_a["path"]))
    assert response.status_code == 200, response.text
    data = response.json()

    assert set(data) == BACKLOG_KEYS
    assert data["project"] == tree["project"]
    assert data["projectUrl"] == tree["projectUrl"] == CLOUD_URL
    assert data["scope"] == f"Area Path: {TEAM_A}"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", data["fetchedAt"])
    # The iterations the board gets are exactly the connect tree flattened (root excluded).
    assert data["iterations"] == _flatten(tree["iterations"])

    items = data["workItems"]
    ids = [item["id"] for item in items]
    assert ids == sorted(ids) == [101, 102, 103, 104, 105, 201]
    for item in items:
        assert set(item) == WORK_ITEM_KEYS
        assert isinstance(item["id"], int)
        assert item["type"] in ("Epic", "Feature")
        for key in ("type", "title", "state", "description", "size", "iterationPath"):
            assert isinstance(item[key], str)
        assert item["parentId"] is None or isinstance(item["parentId"], int)
        # Every iterationPath is the project root or one of the returned iterations
        # (so the Sprints mode switch can resolve it).
        assert item["iterationPath"] in {PROJECT_NAME} | {i["path"] for i in data["iterations"]}
    by_id = {item["id"]: item for item in items}
    assert by_id[102]["size"] == "M"
    assert by_id[102]["parentId"] == 101
    assert by_id[103]["parentId"] == 201 and by_id[201]["type"] == "Epic"  # out-of-scope parent Epic
    assert by_id[104]["parentId"] is None and by_id[104]["description"] == ""
    assert by_id[105]["parentId"] == 301 and 301 not in by_id  # non-Epic parent not included
    assert by_id[101]["description"] == "<p>Platform epic</p>"
    assert data["warnings"] == []
    # Round-trips through the server's own response model unchanged.
    assert AdoBacklogResponse.model_validate(data).model_dump(by_alias=True) == data

    # Two independent requests, two clients, both closed; the PAT never leaves the header.
    assert len(transport.clients) == 2 and all(c.is_closed for c in transport.clients)
    for request in fake.requests:
        assert request.headers["Authorization"] == f"Basic {PAT_B64}"
        assert request.url.params["api-version"] == "7.0"
        assert FAKE_PAT not in str(request.url) and FAKE_PAT.encode() not in request.content
    _assert_no_pat(response.text)


def test_backlog_request_sequence_and_encoded_paths(client, fake):
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code == 200
    calls = [(r.method, r.url.raw_path.split(b"?")[0]) for r in fake.requests]
    assert calls == [
        ("GET", b"/contoso/_apis/projects/Fabrikam%20Plant"),
        ("GET", b"/contoso/Fabrikam%20Plant/_apis/wit/classificationnodes"),
        ("GET", b"/contoso/_apis/wit/fields/Custom.EstimatedSize"),
        ("GET", b"/contoso/_apis/wit/fields/Custom.FeatureSize"),
        ("POST", b"/contoso/Fabrikam%20Plant/_apis/wit/wiql"),
        ("POST", b"/contoso/Fabrikam%20Plant/_apis/wit/workitemsbatch"),
        ("POST", b"/contoso/Fabrikam%20Plant/_apis/wit/workitemsbatch"),  # parent completion
    ]
    assert fake.requests_to("wiql")[0].url.params["$top"] == "20000"
    assert f"[System.AreaPath] UNDER '{TEAM_A}'" in fake.wiql_queries()[0]
    assert [b["ids"] for b in fake.batch_bodies()] == [[101, 102, 103, 104, 105], [201, 301]]
    assert all(b["errorPolicy"] == "omit" and "Custom.EstimatedSize" in b["fields"] for b in fake.batch_bodies())


def test_iteration_scope_flow_uses_a_path_from_the_connect_tree(client, fake):
    tree = client.post("/api/ado/connect", json=_body()).json()
    sprint = _find_node(tree["iterations"], "Sprint 02")
    response = client.post("/api/ado/backlog", json=_body(scopeType="iteration", scopePath=sprint["path"]))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["scope"] == f"Iteration Path: {PROJECT_NAME}\\Phase 1\\Sprint 02"
    assert f"[System.IterationPath] UNDER '{PROJECT_NAME}\\Phase 1\\Sprint 02'" in fake.wiql_queries()[0]
    # 102 is in Sprint 02; its parent Epic 101 (outside that iteration) is completed.
    assert [i["id"] for i in data["workItems"]] == [101, 102]


def test_backlog_allowlist_comes_from_the_environment(env_settings, client, fake):
    env_settings(ADO_ALLOWED_HOSTS=" *.Example.ORG , tfs.example.com ")
    scope = {"scopeType": "area", "scopePath": TEAM_A}

    refused = client.post("/api/ado/backlog", json=_body(**scope))
    assert refused.status_code == 422
    assert refused.json() == {"errors": ["This Azure DevOps host is not allowed: dev.azure.com."]}
    assert fake.requests == []

    onprem = client.post(
        "/api/ado/backlog",
        json=_body(source="onprem", projectUrl="https://tfs.example.com/Coll/Fabrikam%20Plant", **scope),
    )
    assert onprem.status_code == 200, onprem.text
    assert onprem.json()["projectUrl"] == "https://tfs.example.com/Coll/Fabrikam%20Plant"

    wildcard = client.post(
        "/api/ado/backlog",
        json=_body(source="onprem", projectUrl="https://ado.example.org/Coll/Fabrikam%20Plant", **scope),
    )
    assert wildcard.status_code == 200, wildcard.text
    assert {r.url.host for r in fake.requests} == {"tfs.example.com", "ado.example.org"}

    bare = client.post(
        "/api/ado/backlog",
        json=_body(source="onprem", projectUrl="https://example.org/Coll/Fabrikam%20Plant", **scope),
    )
    assert bare.json() == {"errors": ["This Azure DevOps host is not allowed: example.org."]}


def test_backlog_default_allowlist_refuses_other_hosts_without_a_request(client, transport, fake):
    response = client.post(
        "/api/ado/backlog",
        json=_body(projectUrl="https://evil.example.com/a/b", scopeType="area", scopePath="b"),
    )
    assert response.status_code == 422
    assert response.json() == {"errors": ["This Azure DevOps host is not allowed: evil.example.com."]}
    assert fake.requests == []
    assert all(c.is_closed for c in transport.clients)


def test_backlog_field_errors_come_before_the_allowlist_and_any_request(client, fake):
    response = client.post(
        "/api/ado/backlog", json={"projectUrl": "https://evil.example.com/a/b", "pat": " ", "scopeType": "team"}
    )
    assert response.status_code == 422
    assert response.json() == {
        "errors": [
            "Choose the Azure DevOps source (On-Prem or Collaboration Hub).",
            "Choose an Area path or an Iteration path.",
        ]
    }
    assert fake.requests == []


def test_backlog_timeout_comes_from_the_environment(env_settings, client, transport):
    env_settings(ADO_TIMEOUT_SECONDS="12")
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=PROJECT_NAME))
    assert response.status_code == 200
    assert transport.kwargs[0] == {"timeout": 12.0, "follow_redirects": False, "verify": False}


def test_large_backlog_is_chunked_through_the_real_stack(client, fake):
    epics = [work_item(i, "Epic", f"E{i}", "Team A") for i in range(1, 6)]
    features = [work_item(1000 + i, "Feature", f"F{i}", "Team A", parent=1 + i % 5, size=" s ") for i in range(445)]
    fake.work_items = epics + features
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code == 200
    items = response.json()["workItems"]
    assert len(items) == 450
    assert [i["id"] for i in items] == sorted(i["id"] for i in items)
    assert {i["size"] for i in items if i["type"] == "Feature"} == {"S"}
    # Every parent is in scope, so there is no parent-completion call.
    assert [len(b["ids"]) for b in fake.batch_bodies()] == [200, 200, 50]


def test_backlog_without_size_field_through_the_real_stack(client, fake):
    fake.size_field = False
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=PROJECT_NAME))
    assert response.status_code == 200
    data = response.json()
    assert data["warnings"] == [
        "Neither Custom.EstimatedSize nor Custom.FeatureSize exists in this project; sizes are empty."
    ]
    assert {i["size"] for i in data["workItems"]} == {""}
    assert all("Custom.EstimatedSize" not in b["fields"] for b in fake.batch_bodies())


# --- size fields: Custom.EstimatedSize (1st), then Custom.FeatureSize (2nd) -------------

ESTIMATED = "Custom.EstimatedSize"
FEATURE = "Custom.FeatureSize"
NEITHER_WARNING = "Neither Custom.EstimatedSize nor Custom.FeatureSize exists in this project; sizes are empty."


def _mixed_size_backlog() -> list[dict]:
    """Epic 1 with Features 2-9 in Team A, covering the value combinations an
    ADO project with both fields can return (Epic 1 and its in-scope parent link
    exercise the size on an Epic too)."""
    return [
        work_item(1, "Epic", "Epic with feature size", "Team A", feature_size=" xl "),
        work_item(2, "Feature", "Both set", "Team A", parent=1, size=" m ", feature_size="xl"),
        work_item(3, "Feature", "Feature size only", "Team A", parent=1, feature_size=" s "),
        work_item(4, "Feature", "Whitespace estimated", "Team A", parent=1, size=" \t ", feature_size="l"),
        work_item(5, "Feature", "Float estimated", "Team A", parent=1, size=3.5, feature_size="xs"),
        work_item(6, "Feature", "Bool estimated, int feature", "Team A", parent=1, size=True, feature_size=13),
        work_item(7, "Feature", "Object estimated", "Team A", parent=1, size={"v": "M"}, feature_size=["L"]),
        work_item(8, "Feature", "Estimated only", "Team A", parent=1, size="l"),
        work_item(9, "Feature", "Neither set", "Team A", parent=1),
        work_item(10, "Feature", "Odd feature size", "Team A", parent=1, feature_size=2.0),
    ]


def _sizes(data: dict) -> dict[int, str]:
    return {item["id"]: item["size"] for item in data["workItems"]}


def test_backlog_only_feature_size_exists_through_the_real_stack(client, fake):
    fake.size_fields = {FEATURE}
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["warnings"] == []
    # The synthetic backlog stores its sizes in EstimatedSize, which this project lacks.
    assert set(_sizes(data).values()) == {""}

    fake.work_items = _mixed_size_backlog()
    fake.requests.clear()
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["warnings"] == []
    assert _sizes(data) == {1: "XL", 2: "XL", 3: "S", 4: "L", 5: "XS", 6: "13", 7: "", 8: "", 9: "", 10: ""}
    # Both fields are checked, only the existing one is requested.
    assert [r.url.path.rsplit("/", 1)[-1] for r in fake.requests_to("fields")] == [ESTIMATED, FEATURE]
    for body in fake.batch_bodies():
        assert FEATURE in body["fields"] and ESTIMATED not in body["fields"]
    assert AdoBacklogResponse.model_validate(data).model_dump(by_alias=True) == data


def test_backlog_both_size_fields_with_mixed_values_through_the_real_stack(client, fake):
    fake.size_fields = {ESTIMATED, FEATURE}
    fake.work_items = _mixed_size_backlog()
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["warnings"] == []
    # EstimatedSize wins when non-blank (2, 8); blank / whitespace / non-string values
    # fall through to FeatureSize (3-6, Epic 1); unusable in both → "" (7, 9, 10).
    assert _sizes(data) == {1: "XL", 2: "M", 3: "S", 4: "L", 5: "XS", 6: "13", 7: "", 8: "L", 9: "", 10: ""}
    for body in fake.batch_bodies():
        assert body["fields"][-2:] == [ESTIMATED, FEATURE]


def test_backlog_both_size_fields_reach_completed_parent_epics(client, fake):
    # The out-of-scope parent Epic comes from the parent-completion batch, which
    # must request (and read) the same size fields.
    fake.size_fields = {ESTIMATED, FEATURE}
    fake.work_items = [
        work_item(50, "Epic", "Parent in Team B", "Team B", feature_size="m"),
        work_item(51, "Feature", "Child in Team A", "Team A", parent=50, feature_size=" s "),
    ]
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code == 200, response.text
    assert _sizes(response.json()) == {50: "M", 51: "S"}
    bodies = fake.batch_bodies()
    assert [b["ids"] for b in bodies] == [[51], [50]]
    assert all(b["fields"][-2:] == [ESTIMATED, FEATURE] for b in bodies)


def test_backlog_neither_size_field_exists_through_the_real_stack(client, fake):
    fake.size_fields = set()
    fake.work_items = _mixed_size_backlog()
    response = client.post("/api/ado/backlog", json=_body(scopeType="iteration", scopePath=PROJECT_NAME))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["warnings"] == [NEITHER_WARNING]
    assert len(data["workItems"]) == 10
    assert set(_sizes(data).values()) == {""}
    assert [r.url.path.rsplit("/", 1)[-1] for r in fake.requests_to("fields")] == [ESTIMATED, FEATURE]
    assert all(not {ESTIMATED, FEATURE} & set(b["fields"]) for b in fake.batch_bodies())


def test_backlog_neither_warning_comes_before_the_cap_warning(client, fake):
    fake.size_fields = set()
    fake.wiql_ids = list(range(1, 20001))
    fake.work_items = []
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code == 200, response.text
    assert response.json()["warnings"] == [
        NEITHER_WARNING,
        "Only the first 20000 work items were loaded; narrow the scope.",
    ]


@pytest.mark.parametrize(
    "kind, expected",
    [
        ("401", PAT_REJECTED),
        ("500", "Azure DevOps returned an error (HTTP 500). Something broke on the server."),
        ("502", "Azure DevOps returned an error (HTTP 502)."),
        ("timeout", "Could not reach Azure DevOps at dev.azure.com."),
        ("non_json", PAT_REJECTED),
    ],
)
def test_feature_size_check_failure_is_a_422_even_when_estimated_size_exists(
    lenient_client, transport, fake, caplog, kind, expected
):
    # Only a 404 means "absent"; anything else fails the whole request (contract).
    from ado_fakes import error_response

    def handler(request):
        if request.url.path.endswith(f"/_apis/wit/fields/{FEATURE}"):
            fake.requests.append(request)
            return error_response(kind, request)
        return fake(request)

    transport.handler = handler
    with caplog.at_level(logging.DEBUG):
        response = lenient_client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code == 422, response.text
    assert response.json() == {"errors": [expected]}
    assert fake.requests_to("wiql") == [] and fake.requests_to("batch") == []
    assert all(c.is_closed for c in transport.clients)
    _assert_no_pat(caplog.text)
    _assert_no_pat(response.text)


@pytest.mark.parametrize(
    "size_json, expected_size",
    [
        ('"Custom.FeatureSize": 1' + "0" * 5000, ""),  # integer beyond int max str digits
        ('"Custom.FeatureSize": " s\\ud800 "', "S?"),  # lone surrogate is replaced, like other text
        ('"Custom.FeatureSize": 1e400', ""),  # float overflow → inf
        ('"Custom.FeatureSize": NaN', ""),
        ('"Custom.FeatureSize": {"a": [1, 2, {"b": null}]}', ""),
        ('"Custom.EstimatedSize": null, "Custom.FeatureSize": false', ""),
    ],
    ids=["huge-int", "lone-surrogate", "float-overflow", "nan", "object", "null-and-false"],
)
def test_odd_feature_size_payloads_are_never_a_500(lenient_client, transport, size_json, expected_size):
    inner = FakeAdo(size_fields={ESTIMATED, FEATURE})

    def handler(request):
        if request.url.path.endswith("/workitemsbatch"):
            content = '{"value": [{"id": 101, "fields": {"System.WorkItemType": "Feature", %s}}]}' % size_json
            return httpx.Response(200, content=content.encode(), headers={"Content-Type": "application/json"})
        return inner(request)

    transport.handler = handler
    response = lenient_client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=TEAM_A))
    assert response.status_code in (200, 422), response.text
    if response.status_code == 200:
        assert [i["size"] for i in response.json()["workItems"]] == [expected_size]
    else:
        assert response.json() == UNEXPECTED


@pytest.mark.parametrize(
    "failures",
    [{}, {"fields": "401"}, {"wiql": "500"}, {"batch": "timeout"}, {"batch": "203"}, {"nodes": "404"}],
)
def test_backlog_pat_never_appears_in_logs_or_responses(client, fake, caplog, failures):
    fake.failures = failures
    with caplog.at_level(logging.DEBUG):
        response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=PROJECT_NAME))
    assert response.status_code == (422 if failures else 200)
    if failures:
        assert set(response.json()) == {"errors"} and len(response.json()["errors"]) == 1
    _assert_no_pat(caplog.text)
    _assert_no_pat(response.text)


@pytest.mark.parametrize(
    "batch_body",
    [
        b"",
        b"[]",
        b'{"value": {}}',
        b'{"value": [{"id": 101}]}',
        b'{"value": [{"id": 101, "fields": []}]}',
        b'{"value": [' * 3000,
        b'{"value": [{"id": 101, "fields": {"System.WorkItemType": "Epic", "System.Title": "x\\ud800"}}]}',
    ],
)
def test_malformed_batch_payload_is_never_a_500(lenient_client, transport, batch_body):
    inner = FakeAdo()

    def handler(request):
        if request.url.path.endswith("/workitemsbatch"):
            return httpx.Response(200, content=batch_body, headers={"Content-Type": "application/json"})
        return inner(request)

    transport.handler = handler
    response = lenient_client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=PROJECT_NAME))
    assert response.status_code in (200, 422), response.text
    if response.status_code == 422:
        assert set(response.json()) == {"errors"}


def test_scope_path_injection_never_reaches_the_wiql(client, fake):
    hostile = f"{PROJECT_NAME}' OR [System.Id] > 0 OR [System.AreaPath] UNDER '"
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=hostile))
    assert response.status_code == 422
    assert response.json() == {"errors": [f"Unknown Area path: {hostile}."]}
    assert fake.requests_to("wiql") == [] and fake.requests_to("batch") == []


def test_quoted_tree_node_is_escaped_in_the_wiql(client, fake):
    nodes = classification_nodes()
    nodes["value"][0]["children"].append(
        {"name": "O'Brien", "structureType": "area", "path": f"\\{PROJECT_NAME}\\Area\\O'Brien"}
    )
    fake.nodes = nodes
    response = client.post("/api/ado/backlog", json=_body(scopeType="area", scopePath=f"{PROJECT_NAME}\\o'brien"))
    assert response.status_code == 200, response.text
    assert response.json()["scope"] == f"Area Path: {PROJECT_NAME}\\O'Brien"
    assert f"UNDER '{PROJECT_NAME}\\O''Brien'" in fake.wiql_queries()[0]


def test_openapi_documents_the_backlog_route(client):
    spec = client.get("/openapi.json").json()
    operation = spec["paths"]["/api/ado/backlog"]["post"]
    body = operation["requestBody"]["content"]["application/json"]["schema"]
    assert set(body["required"]) == {"source", "projectUrl", "scopeType", "scopePath"}
    assert body["properties"]["scopeType"]["enum"] == ["area", "iteration"]
    assert any(option.get("writeOnly") for option in body["properties"]["pat"]["anyOf"])
    assert operation["responses"]["422"]["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorResponse")
    ref = operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    schema = spec["components"]["schemas"][ref.rsplit("/", 1)[-1]]
    assert set(schema["required"]) == BACKLOG_KEYS
    assert set(spec["components"]["schemas"]["AdoWorkItem"]["properties"]) == WORK_ITEM_KEYS
    assert "pat" not in str(schema)


def test_backlog_get_is_not_allowed(client):
    assert client.get("/api/ado/backlog").status_code == 405
