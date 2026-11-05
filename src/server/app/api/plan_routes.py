from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import DB_ERRORS, DB_UNAVAILABLE, get_session
from app.schemas import (
    ErrorResponse,
    PlanCreateRequest,
    PlanDetail,
    PlanListResponse,
    PlanUpdateRequest,
)
from app.services import plans
from app.services.plans import PLAN_PAGE_SIZE, plan_field_errors


class PlanRoute(APIRoute):
    """Maps database connection failures (during session acquisition or a
    query) to 503 `{errors}`; any other exception keeps its usual handling."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            try:
                return await handler(request)
            except DB_ERRORS:
                return _error(503, DB_UNAVAILABLE)

        return guarded


router = APIRouter(route_class=PlanRoute)

M = TypeVar("M", bound=BaseModel)

ERROR_RESPONSES = {
    404: {"model": ErrorResponse},
    422: {"model": ErrorResponse},
    503: {"model": ErrorResponse},
}


def _error(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"errors": [message]})


def _not_found(plan_id: int) -> JSONResponse:
    return _error(404, f"Release plan not found: {plan_id}.")


def _request_body(model: type[BaseModel]) -> dict:
    """Document the JSON body in OpenAPI while the route reads it manually."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema(by_alias=True)}},
        }
    }


async def _read_json_object(request: Request) -> dict:
    """The JSON body as a dict; anything unreadable or not an object is {} so
    the field checks report it with the app's own messages."""
    try:
        data = await request.json()
    except (ValueError, RecursionError):
        return {}
    return data if isinstance(data, dict) else {}


def _parse_body(data: dict, model: type[M], *, with_project: bool) -> M | JSONResponse:
    """The contract's field messages first (422 `{errors}`); then the model,
    whose failures (e.g. `projectType`) go through the app's validation
    handler (`Invalid request: body.<field>: ...`)."""
    errors = plan_field_errors(data, with_project=with_project)
    if errors:
        return JSONResponse(status_code=422, content={"errors": errors})
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise RequestValidationError([{**err, "loc": ("body", *err["loc"])} for err in exc.errors()])


@router.get("", response_model=PlanListResponse, response_model_by_alias=True, responses=ERROR_RESPONSES)
async def list_plans(page: int = Query(1, ge=1), session: AsyncSession = Depends(get_session)):
    """One page of plans, most recently updated first."""
    items, total = await plans.list_plans(session, page)
    return PlanListResponse(items=items, total=total, page=page, pageSize=PLAN_PAGE_SIZE)


@router.get("/{plan_id}", response_model=PlanDetail, response_model_by_alias=True, responses=ERROR_RESPONSES)
async def get_plan(plan_id: int, session: AsyncSession = Depends(get_session)):
    plan = await plans.get_plan(session, plan_id)
    return plan if plan else _not_found(plan_id)


@router.post(
    "",
    status_code=201,
    response_model=PlanDetail,
    response_model_by_alias=True,
    responses=ERROR_RESPONSES,
    openapi_extra=_request_body(PlanCreateRequest),
)
async def create_plan(request: Request, session: AsyncSession = Depends(get_session)):
    """JSON `{name, projectType, projectName, state}`. The body is read
    manually so the name/state 422s carry the contract's exact messages."""
    payload = _parse_body(await _read_json_object(request), PlanCreateRequest, with_project=True)
    if isinstance(payload, JSONResponse):
        return payload
    created = await plans.create_plan(
        session, payload.name, payload.project_type, payload.project_name, payload.state
    )
    return JSONResponse(status_code=201, content=created.model_dump(mode="json", by_alias=True))


@router.put(
    "/{plan_id}",
    response_model=PlanDetail,
    response_model_by_alias=True,
    responses=ERROR_RESPONSES,
    openapi_extra=_request_body(PlanUpdateRequest),
)
async def update_plan(plan_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    """JSON `{name, state}`; extra keys are ignored. Last write wins."""
    payload = _parse_body(await _read_json_object(request), PlanUpdateRequest, with_project=False)
    if isinstance(payload, JSONResponse):
        return payload
    updated = await plans.update_plan(session, plan_id, payload.name, payload.state)
    return updated if updated else _not_found(plan_id)


@router.delete("/{plan_id}", status_code=204, responses=ERROR_RESPONSES)
async def delete_plan(plan_id: int, session: AsyncSession = Depends(get_session)):
    if not await plans.delete_plan(session, plan_id):
        return _not_found(plan_id)
    return Response(status_code=204)
