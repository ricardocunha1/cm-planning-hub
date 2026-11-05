"""Error mapping shared by the MCP tools (plans/release-plan-mcp-server.md,
"Tool errors"). Tools fail by raising `ToolError`, whose message is what the
agent reads."""

import functools
import logging
import traceback
from collections.abc import Awaitable, Callable
from typing import ParamSpec, TypeVar

from mcp.server.mcpserver.exceptions import ToolError

from app.db import DB_ERRORS, DB_UNAVAILABLE

logger = logging.getLogger(__name__)

UNEXPECTED_ERROR = "The tool failed unexpectedly. Try again later."

P = ParamSpec("P")
R = TypeVar("R")


def guarded(
    *, log_messages: bool = True
) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]:
    """Decorator mapping failures of an async tool to `ToolError`.

    A `ToolError` passes through; the database errors become `DB_UNAVAILABLE`;
    anything else becomes `UNEXPECTED_ERROR` and its traceback is logged on
    the server only. With `log_messages=False` the log holds the exception
    type and the stack frames but not the exception text, for tools whose
    arguments are secrets.
    """

    def decorator(fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
        @functools.wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            try:
                return await fn(*args, **kwargs)
            except ToolError:
                raise
            except DB_ERRORS:
                raise ToolError(DB_UNAVAILABLE) from None
            except Exception as exc:
                _log_unexpected(fn.__name__, exc, log_messages)
                raise ToolError(UNEXPECTED_ERROR) from None

        return wrapper

    return decorator


def _log_unexpected(tool: str, exc: Exception, log_messages: bool) -> None:
    if log_messages:
        logger.error("MCP tool %s failed", tool, exc_info=exc)
        return
    frames = "".join(traceback.format_tb(exc.__traceback__))
    logger.error("MCP tool %s failed: %s\n%s", tool, type(exc).__name__, frames)


def error_text(errors: list[str]) -> str:
    """The message for an invalid board: a heading and one `- <error>` line each."""
    return "Release plan is invalid:\n" + "\n".join(f"- {error}" for error in errors)

