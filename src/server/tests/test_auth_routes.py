"""Unit tests for the auth routes and the protection of the other routers.

Each test builds its own app with `create_app(settings)` (authentication on,
unlike the global `app` the rest of the suite uses), a fake OIDC client and a
fake database session; nothing touches Google or PostgreSQL."""
from urllib.parse import parse_qs, urlparse

import pytest
from authlib.integrations.base_client.errors import MismatchingStateError, OAuthError
from authlib.integrations.starlette_client import OAuth
from authlib.jose.errors import InvalidClaimError
from fastapi.responses import RedirectResponse
from fastapi.testclient import TestClient

from app.api.auth_routes import get_oidc_client
from app.config import Settings, get_settings
from app.db import get_session
from app.main import create_app
from app.models import User

CSRF = {"X-Requested-With": "planning-hub"}
CLAIMS = {"sub": "g-1", "email": "ana@example.com", "email_verified": True, "name": "Ana", "picture": "https://x/p.png"}


def make_settings(**overrides) -> Settings:
    values = dict(
        ado_allowed_hosts=("dev.azure.com",),
        ado_timeout_seconds=5.0,
        google_client_id="client-id",
        google_client_secret="client-secret",
        session_secret="s" * 32,
        auth_enabled=True,
        public_base_url="http://localhost:8080",
    )
    values.update(overrides)
    return Settings(**values)


class FakeOidc:
    """Stands in for the authlib client: no network, scripted outcome."""

    def __init__(self, claims=None, error: Exception | None = None):
        self.claims = claims if claims is not None else dict(CLAIMS)
        self.error = error
        self.redirect_uri = None
        self.session_at_login = None

    async def authorize_redirect(self, request, redirect_uri):
        self.session_at_login = dict(request.session)
        self.redirect_uri = redirect_uri
        request.session["_state_google_abc"] = {"data": "state"}
        return RedirectResponse("https://accounts.google.com/o/oauth2/v2/auth?state=abc", status_code=302)

    async def authorize_access_token(self, request):
        if self.error:
            raise self.error
        return {"userinfo": self.claims}


class FakeDb:
    def __init__(self):
        self.users: dict[int, User] = {}
        self.commits = 0

    async def execute(self, statement):
        params = statement.compile().params
        user = User(
            id=7, sub=params["sub"], email=params["email"], name=params["name"], picture_url=params["picture_url"]
        )
        self.users[7] = user

        class Result:
            def scalar_one(self_inner):
                return user

        return Result()

    async def commit(self):
        self.commits += 1

    async def get(self, model, key):
        return self.users.get(key)


def build(settings=None, oidc=None, db=None, base_url="http://localhost:8080"):
    settings = settings or make_settings()
    oidc = oidc or FakeOidc()
    db = db or FakeDb()
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings

    async def session_override():
        yield db

    app.dependency_overrides[get_session] = session_override
    app.dependency_overrides[get_oidc_client] = lambda: oidc
    return TestClient(app, base_url=base_url), oidc, db


def login(client: TestClient):
    """Run login + callback successfully; the client keeps the session cookie."""
    client.get("/api/auth/login", follow_redirects=False)
    return client.get("/api/auth/callback?state=abc&code=c", follow_redirects=False)


# --- login -----------------------------------------------------------------


def test_login_redirects_to_google_with_the_configured_redirect_uri():
    client, oidc, _ = build(make_settings(public_base_url="https://hub.example.com"), base_url="https://hub.example.com")
    response = client.get("/api/auth/login", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"].startswith("https://accounts.google.com/")
    assert oidc.redirect_uri == "https://hub.example.com/api/auth/callback"


def test_login_drops_a_previous_session_first():
    client, oidc, _ = build()
    login(client)
    assert client.get("/api/auth/me").status_code == 200
    client.get("/api/auth/login", follow_redirects=False)
    assert oidc.session_at_login == {}
    assert client.get("/api/auth/me").status_code == 401


def test_login_ignores_the_request_host_for_the_redirect_uri():
    client, oidc, _ = build()
    client.get("/api/auth/login", headers={"Host": "evil.example", "X-Forwarded-Host": "evil.example"}, follow_redirects=False)
    assert oidc.redirect_uri == "http://localhost:8080/api/auth/callback"


def test_login_and_callback_are_unavailable_when_auth_is_disabled():
    client, _, _ = build(make_settings(auth_enabled=False))
    for path in ("/api/auth/login", "/api/auth/callback"):
        response = client.get(path, follow_redirects=False)
        assert response.status_code == 503
        assert response.json() == {"errors": ["Authentication is disabled."]}


# --- callback --------------------------------------------------------------


def test_successful_callback_upserts_the_user_and_starts_a_session_with_only_the_user_id():
    client, _, db = build()
    response = login(client)
    assert response.status_code == 302
    assert response.headers["location"] == "/"
    assert db.commits == 1
    assert db.users[7].sub == "g-1"
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json() == {"id": 7, "name": "Ana", "email": "ana@example.com", "pictureUrl": "https://x/p.png"}


def test_callback_replaces_the_login_session_data():
    client, _, _ = build()
    login(client)
    # Only the signed-in user id may remain: no leftover state/nonce/PKCE entries.
    from itsdangerous import TimestampSigner
    import base64, json

    cookie = client.cookies.get("session")
    data = TimestampSigner("s" * 32).unsign(cookie.encode())
    assert json.loads(base64.b64decode(data)) == {"user_id": 7}


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (MismatchingStateError(), "state_mismatch"),
        (OAuthError(error="access_denied"), "access_denied"),
        (OAuthError(error="invalid_grant"), "login_failed"),
        (InvalidClaimError("nonce"), "login_failed"),
        (RuntimeError("boom"), "login_failed"),
    ],
)
def test_callback_failures_redirect_to_login_with_a_code_and_no_session(error, code):
    client, _, db = build(oidc=FakeOidc(error=error))
    response = client.get("/api/auth/callback?state=x&code=c", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == f"/login?error={code}"
    assert db.users == {}
    assert client.get("/api/auth/me").status_code == 401


def test_callback_rejects_unverified_email():
    client, _, db = build(oidc=FakeOidc(claims={**CLAIMS, "email_verified": False}))
    response = client.get("/api/auth/callback?state=abc&code=c", follow_redirects=False)
    assert response.headers["location"] == "/login?error=email_not_verified"
    assert db.users == {} and db.commits == 0


def test_callback_rejects_a_disallowed_domain_and_allows_a_listed_one():
    client, _, db = build(make_settings(auth_allowed_email_domains=("corp.com",)))
    response = client.get("/api/auth/callback?state=abc&code=c", follow_redirects=False)
    assert response.headers["location"] == "/login?error=domain_not_allowed"
    assert db.users == {}
    allowed, _, _ = build(
        make_settings(auth_allowed_email_domains=("example.com",)),
    )
    assert allowed.get("/api/auth/callback?state=abc&code=c", follow_redirects=False).headers["location"] == "/"


def test_a_failed_callback_does_not_keep_an_earlier_session():
    client, oidc, _ = build()
    login(client)
    oidc.error = MismatchingStateError()
    client.get("/api/auth/callback?state=bad&code=c", follow_redirects=False)
    assert client.get("/api/auth/me").status_code == 401


def test_real_authlib_client_sends_pkce_state_nonce_and_rejects_a_foreign_state():
    oauth = OAuth()
    real = oauth.register(
        name="google",
        client_id="client-id",
        client_secret="client-secret",
        authorize_url="https://accounts.example/authorize",
        access_token_url="https://accounts.example/token",
        jwks_uri="https://accounts.example/jwks",
        client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"},
    )
    client, _, db = build(oidc=real)
    response = client.get("/api/auth/login", follow_redirects=False)
    query = parse_qs(urlparse(response.headers["location"]).query)
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"] and query["state"] and query["nonce"]
    assert query["redirect_uri"] == ["http://localhost:8080/api/auth/callback"]
    assert query["scope"] == ["openid email profile"]

    forged = client.get("/api/auth/callback?state=forged&code=c", follow_redirects=False)
    assert forged.headers["location"] == "/login?error=state_mismatch"
    assert db.users == {}


# --- me / logout -----------------------------------------------------------


def test_me_requires_a_session():
    client, _, _ = build()
    response = client.get("/api/auth/me")
    assert response.status_code == 401
    assert response.json() == {"errors": ["Authentication required."]}


def test_me_with_a_user_that_no_longer_exists_is_401_and_clears_the_session():
    client, _, db = build()
    login(client)
    db.users.clear()
    assert client.get("/api/auth/me").status_code == 401
    db.users[7] = User(id=7, sub="g-1", email="a@b.c", name="A", picture_url=None)
    assert client.get("/api/auth/me").status_code == 401  # the cookie is gone


def test_me_when_auth_is_disabled_returns_the_dev_user():
    client, _, _ = build(make_settings(auth_enabled=False))
    response = client.get("/api/auth/me")
    assert response.status_code == 200
    assert response.json()["email"] == "dev@localhost"


def test_logout_clears_the_session():
    client, _, _ = build()
    login(client)
    assert client.get("/api/auth/me").status_code == 200
    response = client.post("/api/auth/logout", headers=CSRF)
    assert response.status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/plan").status_code == 401


def test_logout_requires_the_csrf_header():
    client, _, _ = build()
    login(client)
    response = client.post("/api/auth/logout")
    assert response.status_code == 403
    assert response.json() == {"errors": ["Missing X-Requested-With header."]}
    assert client.get("/api/auth/me").status_code == 200  # still signed in


# --- cookie flags ----------------------------------------------------------


def test_cookie_is_httponly_samesite_lax_with_max_age_and_not_secure_on_http():
    client, _, _ = build(make_settings(session_max_age_seconds=600))
    header = login(client).headers["set-cookie"].lower()
    assert "httponly" in header
    assert "samesite=lax" in header
    assert "max-age=600" in header
    assert "secure" not in header


def test_cookie_is_secure_when_public_base_url_is_https():
    client, _, _ = build(make_settings(public_base_url="https://hub.example.com"), base_url="https://hub.example.com")
    header = login(client).headers["set-cookie"].lower()
    assert "secure" in header and "httponly" in header


# --- protection of the other routers ---------------------------------------

PROTECTED_GETS = ["/api/plan", "/api/plan/1"]
PROTECTED_WRITES = [
    ("post", "/api/validate"),
    ("post", "/api/simulate"),
    ("post", "/api/ado/connect"),
    ("post", "/api/ado/backlog"),
    ("post", "/api/ado/sprint-history"),
    ("post", "/api/plan"),
    ("put", "/api/plan/1"),
    ("delete", "/api/plan/1"),
]


@pytest.mark.parametrize("path", PROTECTED_GETS)
def test_protected_get_without_session_is_401_errors_shape(path):
    client, _, _ = build()
    response = client.get(path)
    assert response.status_code == 401
    assert response.json() == {"errors": ["Authentication required."]}


@pytest.mark.parametrize(("method", "path"), PROTECTED_WRITES)
def test_protected_write_without_session_is_401(method, path):
    client, _, _ = build()
    assert getattr(client, method)(path, headers=CSRF).status_code == 401


@pytest.mark.parametrize(("method", "path"), PROTECTED_WRITES)
def test_protected_write_with_session_but_without_csrf_header_is_403(method, path):
    client, _, _ = build()
    login(client)
    assert getattr(client, method)(path).status_code == 403
    assert getattr(client, method)(path, headers={"X-Requested-With": "XMLHttpRequest"}).status_code == 403


def test_protected_write_with_session_and_header_reaches_the_route():
    client, _, _ = build()
    login(client)
    response = client.post("/api/ado/connect", json={}, headers=CSRF)
    assert response.status_code == 422  # past auth: the route's own validation


def test_protected_get_with_session_needs_no_csrf_header():
    client, _, _ = build()
    login(client)

    assert client.get("/api/plan/not-a-number").status_code == 422  # reached the route


def test_a_forged_session_cookie_is_rejected():
    client, _, _ = build()
    client.cookies.set("session", "eyJ1c2VyX2lkIjogN30=.abc.def")
    assert client.get("/api/plan").status_code == 401


def test_a_cookie_signed_with_another_secret_is_rejected():
    other, _, _ = build(make_settings(session_secret="x" * 32))
    login(other)
    client, _, _ = build()
    client.cookies.set("session", other.cookies.get("session"))
    assert client.get("/api/plan").status_code == 401


def test_disabled_auth_lets_protected_routes_through_without_a_session_or_header():
    client, _, _ = build(make_settings(auth_enabled=False))
    assert client.post("/api/ado/connect", json={}).status_code == 422


def test_request_cannot_switch_auth_off():
    client, _, _ = build()
    headers = {"X-Auth-Enabled": "false", "AUTH_ENABLED": "false", "Authorization": "Bearer x"}
    assert client.get("/api/plan?auth_enabled=false", headers=headers).status_code == 401


# --- open paths ------------------------------------------------------------


def test_health_is_open():
    client, _, _ = build()
    assert client.get("/api/health").json() == {"status": "ok"}


def test_mcp_is_open_and_unaffected_by_the_session_middleware():
    client, _, _ = build()
    # No lifespan here, so the MCP app is not running: 503 comes from the MCP
    # endpoint itself, which proves auth did not answer first (401/403).
    response = client.post("/api/mcp", json={})
    assert response.status_code == 503
    assert "set-cookie" not in response.headers
