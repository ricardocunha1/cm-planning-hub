"""Test seam for the MCP tools. FastAPI dependencies and
`app.dependency_overrides` don't reach them, so tools get their database
session and Azure DevOps HTTP client from these providers, which tests replace
through `override_providers`."""

from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager, contextmanager

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_sessionmaker
from app.services.ado_http import ado_http_client

SessionProvider = Callable[[], AbstractAsyncContextManager[AsyncSession]]
AdoClientProvider = Callable[[], AbstractAsyncContextManager[httpx.AsyncClient]]


@asynccontextmanager
async def _default_session() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as session:
        yield session


@asynccontextmanager
async def _default_ado_client() -> AsyncIterator[httpx.AsyncClient]:
    async with ado_http_client(get_settings()) as client:
        yield client


_session_provider: SessionProvider = _default_session
_ado_client_provider: AdoClientProvider = _default_ado_client


def db_session() -> AbstractAsyncContextManager[AsyncSession]:
    """Use in tools: `async with db_session() as session: ...`."""
    return _session_provider()


def ado_http() -> AbstractAsyncContextManager[httpx.AsyncClient]:
    """Use in tools: `async with ado_http() as http: ...`."""
    return _ado_client_provider()


@contextmanager
def override_providers(
    session: SessionProvider | None = None, ado_client: AdoClientProvider | None = None
) -> Iterator[None]:
    """Replace the providers for the duration of the block (tests only)."""
    global _session_provider, _ado_client_provider
    previous = (_session_provider, _ado_client_provider)
    _session_provider = session or _session_provider
    _ado_client_provider = ado_client or _ado_client_provider
    try:
        yield
    finally:
        _session_provider, _ado_client_provider = previous
