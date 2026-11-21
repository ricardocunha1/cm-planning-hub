"""The signed-in user's saved Azure DevOps credentials
(`/api/settings/ado-credentials`, plans/oauth-authentication.md). The PAT is
accepted in request bodies only; no response, log line or error message
carries it. A credential that is not the user's answers 404, like an unknown
id, so ids of other users' credentials are never confirmed."""

from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import ApiError, require_user
from app.api.plan_routes import PlanRoute
from app.config import Settings, get_settings
from app.db import get_session
from app.schemas import (
    AdoCredentialListResponse,
    AdoCredentialRequest,
    AdoCredentialResponse,
    ErrorResponse,
)
from app.services import credentials
from app.services.credentials import CredentialsUnavailableError, credential_field_errors

router = APIRouter(route_class=PlanRoute)

ERROR_RESPONSES = {
    404: {"model": ErrorResponse},
    422: {"model": ErrorResponse},
    503: {"model": ErrorResponse},
}

NO_USER = "Saved credentials need a signed-in user (authentication is disabled on this server)."


def _error(status_code: int, *messages: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"errors": list(messages)})


def _not_found(credential_id: int) -> JSONResponse:
    return _error(404, f"Credential not found: {credential_id}.")


def _body_schema() -> dict:
    """Document the JSON body in OpenAPI while the route reads it manually."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": AdoCredentialRequest.model_json_schema(by_alias=True)}},
        }
    }


async def _read_json_object(request: Request) -> dict[str, Any]:
    """The JSON body as a dict; anything unreadable or not an object is {} so
    the field checks report it with the app's own messages."""
    try:
        data = await request.json()
    except (ValueError, RecursionError):
        return {}
    return data if isinstance(data, dict) else {}


def _user(user_id: int | None) -> int:
    """The signed-in user; credentials cannot be saved without one."""
    if user_id is None:
        raise ApiError(409, NO_USER)
    return user_id


def _unavailable(exc: CredentialsUnavailableError) -> JSONResponse:
    return _error(503, str(exc))


@router.get("", response_model=AdoCredentialListResponse, response_model_by_alias=True, responses=ERROR_RESPONSES)
async def list_credentials(
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(require_user),
):
    """The user's saved credentials; `hasPat` is always true, the PAT is never
    returned (only `patLast4`, null for short or unreadable PATs)."""
    rows = await credentials.list_credentials(session, _user(user_id))
    return AdoCredentialListResponse(items=[credentials.to_response(row, settings) for row in rows])


@router.post(
    "",
    status_code=201,
    response_model=AdoCredentialResponse,
    response_model_by_alias=True,
    responses=ERROR_RESPONSES,
    openapi_extra=_body_schema(),
)
async def create_credential(
    request: Request,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(require_user),
):
    """JSON `{projectName, projectUrl, pat}`. 422 for empty fields, an invalid
    URL or host, or a project URL (compared canonically) already saved."""
    owner = _user(user_id)
    data = await _read_json_object(request)
    errors, canonical = credential_field_errors(data, settings.ado_allowed_hosts, pat_required=True)
    if errors or canonical is None:
        return _error(422, *errors)
    try:
        row = await credentials.create_credential(
            session, settings, owner, data["projectName"], canonical, data["pat"]
        )
    except CredentialsUnavailableError as exc:
        return _unavailable(exc)
    if row is None:
        return _error(422, credentials.DUPLICATE_URL)
    return JSONResponse(
        status_code=201, content=credentials.to_response(row, settings).model_dump(mode="json", by_alias=True)
    )


@router.put(
    "/{credential_id}",
    response_model=AdoCredentialResponse,
    response_model_by_alias=True,
    responses=ERROR_RESPONSES,
    openapi_extra=_body_schema(),
)
async def update_credential(
    credential_id: int,
    request: Request,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(require_user),
):
    """JSON `{projectName, projectUrl, pat?}`. An omitted or blank `pat` keeps
    the stored one, except when the canonical project URL changes: then it is
    required, so a PAT is never silently moved to another project."""
    owner = _user(user_id)
    row = await credentials.get_credential(session, owner, credential_id)
    if row is None:
        return _not_found(credential_id)
    data = await _read_json_object(request)
    errors, canonical = credential_field_errors(data, settings.ado_allowed_hosts, pat_required=False)
    new_pat = data.get("pat").strip() if isinstance(data.get("pat"), str) and data["pat"].strip() else None
    if canonical is not None and canonical.lower() != row.project_url.lower() and new_pat is None:
        errors.append(credentials.PAT_REQUIRED_ON_URL_CHANGE)
    if errors or canonical is None:
        return _error(422, *errors)
    try:
        updated = await credentials.update_credential(session, settings, row, data["projectName"], canonical, new_pat)
    except CredentialsUnavailableError as exc:
        return _unavailable(exc)
    if updated is None:
        return _error(422, credentials.DUPLICATE_URL)
    return credentials.to_response(updated, settings)


@router.delete("/{credential_id}", status_code=204, responses=ERROR_RESPONSES)
async def delete_credential(
    credential_id: int,
    session: AsyncSession = Depends(get_session),
    user_id: int | None = Depends(require_user),
):
    if not await credentials.delete_credential(session, _user(user_id), credential_id):
        return _not_found(credential_id)
    return Response(status_code=204)
