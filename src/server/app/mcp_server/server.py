"""The Release Plan MCP server (specs/mcp_server.md, plans/release-plan-mcp-server.md).

Streamable HTTP, stateless and answering with plain JSON, so any replica can
serve any request. Served by `app.main` at exactly `/api/mcp`.
"""

from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette

from app.config import Settings

MCP_PATH = "/api/mcp"
# Above PLAN_STATE_MAX_BYTES (5 MiB) so a valid large board reaches the tool;
# the SDK default of 4 MiB would refuse it first.
MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024

INSTRUCTIONS = """\
Planning Hub Release Plan tools: build a Release Plan board from an Azure DevOps backlog and store it.

Workflow:
1. Read the backlog with ado_fetch_backlog.
2. Build the board from the returned work items (Epics with their Features). Keep the ids and titles; never invent or drop work items.
3. Check it with validate_release_plan and fix the errors until it is valid.
4. Store it with create_release_plan (or update_release_plan for an existing plan) and return the boardUrl.
"""


def transport_security(settings: Settings) -> TransportSecuritySettings:
    """DNS-rebinding protection for the deployed host. Origins are the
    `http://` and `https://` forms of each allowed host."""
    origins = [f"{scheme}://{host}" for host in settings.mcp_allowed_hosts for scheme in ("http", "https")]
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=list(settings.mcp_allowed_hosts),
        allowed_origins=origins,
    )


def create_mcp_server() -> MCPServer:
    """A new server instance with the tools, resources and prompt registered."""
    return MCPServer("Planning Hub Release Plan", instructions=INSTRUCTIONS)


def create_mcp_app(settings: Settings, server: MCPServer | None = None) -> Starlette:
    """The ASGI app for `server` (a new one by default). Its session manager
    can run only once, so build a new app for each application lifespan."""
    return (server or create_mcp_server()).streamable_http_app(
        streamable_http_path=MCP_PATH,
        json_response=True,
        stateless_http=True,
        max_request_body_size=MAX_REQUEST_BODY_BYTES,
        transport_security=transport_security(settings),
    )
