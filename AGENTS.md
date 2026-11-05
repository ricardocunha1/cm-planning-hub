# AGENTS.md

Guidance for AI coding agents (OpenCode, Claude Code, …) working in this
repository. `CLAUDE.md` only imports this file; edit this one.

**Planning Hub** is a dashboard web app that hosts estimation and planning
tools for Critical Manufacturing (CM) projects. It has a FastAPI server
(`src/server`) and a React SPA (`src/client`), shipped as two Docker images
and deployed to OpenShift with a Helm chart. User-facing documentation is in
`README.md`.

## What this is

The hub groups its tools by category (sidebar + home page cards, registered
in `src/client/src/lib/tools.ts`):

- **Estimations → Monte Carlo** (`/monte-carlo`). Forecasts how many
  sprints a team needs to reach a target (Items Resolved or Story Points) by
  running thousands of simulations sampled from historical sprint
  throughput. It reports P50/P70/P85/P95 confidence levels with completion
  dates (business days) and a histogram. Flow: choose a data source (Excel
  upload or Azure DevOps) → Data Input → Data Validation (optional) →
  Results. The statistics run on the server.
- **Planning → Release Plan** (`/release-plan`). An interactive board for
  planning which Epics/Features land in which milestone or sprint
  (drag-and-drop, table view, pivoted view). Boards are created from a JSON
  file or from Azure DevOps, can be synced from Azure DevOps, saved/loaded
  as JSON and exported to PNG. The board logic is client-only and
  autosaves to localStorage; the server is only used as the Azure DevOps
  proxy.

## Architecture

```text
 Browser ─────────────────────────────────────┐     AI agent (MCP client)
    │  / (static files)                       │ /api/*        │ /api/mcp
    ▼                                         ▼               ▼
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ client  (nginx, port 8080)   │        │ server  (uvicorn, port 8000) │
│ React SPA static files       │        │ FastAPI "Planning Hub API"   │
│ SPA fallback (try_files)     │        │ + MCP server (/api/mcp)      │
└──────────────────────────────┘        └───────┬──────────────┬───────┘
                                                │ SQL          │ REST (PAT from the request,
                                                ▼              ▼ never stored; host allowlist)
                                  ┌──────────────────────────┐ Azure DevOps
                                  │ database  (port 5432)    │
                                  │ PostgreSQL 17            │
                                  │                          │
                                  └──────────────────────────┘
```

- The **client** serves the SPA. In production the ingress sends `/api` straight
  to the server (the diagram omits it); with docker compose the client's nginx
  proxies `/api/` instead (`API_UPSTREAM`, default `http://server:8000`).
- The **server** is stateless: the SPA keeps all state (validated sprint
  summary, simulation results, Release Plan board) and sends what each
  request needs. Every 422 response is `{errors: [str]}`.
- **Azure DevOps** is reached only through the server
  (`/api/ado/*`). The Personal Access Token travels with each request and
  is never persisted; `ADO_ALLOWED_HOSTS` limits which hosts may be called.
- **MCP endpoint** (`POST /api/mcp`): the server also exposes the Release
  Plan to AI agents as an MCP server (Streamable HTTP, stateless JSON mode, so
  any replica answers). It calls `app/services` directly, has no
  authentication, and takes the Azure DevOps PAT as a tool argument. Allowed
  Host headers come from `MCP_ALLOWED_HOSTS`; board links use
  `PUBLIC_BASE_URL`. See `specs/mcp_server.md`.
- A diagram is also available in `docs/architecture.png`.

### Production workload (Helm)

`helm/chart` deploys to OpenShift (namespace `cm-planning-hub`):

- `cm-planning-hub-client-deployment` / `-service` and
  `cm-planning-hub-server-deployment` / `-service` (Services expose port 80
  → 8080 / 8000).
- `cm-planning-hub-db-deployment` / `-service`: PostgreSQL for Release Plan persistence. Its ClusterIP Service exposes
  port 5432 inside the cluster only; the ingress does not route to it.
- `cm-planning-hub-ingress` routes `/api` → server and `/` → client at
  `public_http_address`.
- `values.yaml`: registry `dev.criticalmanufacturing.io`, image names, one
  shared `tag` for both images, `adoAllowedHosts` (passed to the server as
  `ADO_ALLOWED_HOSTS`), `adoDescriptionMaxChars` (`ADO_DESCRIPTION_MAX_CHARS`),
  `postgres` (database image and the Secret that holds
  its credentials).

Both images run as non-root (OpenShift). Releases are built by the manual
**Deploy** GitHub workflow (`.github/workflows/deploy.yml`): GitVersion tag →
server and client tests + build → `deploy/build-docker-image.sh` (build and
push both images) → git tag.

### `specs/` and `plans/`

- **`specs/`** — the functional specification: *what* each tool must do. 
  This is the source of truth for behavior; read the relevant spec before changing a feature.
  `specs/templates/` is not committed — never import or read it.
- **`plans/`** — implementation plans, one per piece of work, with phases,
  checkboxes and *Phase Summaries*. They record *how* and *why* things were
  built (decisions agreed with the user, API contracts, edge cases) that
  cannot be re-derived from the code. Key ones:
  - `monte-carlo-app.md` — "Key decisions": simulation/validation business
    rules (ranking, percentiles, the `>50` sprints sentinel, business days).
  - `release-plan-board.md`, `release-plan-import-export.md`, `release-plan-ado.md` — Release Plan features reference.
  - `release-plan-persistence.md` — storing Release Plan boards in PostgreSQL.
  - `release-plan-mcp-server.md` — the MCP server: decisions, tool contract,
    strict board validation rules and the ADO description limit.

  When working on a plan, follow its "For Future Agents" section (tick
  checkboxes, update phase status, write the Phase Summary). Create a new
  plan only when the user explicitly asks for one or references a planning
  skill such as `real-work` (see **Planning** below).

### Server — `src/server`

Python 3.12, FastAPI, pandas/NumPy, httpx.

| Path | Purpose |
| --- | --- |
| `app/main.py` | App factory: mounts routers under `/api` and `/api/ado`, converts validation errors to `{errors}`. |
| `app/config.py` | Settings from the environment (`ADO_ALLOWED_HOSTS`, `ADO_TIMEOUT_SECONDS`, `ADO_DESCRIPTION_MAX_CHARS`, `DB_*`, `MCP_ALLOWED_HOSTS`, `PUBLIC_BASE_URL`). |
| `app/schemas.py` | Pydantic request/response models — the API contract. |
| `app/api/routes.py` | Monte Carlo: `GET /health`, `POST /validate`, `POST /simulate`. |
| `app/api/ado_routes.py` | Azure DevOps proxy: `POST /ado/connect`, `/ado/backlog`, `/ado/sprint-history`. |
| `app/mcp_server/` | MCP server mounted at `/api/mcp`: `server.py` (server, ASGI app, host/body limits), `plan_tools.py` and `ado_tools.py` (the 6 tools), `resources.py` (`release-plan://schema`), `errors.py`, `deps.py` (test seam). |
| `app/services/` | All business logic (routes stay thin): `validation` (form guardrails), `data_processing` (Excel parsing, sprint summary), `simulation` + `forecast` (vectorized NumPy Monte Carlo, percentiles, dates, histogram), `ado_*` (ADO client, URL rules, backlog and sprint-history reads), `ado_http` (shared ADO HTTP client for routes and MCP tools), `plan_board` (strict Release Plan board validator and JSON Schema, used by MCP only), `plans` (plan storage). |
| `tests/` | pytest suite (unit, route, end-to-end incl. performance limits). |

### Client — `src/client`

Vite + React 18 + TypeScript + Tailwind 3, react-router, Vitest. Code is
organized **per tool** (`monteCarlo/`, `releasePlan/`, shared `ado/`), with
shared hub pieces at the top level.

| Path | Purpose |
| --- | --- |
| `src/main.tsx`, `src/App.tsx` | Entry point and routes. |
| `src/pages/` | One component per route (`monteCarlo/` subfolder for its wizard). |
| `src/components/` | Shared hub UI (layout, sidebar, toasts, dialogs, icons) plus per-tool folders `monteCarlo/`, `releasePlan/`, `ado/`. |
| `src/lib/` | Non-UI logic. `tools.ts` = tool registry (add a tool here + routes in `App.tsx`). Per tool: `types.ts` + `api.ts` mirror the server schemas; `releasePlan/` holds the pure board logic (validation, reducer, layout, storage, export). |
| `src/monteCarloStore.tsx`, `src/releasePlanStore.tsx` | Per-tool state (React context). Monte Carlo is in memory only; Release Plan autosaves to localStorage. |
| `src/test/` | Test helpers and fixtures (`render.tsx` → `renderAt`, DnD/canvas mocks). |
| `Dockerfile`, `nginx.conf.template` | Build → nginx-unprivileged image, `/api` proxy. |

## Development workflow and subagents

Three subagents are defined in `.claude/agents/` (Claude Code). OpenCode
uses the same files through per-file symlinks in `.opencode/agents/`
(OpenCode does not follow a symlinked directory). Edit them only in
`.claude/agents/`, and when adding an agent also add its symlink:
`ln -s ../../.claude/agents/<name>.md .opencode/agents/<name>.md`. Each
file carries both Claude (`name`, `tools`) and OpenCode (`mode`,
`permissions`) frontmatter.

| Subagent | Area | Writes |
| --- | --- | --- |
| `backend-developer` | `src/server`, `specs/` | Python changes + **unit tests** only |
| `frontend-developer` | `src/client`, `specs/` | React/TS changes + **unit tests** only |
| `qa-engineer` | review of the change, tests, `specs/` | **integration / end-to-end tests** only; never production code |

Work is split into two separate steps, each started by its own user
prompt: **Planning** (only when asked) and **Implementation**. Never move
from one to the other in the same turn.

**Models.** Planning runs in the main conversation, on its model. The
implementation subagents run on **Sonnet 5.5**. That default lives in each
harness's config, not in the agent files:

- Claude Code: `.claude/settings.json` →
  `env.CLAUDE_CODE_SUBAGENT_MODEL = "claude-sonnet-5-5"`.
- OpenCode: `opencode.json` → `agent.<name>.model =
  "github-copilot/claude-sonnet-5.5"` (add an entry when adding an agent).

### Planning (only on request)

Run this only when the user explicitly asks for a plan or references a
planning skill such as `real-work`. The main session writes the plan
itself (no developer or QA subagents):

1. Read the request, the relevant `specs/` and existing `plans/`.
2. Create the plan in `plans/<name>.md` following the `real-work` skill:
   phases with checkboxes, the split into backend and frontend tasks, and,
   if the change crosses the API, the API contract (route,
   request/response shapes, 422 `{errors: [str]}` cases).
3. Stop and hand the plan to the user for review: give its path and a
   short summary. Don't change `src/`, don't write tests and don't start
   implementing. Revise the plan if the user asks for changes.

Implementation of a plan starts only when the user later asks for it.

### Implementation

The **main session is the coordinator**: it prepares, delegates, verifies
and reports. For any feature or fix that changes `src/server` or
`src/client` (implementing a reviewed plan, or a direct request without a
plan):

1. **Prepare** — read the request, the plan (if any; follow its "For
   Future Agents" section), the relevant `specs/` and `plans/`. Split the
   work into a backend task and a frontend task. If the change crosses the
   API, take the API contract from the plan or write it once, and give the
   identical contract to both developers. Record a baseline
   (`git status --short` and the current pass/fail state of the
   verification commands) so pre-existing failures are not blamed on, or
   hidden by, this work. In a fresh worktree run `cd src/client && npm ci`
   first.
2. **Develop** — launch `backend-developer` and `frontend-developer` **in
   parallel** (one message, two subagent calls). Give each: the user's goal,
   its own task, the shared API contract, the relevant spec sections and the
   files you expect it to touch. Skip an agent only if its side clearly
   needs no change. When both finish, **re-run the verification commands
   yourself** — never advance on an agent's word alone. Exit criteria:
   server compiles and its tests pass; client build (type-check) and tests
   pass; each developer added/updated unit tests for its change and no
   integration/e2e tests; changes stay in each agent's area
   (`git diff --stat`). On failure, send the output back to the responsible
   developer and re-verify. Never move on with a red build or test.
3. **QA** — only after Develop passes, launch `qa-engineer` with the goal,
   the API contract, the changed files (`git diff --stat` against the
   baseline) and the relevant specs. It reviews against specs and best
   practices, adds **integration / end-to-end tests**, never changes
   production code, and reports Blocker / Major / Minor findings. Exit
   criteria: no open Blocker/Major findings, and the full verification
   commands still pass (re-run them yourself).
4. **Fix loop** — send each Blocker/Major finding back to the responsible
   developer, re-verify the Develop exit criteria, then re-run QA in full.
   At most 3 Develop ↔ QA cycles; if defects remain, stop and report to the
   user. Minor findings don't block; list them in the final report.
5. **Wrap up** — update the plan if there is one (checkboxes, phase
   status, Phase Summary) and the docs (`AGENTS.md`, `README.md`) when the
   architecture or usage changed. Report per phase: agents used, files
   changed, tests added (unit vs. integration/e2e), verification results,
   Develop ↔ QA iterations and outstanding minor findings. Don't commit
   unless asked.

While coordinating, the main session does not write production code or
tests itself, and uses the shell only for verification (tests, builds,
`git diff`, `git status`) — never to commit, push or stash.

Verification commands (all must pass):

```bash
python3 -m compileall -q src/server/app
python3 -m pytest src/server -q
cd src/client && npm run build && npm test -- --run
```

## Commands

```bash
# Full stack (http://localhost:8080; from inside the devcontainer use http://172.17.0.1:8080)
docker compose up --build
docker compose -f docker-compose.yml -f docker-compose.debug.yml up --build   # server under debugpy (5678)

# Server
cd src/server && uvicorn app.main:app --reload --port 8000
cd src/server && pytest                                   # all tests
cd src/server && pytest tests/test_simulation.py          # one file
cd src/server && pytest tests/test_validate_route.py::<name>   # one test

# Client
cd src/client && npm ci && npm run dev    # http://localhost:5173, proxies /api -> :8000
cd src/client && npm test -- --run        # Vitest
cd src/client && npm run build            # tsc -b type-check + production build

# Docker images (normally done by the "Deploy" GitHub workflow; run from repo root)
./deploy/build-docker-image.sh -t <tag> --no-push            # build both images
./deploy/build-docker-image.sh -t <tag> -u <user> -p <pat>   # build + push both
```

Environment notes:

- The devcontainer provides Python 3.12 (`.venv`) and Node 22. If `node` is
  missing: `export PATH=~/.local/node/bin:$PATH`.
- Docker is docker-outside-of-docker: published ports are reachable at
  `172.17.0.1:<port>`, not `localhost`. If attached `docker run` drops
  stdout, use `docker run -d --name x ...; docker wait x; docker logs x`.
- `helm`, `actionlint`, `shellcheck` aren't installed; run them via the
  `alpine/helm`, `rhysd/actionlint`, `koalaman/shellcheck` images.
- No linter is configured; `npm run build` is the client type-check.
- Add npm dependencies with `npx npm@11 install` (npm 10 can't resolve
  vitest 4's peer deps from scratch; `npm ci` with npm 10 is fine).
- The root `.gitignore` ignores `lib/`; `src/client/.gitignore` re-includes
  `src/lib/`.
