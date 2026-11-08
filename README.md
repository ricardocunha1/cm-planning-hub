# Planning Hub

A web application that hosts estimation and planning tools for Critical
Manufacturing (CM) projects. It currently offers two tools:

- **Monte Carlo** (Estimations) — forecasts how many sprints are needed to
  hit a target (Items Resolved or Story Points) by running thousands of
  simulations sampled from a team's historical sprint throughput. Instead of
  a single-point estimate, it reports a range of outcomes (e.g. "95% of
  simulations reach the target within 8 sprints") with a projected
  completion date for each confidence level.
- **Release Plan** (Planning) — an interactive drag-and-drop board for
  planning which Epics and Features ship in which release or sprint. Boards
  are created from Azure DevOps and saved in a PostgreSQL database.

## Navigation

The app is a dashboard: a header, a left
sidebar, and a main content area.

- **Sidebar** — tools are grouped by category. The "Estimations" group
  holds the **Monte Carlo** item (dice icon) and the "Planning" group
  holds the **Release Plan** item (roadmap icon); each is highlighted on
  every page of its tool.
- **Home page** — a section per category with a card per tool with a short description
  and its goal; click a card to open the tool. Unknown URLs land here.
- **Monte Carlo (`/monte-carlo`)** — the entry page lets you choose how
  to import the sprint history data (**Import from an Excel file** or **Import from Azure DevOps**); then follows the three-step flow described below (see
  [How the Monte Carlo tool works](#how-the-monte-carlo-tool-works). The **How to Use** button
  next to the Monte Carlo step breadcrumb opens the in-app help. Results and
  validation data are kept in memory only, so reloading the Confirm or
  Results page sends you back to `/monte-carlo`.
- **Release Plan (`/release-plan`)** — the entry page has the **Create from
  Azure DevOps** card and the list of **Saved release plans**. Each board has
  its own address, `/release-plan/<id>`, so it can be reloaded or shared as a
  link; an unknown or deleted plan sends you back to `/release-plan`. See
  [How the Release Plan tool works](#how-the-release-plan-tool-works).

## How the Monte Carlo tool works

The Monte Carlo tool is a three-step wizard.

### 1. Data Input

Initially the user selects the data source: an Excel file containing an extract of the sprints historical data or a direct connection to Azure DevOps, where they need to enter additional connection details, including a valid __Personal Access Token__.  
The user then must fill in the simulation parameters:

| Parameter                            | Required | Description                                                                                                        |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| Target Type                          | Yes      | "Items Resolved" or "Story Points" — the metric the simulation forecasts against                                   |
| Target Value                         | Yes      | The number of items/story points to reach                                                                          |
| Number of Simulations                | Yes      | How many Monte Carlo runs to perform (capped at 20000). Default: `10000`                                            |
| Sprint Start Date                    | Yes      | Start date of the first simulated sprint                                                                           |
| Sprint Length                        | Yes      | Length of each sprint, in business days. Default: `10` days                                                       |
| Team Capacity Factor                 | Yes      | Team capacity relative to the historical data (default `1.0`). E.g., `1.2` means 20% more capacity than historical |
| Skip Historical Sprint Validation    | No       | Bypasses step 2 and jumps straight to execution                                                                    |
| Exclude Latest Sprints from Sampling | No       | Number of most recent sprints to leave out of the random sampling pool (e.g. to exclude an in-progress sprint)     |

### 2. Data Validation (optional)

Unless skipped, the app validates the uploaded file and parameters, then
summarizes the historical data it parsed — one row per sprint, showing
items resolved, story points, last resolved date, a recency rank, and
whether that sprint is included in the simulation's sampling pool. The user
reviews this summary and confirms before running the simulation.

### 3. Simulation Execution

The app runs the requested number of simulations, each one randomly
sampling from the historical sprint data (respecting the sampling-pool
exclusions from step 2) until the target is reached or a 50-sprint window
is exceeded. Each sampled Items Resolved / Story Points value is scaled by
the Team Capacity Factor before being compared against the target, so a
factor above 1.0 reaches the target in fewer sprints than the raw
historical data would suggest, and a factor below 1.0 takes more. Results
are presented per confidence level — P50, P70, P85, and P95 — showing the
number of sprints required and the projected completion date (business
days only), including a calendar view, plus a histogram of the full distribution of outcomes.

## Sprint History Excel file format

The uploaded file must contain one worksheet with these columns:

| Column Name        | Data Type | Mandatory | Notes                                                                                                   |
| ------------------ | --------- | --------- | ------------------------------------------------------------------------------------------------------- |
| **State**          | String    | **Yes**   | Only rows where State is `Resolved`, `Done`, or `Closed` (case-sensitive) count toward a sprint         |
| **Iteration Path** | String    | **Yes**   | The sprint is derived from the last segment after `\`, e.g. `Project\Release 1\Sprint 12` → `Sprint 12` |
| **Resolved Date**  | Date      | **Yes**   | Used to determine each sprint's most recent completion date and recency rank. Format: `MM/dd/yyyy [hh:mm]` (time optional), e.g. `03/27/2025 14:30` |
| **Story Points**   | Numeric   | **Yes**   | Defaults to 0 for rows where it's missing                                                               |

Date columns must use the `MM/dd/yyyy [hh:mm]` format (month first; the
time part is optional), e.g. `03/27/2025` or `03/27/2025 14:30`.

If a mandatory column is missing, or the file can't be parsed as Excel, the
app reports the specific problem instead of failing silently.

## How the Release Plan tool works

The Release Plan tool lays out a plan's Epics and Features on a board:
Epics are columns, and each Feature sits in the row (band) of the milestone
it is planned for, or in **Unplanned**. Plans are created from Azure DevOps
and stored on the server, so they are available from any browser.

### Creating a board

- **Create from Azure DevOps** — enter the connection details (Azure DevOps
  source, Project URL and Area or Iteration Path) and a valid **Personal
  Access Token**, and give the plan a **Plan name** (pre-filled with
  `<project> – Feature Release Plan`, up to 200 characters). Click **Create
  board** to build the board from the project's backlog; the plan is saved
  and opened at `/release-plan/<id>`.

### Saved release plans

The entry page lists the stored plans, most recently modified first, 10 per
page (**Previous** / **Next**). Each row shows the plan name (a link that
opens the board), the project (`On Prem · <project>` or
`Collaboration Hub · <project>`), and when it was created and last modified.
**Delete** asks for confirmation and removes the plan permanently. Plan names
don't have to be unique.

### The board

- **Summary** — one box per milestone (Feature count, size chips, Epics
  completed), one for Unplanned, and one per milestone flag (cumulative
  counts up to that flag).
- **Milestones** — the frozen left column lets you rename, date, reorder or
  delete a milestone (its Features become Unplanned); the **+** between
  milestones inserts a new one or, in Sprints mode, an additional milestone flag.
- **Releases / Sprints** — Releases mode uses free-form milestones; Sprints
  mode creates one milestone per Iteration Path sprint and plans each
  Feature in its sprint. Switching modes (after a confirmation) discards
  manual planning and flags.
- **Planning on the board**:
  - **Drag and drop** — drag an Epic header (or use ◀/▶) to reorder Epics;
    drag a Feature card onto another band to plan it for that milestone, or
    onto another column of the same Epic to reorder it. Valid drop targets
    are highlighted, and Features can't move to another Epic.
  - **Multi-select** — **Ctrl+click** (⌘+click on Mac) Feature cards of one
    Epic to drag them together; a plain click, **Esc** or a click on the
    background clears the selection.
  - **Auto-scroll** while dragging near the board's top or bottom edge, and
    **Zoom** (−/+, **Fit**).
  - **Flip Board** — toggle the board's orientation between horizontal and vertical.
- **Table view** — the same plan as a table, with search, Epic and
  milestone filters, and a milestone select per Feature.
- **Work-item details** — click a Feature card or Epic title to see its
  state, size, milestone, Iteration Path and description.
- **Sync from ADO / Export PNG** — refresh the board from Azure DevOps, or
  download an image of the board.

### Saving

- **Autosave** (toolbar toggle, on by default) saves the plan to the server
  3 seconds after the last change. The setting is remembered per browser and
  applies to every plan.
- With autosave off, use the **Save** button. It also appears when a save
  fails, so you can retry.
- The toolbar shows the status: **Saved**, **Unsaved changes**, **Saving…**
  or **Save failed**.
- Leaving the board with unsaved changes asks you to **Save**, **Discard**
  or **Cancel**; reloading or closing the tab shows the browser's own
  warning.
- If two people edit the same plan, the last save wins.

## Using the Release Plan from an AI agent (MCP)

The server exposes an MCP endpoint
(Streamable HTTP, stateless) at `https://<host>/api/mcp`, so an AI agent can
read an Azure DevOps backlog and create or update Release Plans. Example with
Claude Code:

```bash
claude mcp add --transport http planning-hub https://<host>/api/mcp
```

Tools:

- `ado_fetch_backlog` — reads the backlog work items from Azure DevOps
- `get_release_plan_schema` — the JSON Schema of what the agent decides.
- `validate_release_plan` — checks the agent's decisions offline and returns every error; stores nothing.
- `create_release_plan`, `update_release_plan` — the agent sends only the
  milestones, the Epic order (`epicOrder`) and which milestone each Feature
  goes in (`assignments`), plus the Azure DevOps connection and PAT. The server
  fetches the backlog in the same call and fills in titles, states, sizes,
  iteration paths and descriptions, so the agent never retypes them. Update
  replaces the decisions and refreshes everything from Azure DevOps.
- `list_release_plans`, `get_release_plan` — browse stored plans (the board includes descriptions).

## Architecture

![Architecture Diagram](docs/architecture.png)

The app is split into two tiers under `src/`:

- **`src/server`** — FastAPI API (includes Pandas/NumPy libraries for simulation logic), port 8000.
  It stores Release Plan boards in **PostgreSQL** and applies the migrations at
  startup.
- **`src/client`** — React + TypeScript single-page app (Vite, Tailwind),
  served by nginx in production. nginx proxies `/api` to the server, so the
  browser only ever talks to one origin. The dashboard's tools come from a
  small registry (`src/client/src/lib/tools.ts`) that feeds both the
  sidebar and the home page.

## Running with Docker Compose

```bash
docker compose up --build        # http://localhost:8080
docker compose down
```

The client container listens on 8080 (non-root nginx) and reaches the
server through `API_UPSTREAM` (default `http://server:8000`). The `postgres`
service holds the release plans.

## Building and deploying

```bash
./deploy/build-docker-image.sh -h                         # usage
./deploy/build-docker-image.sh -t 1.2.3 --no-push         # build client + server images
./deploy/build-docker-image.sh -t 1.2.3 -u <user> -p <pat> # build and push both
```

Releases are made by the manual **Deploy** GitHub workflow: it computes the
version with GitVersion, runs the server and client tests, builds and pushes
`planninghub/planninghub-client` and `planninghub/planninghub-server`
with that tag, and tags the commit. The Helm chart in `helm/chart` deploys
both (set `tag` in `values.yaml`); the ingress sends `/api` to the server and
everything else to the client.

The chart also deploys PostgreSQL (`cm-planning-hub-db-deployment` /
`-service`, image `postgres.image`, default `postgres:17`). The database
credentials come from an **existing Secret that the chart does not create**.
Create it in the namespace before installing:

```bash
oc -n cm-planning-hub create secret generic cm-planning-hub-db-secret \
  --from-literal=username=planninghub --from-literal=password=<password>
```

## Running locally (development)

Requires Python 3.12 and Node 22 (both are set up by the devcontainer,
which also installs the server and client dependencies), and a PostgreSQL
database for the Release Plan API.

```bash
# Database — postgres:17 on port 5432 (from inside the devcontainer use DB_HOST=172.17.0.1)
docker compose up -d postgres

# Server — http://localhost:8000
# DB settings: DB_HOST (default localhost), DB_PORT (5432), DB_USER, DB_PASSWORD;
# the database name is always planninghub. Migrations run at startup
# (DB_MIGRATE_ON_STARTUP=true, waiting up to DB_STARTUP_TIMEOUT_SECONDS=60).
cd src/server
export DB_USER=planninghub DB_PASSWORD=planninghub
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# Client — http://localhost:5173 (Vite proxies /api to localhost:8000)
cd src/client
npm ci
npm run dev
```

## Tests

```bash
cd src/server && pytest              # server (or `pytest src/server` from the repo root)
cd src/client && npm test -- --run   # client (Vitest)
cd src/client && npm run build       # type-check + production build
```

The server's database tests are skipped unless `TEST_DATABASE_URL` is set
(the Deploy workflow runs them against a `postgres:17` service). To run them
locally:

```bash
docker compose up -d postgres
TEST_DATABASE_URL=postgresql+asyncpg://planninghub:planninghub@172.17.0.1:5432/planninghub pytest src/server
```

They use the same `planninghub` database and empty the `release_plans`
table, so they wipe the plans of a running compose stack.

See `AGENTS.md` for architecture notes and the AI-agent workflow (used by
both OpenCode and Claude Code) and `specs/` for the full functional
specification.
