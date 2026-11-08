"""Argument handling for the MCP tools that take a Personal Access Token.

The SDK validates a tool's arguments before the tool runs, and its error text
echoes (part of) the argument values, the PAT included. These tools therefore
declare every argument as `Any` with a `None` default, so the SDK can never
reject a call, check the arguments themselves (`pat_value`, `text_error`, ...)
and advertise the real input schema with `advertise_schema`."""

from typing import Any

from mcp.server.mcpserver import MCPServer
from pydantic import SecretStr

PAT_SCHEMA: dict[str, Any] = {
    "type": "string",
    "format": "password",
    "writeOnly": True,
    "description": "Personal Access Token with read access to work items; used for this call only.",
}


def pat_value(value: Any) -> tuple[SecretStr | None, list[str]]:
    """The PAT as a `SecretStr`, or the error for a missing or non-text value.
    A blank PAT is left to the connection checks. No error echoes the value."""
    if value is None:
        return None, ["pat: is required"]
    if not isinstance(value, str):
        return None, ["pat: must be a string"]
    return SecretStr(value), []


def text_error(argument: str, value: Any, *, required: bool) -> str | None:
    """The error for a missing (when `required`) or non-text argument."""
    if value is None:
        return f"{argument}: is required" if required else None
    if not isinstance(value, str):
        return f"{argument}: must be a string"
    return None


def integer_error(argument: str, value: Any) -> str | None:
    """The error for a missing or non-integer argument."""
    if value is None:
        return f"{argument}: is required"
    if isinstance(value, bool) or not isinstance(value, int):
        return f"{argument}: must be an integer"
    return None


def advertise_schema(
    server: MCPServer,
    tool: str,
    properties: dict[str, dict[str, Any]],
    required: list[str],
    defs: dict[str, Any] | None = None,
) -> None:
    """Publish `properties`, `required` and `$defs` as the input schema of
    `tool`, whose SDK-visible arguments are all optional `Any`."""
    parameters = server._tool_manager.get_tool(tool).parameters  # type: ignore[union-attr]
    parameters["properties"] = {**properties}
    parameters["required"] = required
    if defs is not None:
        parameters["$defs"] = defs
