# Planning Hub - MCP Server

The goal for this document is to describe the creation of an MCP Server for the CM Planning Hub, including its functional and technical requirements.
This will allow AI models to create release plans and provide already a best-effort plan considering the user's context input.

## Functional Requirements

1. The MCP Server shall implement tools for the Release Plan application.
2. The MCP Server shall provide tools to create or update Release Plan boards.
3. The agent shall send only what it decides: the milestones, the flags, the order of the Epics and the milestone of each Feature. The server shall read the Epics and Features from Azure DevOps in the same call and build the full board (titles, states, sizes, iteration paths and descriptions come from Azure DevOps, never from the agent).
4. The agent must be aware of the JSON structure of its decisions and the server must validate the JSON structure received is valid.

## Technical Requirements

1. Create an MCP server to implement tools that support the functional requirements.
2. The MCP server must be aware of the JSON structure to build a board (similar to `normalizePlan` and `planFromBacklog`) and the APIs that store the board.
3. The MCP server tool that creates or updates a plan must validate the decisions received from the agent, build the board from the Azure DevOps backlog and validate that board strictly before storing it. The tool must return an exception if cannot create or save the board; nothing is stored when any step fails.

## Tools

The MCP server is mounted in the API server at `/api/mcp` (Streamable HTTP, stateless). It provides 7 tools (see `plans/release-plan-mcp-server.md` for the full contract):

| Tool | Purpose |
| --- | --- |
| `list_release_plans` | Paginated list of stored plans (`id`, name, project, `boardUrl`; no board). The `id` is an internal handle used only as `planId`; agents must not show it to the user. |
| `get_release_plan` | One plan with its full board (descriptions included), `id` and `boardUrl`. |
| `get_release_plan_schema` | The JSON Schema of the agent's decisions accepted by validate, create and update (no arguments). |
| `validate_release_plan` | Checks the decisions offline (no Azure DevOps call, no PAT); returns `{valid: true}` or all errors; stores nothing. |
| `create_release_plan` | Reads the backlog from Azure DevOps, builds the board from the decisions and stores a new plan. |
| `update_release_plan` | Reads the backlog again, rebuilds the board from the decisions and replaces a plan's board (and optionally its name). |
| `ado_fetch_backlog` | Reads an Azure DevOps backlog (descriptions included), same result as `POST /api/ado/backlog`. |

Create and update return a link to the board. Every failure (invalid decisions, unknown plan, database or Azure DevOps error) is returned as a tool error with a readable message.

### Inputs

Names are camelCase. `validate_release_plan`, `create_release_plan` and `update_release_plan` share these decisions:

| Argument | Meaning |
| --- | --- |
| `connection` | `{source: "onprem"\|"cloud", projectUrl, scopeType: "area"\|"iteration", scopePath}`. Required by validate and create; update uses the stored plan's connection and takes no `connection`. |
| `mode` | `"releases"` (default) or `"sprints"`. |
| `milestones` | The board rows, in order: `{id, name, date?, color?}`. The color defaults by position. |
| `flags` | Milestone flags `{id?, name?, date?, afterMsId}`; default none; only in `sprints` mode. |
| `epicOrder` | Epic ids (integer or string) in board-column order, left to right. `"no-epic"` is the column of the Features without an Epic. |
| `assignments` | `{featureId: milestoneId \| null}`. Keys are Feature ids (integer or numeric string). Features not listed are Unplanned. |

`create_release_plan` also takes `name` and `pat`; `update_release_plan` takes `planId`, `pat` and an optional `name` (null keeps the stored name). `update_release_plan` is a full replace of the decisions: `mode` and `flags` default to `releases` and none, so the agent reads the plan with `get_release_plan` and resends what it keeps. Features absent from `assignments` become Unplanned.

### Building the board

1. The server validates the name and the decisions (structure, duplicate milestone and flag ids, flag references, flags only in `sprints` mode, assignment values naming existing milestones or null, repeated `epicOrder` entries, `connection.projectUrl` host allowlist), reporting all errors at once, then checks the `connection` and the PAT (same messages as `ado_fetch_backlog`).
2. It fetches the backlog like `ado_fetch_backlog` does, with the same description truncation.
3. It groups it like the UI does when it creates a board from Azure DevOps: Features under their parent Epic in ascending id order, Features without a returned parent Epic in the Epic "Features without an Epic" (id `no-epic`, state and description empty), which exists only when there are such Features.
4. Epics follow `epicOrder`; the Epics it omits are appended in ascending id order, with `no-epic` last. `"no-epic"` in `epicOrder` does nothing when there are no such Features. An id that is not in the backlog is an error listing every unknown id.
5. An `assignments` key that is not a Feature of the backlog is an error listing every unknown id. Features are Unplanned unless assigned.
6. The board records the project name returned by Azure DevOps, the scope, the fetch time, the connection (never the PAT) and the iterations. Sizes are trimmed and upper-cased.
7. The board is validated strictly (see Rules) and stored. On update, all Azure DevOps fields are refreshed and the items that are no longer in the scope disappear (the update acts as a sync).

`validate_release_plan` cannot check Epic and Feature ids, which need the backlog; `create_release_plan` and `update_release_plan` report them.

### Errors

Tool errors are plain text. The messages for decisions are `<path>: <problem>` lines under `Release plan is invalid:`, for example:

- `epicOrder: unknown Epic id(s) not in the backlog: 77, 78. Use the ids of the Epics returned by ado_fetch_backlog (or "no-epic").`
- `assignments: unknown Feature id(s) not in the backlog: 888. Use the ids of the Features returned by ado_fetch_backlog.`
- `assignments['102']: unknown milestone id 'zz'; use the id of an entry in milestones, or null for Unplanned`
- `epicOrder[1]: duplicate Epic id '101'`
- `connection: is required` (validate and create)
- `The plan's project cannot be changed (stored: cloud · Project).` when the backlog's project differs from the stored one.
- `The stored plan has no usable Azure DevOps connection (source, projectUrl, scopeType, scopePath), so it cannot be updated by an agent.`

The plan name, connection, PAT and Azure DevOps errors use the existing messages. Structural errors are reported before the reference errors, which need a well-formed input.

## Rules

- **Azure DevOps link required.** Every board stored through MCP carries `source` (kind, project URL, project, scope), built from the `connection`, so Sync from ADO always works. `projectType` and `projectName` are derived from `source`, and a plan's project cannot change on update.
- **Strict validation.** Unlike the REST API, MCP rejects unknown keys and wrong types, reports all errors at once, fills optional fields and stores the normalized board, which equals what `normalizePlan` produces. The built board is validated again as a safety net.
- **The JSON Schema of the decisions is the only guidance the server publishes** (the `get_release_plan_schema` tool and the argument schemas of the tools); the server publishes no resources. There is no example board or prompt: the agent, or a skill driving it, decides the milestones and the assignments. The validator checks structure, not intent.
- **Work items come from Azure DevOps.** The agent never sends titles, states, sizes, iteration paths or descriptions; it reads the descriptions with `ado_fetch_backlog` and `get_release_plan` to decide.
- **No authentication**, as in the REST API.
- **The PAT is a tool argument** of `create_release_plan`, `update_release_plan` and `ado_fetch_backlog`. It is used for that call only and is never stored, logged or returned.
- **No delete tool.** Deleting a plan stays a UI action.
- **Descriptions** fetched from Azure DevOps are truncated (see `specs/release_plan.md`).

## Accepted limitations

- Updates are a full replace and the last write wins. An open board does not refresh, so its autosave can overwrite an agent's update and the reverse: the user must close the board while an agent edits it.
- The PAT passes through the model's context and the client's transcripts.
- Anyone who can reach the host can use the tools.
- Updates need the PAT again and rebuild the board from Azure DevOps, so changes made to the board in the UI that are not in the agent's decisions (for example, work item data edited locally) are lost.
