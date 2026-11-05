"""Azure DevOps tool (specs/mcp_server.md, plans/release-plan-mcp-server.md
"Tool contract"). It returns what `POST /api/ado/backlog` returns. The PAT is
a `SecretStr` from the moment the arguments are validated and is never
logged, stored or returned."""

from typing import Annotated, Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field, SecretStr

from app.config import get_settings
from app.mcp_server import deps
from app.mcp_server.errors import guarded
from app.schemas import AdoBacklogRequest, AdoBacklogResponse
from app.services.ado_backlog import fetch_backlog, scope_field_errors
from app.services.ado_client import UNEXPECTED_RESPONSE, AdoError
from app.services.ado_http import ado_client
from app.services.ado_url import AdoUrlError, connection_field_errors

FETCH_DESCRIPTION = (
    "Read the Epics and Features under an Azure DevOps Area or Iteration path, with the project's "
    "iterations. Use it first to get the backlog a Release Plan board is built from. Ask the user "
    "for `source` (onprem or cloud), the project URL, the scope and a Personal Access Token: never "
    "guess them. The PAT is used for this call only and is never stored or logged. The result is the "
    "same as POST /api/ado/backlog: {project, projectUrl, scope, fetchedAt, workItems, iterations, "
    "warnings}; descriptions are truncated to a configured length."
)

_READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=True)


def _text(value: Any) -> str:
    """The error text safe to show: characters that cannot be UTF-8 encoded
    are replaced."""
    return str(value).encode("utf-8", "replace").decode("utf-8")


@guarded(log_messages=False)
async def ado_fetch_backlog(
    source: Annotated[
        str,
        Field(
            description='"onprem" (Azure DevOps Server) or "cloud" (dev.azure.com). Ask the user.',
            json_schema_extra={"enum": ["onprem", "cloud"]},
        ),
    ],
    projectUrl: Annotated[str, Field(description="The project URL, e.g. https://dev.azure.com/org/Project.")],
    pat: Annotated[SecretStr, Field(description="Personal Access Token with read access to work items.")],
    scopeType: Annotated[str, Field(description='"area" or "iteration".', json_schema_extra={"enum": ["area", "iteration"]})],
    scopePath: Annotated[str, Field(description="The Area or Iteration path, e.g. `Project\\Team A`.")],
) -> dict[str, Any]:
    data = {
        "source": source,
        "projectUrl": projectUrl,
        "pat": pat.get_secret_value(),
        "scopeType": scopeType,
        "scopePath": scopePath,
    }
    errors = connection_field_errors(data) + scope_field_errors(data)
    if errors:
        raise ToolError("\n".join(errors))
    payload = AdoBacklogRequest.model_validate({**data, "pat": pat})
    settings = get_settings()
    try:
        async with deps.ado_http() as http:
            project, client = ado_client(payload, settings, http)
            backlog = await fetch_backlog(
                client, project, payload.scope_type, payload.scope_path, settings.ado_description_max_chars
            )
    except (AdoUrlError, AdoError) as exc:
        raise ToolError(_text(exc)) from None
    except (UnicodeError, RecursionError):
        raise ToolError(UNEXPECTED_RESPONSE) from None
    return AdoBacklogResponse.model_validate(backlog).model_dump(by_alias=True, mode="json")


def register(server: MCPServer) -> None:
    """Register the Azure DevOps tool on `server`."""
    server.add_tool(ado_fetch_backlog, description=FETCH_DESCRIPTION, annotations=_READ_ONLY)
