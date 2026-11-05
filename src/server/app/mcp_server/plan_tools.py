"""Release Plan tools (specs/mcp_server.md, plans/release-plan-mcp-server.md
"Tool contract"). They call `app/services` directly; results use the REST
API's camelCase names."""

from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from app.config import get_settings
from app.mcp_server import deps
from app.mcp_server.errors import error_text, guarded
from app.schemas import PlanDetail, PlanSummary
from app.services import plans
from app.services.plan_board import board_json_schema, validate_board
from app.services.plans import PLAN_STATE_SCHEMA, PLAN_PAGE_SIZE, plan_field_errors

BOARD_SCHEMA_URI = "release-plan://schema"
STATE_TOOLS = ("validate_release_plan", "create_release_plan", "update_release_plan")

PAGE_INVALID = "Page must be 1 or greater."

LIST_DESCRIPTION = (
    "List the stored Release Plans, most recently updated first, "
    f"{PLAN_PAGE_SIZE} per page. Use it to find a plan's id before get_release_plan "
    "or update_release_plan. Returns {items, total, page, pageSize}; items carry no board."
)
GET_DESCRIPTION = (
    "Read one stored Release Plan: its name, project and the full board in `state`, plus the "
    "`boardUrl` where a person opens it. Use it before update_release_plan to start from the "
    "current board."
)
VALIDATE_DESCRIPTION = (
    "Check a board against the strict Release Plan format without storing anything. Returns "
    "{valid: true, state} with the board normalized (defaults filled), or {valid: false, errors} "
    "listing every problem at once as `<path>: <problem>`. Call it, and fix the errors, before "
    "create_release_plan or update_release_plan. The format is the `state` input schema, also "
    f"published as the resource {BOARD_SCHEMA_URI}."
)
CREATE_DESCRIPTION = (
    "Store a new Release Plan and return its summary with the `boardUrl` to give to the user. "
    "`state` must be a valid board (see validate_release_plan); it must carry the Azure DevOps "
    "`source` connection (never the PAT), so Sync from ADO works. The plan's project type and "
    "name come from `state.source.kind` and `state.source.project`, and `state.name` is set to "
    "`name`. The board is rejected with the full list of errors when invalid."
)
UPDATE_DESCRIPTION = (
    "Replace the board of a stored Release Plan (last write wins) and return its summary with the "
    "`boardUrl`. Read the plan with get_release_plan first and send the whole new board in `state`. "
    "A null `name` keeps the stored name. The plan's project cannot change: `state.source.kind` and "
    "`state.source.project` must match the stored ones. An open board in the browser does not "
    "refresh and its autosave can overwrite this update, so ask the user to close the board in "
    "the browser before updating."
)

_READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)
_REPLACE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False)

# `state` is advertised with the board JSON Schema but declared `Any`, so the
# SDK never rejects a malformed board itself: `validate_board` reports every
# error at once.
State = Annotated[Any, Field(description="The Release Plan board JSON.")]


def _board_url(plan_id: int) -> str:
    """The link to the board in the UI: absolute when `PUBLIC_BASE_URL` is set."""
    return f"{get_settings().public_base_url}/release-plan/{plan_id}"


def _summary_result(plan: PlanSummary | PlanDetail) -> dict[str, Any]:
    result = PlanSummary.model_validate(plan, from_attributes=True).model_dump(by_alias=True, mode="json")
    result["boardUrl"] = _board_url(plan.id)
    return result


def _not_found(plan_id: int) -> ToolError:
    return ToolError(f"Release plan not found: {plan_id}.")


def _valid_board(state: Any) -> dict[str, Any]:
    """The normalized board.

    Raises:
        ToolError: listing every error of an invalid board.
    """
    result = validate_board(state, get_settings().ado_allowed_hosts)
    if result.errors or result.board is None:
        raise ToolError(error_text(result.errors))
    return result.board


def _name_error(name: Any) -> str | None:
    """The existing plan-name message for an invalid name, else None."""
    errors = plan_field_errors({"name": name, "state": {"schema": PLAN_STATE_SCHEMA}}, with_project=False)
    return errors[0] if errors else None


@guarded()
async def list_release_plans(page: int = 1) -> dict[str, Any]:
    if page < 1:
        raise ToolError(PAGE_INVALID)
    async with deps.db_session() as session:
        items, total = await plans.list_plans(session, page)
    return {
        "items": [PlanSummary.model_validate(item).model_dump(by_alias=True, mode="json") for item in items],
        "total": total,
        "page": page,
        "pageSize": PLAN_PAGE_SIZE,
    }


@guarded()
async def get_release_plan(planId: int) -> dict[str, Any]:
    async with deps.db_session() as session:
        plan = await plans.get_plan(session, planId)
    if plan is None:
        raise _not_found(planId)
    return {**plan.model_dump(by_alias=True, mode="json"), "boardUrl": _board_url(plan.id)}


@guarded()
async def validate_release_plan(state: State) -> dict[str, Any]:
    result = validate_board(state, get_settings().ado_allowed_hosts)
    if result.errors or result.board is None:
        return {"valid": False, "errors": result.errors}
    return {"valid": True, "state": result.board}


@guarded()
async def create_release_plan(name: str, state: State) -> dict[str, Any]:
    error = _name_error(name)
    if error:
        raise ToolError(error)
    board = _valid_board(state)
    board["name"] = name.strip()
    source = board["source"]
    async with deps.db_session() as session:
        plan = await plans.create_plan(session, name, source["kind"], source["project"], board)
    return _summary_result(plan)


@guarded()
async def update_release_plan(planId: int, state: State, name: str | None = None) -> dict[str, Any]:
    if name is not None:
        error = _name_error(name)
        if error:
            raise ToolError(error)
    board = _valid_board(state)
    async with deps.db_session() as session:
        stored = await plans.get_plan(session, planId)
        if stored is None:
            raise _not_found(planId)
        source = board["source"]
        # `AdoConnectModal` creates a plan with projectName = the backlog's
        # project name, which `planFromBacklog` also stores as `source.project`.
        if source["kind"] != stored.project_type or source["project"].strip() != stored.project_name:
            raise ToolError(
                f"The plan's project cannot be changed (stored: {stored.project_type} · {stored.project_name})."
            )
        final_name = stored.name if name is None else name.strip()
        board["name"] = final_name
        updated = await plans.update_plan(session, planId, final_name, board)
    if updated is None:
        raise _not_found(planId)
    return _summary_result(updated)


def _advertise_board_schema(server: MCPServer) -> None:
    """Publish the board JSON Schema as the `state` input schema of the tools
    taking a board. Its `$defs` move to the root of the tool schema, where the
    `#/$defs/...` references resolve."""
    schema = board_json_schema()
    defs = schema.pop("$defs", {})
    schema["description"] = "The Release Plan board JSON."
    for name in STATE_TOOLS:
        parameters = server._tool_manager.get_tool(name).parameters  # type: ignore[union-attr]
        parameters["properties"]["state"] = schema
        parameters["$defs"] = defs


def register(server: MCPServer) -> None:
    """Register the Release Plan tools on `server`."""
    server.add_tool(list_release_plans, description=LIST_DESCRIPTION, annotations=_READ_ONLY)
    server.add_tool(get_release_plan, description=GET_DESCRIPTION, annotations=_READ_ONLY)
    server.add_tool(validate_release_plan, description=VALIDATE_DESCRIPTION, annotations=_READ_ONLY)
    server.add_tool(create_release_plan, description=CREATE_DESCRIPTION, annotations=_WRITE)
    server.add_tool(update_release_plan, description=UPDATE_DESCRIPTION, annotations=_REPLACE)
    _advertise_board_schema(server)
