"""Release Plan tools (specs/mcp_server.md, plans/release-plan-mcp-server.md
"Tool contract"). They call `app/services` directly; results use the REST
API's camelCase names. The agent sends only its decisions; create and update
fetch the backlog from Azure DevOps and build the board
(`services/plan_from_backlog`). The PAT is a `SecretStr` from the moment the
arguments are validated and is never logged, stored or returned."""

from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field, SecretStr, ValidationError

from app.config import get_settings
from app.mcp_server import deps
from app.mcp_server.arguments import PAT_SCHEMA, advertise_schema, integer_error, pat_value, text_error
from app.mcp_server.errors import error_text, guarded
from app.schemas import AdoBacklogRequest, PlanDetail, PlanSummary
from app.services import plans
from app.services.ado_backlog import fetch_backlog, scope_field_errors
from app.services.ado_client import UNEXPECTED_RESPONSE, AdoError
from app.services.ado_http import ado_client
from app.services.ado_url import AdoUrlError, connection_field_errors
from app.services.plan_board import validate_board
from app.services.plan_from_backlog import (
    Connection,
    PlanDecisions,
    build_board,
    decisions_json_schema,
    parse_decisions,
)
from app.services.plans import PLAN_STATE_SCHEMA, PLAN_PAGE_SIZE, plan_field_errors

# Arguments of the tools that take the agent's decisions, advertised with the
# schema of `PlanDecisions`.
DECISION_TOOLS = {
    "validate_release_plan": ("connection", "mode", "milestones", "flags", "epicOrder", "assignments"),
    "create_release_plan": ("connection", "mode", "milestones", "flags", "epicOrder", "assignments"),
    "update_release_plan": ("mode", "milestones", "flags", "epicOrder", "assignments"),
}

PAGE_INVALID = "Page must be 1 or greater."

LIST_DESCRIPTION = (
    "List the stored Release Plans, most recently updated first, "
    f"{PLAN_PAGE_SIZE} per page. Returns {{items, total, page, pageSize}}; each item carries the plan's "
    "`id`, name, project and `boardUrl`, but no board. The `id` is an internal handle used only as "
    "`planId` for get_release_plan / update_release_plan: never show it to the user. Refer to plans "
    "by name and project, and give the `boardUrl` when pointing the user to a plan."
)
GET_DESCRIPTION = (
    "Read one stored Release Plan: its `id`, name, project and the full board in `state`, plus the "
    "`boardUrl` where a person opens it. Use it before update_release_plan to start from the "
    "current board. The `id` is an internal handle (the `planId` of this and update_release_plan): "
    "never show it to the user; refer to the plan by name and project and give the `boardUrl`."
)
VALIDATE_DESCRIPTION = (
    "Check your decisions for a Release Plan offline, without calling Azure DevOps and without storing "
    "anything. Takes the same decisions as create_release_plan (connection, mode, milestones, flags, "
    "epicOrder, assignments; no PAT). Returns {valid: true} or {valid: false, errors} listing every "
    "problem at once: structure, duplicate milestone or flag ids, flag and assignment references to "
    "milestones, flags outside `sprints` mode, repeated epicOrder entries and the allowed Azure DevOps "
    "hosts. Epic and Feature ids can only be checked against the backlog, so unknown ids are reported by "
    "create_release_plan and update_release_plan, not here. The format is the input schema, also "
    "returned by get_release_plan_schema."
)
SCHEMA_DESCRIPTION = (
    "Return the JSON Schema of the decisions accepted by validate_release_plan, create_release_plan and "
    "update_release_plan: connection, mode, milestones, flags, epicOrder and assignments. Uniqueness and "
    "references between ids and the host allowlist are checked by validate_release_plan, not by the schema."
)
_DECISIONS = (
    "You decide only the milestones, the flags (sprints mode), the order of the Epics (`epicOrder`, the "
    "board columns left to right) and which milestone each Feature goes in (`assignments`, Feature id -> "
    "milestone id; Features left out are Unplanned). The server reads the Epics and Features from Azure "
    "DevOps in the same call and fills in titles, states, sizes, iteration paths and descriptions: never "
    "retype them. Read the backlog, descriptions included, with ado_fetch_backlog to decide, and use the "
    "ids it returns. Epics missing from `epicOrder` are appended in ascending id order; `no-epic` is the "
    "column of the Features without an Epic."
)
CREATE_DESCRIPTION = (
    "Store a new Release Plan built from an Azure DevOps backlog and return its summary with the "
    "`boardUrl` to give to the user. " + _DECISIONS + " Needs the Personal Access Token: ask the user, it "
    "is used for this call only and is never stored or logged. The plan's project type and name come from "
    "`connection.source` and the project returned by Azure DevOps, and the board is named `name`. "
    "Nothing is stored when Azure DevOps or the decisions fail; every decision error is listed at once."
)
UPDATE_DESCRIPTION = (
    "Replace the board of a stored Release Plan (last write wins) and return its summary with the "
    "`boardUrl`. `planId` is the internal `id` from list_release_plans or get_release_plan, never "
    "shown to the user. " + _DECISIONS + " The connection is the stored one, so it is not sent; the plan's "
    "project cannot change. The update is a full replace of your decisions and a sync with Azure DevOps: "
    "titles, states, sizes, descriptions and iterations are refreshed and items no longer in scope "
    "disappear. Call get_release_plan first and resend the assignments, milestones and flags you keep, "
    "because Features absent from `assignments` become Unplanned; drop the assignments of Features that left "
    "the backlog (get_release_plan still returns them), and the error listing unknown "
    "Feature ids tells you which. `mode` defaults to `releases` and `flags` to none. Needs the Personal Access Token (used for this call only, never stored or "
    "logged). A null `name` keeps the stored name. An open board in the browser does not refresh and "
    "its autosave can overwrite this update, so ask the user to close the board in the browser before "
    "updating."
)

_READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
_WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)
_REPLACE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False)

# The decision arguments are declared `Any` and advertised with the schema of
# `PlanDecisions`, so the SDK never rejects a malformed one itself:
# `parse_decisions` reports every error at once.
_CONNECTION = Field(
    description="The Azure DevOps source and scope: {source: onprem|cloud, projectUrl, scopeType: area|iteration, scopePath}."
)
_MODE = Field(description='"releases" (default) or "sprints"; flags need "sprints".')
_MILESTONES = Field(description="Board rows in order: [{id, name, date?, color?}].")
_FLAGS = Field(description='Milestone flags [{id?, name?, date?, afterMsId}], "sprints" mode only; default none.')
_EPIC_ORDER = Field(description='Epic ids in board-column order, left to right; "no-epic" is the Features without an Epic.')
_ASSIGNMENTS = Field(description="{featureId: milestoneId | null}; Features not listed are Unplanned.")

NAME_SCHEMA = {"type": "string", "description": "The plan name shown to users (1-200 characters)."}
UPDATE_NAME_SCHEMA = {
    "anyOf": [{"type": "string"}, {"type": "null"}],
    "default": None,
    "description": "New plan name; null keeps the stored name.",
}
PLAN_ID_SCHEMA = {"type": "integer", "description": "The internal `id` of the plan (never shown to the user)."}

STORED_CONNECTION_INVALID = (
    "The stored plan has no usable Azure DevOps connection (source, projectUrl, scopeType, scopePath), "
    "so it cannot be updated by an agent."
)


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


def _text(value: Any) -> str:
    """The error text safe to show: characters that cannot be UTF-8 encoded
    are replaced."""
    return str(value).encode("utf-8", "replace").decode("utf-8")


def _raw_decisions(
    connection: Any, mode: Any, milestones: Any, flags: Any, epic_order: Any, assignments: Any
) -> dict[str, Any]:
    """The tool arguments as the dict `parse_decisions` takes; an argument
    that is missing (None) is left out, so the model reports it as required or
    applies its default."""
    raw = {
        "connection": connection, "mode": mode, "milestones": milestones,
        "flags": flags, "epicOrder": epic_order, "assignments": assignments,
    }
    return {key: value for key, value in raw.items() if value is not None}


async def _hydrated_board(
    name: str, pat: SecretStr, connection: dict[str, str], decisions: PlanDecisions
) -> dict[str, Any]:
    """Fetch the backlog from Azure DevOps and build the normalized board.

    Raises:
        ToolError: for a bad connection field, an Azure DevOps failure, ids
            not in the backlog or a board that fails validation.
    """
    data = {**connection, "pat": pat.get_secret_value()}
    errors = connection_field_errors(data) + scope_field_errors(data)
    if errors:
        raise ToolError("\n".join(errors))
    payload = AdoBacklogRequest.model_validate({**connection, "pat": pat})
    settings = get_settings()
    try:
        async with deps.ado_http() as http:
            project, client = ado_client(payload, settings, http)
            backlog = await fetch_backlog(
                client, project, payload.scope_type, payload.scope_path, settings.ado_description_max_chars
            )
    except (AdoUrlError, AdoError) as exc:
        raise ToolError(_text(exc)) from None
    except (UnicodeError, RecursionError):
        raise ToolError(UNEXPECTED_RESPONSE) from None
    board, build_errors = build_board(backlog, name, decisions, connection)
    if build_errors or board is None:
        raise ToolError(error_text(build_errors))
    return _valid_board(board)


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
        "items": [_summary_result(item) for item in items],
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
async def get_release_plan_schema() -> dict[str, Any]:
    return decisions_json_schema()


@guarded()
async def validate_release_plan(
    connection: Annotated[Any, _CONNECTION],
    milestones: Annotated[Any, _MILESTONES],
    epicOrder: Annotated[Any, _EPIC_ORDER],
    assignments: Annotated[Any, _ASSIGNMENTS],
    mode: Annotated[Any, _MODE] = "releases",
    flags: Annotated[Any, _FLAGS] = None,
) -> dict[str, Any]:
    raw = _raw_decisions(connection, mode, milestones, flags, epicOrder, assignments)
    result = parse_decisions(raw, get_settings().ado_allowed_hosts, with_connection=True)
    if result.errors:
        return {"valid": False, "errors": result.errors}
    return {"valid": True}


def _argument_errors(*errors: str | None) -> list[str]:
    return [error for error in errors if error]


def _name_errors(name: Any, *, required: bool) -> list[str]:
    """The errors of a plan name argument: missing, not text, or the existing
    name rules."""
    error = text_error("name", name, required=required)
    if error is None and isinstance(name, str):
        error = _name_error(name)
    return _argument_errors(error)


@guarded(log_messages=False)
async def create_release_plan(
    name: Any = None,
    pat: Any = None,
    connection: Any = None,
    milestones: Any = None,
    epicOrder: Any = None,
    assignments: Any = None,
    mode: Any = None,
    flags: Any = None,
) -> dict[str, Any]:
    secret, pat_errors = pat_value(pat)
    raw = _raw_decisions(connection, mode, milestones, flags, epicOrder, assignments)
    parsed = parse_decisions(raw, get_settings().ado_allowed_hosts, with_connection=True)
    errors = _name_errors(name, required=True) + pat_errors + parsed.errors
    if errors or parsed.decisions is None or secret is None or parsed.decisions.connection is None:
        raise ToolError(error_text(errors))
    board = await _hydrated_board(name.strip(), secret, parsed.decisions.connection.model_dump(), parsed.decisions)
    source = board["source"]
    async with deps.db_session() as session:
        plan = await plans.create_plan(session, name, source["kind"], source["project"], board)
    return _summary_result(plan)


def _stored_connection(stored: PlanDetail) -> dict[str, str]:
    """The `connection` of a stored plan, from its `state.source`.

    Raises:
        ToolError: STORED_CONNECTION_INVALID when it is missing or incomplete.
    """
    source = stored.state.get("source") if isinstance(stored.state, dict) else None
    if not isinstance(source, dict):
        raise ToolError(STORED_CONNECTION_INVALID)
    try:
        connection = Connection.model_validate(
            {
                "source": source.get("kind"),
                "projectUrl": source.get("projectUrl"),
                "scopeType": source.get("scopeType"),
                "scopePath": source.get("scopePath"),
            }
        )
    except ValidationError:
        raise ToolError(STORED_CONNECTION_INVALID) from None
    return connection.model_dump()


@guarded(log_messages=False)
async def update_release_plan(
    planId: Any = None,
    pat: Any = None,
    milestones: Any = None,
    epicOrder: Any = None,
    assignments: Any = None,
    name: Any = None,
    mode: Any = None,
    flags: Any = None,
) -> dict[str, Any]:
    secret, pat_errors = pat_value(pat)
    raw = _raw_decisions(None, mode, milestones, flags, epicOrder, assignments)
    parsed = parse_decisions(raw, get_settings().ado_allowed_hosts, with_connection=False)
    errors = (
        _argument_errors(integer_error("planId", planId))
        + _name_errors(name, required=False)
        + pat_errors
        + parsed.errors
    )
    if errors or parsed.decisions is None or secret is None:
        raise ToolError(error_text(errors))
    decisions, pat = parsed.decisions, secret
    async with deps.db_session() as session:
        stored = await plans.get_plan(session, planId)
    if stored is None:
        raise _not_found(planId)
    connection = _stored_connection(stored)
    final_name = stored.name if name is None else name.strip()
    board = await _hydrated_board(final_name, pat, connection, decisions)
    source = board["source"]
    # `AdoConnectModal` creates a plan with projectName = the backlog's
    # project name, which is also stored as `source.project`.
    if source["kind"] != stored.project_type or source["project"].strip() != stored.project_name:
        raise ToolError(
            f"The plan's project cannot be changed (stored: {stored.project_type} · {stored.project_name})."
        )
    async with deps.db_session() as session:
        updated = await plans.update_plan(session, planId, final_name, board)
    if updated is None:
        raise _not_found(planId)
    return _summary_result(updated)


def _advertise_decision_schemas(server: MCPServer) -> None:
    """Publish the schema of `PlanDecisions` for each decision argument of the
    tools taking them. The shared `$defs` move to the root of the tool schema,
    where the `#/$defs/...` references resolve."""
    schema = decisions_json_schema()
    defs = schema.get("$defs", {})
    properties = schema["properties"]
    # `connection` is optional in the model (update does not take it) but
    # required in the tools that advertise it.
    properties["connection"] = {
        "$ref": "#/$defs/Connection",
        "description": properties["connection"]["description"],
    }
    extras = {
        "create_release_plan": {"name": NAME_SCHEMA, "pat": PAT_SCHEMA},
        "update_release_plan": {"planId": PLAN_ID_SCHEMA, "pat": PAT_SCHEMA, "name": UPDATE_NAME_SCHEMA},
    }
    first = {"create_release_plan": ["name", "pat"], "update_release_plan": ["planId", "pat"]}
    for tool_name, arguments in DECISION_TOOLS.items():
        shared = {argument: dict(properties[argument]) for argument in arguments}
        required = first.get(tool_name, []) + [a for a in arguments if a not in ("mode", "flags")]
        advertise_schema(server, tool_name, {**extras.get(tool_name, {}), **shared}, required, defs)


def register(server: MCPServer) -> None:
    """Register the Release Plan tools on `server`."""
    server.add_tool(list_release_plans, description=LIST_DESCRIPTION, annotations=_READ_ONLY)
    server.add_tool(get_release_plan, description=GET_DESCRIPTION, annotations=_READ_ONLY)
    server.add_tool(get_release_plan_schema, description=SCHEMA_DESCRIPTION, annotations=_READ_ONLY)
    server.add_tool(validate_release_plan, description=VALIDATE_DESCRIPTION, annotations=_READ_ONLY)
    server.add_tool(create_release_plan, description=CREATE_DESCRIPTION, annotations=_WRITE)
    server.add_tool(update_release_plan, description=UPDATE_DESCRIPTION, annotations=_REPLACE)
    _advertise_decision_schemas(server)
