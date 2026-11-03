"""Integration / end-to-end tests of the `/api/plan` router against a real
PostgreSQL (marker `db`), driven only through HTTP."""
import copy
import threading
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.db import get_session
from app.main import app

pytestmark = pytest.mark.db

BOARD = {
    "schema": "release-planner-features",
    "version": 1,
    "mode": "features",
    "name": "Proj – Feature Release Plan ✓",
    "source": {"kind": "cloud", "projectName": "Pröj 日本語 🚀", "url": "https://dev.azure.com/org/Proj"},
    "iterations": [{"id": "i1", "name": "Sprint 1", "path": "Proj\\Sprint 1", "start": None, "end": None}],
    "milestones": [{"id": "m1", "name": "MVP", "iterationIds": ["i1"], "nested": {"a": [1, 2.5, None, True, {"b": "ü"}]}}],
    "flags": [],
    "epics": [{"id": 1, "title": "Épico \"quoted\" \\ back\\slash\nnewline", "features": [{"id": 2, "title": "F", "milestoneId": "m1"}]}],
    "savedAt": "2026-11-03T10:00:00.000Z",
}


def create(client, name="Plan", state=None, project_type="cloud", project_name="Proj"):
    r = client.post("/api/plan", json={"name": name, "projectType": project_type, "projectName": project_name, "state": state or BOARD})
    assert r.status_code == 201, r.text
    return r.json()


def test_full_lifecycle_and_roundtrip(db_client):
    created = create(db_client, name="  Padded  ", project_name="  Pröj  ")
    pid = created["id"]
    assert created["name"] == "Padded" and created["projectName"] == "Pröj"
    assert created["state"] == BOARD
    assert created["createdAt"].endswith("Z") or created["createdAt"].endswith("+00:00")

    got = db_client.get(f"/api/plan/{pid}").json()
    assert got == created

    listed = db_client.get("/api/plan?page=1").json()
    assert listed["total"] == 1 and listed["page"] == 1 and listed["pageSize"] == 10
    assert "state" not in listed["items"][0]
    assert listed["items"][0]["id"] == pid

    new_state = copy.deepcopy(BOARD)
    new_state["epics"] = []
    upd = db_client.put(f"/api/plan/{pid}", json={"name": "Renamed", "projectType": "onprem", "projectName": "X", "state": new_state})
    assert upd.status_code == 200
    body = upd.json()
    assert body["name"] == "Renamed" and body["state"] == new_state
    assert body["projectType"] == "cloud" and body["projectName"] == "Pröj"
    assert body["createdAt"] == created["createdAt"]
    assert body["updatedAt"] > created["updatedAt"]

    d = db_client.delete(f"/api/plan/{pid}")
    assert d.status_code == 204 and d.content == b""
    gone = {"errors": [f"Release plan not found: {pid}."]}
    for resp in (
        db_client.get(f"/api/plan/{pid}"),
        db_client.put(f"/api/plan/{pid}", json={"name": "n", "state": BOARD}),
        db_client.delete(f"/api/plan/{pid}"),
    ):
        assert resp.status_code == 404 and resp.json() == gone
    assert db_client.get("/api/plan").json()["total"] == 0


def test_list_pagination_and_ordering_after_updates(db_client):
    ids = [create(db_client, name=f"P{i}")["id"] for i in range(12)]
    page1 = db_client.get("/api/plan?page=1").json()
    page2 = db_client.get("/api/plan?page=2").json()
    assert page1["total"] == 12
    assert [i["id"] for i in page1["items"]] == ids[::-1][:10]
    assert [i["id"] for i in page2["items"]] == ids[::-1][10:]
    assert db_client.get("/api/plan?page=3").json()["items"] == []

    time.sleep(0.01)
    db_client.put(f"/api/plan/{ids[0]}", json={"name": "bumped", "state": BOARD})
    time.sleep(0.01)
    db_client.put(f"/api/plan/{ids[3]}", json={"name": "bumped2", "state": BOARD})
    order = [i["id"] for i in db_client.get("/api/plan?page=1").json()["items"]]
    assert order[:2] == [ids[3], ids[0]]
    assert order[2:] == ids[::-1][:8]
    # no overlap between pages
    all_ids = order + [i["id"] for i in db_client.get("/api/plan?page=2").json()["items"]]
    assert sorted(all_ids) == sorted(ids)


@pytest.mark.parametrize("bad", ["0", "-1", "abc", ""])
def test_list_bad_page_is_422_errors(db_client, bad):
    r = db_client.get(f"/api/plan?page={bad}")
    assert r.status_code == 422
    assert r.json()["errors"] and all(isinstance(e, str) for e in r.json()["errors"])


def test_non_integer_id_is_422(db_client):
    for method in ("get", "delete"):
        r = getattr(db_client, method)("/api/plan/abc")
        assert r.status_code == 422 and list(r.json()) == ["errors"]


def test_validation_errors_do_not_persist(db_client):
    r = db_client.post("/api/plan", json={"name": " ", "projectType": "cloud", "projectName": "", "state": {"schema": "x"}})
    assert r.status_code == 422
    assert r.json()["errors"] == ["Plan name is required.", "Project name is required.", "Plan state is not a release plan."]
    r = db_client.post("/api/plan", json={"name": "n", "projectType": "other", "projectName": "p", "state": BOARD})
    assert r.status_code == 422 and list(r.json()) == ["errors"]
    r = db_client.post("/api/plan", content=b"not json", headers={"content-type": "application/json"})
    assert r.status_code == 422 and list(r.json()) == ["errors"]
    assert db_client.get("/api/plan").json()["total"] == 0


def test_state_size_limit_boundary(db_client):
    big = {"schema": "release-planner-features", "blob": "x" * (5 * 1024 * 1024 + 10)}
    r = db_client.post("/api/plan", json={"name": "n", "projectType": "cloud", "projectName": "p", "state": big})
    assert r.status_code == 422 and r.json() == {"errors": ["Plan state is too large (max 5 MiB)."]}
    ok = {"schema": "release-planner-features", "blob": "x" * (1024 * 1024)}
    pid = create(db_client, state=ok)["id"]
    assert db_client.get(f"/api/plan/{pid}").json()["state"] == ok


def test_name_length_boundaries(db_client):
    assert create(db_client, name="a" * 200)["name"] == "a" * 200
    r = db_client.post("/api/plan", json={"name": "a" * 201, "projectType": "cloud", "projectName": "p", "state": BOARD})
    assert r.json() == {"errors": ["Plan name must be at most 200 characters."]}
    r = db_client.post("/api/plan", json={"name": "n", "projectType": "cloud", "projectName": "p" * 201, "state": BOARD})
    assert r.json() == {"errors": ["Project name must be at most 200 characters."]}


@pytest.mark.parametrize("pid", ["0", "-5", "2147483648", "99999999999999999999"])
def test_out_of_range_id_is_404(db_client, pid):
    gone = {"errors": [f"Release plan not found: {pid}."]}
    assert db_client.get(f"/api/plan/{pid}").json() == gone
    assert db_client.put(f"/api/plan/{pid}", json={"name": "n", "state": BOARD}).status_code == 404
    assert db_client.delete(f"/api/plan/{pid}").status_code == 404


def test_max_int32_id_is_plain_404(db_client):
    assert db_client.get("/api/plan/2147483647").status_code == 404


def test_nul_character_is_422_with_messages(db_client):
    c = TestClient(app, raise_server_exceptions=False)
    nested = {"schema": "release-planner-features", "a": [{"k\u0000ey": 1}], "b": {"c": ["x\u0000"]}}
    for state in ({"schema": "release-planner-features", "t": "a\u0000b"}, nested):
        r = c.post("/api/plan", json={"name": "n", "projectType": "cloud", "projectName": "p", "state": state})
        assert r.status_code == 422 and r.json() == {"errors": ["Plan state contains invalid characters."]}
    r = c.post("/api/plan", json={"name": "a\u0000b", "projectType": "cloud", "projectName": "p\u0000", "state": BOARD})
    assert r.status_code == 422
    assert r.json() == {"errors": ["Plan name contains invalid characters.", "Project name contains invalid characters."]}
    pid = create(db_client)["id"]
    r = c.put(f"/api/plan/{pid}", json={"name": "a\u0000", "state": BOARD})
    assert r.status_code == 422 and r.json() == {"errors": ["Plan name contains invalid characters."]}
    assert db_client.get(f"/api/plan/{pid}").json()["name"] == "Plan"
    assert db_client.get("/api/plan").json()["total"] == 1


def test_concurrent_puts_last_write_wins(db_client):
    pid = create(db_client)["id"]
    results = []

    def put(i):
        st = copy.deepcopy(BOARD)
        st["marker"] = i
        results.append(TestClient(app).put(f"/api/plan/{pid}", json={"name": f"n{i}", "state": st}))

    threads = [threading.Thread(target=put, args=(i,)) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert all(r.status_code == 200 for r in results)
    final = db_client.get(f"/api/plan/{pid}").json()
    assert final["state"]["marker"] == int(final["name"][1:])  # name and state from the same write


def test_concurrent_creates_get_distinct_ids(db_client):
    db_client.get("/api/plan")  # warm the engine (first-connect init is not safe across event loops)
    out = []
    threads = [threading.Thread(target=lambda i=i: out.append(TestClient(app).post("/api/plan", json={"name": f"n{i}", "projectType": "cloud", "projectName": "p", "state": BOARD}))) for i in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    ids = {r.json()["id"] for r in out}
    assert len(ids) == 8 and db_client.get("/api/plan").json()["total"] == 8


def test_unreachable_database_is_503_via_real_connection(clean_db):
    engine = create_async_engine("postgresql+asyncpg://u:p@127.0.0.1:1/none", poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override():
        async with factory() as session:
            yield session

    app.dependency_overrides[get_session] = override
    try:
        c = TestClient(app, raise_server_exceptions=False)
        calls = [
            c.get("/api/plan"),
            c.get("/api/plan/1"),
            c.post("/api/plan", json={"name": "n", "projectType": "cloud", "projectName": "p", "state": BOARD}),
            c.put("/api/plan/1", json={"name": "n", "state": BOARD}),
            c.delete("/api/plan/1"),
        ]
    finally:
        app.dependency_overrides.pop(get_session, None)
    for r in calls:
        assert r.status_code == 503, r.text
        assert r.json() == {"errors": ["The release plan database is unavailable."]}
