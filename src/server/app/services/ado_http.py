"""Shared Azure DevOps plumbing for the REST routes and the MCP tools: the
httpx client factory and the URL-allowlist + `AdoClient` construction."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx

from app.config import Settings
from app.schemas import AdoConnectRequest

from .ado_client import AdoClient
from .ado_url import AdoProject, parse_project_url


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
    payload: AdoConnectRequest, settings: Settings, http: httpx.AsyncClient
) -> tuple[AdoProject, AdoClient]:
    """Parse the project URL (allowlist included) and build the client.

    Raises:
        AdoUrlError: for a URL that breaks the rules, before any request.
        AdoError: PAT_REJECTED for a PAT that can never be valid.
    """
    project = parse_project_url(payload.source, payload.project_url, settings.ado_allowed_hosts)
    client = AdoClient(http, project.base_url, payload.pat.get_secret_value().strip(), settings.ado_timeout_seconds)
    return project, client
