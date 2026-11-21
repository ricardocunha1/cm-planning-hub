"""Unit tests for plan owner scoping (services/plans.py, plan_routes.py) and
the user-row check of `require_user`. Scripted session, no PostgreSQL."""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.api import plan_routes
from app.api.deps import ApiError, require_user
from app.config import Settings
from app.models import ReleasePlanRow, User
from app.services import plans
from fake_session import FakeSession

STATE = {"schema": "release-planner-features", "milestones": []}
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)


def run(coro):
    return asyncio.run(coro)


def plan_row(id: int = 4, owner_id: int | None = 1) -> ReleasePlanRow:
    return ReleasePlanRow(
        id=id, name="Board", project_type="cloud", project_name="P", state=STATE,
        created_at=NOW, updated_at=NOW, owner_id=owner_id,
    )


VISIBLE = "release_plans.owner_id = 5 OR release_plans.owner_id IS NULL"


# --- services/plans.py ------------------------------------------------------------


def scoped(sql: str) -> bool:
    """Whether the statement filters on the owner (the column list also names owner_id)."""
    return "owner_id =" in sql or "owner_id IS NULL" in sql


def test_list_filters_count_and_page_to_own_and_unowned_plans():
    session = FakeSession([plan_row()], scalar_value=1)
    items, total = run(plans.list_plans(session, 1, owner_id=5))
    assert total == 1 and len(items) == 1
    assert VISIBLE in session.sql(0) and VISIBLE in session.sql(1)


def test_list_without_an_owner_is_unscoped():
    session = FakeSession([plan_row()], scalar_value=1)
    run(plans.list_plans(session, 1))
    assert all(not scoped(session.sql(i)) for i in (0, 1))


def test_get_applies_the_visibility_filter():
    session = FakeSession([plan_row(4, owner_id=None)])
    assert run(plans.get_plan(session, 4, 5)).id == 4
    assert "release_plans.id = 4 AND (" + VISIBLE + ")" in session.sql()


def test_get_of_a_plan_owned_by_someone_else_is_none():
    assert run(plans.get_plan(FakeSession([]), 4, 5)) is None


def test_get_without_owner_is_unscoped():
    session = FakeSession([plan_row(owner_id=9)])
    assert run(plans.get_plan(session, 4)).id == 4
    assert not scoped(session.sql())


@pytest.mark.parametrize("plan_id", [0, -1, 2**31])
def test_impossible_ids_never_query(plan_id):
    session = FakeSession([plan_row()])
    assert run(plans.get_plan(session, plan_id, 5)) is None
    assert run(plans.update_plan(session, plan_id, "n", STATE, 5)) is None
    assert run(plans.delete_plan(session, plan_id, 5)) is False
    assert session.statements == []


def test_create_sets_the_owner():
    session = FakeSession()
    run(plans.create_plan(session, " N ", "cloud", " P ", STATE, owner_id=5))
    assert session.added[0].owner_id == 5 and session.added[0].name == "N"


def test_create_without_an_owner_is_unowned():
    session = FakeSession()
    run(plans.create_plan(session, "N", "cloud", "P", STATE))
    assert session.added[0].owner_id is None


def test_update_of_an_invisible_plan_is_none_and_writes_nothing():
    session = FakeSession([])
    assert run(plans.update_plan(session, 4, "n", STATE, 5)) is None
    assert session.commits == 0 and VISIBLE in session.sql()


def test_update_keeps_the_owner():
    existing = plan_row(owner_id=None)
    updated = run(plans.update_plan(FakeSession([existing]), 4, " New ", STATE, 5))
    assert updated.name == "New" and existing.owner_id is None


def test_update_without_an_owner_can_edit_any_plan_as_mcp_does():
    session = FakeSession([plan_row(owner_id=9)])
    assert run(plans.update_plan(session, 4, "n", STATE)) is not None
    assert not scoped(session.sql())


def test_delete_is_scoped_and_false_when_not_visible():
    session = FakeSession(rowcount=0)
    assert run(plans.delete_plan(session, 4, 5)) is False
    assert VISIBLE in session.sql()
    assert run(plans.delete_plan(FakeSession(rowcount=1), 4, 5)) is True


# --- plan_routes.py passes the session user ------------------------------------------


@pytest.fixture()
def recorded(monkeypatch):
    calls: list[tuple] = []

    async def fake_list(session, page, owner_id=None):
        calls.append(("list", owner_id))
        return [], 0

    async def fake_get(session, plan_id, owner_id=None):
        calls.append(("get", owner_id))
        return None

    async def fake_update(session, plan_id, name, state, owner_id=None):
        calls.append(("update", owner_id))
        return None

    async def fake_delete(session, plan_id, owner_id=None):
        calls.append(("delete", owner_id))
        return False

    async def fake_create(session, name, project_type, project_name, state, owner_id=None):
        calls.append(("create", owner_id))
        return SimpleNamespace(model_dump=lambda **kw: {})

    for name, fn in [("list_plans", fake_list), ("get_plan", fake_get), ("update_plan", fake_update),
                     ("delete_plan", fake_delete), ("create_plan", fake_create)]:
        monkeypatch.setattr(plan_routes.plans, name, fn)
    return calls


class StubRequest:
    def __init__(self, data) -> None:
        self.data = data

    async def json(self):
        return self.data


def test_every_plan_route_scopes_by_the_session_user(recorded):
    session = FakeSession()
    run(plan_routes.list_plans(1, session, 5))
    get = run(plan_routes.get_plan(4, session, 5))
    update = run(plan_routes.update_plan(4, StubRequest({"name": "n", "state": STATE}), session, 5))
    delete = run(plan_routes.delete_plan(4, session, 5))
    run(plan_routes.create_plan(
        StubRequest({"name": "n", "projectType": "cloud", "projectName": "P", "state": STATE}), session, 5
    ))
    assert recorded == [("list", 5), ("get", 5), ("update", 5), ("delete", 5), ("create", 5)]
    assert get.status_code == update.status_code == delete.status_code == 404


# --- require_user ---------------------------------------------------------------------


def enabled(**kw) -> Settings:
    return Settings(ado_allowed_hosts=(), ado_timeout_seconds=1.0, auth_enabled=True, **kw)


def request_with(session: dict) -> SimpleNamespace:
    return SimpleNamespace(session=session)


def test_require_user_returns_the_id_of_an_existing_user():
    db = FakeSession(users={7: User(id=7, sub="s", email="a@b.c", name="A")})
    assert run(require_user(request_with({"user_id": 7}), enabled(), db)) == 7


def test_require_user_with_a_deleted_user_is_401_and_clears_the_session():
    request = request_with({"user_id": 7})
    with pytest.raises(ApiError) as excinfo:
        run(require_user(request, enabled(), FakeSession(users={})))
    assert excinfo.value.status_code == 401 and request.session == {}


def test_require_user_without_a_session_is_401_without_a_query():
    db = FakeSession()
    with pytest.raises(ApiError) as excinfo:
        run(require_user(request_with({}), enabled(), db))
    assert excinfo.value.status_code == 401


def test_require_user_when_auth_is_disabled_is_none_and_never_touches_the_database():
    class Exploding:
        async def get(self, *args):
            raise AssertionError("no database access expected")

    assert run(require_user(request_with({"user_id": 7}), Settings(ado_allowed_hosts=(), ado_timeout_seconds=1.0,
                                                                   auth_enabled=False), Exploding())) is None
