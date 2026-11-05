"""Helpers for the MCP tool unit tests: an in-process client and call
wrappers (no HTTP)."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from mcp import Client
from mcp.types import CallToolResult
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.mcp_server.server import create_mcp_server


def run_client(fn: Callable[[Client], Awaitable[Any]]) -> Any:
    """Run `fn(client)` against a fresh server on its own event loop."""

    async def main() -> Any:
        async with Client(create_mcp_server()) as client:
            return await fn(client)

    return asyncio.run(main())


def call(name: str, arguments: dict[str, Any]) -> CallToolResult:
    return run_client(lambda client: client.call_tool(name, arguments))


def ok(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    result = call(name, arguments)
    assert not result.is_error, result.content
    assert result.structured_content is not None
    return result.structured_content


def failure(name: str, arguments: dict[str, Any]) -> str:
    """The text of the ToolError the call returned."""
    result = call(name, arguments)
    assert result.is_error, result.structured_content
    return "\n".join(block.text for block in result.content)  # type: ignore[union-attr]


def db_provider(url: str):
    """A `deps` session provider on a fresh NullPool engine per use."""

    @asynccontextmanager
    async def provider():
        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as session:
                yield session
        finally:
            await engine.dispose()

    return provider


def wire(result: CallToolResult) -> str:
    """Everything a client could read from a result."""
    return json.dumps([result.structured_content, [block.model_dump() for block in result.content]], default=str)
