# Planning Hub - MCP Server

The goal for this document is to describe the creation of an MCP Server for the CM Planning Hub, including its functional and technical requirements.
This will allow AI models to create release plans and provide already a best-effort plan considering the user's context input.

## Functional Requirements

1. The MCP Server shall implement tools for the Release Plan application.
2. The MCP Server shall provide tools to create or update Release Plan boards.
3. The agent must be aware of the JSON structure used for Release Plan boards (state) and the server must validate the JSON structure received is valid.

## Technical Requirements

1. Create an MCP server to implement tools that support the functional requirements.
2. The MCP server must be aware of the JSON structure to build a board (similar to `normalizePlan`) and the APIs that store the board.
3. The MCP server tool that creates or updates a plan must validate the JSON structure received from the agent before storing it. The tool must return an exception if cannot create or save the state.

## Tools

The MCP server is mounted in the API server at `/api/mcp` (Streamable HTTP, stateless). It provides 6 tools (see `plans/release-plan-mcp-server.md` for the full contract):

| Tool | Purpose |
| --- | --- |
| `list_release_plans` | Paginated list of stored plans (`id`, name, project, `boardUrl`; no board). The `id` is an internal handle used only as `planId`; agents must not show it to the user. |
| `get_release_plan` | One plan with its board, `id` and `boardUrl`. |
| `validate_release_plan` | Validates a board; returns `{valid: true}` or all errors; stores nothing (create and update normalize the board themselves). |
| `create_release_plan` | Validates and stores a new plan. |
| `update_release_plan` | Validates and replaces a plan's board (and optionally its name). |
| `ado_fetch_backlog` | Reads an Azure DevOps backlog, same result as `POST /api/ado/backlog`. |

Create and update return a link to the board. Every failure (invalid board, unknown plan, database or Azure DevOps error) is returned as a tool error with a readable message.

## Rules

- **Azure DevOps link required.** Every board stored through MCP must carry `source` (kind, project URL, project, scope), so Sync from ADO always works. `projectType` and `projectName` are derived from `source`, and a plan's project cannot change on update.
- **Strict validation.** Unlike the REST API, MCP rejects unknown keys and wrong types, reports all errors at once, fills optional fields and stores the normalized board, which equals what `normalizePlan` produces.
- **The board JSON Schema is the only guidance the server publishes** (resource `release-plan://schema` and the `state` argument of the tools). There is no example board or prompt: the agent, or a skill driving it, decides how to turn a backlog into a board. The validator checks structure, not intent.
- **Work items are trusted.** The board is not cross-checked against Azure DevOps.
- **No authentication**, as in the REST API.
- **The PAT is a tool argument.** It is used for that call only and is never stored, logged or returned.
- **No delete tool.** Deleting a plan stays a UI action.
- **Descriptions** fetched from Azure DevOps are truncated (see `specs/release_plan.md`).

## Accepted limitations

- Updates are a full replace and the last write wins. An open board does not refresh, so its autosave can overwrite an agent's update and the reverse: the user must close the board while an agent edits it.
- The PAT passes through the model's context and the client's transcripts.
- Anyone who can reach the host can use the tools.
- A valid board may differ from a UI-created one (for example, how orphan Features are grouped).
