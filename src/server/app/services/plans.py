import json
from collections.abc import Mapping
from datetime import timezone
from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.models import ReleasePlanRow
from app.schemas import PlanDetail, PlanSummary

PLAN_PAGE_SIZE = 10
PLAN_STATE_MAX_BYTES = 5 * 1024 * 1024
PLAN_STATE_SCHEMA = "release-planner-features"
NAME_MAX_CHARS = 200

NAME_REQUIRED = "Plan name is required."
NAME_TOO_LONG = f"Plan name must be at most {NAME_MAX_CHARS} characters."
PROJECT_NAME_REQUIRED = "Project name is required."
PROJECT_NAME_TOO_LONG = f"Project name must be at most {NAME_MAX_CHARS} characters."
STATE_INVALID = "Plan state is not a release plan."
STATE_TOO_LARGE = "Plan state is too large (max 5 MiB)."
NAME_INVALID_CHARS = "Plan name contains invalid characters."
PROJECT_NAME_INVALID_CHARS = "Project name contains invalid characters."
STATE_INVALID_CHARS = "Plan state contains invalid characters."

# Ids are an int4 `serial`; anything outside is unknown without a query
# (asyncpg would raise a DataError instead).
MAX_PLAN_ID = 2**31 - 1
NUL = "\x00"


def _valid_id(plan_id: int) -> bool:
    return 1 <= plan_id <= MAX_PLAN_ID


def _visible(owner_id: int | None) -> list[ColumnElement[bool]]:
    """The row filters of the plans a user may see: their own and the unowned
    ones (`owner_id IS NULL`: boards that predate users or came through MCP).
    `owner_id=None` means no user (MCP, or `AUTH_ENABLED` false): no filter."""
    if owner_id is None:
        return []
    return [or_(ReleasePlanRow.owner_id == owner_id, ReleasePlanRow.owner_id.is_(None))]


def _trimmed(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _text_error(value: Any, required: str, too_long: str, invalid_chars: str) -> str | None:
    text = _trimmed(value)
    if not text:
        return required
    if len(text) > NAME_MAX_CHARS:
        return too_long
    if NUL in text:
        return invalid_chars
    return None


def _has_nul(value: Any) -> bool:
    """Whether any string (dict key or value, at any depth) holds U+0000,
    which PostgreSQL `text`/`jsonb` cannot store. Iterative, so depth is safe."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            if NUL in item:
                return True
        elif isinstance(item, dict):
            for key, child in item.items():
                if NUL in key:
                    return True
                stack.append(child)
        elif isinstance(item, list):
            stack.extend(item)
    return False


def _state_error(state: Any) -> str | None:
    if not isinstance(state, dict) or state.get("schema") != PLAN_STATE_SCHEMA:
        return STATE_INVALID
    try:
        size = len(json.dumps(state, ensure_ascii=False).encode("utf-8", "replace"))
    except (ValueError, RecursionError):
        return STATE_INVALID
    if size > PLAN_STATE_MAX_BYTES:
        return STATE_TOO_LARGE
    if _has_nul(state):
        return STATE_INVALID_CHARS
    return None


def plan_field_errors(data: Mapping[str, Any], *, with_project: bool) -> list[str]:
    """The contract's 422 messages for a create (`with_project`) or update
    body, one per failing field in field order (name, projectName, state).
    `projectType` is left to the request model (existing handler format)."""
    checks = [_text_error(data.get("name"), NAME_REQUIRED, NAME_TOO_LONG, NAME_INVALID_CHARS)]
    if with_project:
        checks.append(_text_error(
                data.get("projectName"), PROJECT_NAME_REQUIRED, PROJECT_NAME_TOO_LONG, PROJECT_NAME_INVALID_CHARS
            ))
    checks.append(_state_error(data.get("state")))
    return [error for error in checks if error]


def _summary(row: ReleasePlanRow) -> PlanSummary:
    return PlanSummary(
        id=row.id,
        name=row.name,
        projectType=row.project_type,  # type: ignore[arg-type]
        projectName=row.project_name,
        createdAt=row.created_at.astimezone(timezone.utc),
        updatedAt=row.updated_at.astimezone(timezone.utc),
    )


def _detail(row: ReleasePlanRow) -> PlanDetail:
    return PlanDetail(**_summary(row).model_dump(by_alias=True), state=row.state)


async def list_plans(
    session: AsyncSession, page: int, owner_id: int | None = None
) -> tuple[list[PlanSummary], int]:
    """One page of the plans visible to `owner_id` (most recently updated
    first) and their total count. Every plan when `owner_id` is None."""
    visible = _visible(owner_id)
    total = await session.scalar(select(func.count()).select_from(ReleasePlanRow).where(*visible)) or 0
    result = await session.execute(
        select(ReleasePlanRow)
        .where(*visible)
        .order_by(ReleasePlanRow.updated_at.desc(), ReleasePlanRow.id.desc())
        .limit(PLAN_PAGE_SIZE)
        .offset((page - 1) * PLAN_PAGE_SIZE)
    )
    return [_summary(row) for row in result.scalars()], total


async def _visible_row(session: AsyncSession, plan_id: int, owner_id: int | None) -> ReleasePlanRow | None:
    """The plan row when it exists and is visible to `owner_id`, else None
    (unknown and not-visible are indistinguishable to the caller)."""
    if not _valid_id(plan_id):
        return None
    result = await session.execute(select(ReleasePlanRow).where(ReleasePlanRow.id == plan_id, *_visible(owner_id)))
    return result.scalar_one_or_none()


async def get_plan(session: AsyncSession, plan_id: int, owner_id: int | None = None) -> PlanDetail | None:
    """The plan, or None when the id is unknown or not visible to `owner_id`."""
    row = await _visible_row(session, plan_id, owner_id)
    return _detail(row) if row else None


async def create_plan(
    session: AsyncSession,
    name: str,
    project_type: str,
    project_name: str,
    state: dict[str, Any],
    owner_id: int | None = None,
) -> PlanDetail:
    """Insert a plan (name and project name stored trimmed) owned by
    `owner_id` (None = unowned) and commit."""
    row = ReleasePlanRow(
        name=name.strip(),
        project_type=project_type,
        project_name=project_name.strip(),
        state=state,
        owner_id=owner_id,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _detail(row)


async def update_plan(
    session: AsyncSession, plan_id: int, name: str, state: dict[str, Any], owner_id: int | None = None
) -> PlanDetail | None:
    """Replace name and board and set `updated_at = now()`; the project type,
    name and owner never change. Last write wins. None when the id is unknown
    or not visible to `owner_id`."""
    row = await _visible_row(session, plan_id, owner_id)
    if row is None:
        return None
    row.name = name.strip()
    row.state = state
    row.updated_at = func.now()
    await session.commit()
    await session.refresh(row)
    return _detail(row)


async def delete_plan(session: AsyncSession, plan_id: int, owner_id: int | None = None) -> bool:
    """Delete a plan; False when the id is unknown or not visible to `owner_id`."""
    if not _valid_id(plan_id):
        return False
    result = await session.execute(
        delete(ReleasePlanRow).where(ReleasePlanRow.id == plan_id, *_visible(owner_id))
    )
    await session.commit()
    return result.rowcount > 0
