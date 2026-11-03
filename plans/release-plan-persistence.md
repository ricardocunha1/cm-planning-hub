# Release Plan — Persistence (PostgreSQL)

Implement `specs/release_plan_persistence`: store Release Plan boards in a
PostgreSQL database behind a new `/api/plan` router. The `/release-plan`
page lists the stored plans (paginated, deletable), a board opens at
`/release-plan/:id`, and changes are autosaved (or saved manually) to the
server. JSON save/load and the localStorage plan autosave are removed.
Postgres is added to docker compose, the Deploy workflow (tests) and the
Helm chart, with no volumes. This continues `plans/release-plan-board.md`,
`plans/release-plan-import-export.md` and `plans/release-plan-ado.md`, which
are not edited. Their decisions still govern every board behavior not
restated here.

## For Future Agents
As work proceeds: mark checkboxes `- [x]` as items complete; when a phase is done,
set its status to `Complete` and write its **Phase Summary** (what was done, key
decisions, anything needed to continue with zero context); run the phase's
**Verification Plan** and record the result before moving on. When all phases are
done, fill in **Final Recap** and **Deployment Plan**.

Each phase follows the AGENTS.md *Implementation* workflow: the main session
coordinates; `backend-developer` / `frontend-developer` develop (in parallel when
both have work); then `qa-engineer` reviews; at most 3 Develop ↔ QA cycles. Give
both developers the **API contract** below verbatim. **Do not edit `AGENTS.md`**
in this work (user decision). README and spec notes are covered by Phase 5.

**Area exception (agreed for this plan):** `backend-developer` also owns the
infra files: `docker-compose*.yml`, `.github/workflows/deploy.yml` and
`helm/chart/**`. No other agent edits them.

## Decisions (confirmed with the user, 2026-11-03)
- **All JSON file features are removed**: the home "Import a JSON file" card,
  the toolbar "Load Plan" / "Save Plan" buttons, `ImportJsonModal`, and the
  JSON download code (`exportFile.ts` JSON parts) with their tests. So every
  plan is created from Azure DevOps and always has a project.
  `normalizePlan` / `validate.ts` stay: they normalize the state loaded from
  the server.
- **localStorage plan autosave is dropped.** The board state lives only in
  the DB. The old `cmPlanningHub.releasePlan.v1` key is removed once on app
  start (try/catch), and "Continue last board" goes away (the plan list
  replaces it). The remembered ADO connection
  (`cmPlanningHub.releasePlan.adoConnection.v1`, never a PAT) stays.
- **Routing**: the board is at **`/release-plan/:id`**. A reload or a shared
  link reopens the plan via `GET /api/plan/{id}`. `/release-plan/board` is
  removed (it now redirects to `/release-plan`). Unknown/deleted id (404),
  or a non-numeric id → toast "Release plan not found" and redirect to
  `/release-plan`.
- **Autosave**: **on by default**, saves **3 s after the last change**
  (debounced) with `PUT /api/plan/{id}`. The on/off toggle is a
  **per-browser preference** in localStorage
  (`cmPlanningHub.releasePlan.autosave.v1`, `"on"`/`"off"`; it applies to
  every plan). When autosave is off, a **Save** button is shown (also shown,
  enabled, while autosave is on but the last save failed). The toolbar shows a
  status: `Saved` / `Unsaved changes` / `Saving…` / `Save failed`.
- **Unsaved-changes guard**: if the board has unsaved changes (dirty,
  pending debounce, in-flight or failed save), in-app navigation away from the
  board (sidebar, breadcrumb, browser back) opens a dialog **Save / Discard /
  Cancel**. Reload or closing the tab triggers the browser's `beforeunload`
  prompt.
- **Concurrency: last write wins.** PUT overwrites, with no version check.
- **Server DB stack**: **SQLAlchemy 2.0 async + asyncpg**, schema managed by
  **Alembic**, migrations run **at server startup**.
- **Server tests run against a real Postgres** from `TEST_DATABASE_URL`. DB
  tests are **skipped** when it is unset. The Deploy workflow runs a
  `postgres:17` service container and sets it, so they always run in CI.
  Locally: `docker compose up -d db` and
  `TEST_DATABASE_URL=postgresql+asyncpg://planninghub:planninghub@172.17.0.1:5432/planninghub_test`.
- **Postgres image**: official **`postgres:17`** (Debian; supports
  OpenShift's arbitrary UID) in compose, CI and Helm. **No volumes**: Helm
  uses an `emptyDir` at `PGDATA`, so **data is lost on pod restart**. This is
  accepted for now (spec).
- **Credentials**: a Helm **Secret holds the DB username and password**. The
  Postgres pod reads it as `POSTGRES_USER` / `POSTGRES_PASSWORD`, and the
  server reads it as `DB_USER` / `DB_PASSWORD`. **The server builds the
  connection string** from `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`
  and `DB_NAME` (the last three are plain env vars). Values:
  `postgres.username` (default `planninghub`), `postgres.password`
  (**required**: `helm install … --set postgres.password=…`, via `required`,
  so an install without it fails), `postgres.database` (default
  `planninghub`).
- **`project_type` stores codes `onprem` / `cloud`** (same as
  `PlanSource.kind`). The client shows "On Prem" / "Collaboration Hub".
- **Plan names are not unique.** They are trimmed, 1–200 characters.
- **Sync from ADO and Export PNG are unchanged.** A sync is just another
  change, so it is autosaved.

### Implementation choices (derived, not asked; change them here if needed)
- **`timestamptz`** for `created_at` / `updated_at` (the spec says
  `timestamp`). This keeps API times unambiguous UTC. Both default to `now()`,
  and `updated_at` is set to `now()` explicitly on every PUT (no trigger).
- **Columns vs. state**: `name`, `project_type` and `project_name` are
  columns (for the list). `state` is the full normalized `ReleasePlan`
  object. `PUT` updates `name` and `state` together. **`project_type` and
  `project_name` are fixed at creation** (PUT does not accept them). The
  client keeps `state.name` equal to the `name` column (rename → next save
  sends both).
- **State validation on the server is shallow**: it must be a JSON object
  whose `schema` is `"release-planner-features"`, and its serialized size must
  be ≤ **5 MiB** (`PLAN_STATE_MAX_BYTES`). Deep validation stays in the
  client's `normalizePlan` on load.
- **Pagination**: `GET /api/plan?page=N` (1-based, default 1), fixed page size
  **10** (`PLAN_PAGE_SIZE`). Order: `updated_at DESC, id DESC` (stable). A
  page past the end returns `items: []` with the real `total`. The client
  goes back one page when a delete empties the current page.
- **Server modules**: `app/db.py` (engine + `async_sessionmaker`, built
  lazily from `Settings`; `get_session` FastAPI dependency), `app/models.py`
  (`ReleasePlanRow`, table `release_plans`), `app/services/plans.py`
  (repository functions: `list_plans`, `get_plan`, `create_plan`,
  `update_plan`, `delete_plan`), `app/api/plan_routes.py` (router at
  `/api/plan`), `alembic.ini` + `migrations/` under `src/server`
  (first revision creates `release_plans`), schemas in `app/schemas.py`
  (camelCase aliases, like the ADO schemas).
- **Startup**: a FastAPI `lifespan` runs `alembic upgrade head` (through
  `connection.run_sync`) when `DB_MIGRATE_ON_STARTUP` is true (default
  `true`). It retries the DB connection for up to `DB_STARTUP_TIMEOUT_SECONDS`
  (default 60) and then fails the startup. Existing non-DB tests must keep
  passing **without a DB**: the engine is created lazily, and the test
  `client` fixture doesn't need a DB unless a DB test uses it.
- **Health**: `/api/health` stays DB-independent (liveness/readiness only
  check the process).
- **DB errors**: a connection failure or `OperationalError` from a plan route
  → **503 `{errors: ["The release plan database is unavailable."]}`**. Other
  unexpected errors go to the existing generic 500 handler.
- **Settings** (`app/config.py`, added to `Settings.from_env`): `DB_HOST`
  (default `localhost`), `DB_PORT` (5432), `DB_NAME` (`planninghub`),
  `DB_USER`, `DB_PASSWORD` (default `""`), `DB_MIGRATE_ON_STARTUP`,
  `DB_STARTUP_TIMEOUT_SECONDS`. The URL is built with
  `sqlalchemy.engine.URL.create(drivername="postgresql+asyncpg", …)`, which
  escapes the password. The password is never logged (use `repr`-safe URL
  rendering, `hide_password=True`).
- **Test fixtures** (`tests/conftest.py`): `db_url` (from `TEST_DATABASE_URL`,
  else `pytest.skip`), a session-scoped fixture that runs the Alembic upgrade
  once, a per-test cleanup (`TRUNCATE release_plans RESTART IDENTITY`), and
  `db_client`, a `TestClient` with `get_session` overridden to the test DB.
  The tests use a dedicated `planninghub_test` database (compose creates it
  with an init script).
- **Client modules**: `lib/releasePlan/planApi.ts` (`listPlans`, `getPlan`,
  `createPlan`, `updatePlan`, `deletePlan`; reuses `ApiError`; GET/PUT/DELETE
  helpers next to `postJson` in `lib/ado/api.ts` or a shared `lib/http.ts`),
  `lib/releasePlan/planTypes.ts` (contract types),
  `lib/releasePlan/autosavePreference.ts` (like `sidebarPreference.ts`), a
  `usePlanPersistence` hook (debounce, status, save now, flush), and
  components `PlanList` (+ `DeletePlanDialog`) and `UnsavedChangesDialog`.
- **Store**: `ReleasePlanProvider` loses `storage`, `restoredFromStorage` and
  `consumeRestoredNotice`. It gains `planId: number | null`, `loadPlan(id,
  plan)` and `clearPlan()`. It still owns `plan` + `dispatch` (reducer
  unchanged). Persistence status lives in the board page's hook, not in the
  store.
- **Create flow**: the ADO create modal (`AdoConnectModal`,
  `purpose="create"`) gets a required **Plan name** field above the submit
  button. It is pre-filled with `planFromBacklog`'s default name
  (`"<project> – Feature Release Plan"`) after Connect, and is editable.
  Submit: fetch backlog → `planFromBacklog` → set `name` → `POST /api/plan`
  → navigate to `/release-plan/<id>` → toast "Plan created: <name>" + backlog
  warnings. Errors from POST show inline in the modal (the modal stays open).
  `ReplaceBoardDialog` is no longer used on the home page (creating never
  replaces anything). Remove it if nothing uses it after Phase 4.
- **Plan list** (`PlanList` on `/release-plan`, below the create card):
  section heading "Saved release plans". It is a table with columns Name
  (a link to the board), Project (`On Prem · <project>` /
  `Collaboration Hub · <project>`), Created, Last modified (`toLocaleString`)
  and a Delete button (`aria-label="Delete <name>"`). Pager: "Previous" /
  "Next" buttons and "Page X of Y" (hidden when `total ≤ 10`). There are
  loading, empty ("No saved release plans yet. Create one from Azure
  DevOps.") and error (message + "Retry") states. Delete →
  `DeletePlanDialog` ("Delete <name>? This cannot be undone." Delete /
  Cancel) → `DELETE` → toast "Plan deleted: <name>" → refetch the page.
- **Board load**: `ReleasePlanBoardPage` reads `:id`, shows a loading state,
  calls `getPlan`, runs `normalizePlan(state)` (if it returns null, it is
  treated like not found, with toast "This release plan could not be read"),
  then `loadPlan`. While a plan is loaded, the store's `planId` matches the
  route.
- **Save semantics**: a save sends `{name: plan.name, state: plan}`. The
  status becomes `Saved` only if no newer change arrived during the request
  (compare a change counter). On failure the status is `Save failed` + a toast
  with the server message. Autosave doesn't retry on its own; the next change
  or the Save button retries. Switching autosave on with unsaved changes
  schedules a save. 404 on PUT (deleted elsewhere) → toast "This release plan
  no longer exists" and go to the list.
- **Toolbar** (`BoardToolbar`): remove Load/Save Plan. Add an "Autosave"
  switch (`role="switch"`, `aria-checked`), the save status text
  (`data-testid="save-status"`, `aria-live="polite"`), and a **Save** button
  when autosave is off or the last save failed (disabled when already
  saved). Sync from ADO and Export PNG stay.
- **Guard**: react-router `useBlocker` (requires the data router:
  `main.tsx` moves from `<BrowserRouter>` to `createBrowserRouter` /
  `RouterProvider`; update `test/render.tsx` `renderAt` accordingly) plus a
  `beforeunload` listener while dirty. In the dialog, "Save" saves and then
  proceeds (it stays blocked and shows the error on failure), "Discard"
  proceeds, and "Cancel" stays.

## API contract (shared by backend and frontend)
Mounted at **`/api/plan`**. JSON in/out. Errors are always `{errors: [str]}`:
**422** validation, **404** unknown id, **503** DB unavailable.

```jsonc
// Common shapes
// PlanSummary (list item, no state)
{
  "id": 12,
  "name": "Proj – Feature Release Plan",
  "projectType": "onprem" | "cloud",
  "projectName": "Proj",
  "createdAt": "2026-11-03T10:15:00.123456Z",   // UTC ISO-8601
  "updatedAt": "2026-11-03T11:02:41.000001Z"
}
// PlanDetail = PlanSummary + { "state": { …ReleasePlan… } }

// GET /api/plan?page=1          → 200
{ "items": [PlanSummary, …], "total": 37, "page": 1, "pageSize": 10 }
//   ordered by updatedAt DESC, id DESC; page past the end → "items": []
//   422: page not an integer ≥ 1 → "Invalid request: query.page: …" (existing handler format)

// GET /api/plan/{id}            → 200 PlanDetail
//   404 → { "errors": ["Release plan not found: 12."] }
//   non-integer id → 422 (existing handler format)

// POST /api/plan                → 201 PlanDetail
{ "name": "…", "projectType": "onprem" | "cloud", "projectName": "…", "state": { … } }
//   422 cases:
//   - name empty after trim / > 200 chars → "Plan name is required." / "Plan name must be at most 200 characters."
//   - projectName empty after trim / > 200 chars → "Project name is required." / "Project name must be at most 200 characters."
//   - projectType not onprem|cloud → existing handler format
//   - state not an object or state.schema != "release-planner-features" → "Plan state is not a release plan."
//   - serialized state > 5 MiB → "Plan state is too large (max 5 MiB)."
//   (name/projectName are stored trimmed)

// PUT /api/plan/{id}            → 200 PlanDetail (updatedAt = now())
{ "name": "…", "state": { … } }
//   same name/state 422 rules as POST; extra keys (e.g. projectType) are ignored
//   404 → { "errors": ["Release plan not found: 12."] }

// DELETE /api/plan/{id}         → 204 (no body)
//   404 → { "errors": ["Release plan not found: 12."] }
```

## Phase 1: Database foundation and local/CI Postgres
Status: Not started

Agent: `backend-developer` (server + infra exception). No frontend work.

- [ ] Add `sqlalchemy[asyncio]>=2.0`, `asyncpg`, `alembic` to `src/server/requirements.txt`.
- [ ] Extend `Settings` in `app/config.py` with `db_host`, `db_port`, `db_name`, `db_user`, `db_password`, `db_migrate_on_startup`, `db_startup_timeout_seconds` (env names and defaults in *Implementation choices*), plus a `database_url()` helper using `URL.create`. Unit tests in `tests/test_config.py` (defaults, parsing, password escaping, `hide_password` rendering).
- [ ] Create `app/db.py`: a lazy async engine / `async_sessionmaker` from settings, a `get_session` dependency (yields an `AsyncSession`), and `dispose_engine()`.
- [ ] Create `app/models.py`: SQLAlchemy declarative `ReleasePlanRow` → table `release_plans` (`id` serial PK, `name` text NN, `created_at` / `updated_at` timestamptz NN default `now()`, `project_type` text NN, `project_name` text NN, `state` jsonb NN) plus an index on `(updated_at DESC, id DESC)`.
- [ ] Add Alembic: `src/server/alembic.ini`, `src/server/migrations/env.py` (URL from `Settings`, async-aware, `target_metadata` from `app.models`), first revision `create_release_plans`. Update `src/server/Dockerfile` to copy `alembic.ini` and `migrations/`.
- [ ] Add a FastAPI `lifespan` in `app/main.py`: when `db_migrate_on_startup`, retry connecting until `db_startup_timeout_seconds`, then run `alembic upgrade head` and dispose the engine on shutdown. Existing tests must still pass with no DB (they use `TestClient(app)` without a lifespan context; keep it that way, or make the lifespan a no-op when a test flag is set; document which).
- [ ] `docker-compose.yml`: add service `db` (`postgres:17`, env `POSTGRES_USER/PASSWORD/DB = planninghub`, healthcheck `pg_isready`, port `5432:5432` for local tests, an init script `deploy/db/init-test-db.sql` mounted to `/docker-entrypoint-initdb.d/` that creates `planninghub_test`). Add `DB_HOST=db`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` to `server`, and make `server` `depends_on: db: condition: service_healthy`. No named volumes.
- [ ] `tests/conftest.py`: add the `db_url` / migrated-schema / truncate / `db_client` fixtures (see *Implementation choices*) and a `db` pytest marker (registered in `pytest.ini`/`pyproject`). Add `tests/test_db_migrations.py`: the upgrade creates the table with the expected columns, types and defaults (query `information_schema`), and the downgrade drops it.
- [ ] `.github/workflows/deploy.yml`: add a `services: postgres` (`postgres:17`, user/password/db for `planninghub_test`, health options, port 5432) to the job and set `TEST_DATABASE_URL` on the "Test server" step.

### Verification Plan
- `python3 -m compileall -q src/server/app` → no output, exit 0.
- `python3 -m pytest src/server -q` **without** `TEST_DATABASE_URL` → all previously passing tests pass, and DB tests are reported as skipped.
- `docker compose up -d db` then `TEST_DATABASE_URL=postgresql+asyncpg://planninghub:planninghub@172.17.0.1:5432/planninghub_test python3 -m pytest src/server -q` → all pass, with 0 DB tests skipped.
- `docker compose up -d --build server db` → the server logs show the migration ran. `docker compose exec db psql -U planninghub -d planninghub -c '\d release_plans'` lists the 7 columns.
- `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint` → no errors.

### Phase Summary
_(write when phase completes)_

## Phase 2: Plan API (server) and client data layer
Status: Not started

Agents in parallel: `backend-developer` (server) and `frontend-developer`
(client data layer only, with no UI changes yet). Both get the API contract.

Backend:
- [ ] Add schemas to `app/schemas.py`: `PlanSummary`, `PlanDetail`, `PlanListResponse`, `PlanCreateRequest`, `PlanUpdateRequest` (camelCase aliases, `projectType: Literal["onprem","cloud"]`, `page: int ≥ 1`), with name/projectName/state validation producing the contract's exact messages.
- [ ] Implement `app/services/plans.py` (repository functions over `AsyncSession`; `update_plan` sets `updated_at = func.now()`; each function returns `None`/`False` for a missing id).
- [ ] Implement `app/api/plan_routes.py` (thin routes; 201 on POST, 204 on DELETE, 404 `{errors}` for a missing id, mapping of DB connection errors → 503 `{errors}`) and mount it in `app/main.py` at `/api/plan`.
- [ ] Unit tests: schema validation (every 422 message, trimming, the 5 MiB limit) without a DB; repository and route tests with a DB (`db` marker): CRUD, ordering by `updatedAt` after PUT, pagination (`total`, page past the end, 10 per page with 11 rows), 404s, a PUT that ignores `projectType`, `updatedAt` > `createdAt` after PUT, and the 503 mapping (override `get_session` with a session that raises `OperationalError`/`OSError`).

Frontend:
- [ ] Add `lib/releasePlan/planTypes.ts` (contract types) and `lib/releasePlan/planApi.ts` (`listPlans(page)`, `getPlan(id)`, `createPlan(req)`, `updatePlan(id, req)`, `deletePlan(id)`, all with `AbortSignal` support, throwing `ApiError` with the server's `errors` for 404/422/503 and handling 204). Add the needed GET/PUT/DELETE helpers next to `postJson`.
- [ ] Add `lib/releasePlan/autosavePreference.ts` (`loadAutosave(): boolean` default `true`, `saveAutosave(on)`, key `cmPlanningHub.releasePlan.autosave.v1`, try/catch like `sidebarPreference.ts`).
- [ ] Add `projectLabel(projectType, projectName)` → `"On Prem · X"` / `"Collaboration Hub · X"` (in `selectors.ts`).
- [ ] Unit tests for all of the above (mocked `fetch`).

### Verification Plan
- `python3 -m compileall -q src/server/app` → exit 0.
- With the compose `db` up and `TEST_DATABASE_URL` set: `python3 -m pytest src/server -q` → all pass, 0 skipped DB tests.
- `cd src/client && npm run build && npm test -- --run` → build ok, all tests pass.
- Smoke test against the running stack (`docker compose up -d --build`):
  `curl -s -XPOST 172.17.0.1:8080/api/plan -H 'content-type: application/json' -d '{"name":"T","projectType":"cloud","projectName":"P","state":{"schema":"release-planner-features"}}'` → 201 JSON with `id`. Then
  `curl -s 172.17.0.1:8080/api/plan` → `total ≥ 1`. `curl -s -o /dev/null -w '%{http_code}' -XDELETE 172.17.0.1:8080/api/plan/<id>` → `204`.

### Phase Summary
_(write when phase completes)_

## Phase 3: Plan list and create-with-name (client)
Status: Not started

Agent: `frontend-developer`.

- [ ] Rewrite `ReleasePlanHomePage`: remove the JSON card, the "Last board" section and `ReplaceBoardDialog` usage. Keep the "Create from Azure DevOps" card. Add `PlanList` below it.
- [ ] Implement `components/releasePlan/PlanList.tsx` + `DeletePlanDialog.tsx` per *Implementation choices* (columns, pager, loading/empty/error states, delete confirm → `deletePlan` → toast → refetch; go back one page when the page becomes empty; abort in-flight requests on unmount/page change).
- [ ] `AdoConnectModal` (`purpose="create"` only): add the required "Plan name" input (pre-filled after Connect with the default name, trimmed, 1–200 characters, inline error), and change the submit flow to backlog → `planFromBacklog` → name → `createPlan` → `onCreated(id, plan, warnings)`. POST errors show inline. Sync (`purpose="sync"`) is unchanged.
- [ ] Home page `onCreated`: `loadPlan(id, plan)`, navigate to `/release-plan/<id>`, toast "Plan created: <name>" + warnings.
- [ ] Delete `ImportJsonModal` (+ test) and the JSON-download parts of `exportFile.ts` (+ tests) that nothing uses any more. Keep `fileBase` if `useExportPng` uses it.
- [ ] Unit tests: `PlanList` (render rows/labels/dates, paging, empty, error + retry, delete confirm/cancel, last-item-on-page delete), `DeletePlanDialog`, `AdoConnectModal` name field (pre-fill, validation, POST error inline, success callback), home page wiring.

### Verification Plan
- `cd src/client && npm run build && npm test -- --run` → build ok, all tests pass.
- `grep -rn "ImportJsonModal\|Import a JSON file" src/client/src` → no matches.
- Server verification commands still pass (no server change expected; `git diff --stat src/server` is empty).

### Phase Summary
_(write when phase completes)_

## Phase 4: Board persistence — routing, autosave, save, unsaved guard (client)
Status: Not started

Agent: `frontend-developer`.

- [ ] Move to a data router (`createBrowserRouter` + `RouterProvider` in `main.tsx`/`App.tsx`), keeping every existing route. Change the board route to `/release-plan/:id`, and redirect `/release-plan/board` → `/release-plan`. Update `test/render.tsx` (`renderAt`) and the existing tests that navigate to `/release-plan/board`.
- [ ] Store (`releasePlanStore.tsx`): remove the localStorage storage, `restoredFromStorage` and `consumeRestoredNotice`. Add `planId`, `loadPlan(id, plan)` and `clearPlan()`. Delete `lib/releasePlan/storage.ts` (+ test) and `STORAGE_KEY` usage, except for a one-time `removeItem("cmPlanningHub.releasePlan.v1")` on provider mount.
- [ ] `ReleasePlanBoardPage`: load by `:id` (loading state; when the store already holds that id, e.g. right after create, skip the fetch), `normalizePlan`, the not-found/unreadable → toast + redirect handling, and clear the plan when leaving.
- [ ] `usePlanPersistence(planId, plan)` hook: a change counter, 3 s debounce when autosave is on, `saveNow()`, the status (`saved | dirty | saving | error`), last-write-wins PUT `{name, state}`, a stale-response guard, the 404 → toast + redirect, and abort on unmount. The first plan load is `saved` (not dirty).
- [ ] `BoardToolbar`: remove Load/Save Plan and their props. Add the Autosave switch (persisted via `autosavePreference`), the save status and the Save button rules. Remove the Load Plan modal / `ReplaceBoardDialog` / `planToJson` usage from `BoardWorkspace`. Delete `ReplaceBoardDialog` if it is now unused.
- [ ] `UnsavedChangesDialog` + `useBlocker` (when status ≠ `saved`) + a `beforeunload` listener while dirty (Save / Discard / Cancel per *Decisions*).
- [ ] Unit tests: hook (debounce timing with fake timers, coalescing several changes into one PUT, toggle off → no PUT, toggle on while dirty → PUT, failure → `error` + toast, stale response, 404), toolbar controls, board page load states, guard dialog (each button), `beforeunload` registered only while dirty, and that the old localStorage key is removed.
- [ ] Update/remove the now-obsolete integration tests that rely on JSON save/load or localStorage restore (`ReleasePlanSaveLoad.integration.test.tsx`, the parts of others). `qa-engineer` rewrites the integration coverage in QA.

### Verification Plan
- `cd src/client && npm run build && npm test -- --run` → build ok, all tests pass.
- `grep -rn "Save Plan\|Load Plan\|loadSavedPlan\|release-plan/board\"" src/client/src` → no matches (except the redirect route).
- With `docker compose up -d --build` (stack at `http://172.17.0.1:8080`): `curl -s 172.17.0.1:8080/release-plan/1` → 200 HTML (SPA fallback). Then create a plan via `curl` POST (as in Phase 2), PUT a renamed state, and `GET /api/plan` shows the new name first.
- QA (`qa-engineer`) adds integration tests with a mocked `fetch` for: create → board → change → autosave PUT after 3 s → reload route → same state; list paging + delete; autosave off → Save button → PUT; unsaved guard on sidebar navigation.

### Phase Summary
_(write when phase completes)_

## Phase 5: Helm chart, README and spec notes
Status: Not started

Agent: `backend-developer` (Helm, infra exception). The main session does
the README/spec edits after QA (docs). **Do not edit `AGENTS.md`.**

- [ ] `helm/chart/values.yaml`: add `postgres: {image: postgres:17, username: planninghub, password: "", database: planninghub}` (with a comment that the password must be set with `--set postgres.password=…`).
- [ ] `helm/chart/templates/cm-planning-hub-db-secret.yaml`: Secret `cm-planning-hub-db-secret` with keys `username` and `password`, where the password is `{{ required "postgres.password is required" .Values.postgres.password }}`.
- [ ] `cm-planning-hub-db-deployment.yaml`: 1 replica, `postgres:17`, env `POSTGRES_USER` / `POSTGRES_PASSWORD` from the Secret, `POSTGRES_DB`, `PGDATA=/var/lib/postgresql/data/pgdata`, an `emptyDir` mounted at `/var/lib/postgresql/data`, readiness/liveness `pg_isready` exec probes, and resource requests/limits. No PVC.
- [ ] `cm-planning-hub-db-service.yaml`: ClusterIP `cm-planning-hub-db-service`, port 5432.
- [ ] Server deployment: env `DB_HOST=cm-planning-hub-db-service`, `DB_PORT=5432`, `DB_NAME` (from values), and `DB_USER` / `DB_PASSWORD` via `secretKeyRef` to the Secret.
- [ ] Bump `tag` in `values.yaml` per the release convention only if the user asks (leave it otherwise).
- [ ] Main session: README — Release Plan section (saved plans list, autosave/save, no JSON), local dev (`docker compose up -d db`, DB env vars, `TEST_DATABASE_URL`), and deployment (`--set postgres.password`, the data loss on DB pod restart). Add a note to `specs/release_plan.md` that its JSON import/export requirements are superseded by `specs/release_plan_persistence`.

### Verification Plan
- `docker run --rm -v "$PWD/helm/chart":/chart alpine/helm template /chart --set postgres.password=x` → renders without errors and includes the db Deployment, Service and Secret, and the server env with `secretKeyRef`.
- The same command **without** `--set postgres.password` → fails with "postgres.password is required".
- Full verification commands pass (`compileall`, `pytest` with `TEST_DATABASE_URL`, client build + tests).
- `git diff --stat AGENTS.md` → empty.

### Phase Summary
_(write when phase completes)_

## Final Recap
_(write when all phases complete: summary of the entire piece of work)_

## Deployment Plan
_(write when all phases complete: step-by-step deployment instructions)_
