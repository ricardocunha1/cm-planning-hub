"""Integration: the real authlib client validates a signed ID token end to end
(state, nonce, `iss`, `aud`, `exp`, signature) through the full app; only the
token endpoint is replaced by a function that returns a token we sign with a
local RSA key (no network)."""
import time
from urllib.parse import parse_qs, urlparse

import pytest
from authlib.integrations.starlette_client import OAuth
from joserfc import jwt
from joserfc.jwk import RSAKey

from app.api.auth_routes import get_oidc_client
from app.config import get_settings
from app.db import get_session
from app.main import create_app
from fastapi.testclient import TestClient

from test_auth_routes import FakeDb, make_settings

ISSUER = "https://accounts.google.com"
CLIENT_ID = "client-id"
KEY = RSAKey.generate_key(2048, parameters={"kid": "k1"})
OTHER_KEY = RSAKey.generate_key(2048, parameters={"kid": "k1"})


def claims(nonce: str, **over) -> dict:
    now = int(time.time())
    base = {
        "iss": ISSUER, "aud": CLIENT_ID, "sub": "g-1", "email": "ana@example.com", "email_verified": True,
        "name": "Ana", "iat": now, "exp": now + 600, "nonce": nonce,
    }
    base.update(over)
    return base


def build(token_factory):
    """`token_factory(nonce)` returns the token endpoint response."""
    oauth = OAuth()
    real = oauth.register(
        name="google",
        client_id=CLIENT_ID,
        client_secret="client-secret",
        issuer=ISSUER,
        authorize_url="https://accounts.example/authorize",
        access_token_url="https://accounts.example/token",
        jwks={"keys": [KEY.as_dict(private=False)]},
        client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"},
    )
    seen = {}

    async def fetch_access_token(*args, **kwargs):
        seen["kwargs"] = kwargs
        return token_factory(seen["nonce"])

    real.fetch_access_token = fetch_access_token
    settings = make_settings()
    app = create_app(settings)
    db = FakeDb()

    async def session_override():
        yield db

    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[get_oidc_client] = lambda: real
    client = TestClient(app, base_url="http://localhost:8080")
    return client, seen, db


def run(client, seen, state_override=None):
    response = client.get("/api/auth/login", follow_redirects=False)
    query = parse_qs(urlparse(response.headers["location"]).query)
    seen["nonce"] = query["nonce"][0]
    state = state_override or query["state"][0]
    return client.get(f"/api/auth/callback?state={state}&code=c", follow_redirects=False)


def signed(payload: dict, key=KEY) -> str:
    return jwt.encode({"alg": "RS256", "kid": "k1"}, payload, key)


def test_valid_id_token_logs_in_and_the_pkce_verifier_reaches_the_token_endpoint():
    client, seen, db = build(lambda n: {"access_token": "at", "token_type": "Bearer", "id_token": signed(claims(n))})
    response = run(client, seen)
    assert response.headers["location"] == "/"
    assert seen["kwargs"].get("code_verifier")
    assert client.get("/api/auth/me").json()["email"] == "ana@example.com"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda n: claims(n, aud="someone-else"),
        lambda n: claims(n, iss="https://evil.example"),
        lambda n: claims(n, exp=int(time.time()) - 3600),
        lambda n: claims("not-the-nonce"),
    ],
    ids=["wrong-aud", "wrong-iss", "expired", "wrong-nonce"],
)
def test_invalid_id_token_claims_are_rejected(mutate):
    client, seen, db = build(lambda n: {"access_token": "at", "id_token": signed(mutate(n))})
    response = run(client, seen)
    assert response.headers["location"] == "/login?error=login_failed"
    assert db.users == {}
    assert client.get("/api/auth/me").status_code == 401


def test_id_token_signed_with_another_key_is_rejected():
    client, seen, db = build(lambda n: {"access_token": "at", "id_token": signed(claims(n), OTHER_KEY)})
    assert run(client, seen).headers["location"] == "/login?error=login_failed"
    assert db.users == {}


def test_unverified_email_in_a_valid_token_is_rejected():
    client, seen, db = build(
        lambda n: {"access_token": "at", "id_token": signed(claims(n, email_verified=False))}
    )
    assert run(client, seen).headers["location"] == "/login?error=email_not_verified"
    assert db.users == {}


def test_token_response_without_id_token_is_rejected():
    client, seen, db = build(lambda n: {"access_token": "at"})
    assert run(client, seen).headers["location"] == "/login?error=invalid_claims"
    assert db.users == {}


def test_callback_with_a_wrong_state_is_rejected_before_the_token_exchange():
    client, seen, db = build(lambda n: {"access_token": "at", "id_token": signed(claims(n))})
    response = run(client, seen, state_override="attacker-state")
    assert response.headers["location"] == "/login?error=state_mismatch"
    assert "kwargs" not in seen


def test_state_cannot_be_replayed():
    client, seen, db = build(lambda n: {"access_token": "at", "id_token": signed(claims(n))})
    first = run(client, seen)
    assert first.headers["location"] == "/"
    state = parse_qs(urlparse(client.get("/api/auth/login", follow_redirects=False).headers["location"]).query)["state"][0]
    # A callback after the login finished (session replaced) with an old/other state fails.
    client.post("/api/auth/logout", headers={"X-Requested-With": "planning-hub"})
    replay = client.get(f"/api/auth/callback?state={state}&code=c", follow_redirects=False)
    assert replay.headers["location"] == "/login?error=state_mismatch"


def test_callback_with_provider_error_and_no_code_goes_back_to_login():
    client, seen, db = build(lambda n: {})
    client.get("/api/auth/login", follow_redirects=False)
    response = client.get("/api/auth/callback?error=access_denied", follow_redirects=False)
    assert response.headers["location"] == "/login?error=access_denied"
