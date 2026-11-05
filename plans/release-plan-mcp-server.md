# Release Plan — MCP Server

Implement `specs/mcp_server.md`: an MCP server, mounted in the FastAPI server at
`/api/mcp`, that lets AI agents read an Azure DevOps backlog, build a best-effort
Release Plan and store it through tools that strictly validate the board JSON. It
continues `plans/release-plan-persistence.md` and `plans/release-plan-ado.md`,
whose decisions still govern storage and ADO access. No client code changes.

## For Future Agents
As work proceeds: mark checkboxes `- [x]` as items complete; when a phase is done,
set its status to `Complete` and write its **Phase Summary** (what was done, key
decisions, anything needed to continue with zero context); run the phase's
**Verification Plan** and record the result before moving on. When all phases are
done, fill in **Final Recap** and **Deployment Plan**.

Each phase follows the AGENTS.md *Implementation* workflow: the main session
coordinates, `backend-developer` develops, then `qa-engineer` reviews, with at most
3 Develop ↔ QA cycles. `frontend-developer` is not needed: there are no production
client changes. Give the developer and QA the **Tool contract** and **Validation
rules** below verbatim.

**Area exception (agreed for this plan, as in the persistence plan):**
`backend-developer` also owns the infra files `docker-compose*.yml` and
`helm/chart/**`. `qa-engineer` may add one Vitest test under `src/client` for the
`normalizePlan` round trip and the example mapping check (Phase 4).

**Environment:** the repo's `.venv` is broken (its interpreter points at
`/workspaces/MonteCarloSimulation/.venv`). `python3` (3.10) has the server
dependencies; `python3.12` does not. Images and CI use 3.12, so write code that
runs on both. Record the baseline with `python3` before starting.

## Decisions (confirmed with the user, 2026-11-04)
- **Hosting**: mounted in the existing FastAPI server, Streamable HTTP at
  `/api/mcp`, calling `app/services` directly rather than over REST. No new image,
  Helm deployment or ingress change: `/api` is already routed by both the ingress
  and nginx.
- **SDK**: official `mcp` Python SDK, 2.x (`mcp>=2.3,<3`). In 2.x `FastMCP` is
  gone: use `from mcp.server.mcpserver import MCPServer`.
- **Transport mode**: `stateless_http=True`, `json_response=True`, so any replica
  can answer and no session state is kept. This matches the stateless server.
- **Auth: none**, same as the REST API. Anyone who can reach the host can use the
  MCP tools. The user chose this knowingly.
- **Backlog source**: the `ado_fetch_backlog` tool reads ADO through the existing
  services. `ado_connect` was **dropped** by the user: `fetch_backlog` already
  validates the PAT, project and path, and the user gives the path in their prompt.
- **PAT is a tool argument** (user decision, confirmed twice after the alternative
  of an HTTP header was offered). It therefore passes through the model's context
  and the client's transcripts. The server must never log, store or return it.
- **Project input**: the tool takes the fields of `AdoBacklogRequest` unchanged:
  `source`, `projectUrl`, `pat`, `scopeType`, `scopePath`. `source` has no default:
  the agent must ask the user for it, never guess. **Assumption to confirm at plan
  review:** `projectUrl` stays required, because a project name alone doesn't
  identify the server and collection/organization.
- **Fetch output** (revised at plan review, 2026-11-05): `ado_fetch_backlog` returns
  exactly what `POST /api/ado/backlog` returns (`AdoBacklogResponse`, camelCase).
  There is **no draft board and no server port of `planFromBacklog`**. The agent
  builds the board itself, following the **Backlog → board mapping** below, which is
  published in the guidance resource next to an example board, and summarized in the
  tool description and server `instructions`. The server keeps only the strict
  validator as its board logic.
- **Work items are trusted** (user decision, 2026-11-05): the server fetched them, so
  the board isn't cross-checked against Azure DevOps on create/update. The guidance
  still tells the agent to keep ids and titles and never invent or drop work items.
- **Description limit** (user decision, 2026-11-05): every backlog fetch, REST and MCP
  alike, truncates each work item's `description` to `ADO_DESCRIPTION_MAX_CHARS`
  (default `2000`), so backlogs and boards stay small enough for an agent's context.
  See **Description limit** below.
- **Update semantics**: full replace, last write wins, as `PUT /api/plan/{id}`.
  **Accepted limitation:** the open board doesn't refresh, so a browser tab's
  autosave can overwrite an agent's update and the reverse. Close the board while
  an agent edits it. This is documented in the tool description and the README.
- **Building and planning the board is the agent's job**: the server publishes the
  board schema, the backlog → board mapping, an example board and planning guidance.
  There is no board-building or allocation logic on the server.
- **Validation**: a new strict server validator used **by MCP only**. It rejects
  errors, fills optional fields and returns the normalized board. REST keeps its
  shallow check, so UI autosave can't start failing.
- **ADO link required**: every board stored through MCP must carry the `source`
  connection, so Sync from ADO always works.
- **`projectType` / `projectName` are derived** from `state.source.kind` and
  `state.source.project`, so they can't disagree with the board. They are not tool
  arguments.
- **No delete tool.** Deleting stays a UI action with its confirmation prompt.
- **Board link**: create and update results include a `boardUrl` built from a new
  `PUBLIC_BASE_URL` setting. When it is unset, the value is the relative path
  `/release-plan/<id>`.

## Tool contract
All tools are registered on one `MCPServer`. Failures raise
`mcp.server.mcpserver.exceptions.ToolError` (the call returns `is_error=True`), which
meets the spec's "must return an exception". JSON field names are camelCase, as in
the REST API.

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_release_plans` | `page: int = 1` | `{items: [PlanSummary], total, page, pageSize}` |
| `get_release_plan` | `planId: int` | `PlanDetail` plus `boardUrl` |
| `validate_release_plan` | `state: object` | `{valid: true, state}` or `{valid: false, errors: [str]}`. Stores nothing and does not raise for an invalid board. |
| `create_release_plan` | `name: str`, `state: object` | `PlanSummary` plus `boardUrl` |
| `update_release_plan` | `planId: int`, `state: object`, `name: str \| null = null` | `PlanSummary` plus `boardUrl` |
| `ado_fetch_backlog` | `source`, `projectUrl`, `pat`, `scopeType`, `scopePath` | `AdoBacklogResponse`, identical to `POST /api/ado/backlog`: `{project: {id, name}, projectUrl, scope, fetchedAt, workItems, iterations, warnings}` |

Behavior:
- **`create_release_plan`**: validate; `state.name` is set to `name`; store through
  `plans.create_plan` with `project_type = source.kind` and
  `project_name = source.project`.
- **`update_release_plan`**: validate; a null `name` keeps the stored name; `state.name`
  is set to the final name, keeping the persistence rule that it equals the `name`
  column. `source.kind` and `source.project` must match the stored `project_type` and
  `project_name`, because a plan's project is fixed at creation.
- **`ado_fetch_backlog`**: reuse `connection_field_errors` + `scope_field_errors`, then
  `parse_project_url` (the `ADO_ALLOWED_HOSTS` allowlist still applies) and
  `fetch_backlog`, and return its `AdoBacklogResponse` dumped `by_alias`, exactly as
  the REST route does. Its description summarizes the **Backlog → board mapping** and
  points to the resources.

Tool errors (the message is what the agent reads):

| Case | Message |
| --- | --- |
| Invalid board | `Release plan is invalid:` then one `- <path>: <problem>` line per error |
| Invalid name | The existing `NAME_REQUIRED` / `NAME_TOO_LONG` / `NAME_INVALID_CHARS` |
| Unknown id | `Release plan not found: <id>.` |
| Project changed on update | `The plan's project cannot be changed (stored: <type> · <name>).` |
| Database down | The existing `DB_UNAVAILABLE` |
| ADO failure | The existing `AdoError` / `AdoUrlError` text |
| Anything unexpected | A generic message; the traceback is logged server-side only |

Resources and prompt:

| Kind | Name | Content |
| --- | --- | --- |
| Resource | `release-plan://schema` | JSON Schema generated from the board models |
| Resource | `release-plan://example` | A complete valid board as the **Backlog → board mapping** produces it, then planned: several Epics, the `no-epic` Epic, several milestones, one Feature left Unplanned |
| Resource | `release-plan://guidance` | The **Backlog → board mapping**, then the planning workflow and rules (Phase 3) |
| Prompt | `plan_release` | Starts the workflow, taking an optional `goal` argument; embeds the guidance and the example so clients that don't read resources still get them |

Many MCP clients don't read resources on their own, so spec FR3 must not depend on
them: also advertise the JSON Schema as the `state` argument's input schema on
`validate_release_plan`, `create_release_plan` and `update_release_plan`, describe
the workflow in the server `instructions`, and summarize the mapping in the
`ado_fetch_backlog` description.

The example board is a static file, `app/mcp_server/example_board.json`, so the server
and a client test can both read it. It is built from a test-only backlog fixture,
`src/server/tests/fixtures/mcp_example_backlog.json`, which is not published.

## Backlog → board mapping
What the agent must do with an `ado_fetch_backlog` result. It mirrors `planFromBacklog`
and `groupBacklog` in `src/client/src/lib/releasePlan/fromBacklog.ts`; follow it so the
board looks like a UI-created one and **Sync from ADO** keeps working. Give it
verbatim in the guidance resource.

| Board field | Value |
| --- | --- |
| `schema` / `version` | `release-planner-features` / `1` |
| `source.system` | `Azure DevOps` |
| `source.kind`, `projectUrl`, `scopeType`, `scopePath` | The `ado_fetch_backlog` arguments (`source` → `kind`); never the PAT |
| `source.project` / `scope` / `fetchedAt` | `project.name` / `scope` / `fetchedAt` of the result |
| `iterations` | The result's `iterations`, `{path, finishDate}` unchanged |
| `epics` | One per work item with `type` `Epic`, ascending `id`: `{id, title, state, description, features}` |
| `epics[].features` | The `Feature` items whose `parentId` is that Epic, ascending `id`: `{id, title, state, description, size, iterationPath, milestoneId}`; `size` trimmed and upper-cased |
| Orphan Features | Features with no `parentId`, or whose parent isn't a returned Epic, go in one last Epic `{id: "no-epic", title: "Features without an Epic", state: "", description: ""}`, only when there are any |
| Ids | The ADO integer ids, unchanged; never invent, rename or drop work items |
| `milestones`, `flags`, `mode`, `milestoneId` | The agent's plan (see the guidance); `milestoneId: null` means Unplanned |

## Description limit
Applies to `fetch_backlog` in `app/services/ado_backlog.py`, so `POST /api/ado/backlog`
(board creation and Sync from ADO in the UI) and `ado_fetch_backlog` return the same
text. Sprint history has no descriptions and is unchanged.

- **Setting**: `ADO_DESCRIPTION_MAX_CHARS`, a positive integer, default `2000`. A
  blank, non-integer or `<= 0` value logs a warning and uses the default, like the
  other settings in `app/config.py`. Exposed as `adoDescriptionMaxChars` in Helm
  `values.yaml` and set in `docker-compose.yml`.
- **Counting**: Python characters of the description as Azure DevOps returns it. It is
  HTML, so markup counts too; 2000 characters is roughly 1200–1800 visible ones.
- **Truncation**, only when the description is longer than the limit: cut to the
  limit, then drop a trailing incomplete tag (`<…` with no `>`) and a trailing
  incomplete entity (`&…` with no `;`), trim trailing whitespace and append `…`. The
  result is at most limit + 1 characters. Unclosed tags are left as they are: the
  client's sanitizer and the browser close them. Shorter descriptions are unchanged.
- **Accepted side effect**: boards fetched before this change, or before the limit is
  changed, hold descriptions of another length. Their next Sync from ADO lists those
  descriptions as changed, once.

## Validation rules
Reference: `normalizePlan` in `src/client/src/lib/releasePlan/validate.ts` and
`types.ts`. **Every board this validator accepts must satisfy
`normalizePlan(board)` deep-equals `board`.**

| Field | Rule | When missing |
| --- | --- | --- |
| Unknown keys, at any level | Rejected, so typos are reported | n/a |
| `schema` | Must be `release-planner-features` | Rejected |
| `version` | Must be `1` | `1` |
| `mode` | `releases` or `sprints` | `releases` |
| `name` | Text; overwritten by create/update | Filled from the tool's name |
| `savedAt` | String, kept | Stays absent |
| `source.kind` | `onprem` or `cloud` | Rejected |
| `source.projectUrl` | Non-blank; must pass `parse_project_url` for `kind`, allowlist included | Rejected |
| `source.scopeType` | `area` or `iteration` | Rejected |
| `source.scopePath` | Non-blank | Rejected |
| `source.project` | Non-blank | Rejected |
| `source.system`, `scope`, `fetchedAt` | Strings | `system` = `Azure DevOps`; the others stay absent |
| `iterations[]` | `{path, finishDate}`; `finishDate` is `YYYY-MM-DD` or `""` | `[]` |
| `milestones` | Array, may be empty | Rejected |
| `milestones[].id` | Non-blank string, unique | Rejected |
| `milestones[].name` | Non-blank | Rejected |
| `milestones[].date` | Real calendar date `YYYY-MM-DD`, or `""` | `""` |
| `milestones[].color` | One of `MS_COLORS` | `MS_COLORS[i % 8]` |
| `flags` | Non-empty only in `sprints` mode | `[]` |
| `flags[].afterMsId` | An existing milestone id | Rejected |
| `flags[].id` / `name` / `date` | Unique / text / as a milestone date | `fl_<random>` / `Milestone` / `""` |
| `epics` | Array | Rejected |
| `epics[].id` | Integer or non-blank string (not bool), unique among Epics | Rejected |
| `epics[].features[].id` | As above, unique across **all** Epics | Rejected |
| `title` (Epic and Feature) | Non-blank | Rejected |
| `state`, `description`, `iterationPath` | Text | `""` |
| `size` | Text; stored trimmed and upper-cased | `""` |
| `features[].milestoneId` | `null` or an existing milestone id | `null` (Unplanned) |

- Ids compare as text, so `123` and `"123"` are duplicates.
- No type coercion: `"title": 5` is an error, not `"5"`.
- The existing 5 MiB and NUL checks run first (`_state_error`).
- **All errors are reported at once.** Structural errors come from pydantic.
  Cross-reference checks (duplicates, unknown milestone, flags in `releases` mode) also
  run over the well-formed parts of a board that has structural errors.
- Paths read like `epics[0].features[2].milestoneId`.

## Technical notes (verified against the `mcp` 2.3.0 source)
- **Body limit**: `streamable_http_app` defaults `max_request_body_size` to 4 MiB,
  below `PLAN_STATE_MAX_BYTES` (5 MiB). Set it to 6 MiB, or a valid large board is
  refused before reaching the tool. nginx already allows 20m.
- **Allowed hosts**: with the default `host="127.0.0.1"` the SDK enables DNS-rebinding
  protection for localhost only, so the deployed host would be refused. Pass explicit
  `TransportSecuritySettings`.
- **nginx strips the port**: `proxy_set_header Host $host` sends `localhost`, not
  `localhost:8080`, and `localhost:*` doesn't match a bare `localhost`. List bare
  hosts too.
- **Session manager runs once**: `session_manager.run()` can only be called once per
  instance, and it must run inside the FastAPI `lifespan`. Tests enter `lifespan` many
  times on the same `app` (`with TestClient(app)`), so build a fresh MCP ASGI app per
  `lifespan` run rather than once at import.
- **No trailing-slash redirect**: `app.mount("/api/mcp", …)` would answer `/api/mcp`
  with a 307 to `/api/mcp/`, which some clients don't follow. Prefer an exact route on
  `/api/mcp` delegating to the MCP ASGI app, with `streamable_http_path="/api/mcp"`.
- **FastAPI dependencies don't reach tools**: `get_session`, `get_ado_http_client` and
  `dependency_overrides` have no effect there, and neither do the app's exception
  handlers. Tools need their own seam for tests.
- **Package name**: use `app/mcp_server/`, not `app/mcp/`, to avoid confusion with the
  `mcp` SDK.

## Phase 1: Strict board validator
Status: Complete

Pure logic with no MCP dependency, so it can be tested in isolation.

- [x] Create `src/server/app/services/plan_board.py` with the pydantic board models (`extra="forbid"`, strict types) matching `types.ts`.
- [x] Port `MS_COLORS`, `SCHEMA` (reuse `PLAN_STATE_SCHEMA`), `VERSION`, `DEFAULT_MILESTONE_NAME`, `ADO_SYSTEM`, `NO_EPIC_ID` and `NO_EPIC_TITLE`, with a comment pointing to the client constants they mirror.
- [x] Add `validate_board(state, allowed_hosts) -> BoardResult` (normalized board or `errors: list[str]`) implementing every row of **Validation rules**, including the all-errors-at-once behavior.
- [x] Add `board_json_schema()` returning the JSON Schema generated from the models.
- [x] Unit tests in `src/server/tests/test_plan_board.py`: one case per **Validation rules** row, plus duplicates across Epics, `123` vs `"123"`, booleans as ids, several errors in one call, cross-reference checks alongside structural errors, and the size and NUL limits.
- [x] Unit test: a board shaped like `planFromBacklog` output (one `MVP` milestone, the `no-epic` Epic last) passes `validate_board` unchanged.

### Verification Plan
- `python3 -m compileall -q src/server/app` exits 0.
- `python3 -m pytest src/server/tests/test_plan_board.py -q` passes.
- `python3 -m pytest src/server -q` shows no new failures against the baseline.
- `git diff --stat` shows no changes to `app/api/plan_routes.py` or `plan_field_errors` behavior, so REST validation stays shallow.

**Result (2026-11-05):** all pass. Baseline 831 passed / 41 skipped → 940 passed / 41 skipped (106 unit + 3 QA integration tests). Only new files; `plan_routes.py` and `plans.py` untouched. Run on Python 3.10 only (3.12 has no server deps here).

### Phase Summary
**Done.** `src/server/app/services/plan_board.py` (new) holds the pydantic board models, the ported constants, `validate_board(state, allowed_hosts) -> BoardResult` (`.board`, `.errors`, `.valid`) and `board_json_schema()`. Tests: `tests/test_plan_board.py` (106 unit, backend-developer) and `tests/test_plan_board_integration.py` (3, QA: UI-saved Releases/Sprints boards pass unchanged, input not mutated, REST `plan_field_errors` stays shallow for boards the strict validator rejects). One Develop ↔ QA cycle, verdict PASS.

**Key decisions:**
- pydantic checks structure and generates the schema; each field has a `BeforeValidator` so errors read `path: problem` (e.g. `epics[0].features[2].milestoneId: …`). Cross-reference checks (duplicate ids as text, unknown milestones, flags in releases mode, `projectUrl` via `parse_project_url`) run on the raw input with type guards, so they work alongside structural errors. Errors are de-duplicated.
- `_state_error` (5 MiB, NUL, `schema`) runs first and its message is returned as-is (no path).
- Missing/blank `name` → `DEFAULT_PLAN_NAME` ("Feature Release Plan"), as `normalizePlan`; MCP tools overwrite it anyway. Explicit `null` on optional keys (`savedAt`, `scope`, `fetchedAt`, `color`) is an error; absent keys stay absent.
- `size` trimmed with the JS whitespace set (NBSP, BOM) then upper-cased. `version: true` rejected. Blank flag id/name filled (`fl_<7 base36>` / `Milestone`); given flag ids must be unique.
- Source keys are emitted in `planFromBacklog` order. `board_json_schema()` is self-contained (only internal `#/$defs` refs); date patterns and `minLength` are hints only, Python enforces the real rules.
- QA verified empirically (throwaway Vitest, not committed) that `normalizePlan(board)` deep-equals `validate_board` output for Releases/Sprints boards, defaulted colors and flags, and NBSP/BOM/Unicode sizes.

**Refactor (2026-11-05, user-approved "Option A"):** the hand-written `_normalized` / `_epic` were removed. Normalization now lives in the models (`size` / flag / `name` `AfterValidator`s, a `Board` `model_validator` for default colors, `Field(exclude_if=…)` for the optional keys), and the result is `board.model_dump(by_alias=True)`. Behavior, error messages and `board_json_schema()` are unchanged (all 109 tests unchanged and passing; QA re-ran the `normalizePlan` round trip). `src/server/requirements.txt` gained `pydantic>=2.12`, which `exclude_if` needs and `mcp` 2.3 requires anyway. Only `plan_board.py` imports these models. REST and the client are untouched (client: `tsc -b` clean, 890 Vitest passed).

**For Phase 3:** the schema can't express uniqueness / cross-references / allowlist, so if the SDK validates `state` against it before the tool runs, make sure the agent still gets `validate_board`'s full error list.

**Outstanding minor findings (non-blocking):** the generic "Plan state is not a release plan." for a wrong `schema` could hint the expected value (kept per plan); `Milestone.color` is a `Literal` defaulting to `None` (`type: ignore`).

## Phase 2: MCP endpoint, settings, description limit and infra
Status: Complete

- [x] Add `mcp>=2.3,<3` to `src/server/requirements.txt` and install it. Confirm no dependency conflict with the current `fastapi`, `starlette` and `pydantic`.
- [x] Add settings to `app/config.py`: `mcp_allowed_hosts` (`MCP_ALLOWED_HOSTS`, comma-separated, default `localhost,localhost:*,127.0.0.1,127.0.0.1:*`), `public_base_url` (`PUBLIC_BASE_URL`, default empty, trailing `/` trimmed) and `ado_description_max_chars` (`ADO_DESCRIPTION_MAX_CHARS`, see **Description limit**).
- [x] Implement **Description limit**: a pure `truncate_description(text, max_chars)` helper in `app/services/ado_backlog.py`, applied by `fetch_backlog` to every work item through a new `description_max_chars` argument. `POST /api/ado/backlog` passes the setting; `AdoBacklogResponse` is unchanged.
- [x] Create `src/server/app/mcp_server/server.py`: the `MCPServer` with `instructions`, and a factory for the ASGI app using `stateless_http=True`, `json_response=True`, `streamable_http_path="/api/mcp"`, `max_request_body_size=6 MiB` and `TransportSecuritySettings` from the settings. Derive `allowed_origins` from the hosts as `http://` and `https://` forms.
- [x] Wire it into `app/main.py`: serve exactly `/api/mcp` with no redirect, and run the session manager inside `lifespan`, building a fresh ASGI app per run (see **Technical notes**).
- [x] Move `DB_ERRORS` and `DB_UNAVAILABLE` from `app/api/plan_routes.py` to `app/db.py` and import them back, with no behavior change.
- [x] Extract from `app/api/ado_routes.py` an `ado_http_client(settings)` async context manager and the `_ado_client` helper into `app/services/`, so tools share them. Routes keep their behavior and their `get_ado_http_client` override.
- [x] Add one test seam in `app/mcp_server/` for the DB session factory and the ADO HTTP client.
- [x] `docker-compose.yml`: on `server`, set `MCP_ALLOWED_HOSTS` to include `localhost`, `127.0.0.1`, `172.17.0.1` and `server`, `PUBLIC_BASE_URL: http://localhost:8080` and `ADO_DESCRIPTION_MAX_CHARS: "2000"`.
- [x] `helm/chart`: in the server deployment, set `MCP_ALLOWED_HOSTS` to `{{ .Values.public_http_address }}`, `PUBLIC_BASE_URL` to `https://{{ .Values.public_http_address }}` and `ADO_DESCRIPTION_MAX_CHARS` to `{{ .Values.adoDescriptionMaxChars | quote }}`; add `adoDescriptionMaxChars: 2000` to `values.yaml`.
- [x] Unit tests: settings parsing (including `ADO_DESCRIPTION_MAX_CHARS` default, valid, blank, non-integer, `0` and negative); a test MCP app accepts allowed hosts and answers 421 for others; a body over 4 MiB and under 6 MiB is accepted; `with TestClient(app)` works twice in a row; `POST /api/mcp` doesn't redirect.
- [x] Unit tests for `truncate_description`: at, below and above the limit; a cut inside a tag and inside an entity; trailing whitespace before `…`; empty text; non-ASCII text. Plus a `POST /api/ado/backlog` route test where a long description comes back truncated with a small limit override.

### Verification Plan
- `python3 -m compileall -q src/server/app` exits 0 and `python3 -m pytest src/server -q` passes.
- `python3 -m pytest src/server/tests/test_lifespan.py -q` passes, proving the MCP session manager tolerates repeated `lifespan` runs.
- With `docker compose up --build -d`, this returns `HTTP/1.1 200` with a JSON `serverInfo` and no redirect:
  `curl -si -X POST http://172.17.0.1:8080/api/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'`
- A disallowed Host is refused. The server port isn't published, so run this inside the container and expect `421`:
  `docker compose exec server python -c "import urllib.request as u, urllib.error as e; r=u.Request('http://127.0.0.1:8000/api/mcp', data=b'{}', headers={'Host':'evil.example','Content-Type':'application/json','Accept':'application/json, text/event-stream'}); exec('try:\\n print(u.urlopen(r).status)\\nexcept e.HTTPError as x:\\n print(x.code)')"`
- `docker run --rm -v "$PWD/helm/chart:/chart" alpine/helm template /chart` renders, and the output contains `MCP_ALLOWED_HOSTS`, `PUBLIC_BASE_URL` and `ADO_DESCRIPTION_MAX_CHARS` (`"2000"`).

**Result (2026-11-05):** all pass. Server 940 → 1004 passed / 41 skipped (Python 3.10; 3.12 not available here); `test_lifespan.py` 6 passed. Compose stack: `initialize` through nginx returns `HTTP/1.1 200` JSON with `serverInfo` and `instructions`, no redirect; in-container evil Host returns `421`. `alpine/helm template` renders `MCP_ALLOWED_HOSTS`, `PUBLIC_BASE_URL` (both `| quote`d) and `ADO_DESCRIPTION_MAX_CHARS: "2000"`. No client changes.

### Phase Summary
**Done.** Two Develop ↔ QA cycles (cycle 1: one Major in `truncate_description`, fixed; cycle 2: PASS).

**Files:** `requirements.txt` (`mcp>=2.3,<3`, 2.3.0 installed; `pip check` clean for mcp/fastapi/starlette/pydantic); `app/config.py` (`mcp_allowed_hosts`, `public_base_url`, `ado_description_max_chars`); `app/db.py` now owns `DB_ERRORS` / `DB_UNAVAILABLE` (re-imported by `plan_routes.py`); `app/services/ado_http.py` (new: `ado_http_client(settings)` async CM, `ado_client(payload, settings, http)` taking an `AdoConnectRequest`-shaped payload); `app/api/ado_routes.py` uses them and keeps `get_ado_http_client`; `app/services/ado_backlog.py` (`truncate_description`, `fetch_backlog(..., description_max_chars=2000)`; the REST route passes the setting); `app/mcp_server/server.py` (new: `INSTRUCTIONS` placeholder, `transport_security`, `create_mcp_server`, `create_mcp_app`, `MAX_REQUEST_BODY_BYTES` = 6 MiB); `app/mcp_server/deps.py` (new test seam); `app/main.py`; compose and Helm env vars; `values.yaml` `adoDescriptionMaxChars: 2000`.

**Key decisions / what Phase 3 needs:**
- **Wiring:** each `lifespan` run builds a fresh `MCPServer` and ASGI app in `app.state.mcp_app` and wraps `yield` in `session_manager.run()` (`session_manager` exists only after `streamable_http_app()` is called). `/api/mcp` is an exact Starlette `Route` with an ASGI-callable class endpoint (`McpEndpoint`); a plain function endpoint became GET-only (405). Without lifespan, `/api/mcp` answers 503 `{errors}`. `/api/mcp/` (trailing slash) gets FastAPI's 307; the canonical path has no redirect.
- **Phase 3 tools register on the server built by `create_mcp_server`**, so they exist in every fresh per-lifespan instance.
- **Test seam:** tools use `async with deps.db_session() as session:` and `async with deps.ado_http() as http:`; tests use `with deps.override_providers(session=…, ado_client=…):` (zero-arg callables returning async context managers).
- **Tests over HTTP** need `base_url="http://localhost"`: TestClient's `testserver` host isn't allowed (421). A bad Origin gets 403.
- **Truncation:** cut to the limit; a trailing `<` with no `>` after it is dropped only when it's the last char or followed by a letter, `/`, `!` or `?` (so `a < b` is kept); then a trailing entity start matching `&(#[0-9]{0,7}|#[xX][0-9a-fA-F]{0,6}|[A-Za-z][A-Za-z0-9]{0,31})?$` is dropped; rstrip; append `…`. QA fuzzed 200k inputs: always ≤ limit + 1, unchanged when ≤ limit. Accepted edge: prose `x<y` cut right after `<y` loses `<y`.
- Helm env values use `| quote`.

**Tests:** unit (backend-developer): `test_config.py` (settings), `test_mcp_server.py` (security settings, 200/421, 5 MiB accepted / >6 MiB 413, seam), `test_lifespan.py` (lifespan twice, initialize 200 no redirect, 421, 503 without lifespan), `test_ado_backlog_route.py` (`truncate_description` cases, route truncation with small limit). Integration (QA): `test_mcp_endpoint_integration.py` (12: initialize and `tools/list` over HTTP alongside REST routes, 400/405/406, 503, bad Origin 403, `/api/ado/backlog` truncation end to end with the PAT absent, truncation edge cases).

**Outstanding minor findings (non-blocking):** `GET /api/mcp` with `Accept: text/event-stream` opens an idle SSE stream even in stateless JSON mode (SDK behavior; nginx read timeout closes it); `_parse_positive_int` accepts `"1_000"` / `" 5 "` like the existing float parser.

## Phase 3: Tools, resources and planning guidance
Status: Not started

- [ ] Create `app/mcp_server/plan_tools.py` with `list_release_plans`, `get_release_plan`, `validate_release_plan`, `create_release_plan` and `update_release_plan` as in the **Tool contract**, using `plan_board.validate_board`, `plan_field_errors` and the `app/services/plans.py` functions.
- [ ] Map `DB_ERRORS` to `ToolError(DB_UNAVAILABLE)` and any other exception to a generic `ToolError`, logging the traceback server-side.
- [ ] Confirm how the UI fills `projectName` (`components/releasePlan/AdoConnectModal.tsx`) so the update project check compares like with like, for example against `source.project`.
- [ ] Advertise `board_json_schema()` as the `state` input schema on the three tools that take it. If the SDK then rejects bad input before the tool runs, make sure the agent still gets the full error list from **Validation rules**.
- [ ] Create `app/mcp_server/ado_tools.py` with `ado_fetch_backlog`: wrap `pat` in `SecretStr` on entry, reuse the field checks and services, return the `AdoBacklogResponse` dumped `by_alias` (same JSON as the REST route), map `AdoError` / `AdoUrlError` to `ToolError`, and `UnicodeError` / `RecursionError` to `UNEXPECTED_RESPONSE`.
- [ ] Keep the PAT out of every log line, error and result. The tool description says it is used for this call only and is never stored.
- [ ] Write tool descriptions an agent can act on: when to use each tool, that `source` must come from the user, the short **Backlog → board mapping** on `ado_fetch_backlog`, and on update that the board should be closed in the browser (last write wins).
- [ ] Create `app/mcp_server/example_board.json` and the test fixture `src/server/tests/fixtures/mcp_example_backlog.json` it is built from (see **Resources and prompt**). Test that the fixture parses as `AdoBacklogResponse` and that the example passes `validate_board` unchanged.
- [ ] Create `app/mcp_server/resources.py` with `release-plan://schema`, `release-plan://example` and `release-plan://guidance`, plus the `plan_release` prompt embedding the guidance and the example.
- [ ] Write the guidance, starting with the **Backlog → board mapping** verbatim, then the rules taken from `specs/release_plan.md` and `lib/releasePlan/modeSwitch.ts`:
  - Workflow: ask for `source`, project URL, PAT and Area/Iteration path → `ado_fetch_backlog` → build the board from `workItems` with the mapping, using `release-plan://example` as the model → plan it → `validate_release_plan` (fix and repeat until valid) → `create_release_plan` → give the user `boardUrl`.
  - Mention the fetch `warnings` to the user.
  - Ask the user for context: release dates, priorities, capacity.
  - Choosing `releases` or `sprints` mode, and how Sprints milestones relate to the iteration leaves and their `finishDate`.
  - Planning rules: keep Feature ids and titles from the backlog and never invent work items; use sizes to balance milestones; place finished Features first; leave uncertain Features in Unplanned (`milestoneId: null`).
  - Suggest a short-lived, read-only PAT scoped to Work Items, because it passes through the conversation.
- [ ] Unit tests with the SDK's in-process client (`from mcp import Client`; `Client(server)`): every tool's success and error rows, including `validate_release_plan` not storing anything, derived `projectType` / `projectName`, null `name` on update, project change refused, and an unknown id. DB-backed cases use the `db` marker and fake ADO uses `httpx.MockTransport`.
- [ ] Unit test: for the same mocked ADO responses, `ado_fetch_backlog` returns the same JSON as `POST /api/ado/backlog`, including a description truncated by **Description limit**.
- [ ] Unit test: a recognizable fake PAT appears in no result, no `ToolError` and no captured log (`caplog`), on success and on each ADO failure.

### Verification Plan
- `python3 -m compileall -q src/server/app` exits 0.
- `python3 -m pytest src/server -q` passes without a database (`db` tests skipped).
- `docker compose up -d postgres`, then `TEST_DATABASE_URL=postgresql+asyncpg://planninghub:planninghub@172.17.0.1:5432/planninghub python3 -m pytest src/server -q` passes with the `db` tests running.
- Listing tools through `Client(server)` returns exactly the 6 tools of the contract, with no delete tool and no `ado_connect`.

### Phase Summary
_(write when phase completes)_

## Phase 4: End-to-end verification and docs
Status: Not started

- [ ] QA: add `src/server/tests/test_mcp_integration.py`, driving a real HTTP `POST /api/mcp` with Postgres: fake-ADO `ado_fetch_backlog` → the test builds a board from the returned `workItems` by the **Backlog → board mapping** → `create_release_plan` → `GET /api/plan/{id}` returns the same board → `update_release_plan` → `PUT` from the UI side still works.
- [ ] QA: add a fixture `src/server/tests/fixtures/mcp_board_normalized.json`, generated by `validate_board` with both modes, flags and the `no-epic` Epic. Add a Vitest test asserting `normalizePlan(fixture)` deep-equals the fixture.
- [ ] QA: in the same Vitest file, check the published mapping matches the client: `planFromBacklog(tests/fixtures/mcp_example_backlog.json)` equals `app/mcp_server/example_board.json` in everything but the plan itself (same `source`, `iterations`, Epic and Feature ids, order and fields; `milestones`, `flags`, `mode`, `name` and `milestoneId` are ignored).
- [ ] QA: check a board as the UI saves it (`planFromBacklog` output, and a Sprints-mode board with flags) passes `validate_board`, so agents can update UI-created plans.
- [ ] QA: check `planConnection(state.source)` is non-null for an MCP-created board, so Sync from ADO works.
- [ ] Update `specs/mcp_server.md` with the tools, the ADO link requirement and the accepted limitations.
- [ ] Update `specs/release_plan.md`: descriptions fetched from Azure DevOps are truncated to a configurable length (`ADO_DESCRIPTION_MAX_CHARS`, default 2000).
- [ ] Update `README.md`: connecting an MCP client to `https://<host>/api/mcp` (a Claude Code example), the available tools, the PAT passing through the conversation, the close-the-board limitation, the fact that the endpoint has no authentication, and the new settings (`MCP_ALLOWED_HOSTS`, `PUBLIC_BASE_URL`, `ADO_DESCRIPTION_MAX_CHARS` / `adoDescriptionMaxChars`).
- [ ] Update `AGENTS.md`: architecture (the MCP endpoint), the server table (`app/mcp_server/`, `services/plan_board.py`), the new settings, and the `plans/` key list.

### Verification Plan
- All of these pass: `python3 -m compileall -q src/server/app`, `python3 -m pytest src/server -q` (with `TEST_DATABASE_URL` set), and `cd src/client && npm run build && npm test -- --run`.
- `git diff --stat -- src/client` shows only the new test file; no production client code changed.
- With the compose stack running, an MCP client created by `Client("http://172.17.0.1:8080/api/mcp")` lists the 6 tools, creates a board from the example resource, and the returned `boardUrl` path answers through `GET /api/plan/<id>`.

### Phase Summary
_(write when phase completes)_

## Final Recap
_(write when all phases complete: summary of the entire piece of work)_

## Deployment Plan
_(write when all phases complete: step-by-step deployment instructions)_
