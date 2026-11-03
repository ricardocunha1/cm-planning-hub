from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr


class SprintSummaryRecord(BaseModel):
    """One row of the sprint summary. Serialized with the same column names
    the summary DataFrame uses (e.g. "In Sampling Pool")."""

    model_config = ConfigDict(populate_by_name=True)

    sprint: str = Field(alias="Sprint")
    items_resolved: int = Field(alias="Items Resolved")
    story_points: int = Field(alias="Story Points")
    last_resolved_date: str = Field(alias="Last Resolved Date")
    recency_rank: int = Field(alias="Recency Rank")
    in_sampling_pool: bool = Field(alias="In Sampling Pool")


class SimulationParams(BaseModel):
    """The original Data Input form fields, kept as raw strings (exactly as
    submitted) so /api/simulate parses them the same way the form did."""

    model_config = ConfigDict(coerce_numbers_to_str=True)

    target_type: str | None = None
    target_value: str | None = None
    num_simulations: str | None = None
    skip_validation: bool = False
    exclude_latest_sprints: str | None = None
    sprint_start_date: str | None = None
    sprint_length: str | None = None
    team_capacity_factor: str | None = None


class ValidateResponse(BaseModel):
    summary: list[SprintSummaryRecord]
    params: SimulationParams


class SimulateRequest(BaseModel):
    summary: list[SprintSummaryRecord]
    params: SimulationParams


class ResultRow(BaseModel):
    confidence: int
    label: str
    sprints: int
    exceeds_window: bool
    completion_date: str | None


class Histogram(BaseModel):
    labels: list[str]
    counts: list[int]


class SimulateResponse(BaseModel):
    target_type: str
    target_value: int
    rows: list[ResultRow]
    histogram: Histogram


class ErrorResponse(BaseModel):
    errors: list[str]


class HealthResponse(BaseModel):
    status: str


AdoSource = Literal["onprem", "cloud"]


class AdoConnectRequest(BaseModel):
    """The common `/api/ado/*` request part. The PAT is a SecretStr so it is
    masked in reprs and never echoed back."""

    model_config = ConfigDict(populate_by_name=True)

    source: AdoSource
    project_url: str = Field(alias="projectUrl")
    pat: SecretStr


class AdoTreeNode(BaseModel):
    """An Area or Iteration classification node with its normalized path.
    `finishDate` (`YYYY-MM-DD` or "") is only set on Iteration nodes."""

    model_config = ConfigDict(populate_by_name=True)

    name: str
    path: str
    finish_date: str | None = Field(default=None, alias="finishDate")
    children: list["AdoTreeNode"] = []


class AdoProjectInfo(BaseModel):
    id: str
    name: str


class AdoConnectResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project: AdoProjectInfo
    project_url: str = Field(alias="projectUrl")
    areas: AdoTreeNode
    iterations: AdoTreeNode


AdoScopeType = Literal["area", "iteration"]


class AdoBacklogRequest(AdoConnectRequest):
    """The common part plus the chosen Area or Iteration path, in the
    normalized node path form (e.g. `Proj\\Team A`)."""

    scope_type: AdoScopeType = Field(alias="scopeType")
    scope_path: str = Field(alias="scopePath")


class AdoWorkItem(BaseModel):
    """An Epic or Feature, normalized as described in the API contract."""

    model_config = ConfigDict(populate_by_name=True)

    id: int
    type: str
    title: str
    state: str
    description: str
    size: str
    iteration_path: str = Field(alias="iterationPath")
    parent_id: int | None = Field(alias="parentId")


class AdoIteration(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    path: str
    finish_date: str = Field(alias="finishDate")


class AdoBacklogResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project: AdoProjectInfo
    project_url: str = Field(alias="projectUrl")
    scope: str
    fetched_at: str = Field(alias="fetchedAt")
    work_items: list[AdoWorkItem] = Field(alias="workItems")
    iterations: list[AdoIteration]
    warnings: list[str]


class AdoSprintHistoryRequest(AdoConnectRequest):
    """The common part plus the chosen Iteration path, in the normalized node
    path form (e.g. `Proj\\Phase 1`)."""

    iteration_path: str = Field(alias="iterationPath")


class AdoSprintHistoryItem(BaseModel):
    """A resolved User Story or Bug, normalized as described in the API
    contract. `resolvedDate` is UTC `YYYY-MM-DDTHH:MM:SSZ`; `storyPoints` is
    kept as ADO returns it (int or float), 0 when missing."""

    model_config = ConfigDict(populate_by_name=True)

    id: int
    type: str
    title: str
    state: str
    iteration_path: str = Field(alias="iterationPath")
    resolved_date: str = Field(alias="resolvedDate")
    story_points: int | float = Field(alias="storyPoints")


class AdoSprintHistoryResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    project: AdoProjectInfo
    project_url: str = Field(alias="projectUrl")
    iteration_path: str = Field(alias="iterationPath")
    fetched_at: str = Field(alias="fetchedAt")
    work_items: list[AdoSprintHistoryItem] = Field(alias="workItems")
    warnings: list[str]


PlanProjectType = Literal["onprem", "cloud"]


class PlanSummary(BaseModel):
    """A stored Release Plan without its board (list item)."""

    model_config = ConfigDict(populate_by_name=True)

    id: int
    name: str
    project_type: PlanProjectType = Field(alias="projectType")
    project_name: str = Field(alias="projectName")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")


class PlanDetail(PlanSummary):
    state: dict[str, Any]


class PlanListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    items: list[PlanSummary]
    total: int
    page: int
    page_size: int = Field(alias="pageSize")


class PlanUpdateRequest(BaseModel):
    """`PUT /api/plan/{id}` body. Extra keys (e.g. `projectType`) are ignored.
    The routes read the body manually and run `plan_field_errors` first so the
    422 messages are the contract's own."""

    name: str
    state: dict[str, Any]


class PlanCreateRequest(PlanUpdateRequest):
    model_config = ConfigDict(populate_by_name=True)

    project_type: PlanProjectType = Field(alias="projectType")
    project_name: str = Field(alias="projectName")
