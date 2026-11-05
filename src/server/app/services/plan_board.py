"""Strict validator for Release Plan board JSON (plans/release-plan-mcp-server.md
"Validation rules").

Used by the MCP tools only; the REST API keeps its shallow `plan_field_errors`
check. Every board accepted satisfies the client's `normalizePlan(board)`
deep-equals `board` (lib/releasePlan/validate.ts), so the models mirror
lib/releasePlan/types.ts and the defaults filled here are the ones
`normalizePlan` would fill.
"""

import secrets
import string
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, ValidationError, model_validator

from app.services.ado_url import AdoUrlError, parse_project_url
from app.services.plans import PLAN_STATE_SCHEMA, _state_error

# Mirrors of the client constants (src/client/src/lib/releasePlan/):
# constants.ts: MS_COLORS, SCHEMA, VERSION, DEFAULT_MILESTONE_NAME, DEFAULT_PLAN_NAME;
# fromBacklog.ts: ADO_SYSTEM; types.ts: NO_EPIC_ID, NO_EPIC_TITLE.
MS_COLORS = ("#4E98D1", "#60C5B5", "#EBC160", "#D8804B", "#B64234", "#802D6C", "#0362A4", "#274B76")
SCHEMA = PLAN_STATE_SCHEMA
VERSION = 1
DEFAULT_MILESTONE_NAME = "Milestone"
DEFAULT_PLAN_NAME = "Feature Release Plan"
ADO_SYSTEM = "Azure DevOps"
NO_EPIC_ID = "no-epic"
NO_EPIC_TITLE = "Features without an Epic"

# JavaScript's `String.prototype.trim` whitespace, which differs slightly from
# Python's `str.strip`; `size` must trim exactly as `normalizePlan` does.
_JS_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008"
    "\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_ID_ALPHABET = string.digits + string.ascii_lowercase
_DATE_PATTERN = r"^([0-9]{4}-[0-9]{2}-[0-9]{2})?$"

_DATE_FORMAT = 'must be a real calendar date as YYYY-MM-DD, or "" for no date'


def _need_str(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("must be a string")
    return value


def _non_blank(value: Any) -> str:
    text = _need_str(value)
    if not text.strip():
        raise ValueError("must not be blank")
    return text


def _calendar_date(value: Any) -> str:
    text = _need_str(value)
    if text == "":
        return text
    if len(text) != 10 or not all(c in string.digits for c in text[:4] + text[5:7] + text[8:]) \
            or text[4] != "-" or text[7] != "-":
        raise ValueError(_DATE_FORMAT)
    try:
        date(int(text[:4]), int(text[5:7]), int(text[8:]))
    except ValueError as exc:
        raise ValueError(_DATE_FORMAT) from exc
    return text


def _version(value: Any) -> Any:
    if isinstance(value, bool) or not isinstance(value, int) or value != VERSION:
        raise ValueError(f"must be {VERSION}")
    return value


def _work_item_id(value: Any) -> int | str:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("must be an integer or a non-blank string")
    if isinstance(value, str) and not value.strip():
        raise ValueError("must be an integer or a non-blank string")
    return value


Text = Annotated[str, BeforeValidator(_need_str)]
NonBlank = Annotated[str, BeforeValidator(_non_blank), Field(min_length=1)]
CalendarDate = Annotated[
    str, BeforeValidator(_calendar_date), Field(pattern=_DATE_PATTERN, description="YYYY-MM-DD or empty")
]
WorkItemId = Annotated[int | str, BeforeValidator(_work_item_id)]


def _random_id(prefix: str) -> str:
    return prefix + "".join(secrets.choice(_ID_ALPHABET) for _ in range(7))


def _flag_id(value: str) -> str:
    return value or _random_id("fl_")


def _flag_name(value: str) -> str:
    return value or DEFAULT_MILESTONE_NAME


def _plan_name(value: str) -> str:
    return value or DEFAULT_PLAN_NAME


def _size(value: str) -> str:
    return value.strip(_JS_WHITESPACE).upper()


def _is_none(value: Any) -> bool:
    return value is None


def _no_schema_default(schema: dict[str, Any]) -> None:
    schema.pop("default", None)


def _absent_by_default() -> Any:
    """A field that may be missing and, when missing, stays absent from the
    normalized board (`savedAt`, `source.scope`, `source.fetchedAt`)."""
    return Field(default=None, exclude_if=_is_none, json_schema_extra=_no_schema_default)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Milestone(_Strict):
    """A board row (release or sprint)."""

    id: NonBlank
    name: NonBlank
    date: CalendarDate = ""
    color: Literal[MS_COLORS] = Field(  # type: ignore[valid-type]
        default=None, json_schema_extra=_no_schema_default
    )  # when missing: MS_COLORS[index % 8]


class Flag(_Strict):
    """A milestone flag placed after a milestone; Sprints mode only."""

    id: Annotated[Text, AfterValidator(_flag_id)] = Field(default="", validate_default=True)  # blank: `fl_<random>`
    name: Annotated[Text, AfterValidator(_flag_name)] = Field(default="", validate_default=True)
    date: CalendarDate = ""
    afterMsId: NonBlank


class Feature(_Strict):
    """An Azure DevOps Feature; `milestoneId: null` means Unplanned."""

    id: WorkItemId
    title: NonBlank
    state: Text = ""
    description: Text = ""
    size: Annotated[Text, AfterValidator(_size)] = ""  # stored trimmed and upper-cased
    iterationPath: Text = ""
    milestoneId: str | None = None


class Epic(_Strict):
    """An Azure DevOps Epic with its Features (board columns, left to right)."""

    id: WorkItemId
    title: NonBlank
    state: Text = ""
    description: Text = ""
    features: list[Feature] = Field(default_factory=list)


class Iteration(_Strict):
    path: Text
    finishDate: CalendarDate = ""


class Source(_Strict):
    """The Azure DevOps connection (never the PAT); required, so Sync works."""

    system: str = ADO_SYSTEM
    project: NonBlank
    scope: str = _absent_by_default()
    fetchedAt: str = _absent_by_default()
    kind: Literal["onprem", "cloud"]
    projectUrl: NonBlank
    scopeType: Literal["area", "iteration"]
    scopePath: NonBlank


class Board(_Strict):
    """A Feature release plan (`schema: "release-planner-features"`)."""

    schema_: Literal["release-planner-features"] = Field(alias="schema")
    version: Annotated[Literal[1], BeforeValidator(_version)] = VERSION
    mode: Literal["releases", "sprints"] = "releases"
    name: Annotated[Text, AfterValidator(_plan_name)] = DEFAULT_PLAN_NAME
    savedAt: str = _absent_by_default()
    source: Source
    iterations: list[Iteration] = Field(default_factory=list)
    milestones: list[Milestone]
    flags: list[Flag] = Field(default_factory=list)
    epics: list[Epic]

    @model_validator(mode="after")
    def _fill_milestone_colors(self) -> "Board":
        for i, ms in enumerate(self.milestones):
            if ms.color is None:
                ms.color = MS_COLORS[i % len(MS_COLORS)]
        return self


@dataclass(frozen=True)
class BoardResult:
    """Outcome of `validate_board`: the normalized board, or the errors."""

    board: dict[str, Any] | None = None
    errors: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors


def board_json_schema() -> dict[str, Any]:
    """The board's JSON Schema (self-contained: definitions live in `$defs`)."""
    return Board.model_json_schema(by_alias=True, mode="validation")


def validate_board(state: Any, allowed_hosts: Iterable[str]) -> BoardResult:
    """Strictly validate a board and return it normalized.

    The 5 MiB and NUL limits are checked first (`_state_error`). Then every
    structural error and cross-reference error is reported at once, each as
    `<path>: <problem>`. The input is never mutated.

    Args:
        state: The parsed board JSON.
        allowed_hosts: Host allowlist for `source.projectUrl` (`ADO_ALLOWED_HOSTS`).
    """
    limit_error = _state_error(state)
    if limit_error:
        return BoardResult(errors=[limit_error])

    errors: list[str] = []
    board: Board | None = None
    try:
        board = Board.model_validate(state)
    except ValidationError as exc:
        errors.extend(_structural_errors(exc))
    errors.extend(_reference_errors(state, tuple(allowed_hosts)))
    errors = list(dict.fromkeys(errors))
    if errors or board is None:
        return BoardResult(errors=errors)
    return BoardResult(board=board.model_dump(by_alias=True))


# ---- structural errors ----------------------------------------------------


def _path(loc: Iterable[Any]) -> str:
    out = ""
    for part in loc:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += f".{part}" if out else str(part)
    return out


def _problem(error: Any) -> str:
    kind = error["type"]
    if kind == "missing":
        return "is required"
    if kind == "extra_forbidden":
        return "unknown key (not part of the board format)"
    if kind == "value_error":
        return str(error["ctx"]["error"])
    if kind in ("literal_error", "enum"):
        return f"must be {error['ctx']['expected']}"
    if kind == "model_type":
        return "must be an object"
    if kind == "list_type":
        return "must be an array"
    if kind == "string_type":
        return "must be a string"
    return str(error["msg"])


def _structural_errors(exc: ValidationError) -> list[str]:
    return [f"{_path(e['loc'])}: {_problem(e)}" if e["loc"] else _problem(e) for e in exc.errors()]


# ---- cross-reference errors (run over the well-formed parts of `state`) ----


def _items(value: Any) -> list[tuple[int, dict[str, Any]]]:
    """The object entries of an array, with their index; other values are skipped."""
    if not isinstance(value, list):
        return []
    return [(i, item) for i, item in enumerate(value) if isinstance(item, dict)]


def _id_text(value: Any) -> str | None:
    """An id as text (so `123` and `"123"` collide), None when not a valid id."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and value.strip():
        return value
    return None


def _reference_errors(state: dict[str, Any], allowed_hosts: tuple[str, ...]) -> list[str]:
    errors: list[str] = []
    errors.extend(_source_errors(state.get("source"), allowed_hosts))

    milestone_ids: dict[str, int] = {}
    for i, ms in _items(state.get("milestones")):
        ms_id = ms.get("id")
        if not isinstance(ms_id, str) or not ms_id.strip():
            continue
        if ms_id in milestone_ids:
            errors.append(
                f"milestones[{i}].id: duplicate milestone id {ms_id!r} "
                f"(already used by milestones[{milestone_ids[ms_id]}])"
            )
        else:
            milestone_ids[ms_id] = i

    flags = state.get("flags")
    mode = state.get("mode", "releases")
    if mode == "releases" and isinstance(flags, list) and flags:
        errors.append('flags: must be empty in "releases" mode; set mode to "sprints" to use flags')
    flag_ids: dict[str, int] = {}
    for i, flag in _items(flags):
        flag_id = flag.get("id")
        if isinstance(flag_id, str) and flag_id.strip():
            if flag_id in flag_ids:
                errors.append(
                    f"flags[{i}].id: duplicate flag id {flag_id!r} (already used by flags[{flag_ids[flag_id]}])"
                )
            else:
                flag_ids[flag_id] = i
        after = flag.get("afterMsId")
        if isinstance(after, str) and after.strip() and after not in milestone_ids:
            errors.append(
                f"flags[{i}].afterMsId: unknown milestone id {after!r}; "
                "use the id of an entry in milestones"
            )

    epic_ids: dict[str, int] = {}
    feature_ids: dict[str, str] = {}
    for i, epic in _items(state.get("epics")):
        epic_id = _id_text(epic.get("id"))
        if epic_id is not None:
            if epic_id in epic_ids:
                errors.append(
                    f"epics[{i}].id: duplicate Epic id {epic_id!r} (already used by epics[{epic_ids[epic_id]}])"
                )
            else:
                epic_ids[epic_id] = i
        for j, feature in _items(epic.get("features")):
            here = f"epics[{i}].features[{j}]"
            feature_id = _id_text(feature.get("id"))
            if feature_id is not None:
                if feature_id in feature_ids:
                    errors.append(
                        f"{here}.id: duplicate Feature id {feature_id!r} "
                        f"(already used by {feature_ids[feature_id]}); Feature ids are unique across all Epics"
                    )
                else:
                    feature_ids[feature_id] = here
            ref = feature.get("milestoneId")
            if isinstance(ref, str) and ref not in milestone_ids:
                errors.append(
                    f"{here}.milestoneId: unknown milestone id {ref!r}; "
                    "use the id of an entry in milestones, or null for Unplanned"
                )
    return errors


def _source_errors(source: Any, allowed_hosts: tuple[str, ...]) -> list[str]:
    if not isinstance(source, dict):
        return []
    kind, url = source.get("kind"), source.get("projectUrl")
    if kind not in ("onprem", "cloud") or not isinstance(url, str) or not url.strip():
        return []
    try:
        parse_project_url(kind, url, allowed_hosts)
    except AdoUrlError as exc:
        return [f"source.projectUrl: {exc}"]
    return []
