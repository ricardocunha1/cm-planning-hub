"""Unit tests for the saved-PAT fallback of the `/api/ado/*` routes: the
request's PAT always wins; without one the session user's saved PAT for the
canonical project URL is used. Handlers are called directly (no TestClient)."""
import asyncio
import base64
import json

import pytest
from cryptography.fernet import Fernet

from ado_fakes import FAKE_PAT, FakeAdo, mock_http_client
from app.api import ado_routes
from app.config import Settings
from app.schemas import AdoConnectRequest
from app.services import credentials
from app.services.ado_http import ado_client, request_pat, resolve_pat
from app.services.ado_url import (
    PAT_OR_SAVED_REQUIRED,
    PAT_REQUIRED,
    AdoUrlError,
    connection_field_errors,
)
from fake_session import FakeSession

KEY = Fernet.generate_key().decode()
SETTINGS = Settings(ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0, pat_encryption_key=KEY)
URL = "https://dev.azure.com/contoso/Fabrikam%20Plant"
SAVED_PAT = "saved-pat-0123456789"


def basic(pat: str) -> str:
    return "Basic " + base64.b64encode(f":{pat}".encode()).decode()


class StubRequest:
    def __init__(self, data) -> None:
        self.data = data

    async def json(self):
        return self.data


def saved_token(pat: str = SAVED_PAT, settings: Settings = SETTINGS) -> str:
    return credentials.encrypt_pat(settings, pat)


def connect(data, session, user_id=1, settings=SETTINGS):
    fake = FakeAdo()

    async def main():
        async with mock_http_client(fake) as http:
            return await ado_routes.connect(StubRequest(data), settings, http, session, user_id)

    return asyncio.run(main()), fake


def body(**overrides):
    data = {"source": "cloud", "projectUrl": URL}
    data.update(overrides)
    return data


def errors_of(response) -> list[str]:
    return json.loads(response.body)["errors"]


# --- connection_field_errors ----------------------------------------------------------


def test_pat_is_required_by_default_as_the_mcp_tools_need_it():
    assert connection_field_errors({"source": "cloud", "projectUrl": "u"}) == [PAT_REQUIRED]


@pytest.mark.parametrize("pat", [None, "", "  "])
def test_pat_can_be_absent_or_blank_when_not_required(pat):
    assert connection_field_errors({"source": "cloud", "projectUrl": "u", "pat": pat}, pat_required=False) == []
    assert connection_field_errors({"source": "cloud", "projectUrl": "u"}, pat_required=False) == []


@pytest.mark.parametrize("pat", [123, ["x"], {"a": 1}])
def test_a_non_string_pat_is_still_reported(pat):
    assert connection_field_errors({"source": "cloud", "projectUrl": "u", "pat": pat}, pat_required=False) == [
        PAT_REQUIRED
    ]


# --- ado_client / resolve_pat ---------------------------------------------------------


def request_of(**overrides) -> AdoConnectRequest:
    return AdoConnectRequest.model_validate({"source": "cloud", "projectUrl": URL, **overrides})


def test_ado_client_prefers_the_request_pat_over_the_resolved_one():
    http = object()
    _, client = ado_client(request_of(pat=f" {FAKE_PAT} "), SETTINGS, http, "resolved")  # type: ignore[arg-type]
    assert client._headers["Authorization"] == basic(FAKE_PAT)
    _, client = ado_client(request_of(), SETTINGS, http, f" {SAVED_PAT} ")  # type: ignore[arg-type]
    assert client._headers["Authorization"] == basic(SAVED_PAT)


def test_ado_client_without_any_pat_is_a_url_error_with_the_clear_message():
    with pytest.raises(AdoUrlError, match="Personal Access Token is required"):
        ado_client(request_of(), SETTINGS, object())  # type: ignore[arg-type]
    with pytest.raises(AdoUrlError):
        ado_client(request_of(pat="   "), SETTINGS, object(), None)  # type: ignore[arg-type]


def test_request_pat_is_trimmed_or_empty():
    assert request_pat(request_of(pat=" abc ")) == "abc"
    assert request_pat(request_of()) == ""
    assert request_pat(request_of(pat="  ")) == ""


def test_resolve_pat_is_skipped_when_the_request_has_a_pat():
    session = FakeSession([saved_token()])
    assert asyncio.run(resolve_pat(request_of(pat=FAKE_PAT), SETTINGS, session, 1)) is None
    assert session.statements == []


def test_resolve_pat_without_a_user_does_not_query():
    session = FakeSession([saved_token()])
    assert asyncio.run(resolve_pat(request_of(), SETTINGS, session, None)) is None
    assert session.statements == []


def test_resolve_pat_looks_up_the_users_pat_by_canonical_url():
    session = FakeSession([saved_token()])
    request = request_of(projectUrl=URL.upper() + "/")
    assert asyncio.run(resolve_pat(request, SETTINGS, session, 9)) == SAVED_PAT
    assert "user_id = 9" in session.sql() and URL.lower().replace("%", "%%") in session.sql()


def test_resolve_pat_with_nothing_saved_is_none():
    assert asyncio.run(resolve_pat(request_of(), SETTINGS, FakeSession([]), 1)) is None


def test_resolve_pat_rejects_a_disallowed_host_before_querying():
    session = FakeSession([saved_token()])
    with pytest.raises(AdoUrlError):
        asyncio.run(resolve_pat(request_of(projectUrl="https://evil.example.com/a/b"), SETTINGS, session, 1))
    assert session.statements == []


# --- route behaviour ---------------------------------------------------------------------


def test_connect_uses_the_saved_pat_when_the_request_has_none():
    response, fake = connect(body(), FakeSession([saved_token()]))
    assert response["project"]["name"]
    assert {r.headers["Authorization"] for r in fake.requests} == {basic(SAVED_PAT)}


@pytest.mark.parametrize("pat", [None, "", "   "])
def test_connect_treats_a_blank_pat_as_absent(pat):
    _, fake = connect(body(pat=pat), FakeSession([saved_token()]))
    assert fake.requests[0].headers["Authorization"] == basic(SAVED_PAT)


def test_connect_with_a_pat_in_the_request_overrides_and_never_reads_the_saved_one():
    session = FakeSession([saved_token()])
    _, fake = connect(body(pat=FAKE_PAT), session)
    assert fake.requests[0].headers["Authorization"] == basic(FAKE_PAT)
    assert session.statements == []


def test_connect_with_no_pat_and_nothing_saved_is_422_with_the_clear_message():
    response, fake = connect(body(), FakeSession([]))
    assert response.status_code == 422
    assert errors_of(response) == [PAT_OR_SAVED_REQUIRED]
    assert fake.requests == []


def test_connect_without_a_signed_in_user_cannot_use_saved_pats():
    session = FakeSession([saved_token()])
    response, fake = connect(body(), session, user_id=None)
    assert errors_of(response) == [PAT_OR_SAVED_REQUIRED] and fake.requests == [] and session.statements == []


def test_connect_with_an_unreadable_saved_pat_is_422_without_leaking_it():
    other = Settings(ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0,
                     pat_encryption_key=Fernet.generate_key().decode())
    response, fake = connect(body(), FakeSession([saved_token(settings=other)]))
    assert response.status_code == 422 and errors_of(response) == [credentials.STORED_PAT_UNREADABLE]
    assert fake.requests == [] and SAVED_PAT not in response.body.decode()


def test_connect_with_a_saved_pat_and_no_server_key_is_503():
    keyless = Settings(ado_allowed_hosts=("dev.azure.com",), ado_timeout_seconds=5.0)
    response, fake = connect(body(), FakeSession([saved_token()]), settings=keyless)
    assert response.status_code == 503 and "PAT_ENCRYPTION_KEY" in errors_of(response)[0]
    assert fake.requests == []
