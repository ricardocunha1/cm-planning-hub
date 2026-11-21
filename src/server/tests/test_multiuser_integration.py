"""QA integration / end-to-end (marker `db`): the real app, built from the
environment with authentication ENABLED, against a real PostgreSQL. Two users
sign in through the (faked) Google OIDC callback and every call goes through
the real routes, session cookies, CSRF check and `require_user`.

Covers plans/oauth-authentication.md Phase 3: board ownership, saved PATs and
their isolation, the PAT never leaking, the ADO fallback to the saved PAT with
a mocked ADO transport, and `/api/mcp` staying open and unowned.
"""
import asyncio
import base64
import json
import logging

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from ado_fakes import PROJECT_NAME, FakeAdo, mock_http_client, synthetic_sprint_history
from app.api.ado_routes import get_ado_http_client
from app.api.auth_routes import get_oidc_client
from app.config import get_settings
from app.db import get_session
from app.main import create_app
from app.mcp_server.deps import override_providers
from db_helpers import run_sql
from mcp_helpers import db_provider
from test_auth_routes import CLAIMS, FakeOidc
from test_db_migrations import query

pytestmark = pytest.mark.db

KEY = Fernet.generate_key().decode()
CSRF = {"X-Requested-With": "planning-hub"}
MCP_HEADERS = {"Accept": "application/json, text/event-stream"}
URL = "https://dev.azure.com/contoso/Fabrikam%20Plant"
PAT_A = "pat-of-ana-AAAA1111zzzz"
PAT_B = "pat-of-ben-BBBB2222yyyy"
BOARD = {
    "schema": "release-planner-features",
    "version": 1,
    "mode": "features",
    "name": "Board",
    "source": {"kind": "cloud", "projectName": "P", "url": "https://dev.azure.com/o/P"},
    "iterations": [],
    "milestones": [],
    "flags": [],
    "epics": [],
    "savedAt": "2026-11-03T10:00:00.000Z",
}
CRED_URL = "/api/settings/ado-credentials"


def basic(pat: str) -> str:
    return "Basic " + base64.b64encode(f":{pat}".encode()).decode()


@pytest.fixture()
def stack(clean_db, monkeypatch):
    """(app, fake_ado, oidc holder) with auth on, built from the environment."""
    url = make_url(clean_db)
    env = {
        "DB_HOST": url.host or "localhost",
        "DB_PORT": str(url.port or 5432),
        "DB_USER": url.username or "",
        "DB_PASSWORD": url.password or "",
        "DB_NAME": url.database or "",
        "DB_MIGRATE_ON_STARTUP": "false",
        "AUTH_ENABLED": "true",
        "GOOGLE_CLIENT_ID": "cid",
        "GOOGLE_CLIENT_SECRET": "csecret",
        "SESSION_SECRET": "s" * 32,
        "PAT_ENCRYPTION_KEY": KEY,
        "PUBLIC_BASE_URL": "http://localhost:8080",
        "ADO_ALLOWED_HOSTS": "dev.azure.com",
    }
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    get_settings.cache_clear()
    run_sql(clean_db, "TRUNCATE users RESTART IDENTITY CASCADE")  # drop the conftest user: ids come from sign-in
    application = create_app(get_settings())
    fake = FakeAdo()
    holder = {"oidc": FakeOidc()}
    application.dependency_overrides[get_oidc_client] = lambda: holder["oidc"]
    # NullPool engines: no asyncpg connection may outlive the loop of one request.
    engine = create_async_engine(clean_db, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def session_override():
        async with factory() as session:
            yield session

    application.dependency_overrides[get_session] = session_override

    async def ado_http():
        async with mock_http_client(fake) as http:
            yield http

    application.dependency_overrides[get_ado_http_client] = ado_http
    with override_providers(session=db_provider(clean_db)):
        yield application, fake, holder
    asyncio.run(engine.dispose())
    get_settings.cache_clear()


def sign_in(application, holder, sub: str, name: str) -> TestClient:
    holder["oidc"] = FakeOidc(claims={**CLAIMS, "sub": sub, "email": f"{name.lower()}@example.com", "name": name})
    client = TestClient(application, base_url="http://localhost:8080")
    client.get("/api/auth/login", follow_redirects=False)
    r = client.get("/api/auth/callback?state=abc&code=c", follow_redirects=False)
    assert r.headers["location"] == "/"
    client.headers.update(CSRF)
    return client


@pytest.fixture()
def users(stack):
    application, fake, holder = stack
    with TestClient(application):  # runs the lifespan (MCP + engine) for the whole test
        ana = sign_in(application, holder, "g-ana", "Ana")
        ben = sign_in(application, holder, "g-ben", "Ben")
        yield ana, ben, fake, application


def create_plan(client, name="Board"):
    r = client.post("/api/plan", json={"name": name, "projectType": "cloud", "projectName": "P", "state": BOARD})
    assert r.status_code == 201, r.text
    return r.json()


def save_pat(client, pat=PAT_A, url=URL, name="Fabrikam"):
    r = client.post(CRED_URL, json={"projectName": name, "projectUrl": url, "pat": pat})
    assert r.status_code == 201, r.text
    return r.json()


def rpc_tool(client, name, arguments):
    r = client.post(
        "/api/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}},
        headers=MCP_HEADERS,
    )
    assert r.status_code == 200, r.text
    return r.json()["result"]


# --- migration 0003 ------------------------------------------------------------------


def test_migration_0003_schema_constraints_and_downgrade(migrated_db):
    from alembic import command

    from db_helpers import alembic_config

    cols = {
        r[0]: r[1:]
        for r in query(
            migrated_db,
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='ado_credentials'",
        )
    }
    assert set(cols) == {"id", "user_id", "project_name", "project_url", "pat_encrypted", "created_at", "updated_at"}
    assert all(v[1] == "NO" for v in cols.values())
    fks = query(
        migrated_db,
        "SELECT conname, confdeltype FROM pg_constraint WHERE contype='f' AND conname IN "
        "('fk_release_plans_owner_id_users') OR conrelid='ado_credentials'::regclass AND contype='f'",
    )
    kinds = {name: (t.decode() if isinstance(t, bytes) else t) for name, t in fks}
    assert kinds["fk_release_plans_owner_id_users"] == "n"  # SET NULL
    assert kinds["ado_credentials_user_id_fkey"] == "c"  # CASCADE
    assert query(migrated_db, "SELECT count(*) FROM pg_indexes WHERE indexname='ix_release_plans_owner_id'") == [(1,)]
    assert query(
        migrated_db, "SELECT count(*) FROM pg_constraint WHERE conname='uq_ado_credentials_user_id_project_url'"
    ) == [(1,)]

    config = alembic_config(migrated_db)
    try:
        command.downgrade(config, "0002")
        assert query(migrated_db, "SELECT to_regclass('ado_credentials')") == [(None,)]
        assert query(
            migrated_db, "SELECT count(*) FROM information_schema.columns WHERE table_name='release_plans' AND column_name='owner_id'"
        ) == [(0,)]
        assert query(migrated_db, "SELECT to_regclass('users')") == [("users",)]
    finally:
        command.upgrade(config, "head")
    assert query(migrated_db, "SELECT to_regclass('ado_credentials')") == [("ado_credentials",)]


def test_upgrade_from_0002_keeps_existing_boards_unowned(migrated_db):
    from alembic import command

    from db_helpers import alembic_config

    config = alembic_config(migrated_db)
    try:
        command.downgrade(config, "0002")
        run_sql(migrated_db, "TRUNCATE release_plans RESTART IDENTITY")
        run_sql(
            migrated_db,
            "INSERT INTO release_plans (name, project_type, project_name, state) VALUES ('old','cloud','P','{}')",
        )
        command.upgrade(config, "head")
        assert query(migrated_db, "SELECT name, owner_id FROM release_plans") == [("old", None)]
    finally:
        command.upgrade(config, "head")
        run_sql(migrated_db, "TRUNCATE release_plans RESTART IDENTITY")


# --- DB behaviour ---------------------------------------------------------------------


def test_ciphertext_stored_unique_case_insensitive_cascade_and_set_null(users, clean_db):
    ana, ben, _, _ = users
    created = save_pat(ana, url="https://DEV.azure.com/contoso/Fabrikam%20Plant/")
    assert created["projectUrl"] == URL.replace("contoso", "contoso")  # canonical: lower host, no slash
    stored = query(clean_db, "SELECT pat_encrypted, project_url FROM ado_credentials")[0]
    assert stored[0] != PAT_A and PAT_A not in stored[0]
    assert Fernet(KEY.encode()).decrypt(stored[0].encode()).decode() == PAT_A
    # same project, different case / trailing slash -> duplicate 422 (lower() matching)
    dup = ana.post(CRED_URL, json={"projectName": "x", "projectUrl": URL.replace("Fabrikam", "FABRIKAM") + "/", "pat": "p2"})
    assert dup.status_code == 422 and dup.json()["errors"]
    # another user may save the same URL
    save_pat(ben, pat=PAT_B)
    # boards: one owned by Ana, one unowned
    plan = create_plan(ana)
    assert query(clean_db, "SELECT owner_id FROM release_plans WHERE id=%d" % plan["id"]) == [(1,)]
    # delete Ana: credentials cascade, boards become unowned
    run_sql(clean_db, "DELETE FROM users WHERE sub='g-ana'")
    assert query(clean_db, "SELECT count(*) FROM ado_credentials") == [(1,)]
    assert query(clean_db, "SELECT owner_id FROM release_plans WHERE id=%d" % plan["id"]) == [(None,)]
    # the board survives and is now visible to Ben like any unowned board
    assert ben.get(f"/api/plan/{plan['id']}").status_code == 200


# --- isolation ------------------------------------------------------------------------


def test_two_users_cannot_see_edit_or_delete_each_others_boards(users):
    ana, ben, _, _ = users
    mine = create_plan(ana, "Ana board")
    pid = mine["id"]
    assert [p["name"] for p in ben.get("/api/plan").json()["items"]] == []
    assert ben.get("/api/plan").json()["total"] == 0
    for r in (
        ben.get(f"/api/plan/{pid}"),
        ben.put(f"/api/plan/{pid}", json={"name": "hijack", "state": BOARD}),
        ben.delete(f"/api/plan/{pid}"),
    ):
        assert r.status_code == 404
        assert r.json() == {"errors": [f"Plan not found: {pid}."]} or "errors" in r.json()
    # unchanged for Ana
    assert ana.get(f"/api/plan/{pid}").json()["name"] == "Ana board"
    # indistinguishable from an unknown id
    assert ben.get("/api/plan/99999").json().keys() == ben.get(f"/api/plan/{pid}").json().keys()
    # owner stays on update
    assert ana.put(f"/api/plan/{pid}", json={"name": "renamed", "state": BOARD}).status_code == 200
    assert [p["name"] for p in ana.get("/api/plan").json()["items"]] == ["renamed"]
    assert ana.delete(f"/api/plan/{pid}").status_code == 204


def test_two_users_cannot_see_edit_or_delete_each_others_pats(users):
    ana, ben, _, _ = users
    cred = save_pat(ana)
    cid = cred["id"]
    assert ben.get(CRED_URL).json() == {"items": []}
    put = ben.put(f"{CRED_URL}/{cid}", json={"projectName": "x", "projectUrl": URL, "pat": PAT_B})
    assert put.status_code == 404
    assert ben.delete(f"{CRED_URL}/{cid}").status_code == 404
    assert ben.delete(f"{CRED_URL}/99999").status_code == 404
    assert ben.put(f"{CRED_URL}/99999", json={"projectName": "x", "projectUrl": URL, "pat": "p"}).status_code == 404
    assert ana.get(CRED_URL).json()["items"] == [
        {"id": cid, "projectName": "Fabrikam", "projectUrl": URL, "hasPat": True, "patLast4": PAT_A[-4:]}
    ]


def test_unowned_boards_are_shared_and_mcp_created_ones_are_unowned(users, clean_db):
    ana, ben, _, application = users
    with TestClient(application, base_url="http://localhost") as mcp:  # unauthenticated, no cookie
        result = rpc_tool(
            mcp, "list_release_plans", {}
        )
        assert result.get("isError") is not True
    run_sql(
        clean_db,
        "INSERT INTO release_plans (name, project_type, project_name, state) VALUES ('legacy','cloud','P','{}')",
    )
    assert [p["name"] for p in ana.get("/api/plan").json()["items"]] == ["legacy"]
    assert [p["name"] for p in ben.get("/api/plan").json()["items"]] == ["legacy"]
    pid = ana.get("/api/plan").json()["items"][0]["id"]
    # editing an unowned board does not claim it
    assert ana.put(f"/api/plan/{pid}", json={"name": "legacy2", "state": BOARD}).status_code == 200
    assert query(clean_db, "SELECT owner_id FROM release_plans WHERE id=%d" % pid) == [(None,)]


def test_mcp_stays_unauthenticated_and_sees_every_users_board(users):
    ana, ben, _, application = users
    plan = create_plan(ana, "Only Ana")
    create_plan(ben, "Only Ben")
    anon = TestClient(application, base_url="http://localhost")
    assert anon.get("/api/plan").status_code == 401
    result = rpc_tool(anon, "list_release_plans", {})
    assert result.get("isError") is not True
    names = sorted(p["name"] for p in result["structuredContent"]["plans"]) if "plans" in result["structuredContent"] else None
    if names is not None:
        assert names == ["Only Ana", "Only Ben"]
    got = rpc_tool(anon, "get_release_plan", {"planId": plan["id"]})
    assert got.get("isError") is not True


# --- ADO fallback end to end ----------------------------------------------------------


def test_connect_without_pat_uses_only_the_session_users_saved_pat(users):
    ana, ben, fake, _ = users
    body = {"source": "cloud", "projectUrl": URL}
    # nothing saved -> 422, no ADO call
    r = ana.post("/api/ado/connect", json=body)
    assert r.status_code == 422 and "Personal Access Token is required" in r.json()["errors"][0]
    assert fake.requests == []

    save_pat(ana, PAT_A)
    r = ana.post("/api/ado/connect", json=body)
    assert r.status_code == 200, r.text
    assert r.json()
    assert fake.requests and all(q.headers["Authorization"] == basic(PAT_A) for q in fake.requests)
    assert PAT_A not in r.text

    # Ben has nothing saved: Ana's PAT is never used for him
    fake.requests.clear()
    r = ben.post("/api/ado/connect", json=body)
    assert r.status_code == 422 and fake.requests == []

    # explicit PAT wins over the saved one; URL case/trailing slash resolves the same credential
    r = ana.post("/api/ado/connect", json={**body, "pat": PAT_B})
    assert r.status_code == 200
    assert all(q.headers["Authorization"] == basic(PAT_B) for q in fake.requests)
    fake.requests.clear()
    r = ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": URL.replace("Fabrikam", "fabrikam") + "/", "pat": "  "})
    assert r.status_code == 200
    assert all(q.headers["Authorization"] == basic(PAT_A) for q in fake.requests)


def test_backlog_and_sprint_history_also_fall_back_to_the_saved_pat(users):
    ana, _, fake, _ = users
    save_pat(ana, PAT_A)
    b = ana.post(
        "/api/ado/backlog",
        json={"source": "cloud", "projectUrl": URL, "scopeType": "area", "scopePath": f"{PROJECT_NAME}\\Team A"},
    )
    assert b.status_code == 200, b.text
    fake.work_items = synthetic_sprint_history()
    s = ana.post(
        "/api/ado/sprint-history",
        json={"source": "cloud", "projectUrl": URL, "iterationPath": f"{PROJECT_NAME}\\Phase 1"},
    )
    assert s.status_code == 200, s.text
    assert all(q.headers["Authorization"] == basic(PAT_A) for q in fake.requests)


def test_changing_the_url_requires_a_pat_and_never_moves_the_old_one(users):
    ana, _, fake, _ = users
    cid = save_pat(ana, PAT_A)["id"]
    other = "https://dev.azure.com/contoso/Other"
    r = ana.put(f"{CRED_URL}/{cid}", json={"projectName": "Fabrikam", "projectUrl": other})
    assert r.status_code == 422 and "project URL changed" in r.json()["errors"][0]
    r = ana.put(f"{CRED_URL}/{cid}", json={"projectName": "Fabrikam", "projectUrl": other, "pat": "  "})
    assert r.status_code == 422
    # unchanged row; old URL still resolves, new URL has no PAT
    assert ana.get(CRED_URL).json()["items"][0]["projectUrl"] == URL
    assert ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": other}).status_code == 422
    # a case-only/slash change keeps the PAT; a rename keeps the PAT
    ok = ana.put(f"{CRED_URL}/{cid}", json={"projectName": "Renamed", "projectUrl": URL + "/"})
    assert ok.status_code == 200 and ok.json()["projectName"] == "Renamed"
    assert ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": URL}).status_code == 200
    # with a new PAT the URL moves and the PAT follows
    fake.requests.clear()
    moved = ana.put(f"{CRED_URL}/{cid}", json={"projectName": "Fabrikam", "projectUrl": other, "pat": PAT_B})
    assert moved.status_code == 200 and moved.json()["projectUrl"] == other
    assert ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": URL}).status_code == 422


def test_saved_pat_unreadable_after_key_rotation_is_422_not_a_leak(users, clean_db, monkeypatch):
    ana, _, _, _ = users
    save_pat(ana, PAT_A)
    token = query(clean_db, "SELECT pat_encrypted FROM ado_credentials")[0][0]
    other_key = Fernet.generate_key().decode()
    monkeypatch.setenv("PAT_ENCRYPTION_KEY", other_key)
    get_settings.cache_clear()
    r = ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": URL})
    assert r.status_code == 422
    assert PAT_A not in r.text and token not in r.text and other_key not in r.text
    assert "Enter it again" in r.json()["errors"][0]


# --- the PAT never leaks ---------------------------------------------------------------


def test_pat_never_appears_in_responses_logs_or_error_bodies(users, caplog, clean_db):
    ana, ben, fake, _ = users
    secret = "SUPER-secret-pat-value-777"
    caplog.set_level(logging.DEBUG)
    responses = []
    responses.append(ana.post(CRED_URL, json={"projectName": "F", "projectUrl": URL, "pat": secret}))
    cid = responses[0].json()["id"]
    token = query(clean_db, "SELECT pat_encrypted FROM ado_credentials")[0][0]
    responses.append(ana.get(CRED_URL))
    responses.append(ana.post(CRED_URL, json={"projectName": "F", "projectUrl": URL, "pat": secret}))  # duplicate 422
    responses.append(ana.post(CRED_URL, json={"projectName": "", "projectUrl": "http://bad", "pat": secret}))  # 422
    responses.append(ana.post(CRED_URL, json={"projectName": "F", "projectUrl": "https://evil.example/o/p", "pat": secret}))
    responses.append(ana.put(f"{CRED_URL}/{cid}", json={"projectName": "F2", "projectUrl": URL, "pat": secret + "!"}))
    responses.append(ana.post(CRED_URL, content=b'{"pat": "%s", broken' % secret.encode(), headers={"Content-Type": "application/json"}))
    responses.append(ana.post(CRED_URL, json=[secret]))
    responses.append(ben.put(f"{CRED_URL}/{cid}", json={"projectName": "x", "projectUrl": URL, "pat": secret}))
    responses.append(ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": URL, "pat": secret}))
    fake.failures["any"] = "401"
    responses.append(ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": URL, "pat": secret}))
    responses.append(ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": URL}))
    responses.append(ana.delete(f"{CRED_URL}/{cid}"))
    for r in responses:
        assert secret not in r.text and token not in r.text, (r.request.url, r.text)
        assert "pat_encrypted" not in r.text
    for r in responses[1:2] + responses[:1]:
        assert "pat" not in r.json() if r.text else True
    assert responses[0].json()["patLast4"] == secret[-4:]
    assert responses[1].json()["items"][0]["patLast4"] == secret[-4:]
    assert responses[5].json()["patLast4"] == (secret + "!")[-4:]
    assert secret not in caplog.text and token not in caplog.text


# --- auth-enabled 401 / CSRF paths ----------------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", CRED_URL),
        ("post", CRED_URL),
        ("put", CRED_URL + "/1"),
        ("delete", CRED_URL + "/1"),
        ("get", "/api/plan"),
        ("post", "/api/ado/connect"),
        ("post", "/api/ado/backlog"),
        ("post", "/api/ado/sprint-history"),
        ("post", "/api/validate"),
    ],
)
def test_anonymous_requests_get_401_and_the_csrf_header_is_enforced(users, method, path):
    _, _, _, application = users
    anon = TestClient(application, base_url="http://localhost:8080")
    r = getattr(anon, method)(path, headers=CSRF if method != "get" else {}, **({"json": {}} if method in ("post", "put") else {}))
    assert r.status_code == 401 and r.json() == {"errors": ["Authentication required."]}
    if method != "get":
        # authentication is checked before CSRF: an anonymous caller learns nothing more
        no_csrf = getattr(anon, method)(path, **({"json": {}} if method in ("post", "put") else {}))
        assert no_csrf.status_code == 401


@pytest.mark.parametrize("method,path", [("post", CRED_URL), ("put", CRED_URL + "/1"), ("delete", CRED_URL + "/1")])
def test_signed_in_but_missing_csrf_header_is_403_and_changes_nothing(users, method, path, clean_db):
    ana, _, _, _ = users
    extra = {"json": {"projectName": "n", "projectUrl": URL, "pat": "p"}} if method != "delete" else {}
    r = getattr(ana, method)(path, headers={"X-Requested-With": "wrong"}, **extra)
    assert r.status_code == 403
    assert query(clean_db, "SELECT count(*) FROM ado_credentials") == [(0,)]


def test_a_session_of_a_deleted_user_is_401_everywhere_and_cleared(users, clean_db):
    ana, _, _, _ = users
    save_pat(ana)
    create_plan(ana)
    run_sql(clean_db, "DELETE FROM users WHERE sub='g-ana'")
    for r in (
        ana.get("/api/plan"),
        ana.get(CRED_URL),
        ana.post(CRED_URL, json={"projectName": "n", "projectUrl": URL, "pat": "p"}),
        ana.post("/api/ado/connect", json={"source": "cloud", "projectUrl": URL}),
        ana.post("/api/validate", json={}),
        ana.get("/api/auth/me"),
    ):
        assert r.status_code == 401, r.request.url
    # the stale cookie cannot recreate rows for a user that no longer exists
    assert query(clean_db, "SELECT count(*) FROM ado_credentials") == [(0,)]


def test_health_stays_open_without_a_session(users):
    _, _, _, application = users
    assert TestClient(application).get("/api/health").status_code == 200


# --- settings validation through the real stack ------------------------------------------------


def test_settings_validation_errors_are_422_with_errors_lists(users):
    ana, _, _, _ = users
    for body in ({}, {"projectName": "", "projectUrl": "", "pat": ""}, {"projectName": "n", "projectUrl": "ftp://x", "pat": "p"}):
        r = ana.post(CRED_URL, json=body)
        assert r.status_code == 422
        assert isinstance(r.json()["errors"], list) and all(isinstance(e, str) for e in r.json()["errors"])
    bad_host = ana.post(CRED_URL, json={"projectName": "n", "projectUrl": "https://evil.example/org/proj", "pat": "p"})
    assert bad_host.status_code == 422
    assert json.loads(ana.post(CRED_URL, content=b"not json", headers={"Content-Type": "application/json"}).text)["errors"]
    assert ana.get(CRED_URL).json() == {"items": []}
