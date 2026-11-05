from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.schemas import (
    AdoBacklogRequest,
    AdoBacklogResponse,
    AdoConnectRequest,
    AdoConnectResponse,
    AdoSprintHistoryRequest,
    AdoSprintHistoryResponse,
    ErrorResponse,
)
from app.services.ado_backlog import connect as ado_connect
from app.services.ado_backlog import fetch_backlog, scope_field_errors
from app.services.ado_client import UNEXPECTED_RESPONSE, AdoError
from app.services.ado_http import ado_client, ado_http_client
from app.services.ado_sprint_history import fetch_sprint_history, iteration_path_errors
from app.services.ado_url import AdoUrlError, connection_field_errors

router = APIRouter()

ERROR_RESPONSES = {422: {"model": ErrorResponse}}


async def get_ado_http_client(settings: Settings = Depends(get_settings)) -> AsyncIterator[httpx.AsyncClient]:
    """One httpx client per request, closed when the response is done. Tests
    override this dependency with a client on an `httpx.MockTransport`."""
    async with ado_http_client(settings) as client:
        yield client


def _errors(messages: list[str]) -> JSONResponse:
    """The contract's 422 `{errors}`. Characters that cannot be UTF-8 encoded
    are replaced, so rendering the error itself can never fail."""
    safe = [m.encode("utf-8", "replace").decode("utf-8") for m in messages]
    return JSONResponse(status_code=422, content={"errors": safe})


def _request_body(model: type) -> dict:
    """Document the JSON body in OpenAPI while the route reads it manually."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema(by_alias=True)}},
        }
    }


async def _read_json_object(request: Request) -> dict:
    """The JSON body as a dict; anything unreadable (incl. nesting deeper than
    the decoder allows) or not an object is {} so the field checks report it
    with the app's own messages."""
    try:
        data = await request.json()
    except (ValueError, RecursionError):
        return {}
    return data if isinstance(data, dict) else {}


@router.post(
    "/connect",
    response_model=AdoConnectResponse,
    response_model_exclude_none=True,
    responses=ERROR_RESPONSES,
    openapi_extra=_request_body(AdoConnectRequest),
)
async def connect(
    request: Request,
    settings: Settings = Depends(get_settings),
    http: httpx.AsyncClient = Depends(get_ado_http_client),
):
    """JSON `{source, projectUrl, pat}`: validates the URL and the PAT and
    returns the project with its Area and Iteration trees.

    The body is read manually rather than as a Pydantic body param so
    missing/blank fields produce the API contract's messages (all failing
    fields together) instead of FastAPI's own 422. A URL whose host is not
    on the allowlist is rejected before any request to Azure DevOps, as is
    input that can never be valid: a URL that is not UTF-8 encodable gets the
    shape message for the source, a PAT that is not UTF-8 encodable or has
    control characters gets the PAT-rejected message (see `AdoClient`). Any
    UnicodeError / RecursionError that still escapes the services is a 422
    "unexpected response", never a 500.
    """
    data = await _read_json_object(request)
    errors = connection_field_errors(data)
    if errors:
        return _errors(errors)
    payload = AdoConnectRequest.model_validate(data)

    try:
        project, client = ado_client(payload, settings, http)
        return await ado_connect(client, project)
    except (AdoUrlError, AdoError) as exc:
        return _errors([str(exc)])
    except (UnicodeError, RecursionError):
        return _errors([UNEXPECTED_RESPONSE])


@router.post(
    "/backlog",
    response_model=AdoBacklogResponse,
    responses=ERROR_RESPONSES,
    openapi_extra=_request_body(AdoBacklogRequest),
)
async def backlog(
    request: Request,
    settings: Settings = Depends(get_settings),
    http: httpx.AsyncClient = Depends(get_ado_http_client),
):
    """JSON `{source, projectUrl, pat, scopeType, scopePath}`: the Epics and
    Features under the chosen Area or Iteration path, plus the iterations.

    Validated like `connect` (same messages, all failing fields together),
    plus "Choose an Area path or an Iteration path." for a missing/invalid
    `scopeType` or a blank `scopePath`.
    """
    data = await _read_json_object(request)
    errors = connection_field_errors(data) + scope_field_errors(data)
    if errors:
        return _errors(errors)
    payload = AdoBacklogRequest.model_validate(data)

    try:
        project, client = ado_client(payload, settings, http)
        return await fetch_backlog(
            client, project, payload.scope_type, payload.scope_path, settings.ado_description_max_chars
        )
    except (AdoUrlError, AdoError) as exc:
        return _errors([str(exc)])
    except (UnicodeError, RecursionError):
        return _errors([UNEXPECTED_RESPONSE])


@router.post(
    "/sprint-history",
    response_model=AdoSprintHistoryResponse,
    responses=ERROR_RESPONSES,
    openapi_extra=_request_body(AdoSprintHistoryRequest),
)
async def sprint_history(
    request: Request,
    settings: Settings = Depends(get_settings),
    http: httpx.AsyncClient = Depends(get_ado_http_client),
):
    """JSON `{source, projectUrl, pat, iterationPath}`: the resolved User
    Stories and Bugs under the chosen Iteration path, the Monte Carlo sprint
    history (its `workItems` are posted to /api/validate as
    `sprint_history_items`).

    Validated like `connect` (same messages, all failing fields together),
    plus "Choose an Iteration path." for a missing or blank `iterationPath`.
    """
    data = await _read_json_object(request)
    errors = connection_field_errors(data) + iteration_path_errors(data)
    if errors:
        return _errors(errors)
    payload = AdoSprintHistoryRequest.model_validate(data)

    try:
        project, client = ado_client(payload, settings, http)
        return await fetch_sprint_history(client, project, payload.iteration_path)
    except (AdoUrlError, AdoError) as exc:
        return _errors([str(exc)])
    except (UnicodeError, RecursionError):
        return _errors([UNEXPECTED_RESPONSE])
