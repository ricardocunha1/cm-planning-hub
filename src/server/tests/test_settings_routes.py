"""Unit tests for the credential route handlers, called directly with a stub
request and a scripted session (no TestClient, no database)."""
import asyncio
import json
import logging
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

from app.api import settings_routes
from app.api.deps import ApiError
from app.config import Settings
from app.models import AdoCredential
from app.services import credentials
from fake_session import FakeSession

KEY = Fernet.generate_key().decode()
HOSTS = ("dev.azure.com", "*.visualstudio.com", "tfs.example.com")
SETTINGS = Settings(ado_allowed_hosts=HOSTS, ado_timeout_seconds=5.0, pat_encryption_key=KEY)
PAT = "s3cr3t-pat-value-1234567890"
URL = "https://dev.azure.com/contoso/Alpha"


class StubRequest:
    def __init__(self, data) -> None:
        self.data = data

    async def json(self):
        if isinstance(self.data, Exception):
            raise self.data
        return self.data


def body(**overrides):
    data = {"projectName": "Alpha", "projectUrl": URL, "pat": PAT}
    data.update(overrides)
    return data


def stored(id: int = 3, user_id: int = 1, url: str = URL) -> AdoCredential:
    return AdoCredential(
        id=id, user_id=user_id, project_name="Alpha", project_url=url,
        pat_encrypted=credentials.encrypt_pat(SETTINGS, PAT),
    )


def call(handler, *args, **kwargs):
    return asyncio.run(handler(*args, **kwargs))


def payload(response) -> dict:
    return json.loads(response.body)


def create(data, session=None, user_id=1, settings=SETTINGS):
    return call(settings_routes.create_credential, StubRequest(data), session or FakeSession([]), settings, user_id)


def update(data, session, credential_id=3, user_id=1):
    return call(settings_routes.update_credential, credential_id, StubRequest(data), session, SETTINGS, user_id)


# --- list ----------------------------------------------------------------------


def test_list_returns_items_with_has_pat_and_last4_but_never_the_pat():
    response = call(settings_routes.list_credentials, FakeSession([stored(), stored(4, url=URL + "2")]), SETTINGS, 1)
    dumped = response.model_dump(by_alias=True)
    assert dumped["items"][0] == {
        "id": 3, "projectName": "Alpha", "projectUrl": URL, "hasPat": True, "patLast4": PAT[-4:]
    }
    assert PAT not in str(dumped)


def test_list_gives_null_last4_for_an_unreadable_item_without_failing_the_list():
    broken = stored(4, url=URL + "2")
    broken.pat_encrypted = "garbage"
    response = call(settings_routes.list_credentials, FakeSession([stored(), broken]), SETTINGS, 1)
    assert [item.pat_last4 for item in response.items] == [PAT[-4:], None]


def test_without_a_signed_in_user_every_handler_answers_409():
    for handler, args in [
        (settings_routes.list_credentials, (FakeSession(), SETTINGS, None)),
        (settings_routes.delete_credential, (3, FakeSession(), None)),
    ]:
        with pytest.raises(ApiError) as excinfo:
            call(handler, *args)
        assert excinfo.value.status_code == 409
    with pytest.raises(ApiError):
        create(body(), user_id=None)


# --- create --------------------------------------------------------------------


def test_create_answers_201_with_the_canonical_url_and_no_pat():
    session = FakeSession([])
    response = create(body(projectUrl=URL + "/", projectName=" Alpha "), session)
    assert response.status_code == 201
    assert payload(response) == {
        "id": 1, "projectName": "Alpha", "projectUrl": URL, "hasPat": True, "patLast4": PAT[-4:]
    }
    assert PAT not in response.body.decode()
    assert session.added[0].user_id == 1


def test_create_trims_and_stores_the_canonical_form():
    session = FakeSession([])
    response = create(body(projectUrl=URL + "/"), session)
    assert payload(response)["projectUrl"] == URL
    assert session.added[0].project_url == URL


@pytest.mark.parametrize("missing", ["projectName", "projectUrl", "pat"])
def test_create_requires_name_url_and_pat(missing):
    data = body()
    data.pop(missing)
    response = create(data)
    assert response.status_code == 422
    assert len(payload(response)["errors"]) == 1 and PAT not in response.body.decode()


@pytest.mark.parametrize("raw", [b"", None, [1], "text"])
def test_create_with_an_unreadable_or_non_object_body_reports_the_field_messages(raw):
    data = ValueError("bad json") if raw == b"" else raw
    assert payload(create(data))["errors"] == [
        credentials.NAME_REQUIRED, credentials.URL_REQUIRED, credentials.PAT_REQUIRED,
    ]


def test_create_rejects_an_invalid_url_and_a_disallowed_host_without_the_pat():
    for url, text in [("ftp://x", "https://"), ("https://evil.example.com/a/b", "not allowed")]:
        response = create(body(projectUrl=url))
        assert response.status_code == 422 and text in payload(response)["errors"][0]
        assert PAT not in response.body.decode()


@pytest.mark.parametrize("variant", [URL, URL + "/", "https://DEV.azure.com/contoso/alpha/"])
def test_create_duplicate_canonical_url_is_422(variant):
    response = create(body(projectUrl=variant), FakeSession([55]))
    assert response.status_code == 422
    assert payload(response)["errors"] == [credentials.DUPLICATE_URL]


def test_create_without_an_encryption_key_is_503_and_clear():
    response = create(body(), settings=Settings(ado_allowed_hosts=HOSTS, ado_timeout_seconds=5.0))
    assert response.status_code == 503
    assert "PAT_ENCRYPTION_KEY" in payload(response)["errors"][0] and PAT not in response.body.decode()


def test_create_never_logs_the_pat(caplog):
    with caplog.at_level(logging.DEBUG):
        create(body())
        create(body(projectUrl="bad"))
    assert PAT not in caplog.text


# --- update --------------------------------------------------------------------


def test_update_of_a_credential_that_is_not_the_users_is_404_before_any_validation():
    session = FakeSession([])  # the scoped lookup finds nothing
    response = update({}, session, credential_id=3, user_id=2)
    assert response.status_code == 404
    assert "user_id = 2" in session.sql(0)
    assert payload(response)["errors"] == ["Credential not found: 3."]


def test_update_without_pat_keeps_the_stored_one():
    existing = stored()
    before = existing.pat_encrypted
    session = FakeSession([existing])
    response = update(body(pat=None, projectName="Renamed"), session)
    assert payload_of(response)["projectName"] == "Renamed"
    assert existing.pat_encrypted == before


def payload_of(model) -> dict:
    return model.model_dump(by_alias=True)


def test_update_with_a_blank_pat_keeps_the_stored_one():
    existing = stored()
    before = existing.pat_encrypted
    update(body(pat="  "), FakeSession([existing]))
    assert existing.pat_encrypted == before


def test_update_with_a_pat_replaces_it():
    existing = stored()
    update(body(pat="another-pat"), FakeSession([existing]))
    assert credentials.decrypt_pat(SETTINGS, existing.pat_encrypted) == "another-pat"


@pytest.mark.parametrize("same", [URL, URL + "/", URL.upper()])
def test_update_with_the_same_canonical_url_does_not_need_a_pat(same):
    response = update(body(projectUrl=same, pat=None), FakeSession([stored()]))
    assert not isinstance(response, settings_routes.JSONResponse)


def test_changing_the_canonical_url_requires_a_pat():
    existing = stored()
    response = update(body(projectUrl="https://dev.azure.com/contoso/Beta", pat=None), FakeSession([existing]))
    assert response.status_code == 422
    assert payload(response)["errors"] == [credentials.PAT_REQUIRED_ON_URL_CHANGE]
    assert existing.project_url == URL


def test_changing_the_url_with_a_pat_succeeds_and_stores_the_new_canonical_url():
    existing = stored()
    response = update(body(projectUrl="https://dev.azure.com/contoso/Beta/", pat="new"), FakeSession([existing], []))
    assert payload_of(response)["projectUrl"] == "https://dev.azure.com/contoso/Beta"
    assert credentials.decrypt_pat(SETTINGS, existing.pat_encrypted) == "new"
    assert payload_of(response)["patLast4"] is None  # shorter than 8 characters


def test_update_to_a_url_the_user_already_has_is_422():
    response = update(
        body(projectUrl="https://dev.azure.com/contoso/Beta", pat="new"), FakeSession([stored()], [77])
    )
    assert response.status_code == 422 and payload(response)["errors"] == [credentials.DUPLICATE_URL]


def test_update_validation_errors_are_422():
    response = update(body(projectName="", projectUrl="http://x"), FakeSession([stored()]))
    assert response.status_code == 422 and len(payload(response)["errors"]) == 2


# --- delete --------------------------------------------------------------------


def test_delete_answers_204_for_an_owned_credential():
    response = call(settings_routes.delete_credential, 3, FakeSession(rowcount=1), 1)
    assert response.status_code == 204 and response.body == b""


def test_delete_of_someone_elses_or_unknown_credential_is_404():
    session = FakeSession(rowcount=0)
    response = call(settings_routes.delete_credential, 3, session, 2)
    assert response.status_code == 404 and "user_id = 2" in session.sql()
