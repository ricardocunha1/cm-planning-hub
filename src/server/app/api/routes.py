from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile  # what request.form() yields; fastapi.UploadFile subclasses it

from app.schemas import (
    ErrorResponse,
    HealthResponse,
    SimulateRequest,
    SimulateResponse,
    ValidateResponse,
)
from app.services.data_processing import (
    DataValidationError,
    build_sprint_summary,
    parse_sprint_history,
    parse_sprint_history_items,
    summary_from_records,
    summary_to_records,
)
from app.services.forecast import SimulationError, run_forecast
from app.services.validation import SPRINT_HISTORY_ITEMS_FIELD, has_sprint_history_items, validate_parameters

router = APIRouter()
# Open without a session (the load balancer and the container healthcheck call it).
public_router = APIRouter()

FORM_FIELDS = (
    "target_type",
    "target_value",
    "num_simulations",
    "exclude_latest_sprints",
    "sprint_start_date",
    "sprint_length",
    "team_capacity_factor",
)

ERROR_RESPONSES = {422: {"model": ErrorResponse}}

# Largest non-file form field (Starlette's default is 1 MB): the Azure DevOps
# `sprint_history_items` JSON can hold up to 20000 work items. Matches the
# client's nginx upload limit.
MAX_FORM_PART_SIZE = 20 * 1024 * 1024


def _errors(messages: list[str]) -> JSONResponse:
    return JSONResponse(status_code=422, content={"errors": messages})


@public_router.get("/health", response_model=HealthResponse)
def health():
    return {"status": "ok"}


@router.post("/validate", response_model=ValidateResponse, responses=ERROR_RESPONSES)
async def validate(request: Request):
    """Multipart form: the Data Input fields (`target_type`, `target_value`,
    `num_simulations`, `skip_validation`, `exclude_latest_sprints`,
    `sprint_start_date`, `sprint_length`, `team_capacity_factor`) plus the
    data source: the `sprint_history_file` upload, or `sprint_history_items`
    (the `/api/ado/sprint-history` `workItems` as a JSON string), which, when
    non-blank, replaces the file. Returns the sprint summary and the params
    to send back to /api/simulate.

    Errors in the Azure DevOps items are reported together with the
    parameter errors; an unreadable Excel file is only reported once the
    parameters are valid.

    The form is read manually rather than through FastAPI `Form()` params so
    missing/blank fields and an empty file input produce the same error
    messages as the original form handling instead of FastAPI's own 422.
    """
    form = await request.form(max_part_size=MAX_FORM_PART_SIZE)
    file = form.get("sprint_history_file")
    if not isinstance(file, UploadFile):
        file = None
    fields = {key: value for key, value in form.items() if isinstance(value, str)}

    errors = validate_parameters(fields, file)

    df = None
    if has_sprint_history_items(fields):
        try:
            df = await run_in_threadpool(parse_sprint_history_items, fields[SPRINT_HISTORY_ITEMS_FIELD])
        except DataValidationError as exc:
            errors = [str(exc)] + errors
    elif not errors:
        try:
            df = await run_in_threadpool(parse_sprint_history, file.file)
        except DataValidationError as exc:
            errors = [str(exc)]

    if errors:
        return _errors(errors)

    exclude_latest_raw = fields.get("exclude_latest_sprints", "").strip()
    exclude_latest = int(exclude_latest_raw) if exclude_latest_raw else 0
    summary = build_sprint_summary(df, exclude_latest)

    params = {key: fields[key] for key in FORM_FIELDS if key in fields}
    params["skip_validation"] = "skip_validation" in form
    return {"summary": summary_to_records(summary), "params": params}


@router.post("/simulate", response_model=SimulateResponse, responses=ERROR_RESPONSES)
def simulate(payload: SimulateRequest):
    summary = summary_from_records([record.model_dump(by_alias=True) for record in payload.summary])
    try:
        return run_forecast(summary, payload.params.model_dump())
    except SimulationError as exc:
        return _errors([str(exc)])
    except (TypeError, ValueError, KeyError) as exc:
        return _errors([f"Could not run simulation: {exc}"])
