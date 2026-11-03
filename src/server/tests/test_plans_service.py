import asyncio

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.services import plans

pytestmark = pytest.mark.db

STATE = {"schema": "release-planner-features", "milestones": []}


def run(url: str, coro_fn):
    """Run `coro_fn(session)` on a fresh engine/loop."""

    async def main():
        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as session:
                return await coro_fn(session)
        finally:
            await engine.dispose()

    return asyncio.run(main())


def test_create_get_trims_and_roundtrips(clean_db):
    created = run(clean_db, lambda s: plans.create_plan(s, "  A  ", "cloud", " P ", STATE))
    assert (created.name, created.project_name, created.project_type) == ("A", "P", "cloud")
    fetched = run(clean_db, lambda s: plans.get_plan(s, created.id))
    assert fetched == created and fetched.state == STATE
    assert created.created_at.utcoffset().total_seconds() == 0


def test_missing_id_returns_none_or_false(clean_db):
    assert run(clean_db, lambda s: plans.get_plan(s, 99)) is None
    assert run(clean_db, lambda s: plans.update_plan(s, 99, "x", STATE)) is None
    assert run(clean_db, lambda s: plans.delete_plan(s, 99)) is False


def test_update_changes_name_state_and_bumps_updated_at(clean_db):
    created = run(clean_db, lambda s: plans.create_plan(s, "A", "onprem", "P", STATE))
    new_state = {**STATE, "milestones": [1]}
    updated = run(clean_db, lambda s: plans.update_plan(s, created.id, " B ", new_state))
    assert updated.name == "B" and updated.state == new_state
    assert updated.project_type == "onprem" and updated.project_name == "P"
    assert updated.updated_at > created.updated_at
    assert updated.created_at == created.created_at


def test_delete_removes_row(clean_db):
    created = run(clean_db, lambda s: plans.create_plan(s, "A", "onprem", "P", STATE))
    assert run(clean_db, lambda s: plans.delete_plan(s, created.id)) is True
    assert run(clean_db, lambda s: plans.get_plan(s, created.id)) is None


def test_list_orders_by_updated_at_desc_and_paginates(clean_db):
    ids = [run(clean_db, lambda s, i=i: plans.create_plan(s, f"n{i}", "onprem", "P", STATE)).id for i in range(11)]
    items, total = run(clean_db, lambda s: plans.list_plans(s, 1))
    assert total == 11 and len(items) == plans.PLAN_PAGE_SIZE
    assert [i.id for i in items] == ids[::-1][:10]
    items2, _ = run(clean_db, lambda s: plans.list_plans(s, 2))
    assert [i.id for i in items2] == [ids[0]]
    items3, total3 = run(clean_db, lambda s: plans.list_plans(s, 3))
    assert items3 == [] and total3 == 11
    run(clean_db, lambda s: plans.update_plan(s, ids[0], "n0", STATE))
    items4, _ = run(clean_db, lambda s: plans.list_plans(s, 1))
    assert items4[0].id == ids[0]
