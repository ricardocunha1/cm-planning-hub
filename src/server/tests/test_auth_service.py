"""Unit tests for app/services/auth.py: claim checks and the user upsert."""
import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy.dialects import postgresql

from app.config import Settings
from app.models import User
from app.services.auth import (
    AuthError,
    GoogleProfile,
    callback_url,
    profile_from_claims,
    upsert_user,
)

CLAIMS = {
    "sub": "1234",
    "email": "Ana@Example.com",
    "email_verified": True,
    "name": "Ana Silva",
    "picture": "https://example.com/a.png",
}


def test_profile_from_valid_claims():
    profile = profile_from_claims(CLAIMS, ())
    assert profile == GoogleProfile(sub="1234", email="Ana@Example.com", name="Ana Silva", picture_url="https://example.com/a.png")


def test_name_falls_back_to_email_and_picture_to_none():
    profile = profile_from_claims({**CLAIMS, "name": "  ", "picture": None}, ())
    assert profile.name == "Ana@Example.com"
    assert profile.picture_url is None


@pytest.mark.parametrize("verified", [False, None, "true", 1])
def test_unverified_email_is_rejected(verified):
    with pytest.raises(AuthError) as info:
        profile_from_claims({**CLAIMS, "email_verified": verified}, ())
    assert info.value.code == "email_not_verified"


def test_missing_email_verified_claim_is_rejected():
    claims = {k: v for k, v in CLAIMS.items() if k != "email_verified"}
    with pytest.raises(AuthError) as info:
        profile_from_claims(claims, ())
    assert info.value.code == "email_not_verified"


@pytest.mark.parametrize("override", [{"sub": ""}, {"sub": None}, {"email": None}, {"email": "no-at-sign"}])
def test_missing_subject_or_email_is_invalid(override):
    with pytest.raises(AuthError) as info:
        profile_from_claims({**CLAIMS, **override}, ())
    assert info.value.code == "invalid_claims"


def test_domain_must_be_in_the_allowed_list_case_insensitively():
    assert profile_from_claims(CLAIMS, ("example.com",)).sub == "1234"
    with pytest.raises(AuthError) as info:
        profile_from_claims(CLAIMS, ("other.org",))
    assert info.value.code == "domain_not_allowed"


def test_domain_check_uses_the_last_at_sign_and_not_a_suffix():
    with pytest.raises(AuthError):
        profile_from_claims({**CLAIMS, "email": "a@evil.com@example.com.evil.org"}, ("example.com",))
    with pytest.raises(AuthError):
        profile_from_claims({**CLAIMS, "email": "a@notexample.com"}, ("example.com",))


def test_callback_url_is_public_base_url_plus_callback_path():
    settings = Settings.from_env({"PUBLIC_BASE_URL": "https://hub.example.com/"})
    assert callback_url(settings) == "https://hub.example.com/api/auth/callback"


class FakeResult:
    def __init__(self, row):
        self.row = row

    def scalar_one(self):
        return self.row


class FakeSession:
    def __init__(self, row):
        self.row = row
        self.statements = []
        self.commits = 0

    async def execute(self, statement):
        self.statements.append(statement)
        return FakeResult(self.row)

    async def commit(self):
        self.commits += 1


def test_upsert_user_inserts_or_updates_by_sub_and_commits():
    row = User(id=5, sub="1234", email="ana@example.com", name="Ana", picture_url=None, last_login_at=datetime.now(timezone.utc))
    session = FakeSession(row)
    profile = GoogleProfile(sub="1234", email="ana@example.com", name="Ana", picture_url=None)

    user = asyncio.run(upsert_user(session, profile))

    assert user is row
    assert session.commits == 1
    sql = str(session.statements[0].compile(dialect=postgresql.dialect()))
    assert "ON CONFLICT (sub) DO UPDATE" in sql
    assert "last_login_at=now()" in sql.replace(" = ", "=")
    assert "RETURNING" in sql
    # created_at is left alone on conflict
    assert "created_at=" not in sql.replace(" = ", "=")
