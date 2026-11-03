import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.db import get_session
from app.main import app

STATE = {"schema": "release-planner-features", "milestones": []}
UNAVAILABLE = {"errors": ["The release plan database is unavailable."]}


def body(**overrides):
    return {"name": "Plan", "projectType": "onprem", "projectName": "Proj", "state": STATE, **overrides}


# --- 503 mapping (no database needed) --------------------------------------


def _failing_session(exc: Exception):
    async def override():
        raise exc
        yield  # pragma: no cover

    return override


async def _unused_session():
    yield None  # validation fails before the session is touched


@pytest.mark.parametrize(
    "exc",
    [OperationalError("SELECT 1", {}, ConnectionRefusedError("refused")), ConnectionRefusedError("refused")],
)
@pytest.mark.parametrize(
    "call",
    [
        lambda c: c.get("/api/plan"),
        lambda c: c.get("/api/plan/1"),
        lambda c: c.post("/api/plan", json=body()),
        lambda c: c.put("/api/plan/1", json=body()),
        lambda c: c.delete("/api/plan/1"),
    ],
)
def test_connection_failure_is_503(exc, call):
    app.dependency_overrides[get_session] = _failing_session(exc)
    try:
        response = call(TestClient(app))
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert response.status_code == 503
    assert response.json() == UNAVAILABLE


def test_health_does_not_need_db():
    assert TestClient(app).get("/api/health").status_code == 200


# --- Request validation reached before any DB use --------------------------


def test_field_errors_are_exact_and_collected():
    app.dependency_overrides[get_session] = _unused_session
    try:
        response = TestClient(app).post("/api/plan", json={"name": " ", "projectName": "", "state": {}})
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert response.status_code == 422
    assert response.json() == {
        "errors": ["Plan name is required.", "Project name is required.", "Plan state is not a release plan."]
    }


def test_invalid_project_type_uses_handler_format():
    app.dependency_overrides[get_session] = _unused_session
    try:
        response = TestClient(app).post("/api/plan", json=body(projectType="hybrid"))
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert response.status_code == 422
    (message,) = response.json()["errors"]
    assert message.startswith("Invalid request: body.projectType: ")


def test_bad_page_and_bad_id_use_handler_format():
    client = TestClient(app)
    for url, loc in [("/api/plan?page=0", "query.page"), ("/api/plan?page=x", "query.page"), ("/api/plan/abc", "path.plan_id")]:
        response = client.get(url)
        assert response.status_code == 422
        assert response.json()["errors"][0].startswith(f"Invalid request: {loc}: ")


# --- With a database --------------------------------------------------------

db = pytest.mark.db


@db
def test_crud_flow(db_client):
    created = db_client.post("/api/plan", json=body(name="  Plan  ", projectName=" Proj "))
    assert created.status_code == 201
    plan = created.json()
    assert plan["name"] == "Plan" and plan["projectName"] == "Proj"
    assert plan["state"] == STATE and plan["createdAt"].endswith("Z")
    url = f"/api/plan/{plan['id']}"

    assert db_client.get(url).json() == plan

    updated = db_client.put(url, json={"name": "New", "state": {**STATE, "x": 1}, "projectType": "cloud", "projectName": "Z"})
    assert updated.status_code == 200
    data = updated.json()
    assert data["name"] == "New" and data["projectType"] == "onprem" and data["projectName"] == "Proj"
    assert data["updatedAt"] > data["createdAt"]
    assert data["state"]["x"] == 1

    deleted = db_client.delete(url)
    assert deleted.status_code == 204 and deleted.content == b""
    assert db_client.get(url).status_code == 404


@db
@pytest.mark.parametrize("method", ["get", "put", "delete"])
def test_unknown_id_is_404(db_client, method):
    kwargs = {"json": {"name": "x", "state": STATE}} if method == "put" else {}
    response = getattr(db_client, method)("/api/plan/12", **kwargs)
    assert response.status_code == 404
    assert response.json() == {"errors": ["Release plan not found: 12."]}


@db
def test_list_pagination_and_order(db_client):
    ids = [db_client.post("/api/plan", json=body(name=f"n{i}")).json()["id"] for i in range(11)]
    first = db_client.get("/api/plan").json()
    assert first["total"] == 11 and first["page"] == 1 and first["pageSize"] == 10
    assert [i["id"] for i in first["items"]] == ids[::-1][:10]
    assert "state" not in first["items"][0]
    assert [i["id"] for i in db_client.get("/api/plan?page=2").json()["items"]] == [ids[0]]
    assert db_client.get("/api/plan?page=5").json()["items"] == []
    db_client.put(f"/api/plan/{ids[0]}", json={"name": "n0", "state": STATE})
    assert db_client.get("/api/plan").json()["items"][0]["id"] == ids[0]


@db
def test_put_validation_errors(db_client):
    plan_id = db_client.post("/api/plan", json=body()).json()["id"]
    response = db_client.put(f"/api/plan/{plan_id}", json={"name": "a" * 201, "state": {"schema": "x"}})
    assert response.status_code == 422
    assert response.json() == {
        "errors": ["Plan name must be at most 200 characters.", "Plan state is not a release plan."]
    }


@pytest.mark.parametrize("method", ["get", "put", "delete"])
@pytest.mark.parametrize("plan_id", [99999999999, 2147483648, 0, -5])
def test_out_of_range_id_is_404(method, plan_id):
    app.dependency_overrides[get_session] = _unused_session
    try:
        kwargs = {"json": {"name": "x", "state": STATE}} if method == "put" else {}
        response = getattr(TestClient(app), method)(f"/api/plan/{plan_id}", **kwargs)
    finally:
        app.dependency_overrides.pop(get_session, None)
    assert response.status_code == 404
    assert response.json() == {"errors": [f"Release plan not found: {plan_id}."]}


@pytest.mark.parametrize("method", ["post", "put"])
def test_nul_characters_are_422(method):
    app.dependency_overrides[get_session] = _unused_session
    try:
        payload = body(name="a\x00", projectName="p\x00", state={**STATE, "x": {"y\x00": 1}})
        url = "/api/plan" if method == "post" else "/api/plan/1"
        response = getattr(TestClient(app), method)(url, json=payload)
    finally:
        app.dependency_overrides.pop(get_session, None)
    expected = ["Plan name contains invalid characters."]
    if method == "post":
        expected.append("Project name contains invalid characters.")
    expected.append("Plan state contains invalid characters.")
    assert response.status_code == 422
    assert response.json() == {"errors": expected}
