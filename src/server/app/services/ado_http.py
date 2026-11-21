"""Shared Azure DevOps plumbing for the REST routes and the MCP tools: the
httpx client factory and the URL-allowlist + `AdoClient` construction."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.schemas import AdoConnectRequest

from .ado_client import AdoClient
from .ado_url import PAT_OR_SAVED_REQUIRED, AdoProject, AdoUrlError, parse_project_url
from .credentials import find_pat


@asynccontextmanager
async def ado_http_client(settings: Settings) -> AsyncIterator[httpx.AsyncClient]:
    """One httpx client, closed on exit.

    TLS certificate verification is disabled: on-prem Azure DevOps Server
    instances (e.g. tfs-projects.cmf.criticalmanufacturing.com) use
    certificates signed by an internal CA that isn't in the image's bundle."""
    async with httpx.AsyncClient(
        timeout=settings.ado_timeout_seconds, follow_redirects=False, verify=False
    ) as client:
        yield client


def ado_client(
    payload: AdoConnectRequest, settings: Settings, http: httpx.AsyncClient, pat: str | None = None
) -> tuple[AdoProject, AdoClient]:
    """Parse the project URL (allowlist included) and build the client.

    The PAT is the request's own when it has one, else `pat` (the user's saved
    PAT resolved by the caller; see `resolve_pat`). A request's PAT always wins.

    Raises:
        AdoUrlError: for a URL that breaks the rules, before any request, or
            when there is no PAT at all.
        AdoError: PAT_REJECTED for a PAT that can never be valid.
    """
    project = parse_project_url(payload.source, payload.project_url, settings.ado_allowed_hosts)
    token = request_pat(payload) or (pat or "").strip()
    if not token:
        raise AdoUrlError(PAT_OR_SAVED_REQUIRED)
    client = AdoClient(http, project.base_url, token, settings.ado_timeout_seconds)
    return project, client


def request_pat(payload: AdoConnectRequest) -> str:
    """The trimmed PAT the request carries; "" when absent or blank."""
    return payload.pat.get_secret_value().strip() if payload.pat is not None else ""


async def resolve_pat(
    payload: AdoConnectRequest, settings: Settings, session: AsyncSession, user_id: int | None
) -> str | None:
    """The saved PAT to use when the request carries none: the session user's
    credential for the project's canonical URL. None when the request has its
    own PAT (it always wins), there is no signed-in user (`AUTH_ENABLED` false)
    or nothing is saved.

    Raises:
        AdoUrlError: the project URL breaks the rules.
        CredentialsUnavailableError / StoredPatUnreadableError: see `find_pat`.
    """
    if request_pat(payload) or user_id is None:
        return None
    project = parse_project_url(payload.source, payload.project_url, settings.ado_allowed_hosts)
    return await find_pat(session, settings, user_id, project.project_url)
