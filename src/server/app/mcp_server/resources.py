"""The board JSON Schema resource, the only guidance the server publishes."""

from typing import Any

from mcp.server.mcpserver import MCPServer

from app.mcp_server.plan_tools import BOARD_SCHEMA_URI
from app.services.plan_board import board_json_schema


def release_plan_schema() -> dict[str, Any]:
    """The JSON Schema of a Release Plan board."""
    return board_json_schema()


def register(server: MCPServer) -> None:
    """Register the resources on `server`."""
    server.resource(
        BOARD_SCHEMA_URI,
        name="release_plan_schema",
        description=(
            "JSON Schema of the Release Plan board accepted by validate_release_plan, "
            "create_release_plan and update_release_plan. Uniqueness, references between "
            "ids and the host allowlist are checked by validate_release_plan, not by the schema."
        ),
        mime_type="application/json",
    )(release_plan_schema)
