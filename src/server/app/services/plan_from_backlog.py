"""Build a Release Plan board from a fetched Azure DevOps backlog and the
decisions an agent makes (plans/release-plan-mcp-server.md, specs/mcp_server.md).

The agent decides the milestones, the flags, the Epic order and which
milestone each Feature goes in; everything else (titles, states, sizes,
iteration paths, descriptions) comes from the backlog. `group_backlog` and
`_to_feature` mirror `groupBacklog` / `toFeature` in the client's
lib/releasePlan/fromBacklog.ts, so the board matches the one the UI builds
from the same backlog.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.services.ado_url import AdoUrlError, parse_project_url
from app.services.plan_board import (
    ADO_SYSTEM,
    NO_EPIC_ID,
    NO_EPIC_TITLE,
    SCHEMA,
    VERSION,
    DEFAULT_PLAN_NAME,
    Flag,
    Milestone,
    NonBlank,
    WorkItemId,
    _size,
    structural_errors,
)

_INPUT_CONFIG = ConfigDict(extra="forbid", strict=True)


class Connection(BaseModel):
    """The Azure DevOps connection of a plan (never the PAT)."""

    model_config = _INPUT_CONFIG

    source: Annotated[Literal["onprem", "cloud"], Field(description='"onprem" (Azure DevOps Server) or "cloud" (dev.azure.com).')]
    projectUrl: Annotated[NonBlank, Field(description="The project URL, e.g. https://dev.azure.com/org/Project.")]
    scopeType: Annotated[Literal["area", "iteration"], Field(description='"area" or "iteration".')]
    scopePath: Annotated[NonBlank, Field(description="The Area or Iteration path, e.g. `Project\\Team A`.")]


class PlanDecisions(BaseModel):
    """What the agent decides; `connection` is absent when updating a plan
    (the stored one is used)."""

    model_config = _INPUT_CONFIG

    connection: Connection | None = Field(
        default=None, description="The Azure DevOps source and scope the board is built from (never the PAT)."
    )
    mode: Literal["releases", "sprints"] = Field(
        default="releases",
        description="`releases`: milestones are releases; `sprints`: milestones are sprints, and flags are allowed.",
    )
    milestones: list[Milestone] = Field(description="Board rows in order; may be empty.")
    flags: list[Flag] = Field(default_factory=list, description="Milestone flags; only in `sprints` mode.")
    epicOrder: list[WorkItemId] = Field(
        description=(
            "Epic ids in board-column order, left to right; `no-epic` is the column of the Features without "
            "an Epic. Epics left out are appended in ascending id order."
        )
    )
    assignments: dict[str, str | None] = Field(
        description=(
            "Feature id -> milestone id, or null for Unplanned. Features not listed are Unplanned."
        )
    )


@dataclass(frozen=True)
class DecisionsResult:
    """Outcome of `parse_decisions`: the decisions, or the errors."""

    decisions: PlanDecisions | None = None
    errors: list[str] = field(default_factory=list)


def _id_text(value: Any) -> str:
    return str(value).strip()


def _normalize_assignments(value: Any) -> tuple[Any, list[str]]:
    """The assignments with Feature id keys as trimmed text (so `102` and
    `"102"` are the same key); other values are left for the model to report."""
    if not isinstance(value, Mapping):
        return value, []
    result: dict[Any, Any] = {}
    errors: list[str] = []
    for key, target in value.items():
        text = _id_text(key) if isinstance(key, (int, str)) and not isinstance(key, bool) else key
        if text in result:
            errors.append(f"assignments: duplicate Feature id {text!r}")
        result[text] = target
    return result, errors


def parse_decisions(raw: Mapping[str, Any], allowed_hosts: Iterable[str], *, with_connection: bool) -> DecisionsResult:
    """Validate the agent's decisions offline, listing every error at once.

    Checks the structure, duplicate milestone / flag ids, flag `afterMsId`
    references, flags only in `sprints` mode, assignment values referencing
    existing milestones, duplicate `epicOrder` entries and the connection host
    allowlist. Whether Feature / Epic ids exist needs the backlog and is
    checked by `build_board`. The input is never mutated.

    Args:
        raw: `{connection?, mode?, milestones, flags?, epicOrder, assignments}`.
        allowed_hosts: Host allowlist for `connection.projectUrl`.
        with_connection: Whether `connection` is required.
    """
    assignments, errors = _normalize_assignments(raw.get("assignments"))
    data = {**raw, "assignments": assignments} if "assignments" in raw else dict(raw)
    if with_connection and data.get("connection") is None:
        errors.append("connection: is required")
    decisions: PlanDecisions | None = None
    try:
        decisions = PlanDecisions.model_validate(data)
    except ValidationError as exc:
        errors.extend(structural_errors(exc))
    if decisions is not None:
        errors.extend(_reference_errors(decisions, tuple(allowed_hosts)))
    errors = list(dict.fromkeys(errors))
    if errors or decisions is None:
        return DecisionsResult(errors=errors)
    return DecisionsResult(decisions=decisions)


def _reference_errors(decisions: PlanDecisions, allowed_hosts: tuple[str, ...]) -> list[str]:
    errors: list[str] = []
    milestone_ids: dict[str, int] = {}
    for i, ms in enumerate(decisions.milestones):
        if ms.id in milestone_ids:
            errors.append(
                f"milestones[{i}].id: duplicate milestone id {ms.id!r} "
                f"(already used by milestones[{milestone_ids[ms.id]}])"
            )
        else:
            milestone_ids[ms.id] = i

    if decisions.mode == "releases" and decisions.flags:
        errors.append('flags: must be empty in "releases" mode; set mode to "sprints" to use flags')
    flag_ids: dict[str, int] = {}
    for i, flag in enumerate(decisions.flags):
        if flag.id:
            if flag.id in flag_ids:
                errors.append(f"flags[{i}].id: duplicate flag id {flag.id!r} (already used by flags[{flag_ids[flag.id]}])")
            else:
                flag_ids[flag.id] = i
        if flag.afterMsId not in milestone_ids:
            errors.append(
                f"flags[{i}].afterMsId: unknown milestone id {flag.afterMsId!r}; use the id of an entry in milestones"
            )

    seen: set[str] = set()
    for i, epic_id in enumerate(decisions.epicOrder):
        text = _id_text(epic_id)
        if text in seen:
            errors.append(f"epicOrder[{i}]: duplicate Epic id {text!r}")
        seen.add(text)

    for feature_id, ref in decisions.assignments.items():
        if ref is not None and ref not in milestone_ids:
            errors.append(
                f"assignments[{feature_id!r}]: unknown milestone id {ref!r}; "
                "use the id of an entry in milestones, or null for Unplanned"
            )

    if decisions.connection is not None:
        try:
            parse_project_url(decisions.connection.source, decisions.connection.projectUrl, allowed_hosts)
        except AdoUrlError as exc:
            errors.append(f"connection.projectUrl: {exc}")
    return errors


# ---- grouping (mirror of groupBacklog) --------------------------------------


@dataclass(frozen=True)
class GroupedBacklog:
    """`group_backlog` result: Epics in ascending id order, each with its
    Features (ascending id), and the Features without a returned parent Epic."""

    epics: list[tuple[Mapping[str, Any], list[Mapping[str, Any]]]]
    orphans: list[Mapping[str, Any]]


def group_backlog(items: Iterable[Mapping[str, Any]]) -> GroupedBacklog:
    """Group the flat backlog: Features under their parent Epic; the others
    (no parent, or a parent that is not a returned Epic) are orphans."""
    ordered = sorted(items, key=lambda item: item["id"])
    groups: dict[int, tuple[Mapping[str, Any], list[Mapping[str, Any]]]] = {
        item["id"]: (item, []) for item in ordered if item["type"] == "Epic"
    }
    orphans: list[Mapping[str, Any]] = []
    for item in ordered:
        if item["type"] != "Feature":
            continue
        parent = item.get("parentId")
        group = groups.get(parent) if parent is not None else None
        if group is not None:
            group[1].append(item)
        else:
            orphans.append(item)
    return GroupedBacklog(epics=list(groups.values()), orphans=orphans)


def _to_feature(item: Mapping[str, Any], assignments: Mapping[str, str | None]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "title": item["title"],
        "state": item["state"],
        "description": item["description"],
        "size": _size(item["size"]),
        "iterationPath": item["iterationPath"],
        "milestoneId": assignments.get(str(item["id"])),
    }


def _ordered_epics(groups: GroupedBacklog, epic_order: list[str]) -> list[tuple[Any, dict[str, Any]]]:
    """`(id, epic)` pairs in board order: `epic_order` first, then the Epics it
    omits in ascending id order, the orphans' Epic last."""
    by_id: dict[str, dict[str, Any]] = {}
    for epic, features in groups.epics:
        by_id[str(epic["id"])] = {
            "id": epic["id"],
            "title": epic["title"],
            "state": epic["state"],
            "description": epic["description"],
            "features": features,
        }
    if groups.orphans:
        by_id[NO_EPIC_ID] = {
            "id": NO_EPIC_ID,
            "title": NO_EPIC_TITLE,
            "state": "",
            "description": "",
            "features": groups.orphans,
        }
    ordered_ids = [epic_id for epic_id in dict.fromkeys(epic_order) if epic_id in by_id]
    ordered_ids += [epic_id for epic_id in by_id if epic_id not in ordered_ids]
    return [(epic_id, by_id[epic_id]) for epic_id in ordered_ids]


def _listed(ids: Iterable[str]) -> str:
    return ", ".join(ids)


def build_board(
    backlog: Mapping[str, Any], name: str, decisions: PlanDecisions, connection: Mapping[str, str]
) -> tuple[dict[str, Any] | None, list[str]]:
    """The full board for `backlog` and the agent's `decisions`.

    The board is not yet normalized: run `validate_board` on it. Epics follow
    `decisions.epicOrder`; Epics it omits are appended in ascending id order
    with the "no Epic" Epic last, and `"no-epic"` in the order is a no-op when
    there are no orphan Features. Features keep ascending id order and are
    Unplanned unless assigned. Items gone from the scope are simply absent.

    Args:
        backlog: The `fetch_backlog` payload.
        name: The plan name.
        decisions: The validated decisions (see `parse_decisions`).
        connection: `{source, projectUrl, scopeType, scopePath}` of the plan.

    Returns:
        `(board, [])`, or `(None, errors)` for Epic / Feature ids that are not
        in the backlog.
    """
    groups = group_backlog(backlog["workItems"])
    epic_order = [_id_text(epic_id) for epic_id in decisions.epicOrder]
    epics = _ordered_epics(groups, epic_order)

    errors: list[str] = []
    known_epics = {str(epic["id"]) for epic, _ in groups.epics} | {NO_EPIC_ID}
    unknown_epics = [epic_id for epic_id in dict.fromkeys(epic_order) if epic_id not in known_epics]
    if unknown_epics:
        errors.append(
            f"epicOrder: unknown Epic id(s) not in the backlog: {_listed(unknown_epics)}. "
            'Use the ids of the Epics returned by ado_fetch_backlog (or "no-epic").'
        )
    feature_ids = {str(f["id"]) for _, features in groups.epics for f in features} | {
        str(f["id"]) for f in groups.orphans
    }
    unknown_features = [key for key in decisions.assignments if key not in feature_ids]
    if unknown_features:
        errors.append(
            f"assignments: unknown Feature id(s) not in the backlog: {_listed(unknown_features)}. "
            "Use the ids of the Features returned by ado_fetch_backlog."
        )
    if errors:
        return None, errors

    board = {
        "schema": SCHEMA,
        "version": VERSION,
        "mode": decisions.mode,
        "name": name or DEFAULT_PLAN_NAME,
        "source": {
            "system": ADO_SYSTEM,
            "project": backlog["project"]["name"],
            "scope": backlog["scope"],
            "fetchedAt": backlog["fetchedAt"],
            "kind": connection["source"],
            "projectUrl": connection["projectUrl"],
            "scopeType": connection["scopeType"],
            "scopePath": connection["scopePath"],
        },
        "iterations": [{"path": it["path"], "finishDate": it["finishDate"]} for it in backlog["iterations"]],
        "milestones": [ms.model_dump(exclude_unset=True) for ms in decisions.milestones],
        "flags": [flag.model_dump(exclude_unset=True) for flag in decisions.flags],
        "epics": [
            {**epic, "features": [_to_feature(f, decisions.assignments) for f in epic["features"]]}
            for _, epic in epics
        ],
    }
    return board, []


def decisions_json_schema() -> dict[str, Any]:
    """The JSON Schema of the agent's decisions (self-contained: definitions
    live in `$defs`); what `get_release_plan_schema` returns."""
    return PlanDecisions.model_json_schema(by_alias=True, mode="validation")
