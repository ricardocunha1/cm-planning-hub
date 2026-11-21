"""Unit tests for the credentials service: Fernet encryption of the PAT, the
canonical project URL, field validation and the per-user CRUD (scripted fake
session; the PostgreSQL behaviour is covered by the `db` integration tests)."""
import asyncio
import logging

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.exc import IntegrityError

from app.config import Settings
from app.models import AdoCredential
from app.services import credentials
from app.services.ado_url import AdoUrlError
from fake_session import FakeSession

KEY = Fernet.generate_key().decode()
HOSTS = ("dev.azure.com", "*.visualstudio.com", "tfs.example.com")
PAT = "s3cr3t-pat-value-1234567890"
URL = "https://dev.azure.com/contoso/Alpha"


def make_settings(key: str = KEY) -> Settings:
    return Settings(ado_allowed_hosts=HOSTS, ado_timeout_seconds=5.0, pat_encryption_key=key)


def row(id: int = 3, user_id: int = 1, url: str = URL, name: str = "Alpha", pat: str = PAT) -> AdoCredential:
    return AdoCredential(
        id=id, user_id=user_id, project_name=name, project_url=url,
        pat_encrypted=credentials.encrypt_pat(make_settings(), pat),
    )


def run(coro):
    return asyncio.run(coro)


# --- encryption -------------------------------------------------------------------


def test_encrypt_decrypt_round_trip_and_ciphertext_differs():
    token = credentials.encrypt_pat(make_settings(), PAT)
    assert token != PAT and PAT not in token
    assert credentials.decrypt_pat(make_settings(), token) == PAT


def test_encryption_is_not_deterministic():
    settings = make_settings()
    assert credentials.encrypt_pat(settings, PAT) != credentials.encrypt_pat(settings, PAT)


@pytest.mark.parametrize("key", ["", "not-a-key", "a" * 44])
def test_missing_or_invalid_key_is_a_clear_error(key):
    with pytest.raises(credentials.CredentialsUnavailableError, match="PAT_ENCRYPTION_KEY"):
        credentials.encrypt_pat(make_settings(key), PAT)
    with pytest.raises(credentials.CredentialsUnavailableError):
        credentials.decrypt_pat(make_settings(key), "x")


def test_the_error_for_a_bad_key_does_not_contain_the_key_or_pat():
    with pytest.raises(credentials.CredentialsUnavailableError) as excinfo:
        credentials.encrypt_pat(make_settings("not-a-key"), PAT)
    assert "not-a-key" not in str(excinfo.value) and PAT not in str(excinfo.value)


def test_a_token_from_another_key_is_unreadable_without_leaking():
    token = credentials.encrypt_pat(make_settings(Fernet.generate_key().decode()), PAT)
    with pytest.raises(credentials.StoredPatUnreadableError) as excinfo:
        credentials.decrypt_pat(make_settings(), token)
    assert PAT not in str(excinfo.value) and token not in str(excinfo.value)


def test_garbage_token_is_unreadable():
    with pytest.raises(credentials.StoredPatUnreadableError):
        credentials.decrypt_pat(make_settings(), "not-a-token")


# --- canonical URL ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [URL, URL + "/", "  " + URL + "  ", "HTTPS://DEV.AZURE.COM/contoso/Alpha", URL + "/_boards/board?x=1#f"],
)
def test_canonical_url_ignores_slash_whitespace_host_case_and_suffixes(raw):
    assert credentials.canonical_project_url(raw, HOSTS) == URL


def test_canonical_url_accepts_the_visualstudio_form_and_onprem():
    assert credentials.canonical_project_url("https://contoso.visualstudio.com/Alpha/", HOSTS) == (
        "https://contoso.visualstudio.com/Alpha"
    )
    assert credentials.canonical_project_url("https://tfs.example.com/Coll/My%20Proj/", HOSTS) == (
        "https://tfs.example.com/Coll/My%20Proj"
    )


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("http://dev.azure.com/contoso/Alpha", "The URL must start with https://."),
        ("https://evil.example.com/a/b", "This Azure DevOps host is not allowed: evil.example.com."),
        ("https://dev.azure.com/contoso", "Collaboration Hub URLs look like"),
        ("https://tfs.example.com/Coll", "On-Prem URLs look like"),
    ],
)
def test_canonical_url_errors(raw, message):
    with pytest.raises(AdoUrlError, match=message):
        credentials.canonical_project_url(raw, HOSTS)


# --- field validation ---------------------------------------------------------------------


def body(**overrides):
    data = {"projectName": "Alpha", "projectUrl": URL, "pat": PAT}
    data.update(overrides)
    return data


def test_valid_body_has_no_errors_and_returns_the_canonical_url():
    assert credentials.credential_field_errors(body(projectUrl=URL + "/"), HOSTS, pat_required=True) == ([], URL)


def test_empty_body_reports_every_message():
    errors, canonical = credentials.credential_field_errors({}, HOSTS, pat_required=True)
    assert errors == [credentials.NAME_REQUIRED, credentials.URL_REQUIRED, credentials.PAT_REQUIRED]
    assert canonical is None


@pytest.mark.parametrize("pat", [None, "", "   ", 5])
def test_pat_is_required_on_create_but_optional_on_update(pat):
    assert credentials.credential_field_errors(body(pat=pat), HOSTS, pat_required=True)[0] == [credentials.PAT_REQUIRED]
    assert credentials.credential_field_errors(body(pat=pat), HOSTS, pat_required=False)[0] == []


@pytest.mark.parametrize("pat", ["bad\npat", "x" * 1025, "\ud800"])
def test_invalid_pat_is_rejected_without_echoing_it(pat):
    errors, _ = credentials.credential_field_errors(body(pat=pat), HOSTS, pat_required=False)
    assert errors == [credentials.PAT_INVALID]


@pytest.mark.parametrize(
    ("name", "message"),
    [("  ", credentials.NAME_REQUIRED), ("a" * 201, credentials.NAME_TOO_LONG), ("a\x00b", credentials.NAME_INVALID_CHARS)],
)
def test_name_rules(name, message):
    assert credentials.credential_field_errors(body(projectName=name), HOSTS, pat_required=True)[0] == [message]


def test_invalid_url_message_is_reported_with_no_canonical_url():
    errors, canonical = credentials.credential_field_errors(
        body(projectUrl="https://evil.example.com/a/b"), HOSTS, pat_required=True
    )
    assert errors == ["This Azure DevOps host is not allowed: evil.example.com."] and canonical is None


# --- CRUD ----------------------------------------------------------------------------------


def test_to_response_never_contains_the_pat_only_its_last_4_characters():
    dumped = credentials.to_response(row(), make_settings()).model_dump(by_alias=True)
    assert dumped == {"id": 3, "projectName": "Alpha", "projectUrl": URL, "hasPat": True, "patLast4": PAT[-4:]}
    assert PAT not in str(dumped) and "pat_encrypted" not in str(dumped)


def test_pat_last4_returns_exactly_four_characters_from_eight_up():
    token = credentials.encrypt_pat(make_settings(), "12345678")
    assert credentials.pat_last4(make_settings(), token) == "5678"


def test_pat_last4_is_null_for_short_pats():
    token = credentials.encrypt_pat(make_settings(), "1234567")
    assert credentials.pat_last4(make_settings(), token) is None


def test_pat_last4_is_null_when_the_token_is_unreadable_or_the_key_unusable(caplog):
    token = credentials.encrypt_pat(make_settings(Fernet.generate_key().decode()), PAT)
    assert credentials.pat_last4(make_settings(), token) is None
    assert credentials.pat_last4(make_settings(), "not-a-fernet-token") is None
    good = credentials.encrypt_pat(make_settings(), PAT)
    assert credentials.pat_last4(make_settings(""), good) is None
    assert credentials.pat_last4(make_settings("not-a-key"), good) is None
    assert PAT not in caplog.text


def test_to_response_of_an_unreadable_row_has_null_last4():
    other = row()
    other.pat_encrypted = credentials.encrypt_pat(make_settings(Fernet.generate_key().decode()), PAT)
    assert credentials.to_response(other, make_settings()).pat_last4 is None


def test_list_is_scoped_to_the_user():
    session = FakeSession([row()])
    assert len(run(credentials.list_credentials(session, 42))) == 1
    assert "ado_credentials.user_id = 42" in session.sql()


def test_get_and_delete_are_scoped_to_the_user_and_ignore_impossible_ids():
    session = FakeSession([], rowcount=0)
    assert run(credentials.get_credential(session, 42, 3)) is None
    assert "ado_credentials.id = 3 AND ado_credentials.user_id = 42" in session.sql()
    assert run(credentials.delete_credential(session, 42, 3)) is False
    assert "user_id = 42" in session.sql()
    assert run(credentials.get_credential(session, 42, 0)) is None
    assert run(credentials.delete_credential(session, 42, 2**31)) is False
    assert len(session.statements) == 2  # the impossible ids never reached the database


def test_delete_returns_true_when_a_row_was_removed():
    session = FakeSession(rowcount=1)
    assert run(credentials.delete_credential(session, 1, 3)) is True
    assert session.commits == 1


def test_create_stores_ciphertext_and_the_canonical_url_for_the_user():
    session = FakeSession([])  # no duplicate
    created = run(credentials.create_credential(session, make_settings(), 7, "  Alpha ", URL, f" {PAT} "))
    assert created is session.added[0]
    assert (created.user_id, created.project_name, created.project_url) == (7, "Alpha", URL)
    assert created.pat_encrypted != PAT and PAT not in created.pat_encrypted
    assert credentials.decrypt_pat(make_settings(), created.pat_encrypted) == PAT
    assert session.commits == 1


def test_create_duplicate_url_is_refused_case_insensitively():
    session = FakeSession([123])
    assert run(credentials.create_credential(session, make_settings(), 7, "A", URL, PAT)) is None
    assert session.added == [] and session.commits == 0
    assert "lower(ado_credentials.project_url) = 'https://dev.azure.com/contoso/alpha'" in session.sql()
    assert "user_id = 7" in session.sql()


def test_create_without_a_key_raises_before_any_query():
    session = FakeSession([])
    with pytest.raises(credentials.CredentialsUnavailableError):
        run(credentials.create_credential(session, make_settings(""), 7, "A", URL, PAT))
    assert session.statements == []


def test_create_losing_a_race_on_the_unique_constraint_is_a_duplicate():
    session = FakeSession([])
    session.commit_error = IntegrityError("insert", {}, Exception("duplicate key"))
    assert run(credentials.create_credential(session, make_settings(), 7, "A", URL, PAT)) is None
    assert session.rollbacks == 1


def test_update_keeps_the_stored_pat_when_none_is_given():
    existing = row()
    before = existing.pat_encrypted
    session = FakeSession()
    updated = run(credentials.update_credential(session, make_settings(), existing, " Renamed ", URL, None))
    assert updated.project_name == "Renamed" and updated.pat_encrypted == before
    assert session.statements == [] and session.commits == 1  # same URL: no duplicate query


def test_update_replaces_the_pat_with_a_new_ciphertext():
    existing = row()
    before = existing.pat_encrypted
    run(credentials.update_credential(FakeSession([]), make_settings(), existing, "A", URL + "x", " new-pat "))
    assert existing.pat_encrypted != before
    assert credentials.decrypt_pat(make_settings(), existing.pat_encrypted) == "new-pat"


def test_update_to_another_urls_duplicate_is_refused_and_leaves_the_row_alone():
    existing = row()
    session = FakeSession([99])
    other = "https://dev.azure.com/contoso/Beta"
    assert run(credentials.update_credential(session, make_settings(), existing, "A", other, PAT)) is None
    assert existing.project_url == URL and session.commits == 0
    assert "ado_credentials.id != 3" in session.sql()


def test_find_pat_decrypts_the_users_credential_by_case_insensitive_url():
    session = FakeSession([row().pat_encrypted])
    assert run(credentials.find_pat(session, make_settings(), 1, URL.upper())) == PAT
    assert "user_id = 1" in session.sql() and "lower(ado_credentials.project_url)" in session.sql()


def test_find_pat_without_a_credential_is_none_even_with_no_key():
    assert run(credentials.find_pat(FakeSession([]), make_settings(""), 1, URL)) is None


def test_find_pat_with_a_stored_token_and_no_key_is_a_clear_error():
    with pytest.raises(credentials.CredentialsUnavailableError):
        run(credentials.find_pat(FakeSession([row().pat_encrypted]), make_settings(""), 1, URL))


def test_the_pat_never_reaches_the_logs(caplog):
    with caplog.at_level(logging.DEBUG):
        session = FakeSession([])
        run(credentials.create_credential(session, make_settings(), 7, "A", URL, PAT))
        run(credentials.find_pat(FakeSession([session.added[0].pat_encrypted]), make_settings(), 7, URL))
    assert PAT not in caplog.text
