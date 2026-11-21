# OAuth Authentication (Google SSO) and per-user Azure DevOps PATs

Add Google OAuth/OIDC login to Planning Hub, show the signed-in user in the sidebar, let each user store Azure DevOps (ADO) Personal Access Tokens in a settings modal (encrypted at rest, never displayed), and prefill the creation modals from the stored PATs. Release Plan boards become owner-scoped.

## For Future Agents
As work proceeds: mark checkboxes `- [x]` as items complete; when a phase is done,
set its status to `Complete` and write its **Phase Summary** (what was done, key
decisions, anything needed to continue with zero context); run the phase's
**Verification Plan** and record the result before moving on. When all phases are
done, fill in **Final Recap** and **Deployment Plan**.

Follow `AGENTS.md` (Implementation section): per phase the main session
coordinates `backend-developer` and `frontend-developer` in parallel with the
API contract below, re-runs the verification commands itself, then runs
`qa-engineer`; max 3 Develop <-> QA cycles. Do not commit unless asked.

### Decisions agreed with the user
- Provider: Google (OIDC). Settings configurable via env; any verified Google account may sign in. Optional `AUTH_ALLOWED_EMAIL_DOMAINS` (empty = any).
- `/api/mcp` stays **unauthenticated** (known gap; MCP agents cannot do a browser login). Follow-up: per-user API tokens.
- Release Plan boards are **owner-scoped** (`release_plans.owner_id`). Rows with `owner_id IS NULL` (existing boards and boards created through MCP) are visible/editable to every signed-in user, since MCP has no user identity.
- Stored PATs: multiple per user, each with project name + project URL + PAT; matched to a modal by normalized project URL; encrypted at rest; the PAT is resolved server-side and never returned by the API.

### Security design (applies to all phases)
- Server-side authorization-code flow with PKCE, `state` and `nonce` (`authlib` Starlette client, Google OIDC discovery). Verify ID token signature, `iss`, `aud`, `exp`, `nonce` and `email_verified`.
- Routes under `/api/auth`: `GET /login`, `GET /callback`, `GET /me`, `POST /logout`. Redirect URI = `PUBLIC_BASE_URL` + `/api/auth/callback`.
- Session: Starlette `SessionMiddleware` (signed cookie, holds only `user_id`), `HttpOnly`, `SameSite=Lax`, `Secure` when `PUBLIC_BASE_URL` is https, bounded max-age; session cleared on login start and on logout.
- CSRF: `POST/PUT/DELETE` under `/api` require header `X-Requested-With: planning-hub` (client `request()` adds it), on top of SameSite=Lax.
- Env (all with defaults so existing `Settings(...)` calls in tests still work; secrets `repr=False`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `PAT_ENCRYPTION_KEY` (Fernet), `AUTH_ENABLED` (default true), `AUTH_ALLOWED_EMAIL_DOMAINS`, `SESSION_MAX_AGE_SECONDS`. With auth enabled, fail fast at startup when secrets are missing.
- PATs: Fernet-encrypted, never logged, never returned.
- uvicorn runs with `--proxy-headers --forwarded-allow-ips` (Dockerfile) so scheme/host are right behind nginx/OpenShift.
- Open paths: `/api/health`, `/api/auth/*`, `/api/mcp`. Everything else under `/api` requires a session (`Depends(require_user)`, 401 `{errors:[...]}`).

### API contract (errors are always `{errors:[str]}`)
- `GET /api/auth/login` -> 302 to Google. `GET /api/auth/callback` -> 302 to `/`; on failure 302 to `/login?error=<code>`.
- `GET /api/auth/me` -> 200 `{id, name, email, pictureUrl|null}`; 401 without session.
- `POST /api/auth/logout` -> 204.
- `GET /api/settings/ado-credentials` -> 200 `{items:[{id, projectName, projectUrl, hasPat}]}`.
- `POST /api/settings/ado-credentials` body `{projectName, projectUrl, pat}` -> 201 item. 422: empty name/URL/PAT, invalid URL or host not allowed (reuse `parse_project_url`), duplicate URL for the user.
- `PUT /api/settings/ado-credentials/{id}` body `{projectName, projectUrl, pat?}` (omitted `pat` keeps the stored one) -> 200 item; 404 if not owned.
- `DELETE /api/settings/ado-credentials/{id}` -> 204; 404 if not owned.
- `POST /api/ado/connect|backlog|sprint-history`: `pat` becomes optional; when absent the server uses the session user's stored PAT matching `projectUrl`; none found -> 422 with a "PAT required" message.

## Phase 1: OAuth login (backend + frontend)
Status: Complete   <!-- Not started | In progress | Complete -->

Backend (`backend-developer`):
- [x] Add `authlib`, `itsdangerous`, `cryptography` to `src/server/requirements.txt`.
- [x] Extend `Settings` in `src/server/app/config.py` with the auth env vars above (defaults, `repr=False` on secrets, parsing helpers like the existing ones) and a startup check for missing secrets when `AUTH_ENABLED`.
- [x] Add `User` model in `app/models.py` and migration `migrations/versions/0002_create_users.py` (`id`, `sub` unique, `email`, `name`, `picture_url`, `created_at`, `last_login_at`).
- [x] Add `app/services/auth.py` (OIDC client factory, user upsert by `sub`, allowed-domain check) and `app/api/auth_routes.py` (`login`, `callback`, `me`, `logout`).
- [x] Add `app/api/deps.py::require_user` and CSRF header check; apply to `routes`, `ado_routes`, `plan_routes` routers; keep `/api/health`, `/api/auth/*`, `/api/mcp` open.
- [x] Wire `SessionMiddleware` and the auth router in `app/main.py`; add `--proxy-headers --forwarded-allow-ips` to the Dockerfile CMD.
- [x] Unit tests with a faked OIDC client: state/nonce mismatch, unverified email, disallowed domain, 401 on protected route, health and MCP open, logout clears session, CSRF header required. `tests/conftest.py` `client` fixture overrides `require_user` so existing tests stay green; auth tests use a client without the override.

Frontend (`frontend-developer`):
- [x] Add `src/lib/auth/api.ts` (`getMe`, `logout` built on `getJson`/`postJson`) and `src/authStore.tsx` (`AuthProvider`, `useAuth`; states loading / anonymous / authenticated).
- [x] In `src/lib/monteCarlo/api.ts` `request()`: send `X-Requested-With: planning-hub` on non-GET calls and flag the auth store as anonymous on 401.
- [x] Add icons `src/components/icons/HandWaveIcon.tsx` (welcome) and `GoogleIcon.tsx` (multi-colour "G").
- [x] Add `src/pages/LoginPage.tsx` at `/login`: heading "CM Planning Hub", welcome icon, sentence "Estimate and plan your implementation projects", button "Login with SSO" that navigates to `/api/auth/login`; show a message for `?error=`.
- [x] `src/App.tsx`: guard layout route (redirect to `/login` when anonymous, spinner while loading) around existing routes, `/login` outside it (redirect to `/` when already signed in). `src/main.tsx`: `AuthProvider` inside `ToastProvider`.
- [x] `src/components/Sidebar.tsx` (+ `Layout.tsx` if needed): make the aside a full-height flex column and add a bottom footer (`mt-auto`) with avatar/initial, the user's name and a sign-out button, following the collapsed (`md:sr-only`) conventions.
- [x] Update `src/test/render.tsx` and `src/test/renderApp.tsx` (authenticated default user, `initialUser` option, `/login` stub, stubbed `/api/auth/me`); add tests for LoginPage, guard redirects, Sidebar footer, 401 handling; fix affected existing tests.

Infra / docs:
- [x] `docker-compose.yml`: add the auth env vars (dev placeholders via `${VAR}`); Helm `values.yaml` `auth` block and `cm-planning-hub-server-deployment.yaml` env using `secretKeyRef` (same pattern as `postgres.secret`); document the secret creation.
- [x] `README.md`: Google Cloud Console setup (OAuth client, redirect URIs `http://localhost:8080/api/auth/callback` and `https://<host>/api/auth/callback`), env vars, generating `SESSION_SECRET` and `PAT_ENCRYPTION_KEY`.
- [x] Add `specs/authentication.md`; add an "unauthenticated by design" note to `specs/mcp_server.md`.

### Verification Plan
- `python3 -m compileall -q src/server/app` succeeds; `python3 -m pytest src/server -q` all pass.
- `cd src/client && npm run build && npm test -- --run` all pass.
- Manual (`docker compose up --build` with a Google client): `/` redirects to `/login`; "Login with SSO" signs in; user name shows at the bottom of the sidebar; sign-out returns to `/login`; `curl -i localhost:8080/api/plan` returns 401 and `/api/health` returns 200.

### Phase Summary
Done 2026-11-21 via backend-developer + frontend-developer in parallel, then qa-engineer, then one fix round (QA's single Major). QA was not re-run in full after the fix; I re-ran all verification commands myself instead.

**Backend** (`src/server`): Google OIDC with authlib (PKCE S256, state, nonce, ID-token checks, `email_verified` must be exactly true, optional domain allowlist). Routes `/api/auth/{login,callback,me,logout}` in `app/api/auth_routes.py`; `app/api/deps.py` has `require_user` (401 `{errors}`) and `require_csrf` (403 without `X-Requested-With: planning-hub`), applied at `include_router` in `main.py`; `/health` moved to a `public_router`; MCP route untouched. Session = Starlette `SessionMiddleware` cookie holding only `user_id`. `users` table (`sub` unique, not `google_sub`) via migration `0002`, `upsert_user` is `INSERT .. ON CONFLICT (sub)`. New env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (>= 32 chars), `PAT_ENCRYPTION_KEY` (parsed, not yet required), `AUTH_ENABLED` (default true), `AUTH_ALLOWED_EMAIL_DOMAINS`, `SESSION_MAX_AGE_SECONDS` (28800). The lifespan fails fast when auth is on and Google id/secret, `SESSION_SECRET` or `PUBLIC_BASE_URL` is missing. The redirect URI is always `PUBLIC_BASE_URL` + `/api/auth/callback` (no request-derived fallback, so no Host-header influence). `AUTH_ENABLED=false` is environment-only. Tests set it in `tests/conftest.py`, which also overrides `require_user`/`require_csrf` on the global app; new auth tests use `create_app(settings)` without overrides.

**Frontend** (`src/client`): `authStore.tsx` (`AuthProvider` with `initialUser` prop for tests, `useAuth`), `lib/auth/{api,types,session}.ts` (`onUnauthorized` pub/sub so `request()` can flag anonymous on 401), CSRF header on all non-GET in `lib/monteCarlo/api.ts`, `pages/LoginPage.tsx` (all six backend error codes mapped), `RequireAuth` guard in `App.tsx`, sidebar footer (avatar, name, sign-out; Phase 2 adds the gear next to it). Test helpers `renderAt`/`renderApp` default to a signed-in `TEST_USER` (`initialUser: null` = anonymous); real `/me` flow is covered in `AppAuth.test.tsx`.

**Infra/docs**: `docker-compose.yml` (auth env via `.env`, see `.env.example`; `FORWARDED_ALLOW_IPS=*`), Helm `values.yaml` `auth` block + server deployment env (Secret `cm-planning-hub-auth-secret`, `FORWARDED_ALLOW_IPS=*`), README "Authentication" section, `specs/authentication.md`, note in `specs/mcp_server.md`. Dockerfile CMD only adds `--proxy-headers` (uvicorn reads `FORWARDED_ALLOW_IPS` itself).

**Verification results** (re-run by the coordinator): `compileall` ok; `pytest src/server -q` 1342 passed / 82 skipped (baseline 1244/79); client `npm run build` ok and 99 files / 1038 tests passed (baseline 94/987). Baseline needed environment workarounds on this machine: a Python 3.12 venv (repo `.venv` has no deps) and `NODE_OPTIONS=--no-experimental-webstorage` because Node 26 breaks jsdom localStorage (project targets Node 22). QA also ran the `db` tests against a throwaway `postgres:17` container: 1416 passed / 1 skipped. Helm template renders with the new env.

**Not done / open for later phases**: real Google login was never exercised (needs a Google OAuth client). Accepted minors (in `specs/authentication.md`): stateless logout with sliding expiry; `require_user` does not read the user row (add the existence check in Phase 3 when `owner_id` becomes an FK); board in localStorage survives sign-out (consider clearing it); 401 mid-session loses unsaved Monte Carlo input.

## Phase 2: Settings modal for ADO PATs (frontend)
Status: Complete

- [x] Add `src/components/icons/SettingsIcon.tsx` (gear) and a settings button in the sidebar footer.
- [x] Add `src/lib/settings/types.ts` and `src/lib/settings/api.ts` (list/create/update/delete per the contract, on top of `getJson/postJson/putJson/deleteRequest`).
- [x] Add `src/settingsStore.tsx` (credentials list loaded after login, refresh/add/update/remove) and mount it under `AuthProvider`.
- [x] Add `src/components/settings/SettingsModal.tsx` modeled on `components/ado/AdoConnectModal.tsx` with `useDialog`: list of entries (project name, URL, masked `••••••••` "PAT saved"), add/edit form with project name (free text), project URL (validated with `lib/ado/url.ts`) and PAT (`type="password"`, autocomplete off; on edit empty field with "leave blank to keep"), delete through `ConfirmDialog`. The PAT value is never rendered.
- [x] Tests (Vitest, fetch stubbed): modal open/close, validation errors, PAT never in the DOM as text, add/edit/delete call the right endpoints, toast on error.

### Verification Plan
- `cd src/client && npm run build && npm test -- --run` pass, including the new SettingsModal and store tests.
- Manual with a stubbed or real backend: gear icon opens the modal; saved entries show only the masked PAT.

### Phase Summary
Done 2026-11-21: frontend-developer, then qa-engineer (PASS, no Blocker/Major; minors left open, listed below). Backend untouched, so the server suite is unchanged (1342 passed / 82 skipped).

**What exists** (`src/client/src`): `components/icons/SettingsIcon.tsx`; `components/settings/SettingsButton.tsx` (gear in the sidebar footer, owns the open state, stacks under the avatar when the sidebar is collapsed) and `SettingsModal.tsx` (portal, `useDialog`, `z-50`, `ConfirmDialog` at `z-[60]` on top; loading/error+Retry/empty/list states; entries show project name, URL and a masked "PAT saved" only; add/edit form with name, URL, PAT `type=password` + autofill opt-outs; blank PAT on edit omits the `pat` key; PAT state cleared on save/Cancel/close); `lib/settings/{types,api}.ts` (contract in the plan, PAT only in request bodies); `settingsStore.tsx` (`SettingsProvider`/`useSettings`: `items`, `status` idle|loading|ready|error, `load`, `ensureLoaded`, `add`, `update`, `remove`).

**Decisions**: the store does NOT fetch on mount or login (existing tests assert `fetchMock.mock.calls[0]`); it loads lazily via `ensureLoaded()`, which Phase 4 must call when a modal needs the list (`items[].projectUrl` / `hasPat` are the match keys). It resets on sign-out or user change, with a generation counter dropping stale list responses. Client URL check accepts the cloud or on-prem shape of `lib/ado/url.ts` (the stored credential has no `source`); the server (`parse_project_url` + host allowlist) is authoritative. Test helpers `renderAt`/`renderApp`/`SignedIn` take `initialCredentials`/`credentials`.

**Verification (re-run by the coordinator)**: `npm run build` ok; client 104 files / 1085 tests pass (baseline 99/1038; with `NODE_OPTIONS=--no-experimental-webstorage` on this Node 26 machine). QA added `SettingsFlow.integration.test.tsx` and `SettingsUserSwitch.integration.test.tsx` (PAT never in DOM/toasts/URLs/storage, CSRF header, lazy load, Esc stacking, 401 -> /login, user switch). Not tested against a real backend: Phase 3 endpoints do not exist yet, so in the real app the modal shows an error toast until then.

**Open minors / notes for Phase 3 and 4**
- `settingsStore.add/update/remove` are not guarded by the generation counter: a sign-out mid-save could add the previous user's entry to the next user's list (narrow window).
- Editing the project URL with a blank PAT keeps the PAT stored for the old URL. Phase 3 decision: require `pat` when `projectUrl` changes (422), or document it.
- Phase 3 duplicate check on `(user_id, project_url)` must compare the canonical URL from `parse_project_url` (trailing slash, case), not the raw string, or `.../Alpha` and `.../Alpha/` count as different projects.
- A 401 on the settings list also shows a "Could not load settings" toast while redirecting to `/login` (cosmetic).

## Phase 3: Backend storage of PATs and plan ownership
Status: Complete

- [x] Migration `0003`: `ado_credentials` (`id`, `user_id` FK cascade, `project_name`, `project_url`, `pat_encrypted`, `created_at`, `updated_at`, unique `(user_id, project_url)`) and nullable indexed `release_plans.owner_id` FK to `users`; update `app/models.py`.
- [x] `app/services/credentials.py`: Fernet encrypt/decrypt, CRUD scoped to the user, lookup by normalized project URL.
- [x] `app/schemas.py` models and `app/api/settings_routes.py` implementing the contract (responses never contain the PAT); reuse `parse_project_url` for URL/host validation; mount in `main.py` behind `require_user`.
- [x] `app/services/plans.py`: every function takes the owner; visible = `owner_id == user OR owner_id IS NULL`; create sets the owner; update/delete enforce visibility (404 otherwise). MCP tools keep working through the unowned (`NULL`) path.
- [x] `app/api/ado_routes.py`, `app/schemas.py`, `app/services/ado_http.py::ado_client`, and the `connection_field_errors` check in `ado_url.py`: make `pat` optional and fall back to the stored PAT for the session user; update the MCP `ado_fetch_backlog` wording only if behaviour changes (it should not).
- [x] Unit tests: encryption round trip, ciphertext differs from plaintext, PAT absent from responses and logs, ownership 404s, duplicate URL 422, plan scoping, ADO fallback to stored PAT. Add the new tables to `clean_db` truncation in `tests/conftest.py`; QA adds Postgres integration tests (`db` marker).

### Verification Plan
- `python3 -m compileall -q src/server/app && python3 -m pytest src/server -q` pass.
- With `TEST_DATABASE_URL` set: `python3 -m pytest src/server -q -m db` passes (migrations `0002`/`0003` apply from scratch).
- Manual: save a PAT, then `SELECT pat_encrypted FROM ado_credentials` shows ciphertext; a second user cannot see or load the first user's boards or PATs.

### Phase Summary
Backend only. New: migration `0003` (`ado_credentials`, `release_plans.owner_id` nullable FK, ON DELETE SET NULL so a deleted user's boards become shared), `services/credentials.py` (Fernet, user-scoped CRUD, `find_pat`), `api/settings_routes.py`, `require_user` now checks the user row (401 + session cleared), owner-scoped plans (`owner_id=None` = unscoped: MCP and auth-disabled paths), `pat` optional on `/api/ado/*` with stored-PAT fallback (explicit PAT wins; MCP still requires it). `PAT_ENCRYPTION_KEY` is now required at startup when auth is enabled (compose, Helm secret key `patEncryptionKey`, README, `.env.example` updated; existing deployments must add it before upgrading).

Decisions: URLs are stored in canonical form (cloud parse first, then on-prem); duplicates/lookups compare `lower(project_url)`; PUT with a changed canonical URL requires a new `pat` (422); foreign ids give 404; no signed-in user -> settings routes 409; missing key 503; unreadable stored PAT 422.

Verification (coordinator): compileall ok; pytest 1467 passed / 82 skipped (baseline 1342). QA with real Postgres 17: `-m db` 108 passed; migration 0003 up/down verified; QA added `test_multiuser_integration.py` (27 tests: isolation, ADO fallback, no PAT leakage, MCP unaffected) and fixed a stale column test in `test_db_migrations.py`. Iterations: 1 Develop, 1 QA, no fix cycle.

Open minors: every protected route (incl. /validate, /simulate) now needs the DB; case-sensitive DB unique constraint vs lower() check (race; a functional unique index on `(user_id, lower(project_url))` would close it); a non-string `pat` in PUT is treated as "keep"; full-suite run with `TEST_DATABASE_URL` has one order-dependent failure in `test_lifespan_migrates_empty_schema_to_head_and_is_idempotent` (passes alone); Helm template not rendered; Phase 2 UI should surface the 422 on URL change without PAT.


## Phase 4: Project pickers backed by stored PATs
Status: Complete (delivered differently from the original design; see Phase Summary)

Original design (superseded by decision, 2026-11-21): prefill the PAT field when the URL matches a stored credential, allow a one-off override, and show a "Save PAT to my settings" button. The user decided instead that the SPA never holds a PAT: projects are registered once in Settings and every Azure DevOps flow selects one.

- [x] Make `pat` optional in the client request types (`lib/ado/types.ts`; flows to `AdoScopedRequest`, sprint-history and backlog requests); remove the PAT check from the connect form validation.
- [x] `components/ado/AdoConnectModal.tsx` (Release Plan create, Monte Carlo load): source radios, URL and PAT inputs replaced by a "Project" select fed by `settingsStore` (`ensureLoaded`, loading/error+Retry, empty state with "Open settings"); the request sends `{source: sourceOf(url), projectUrl}` with no `pat`; last connected project remembered; server 422 shown inline with a hint/button to open Settings.
- [x] `components/releasePlan/AdoSyncModal.tsx`: PAT field removed; the plan's stored project URL is matched (`sameProjectUrl`: case-insensitive, trailing slash ignored) to a Settings project; shows "Using the saved Personal Access Token of <name>" or "No saved Personal Access Token for this project." + "Open settings"; request omits `pat`.
- [x] Settings modal polish: icon-only Add/Edit/Delete (Delete red, inverts on hover), text Retry/Save/Cancel/Close, On-Prem/Collaboration Hub radios (placeholder only, not stored; source inferred on edit), PAT shown only as dots + last 4 (`patLast4`, new server field; null when the PAT is shorter than 8 characters or unreadable).
- [x] `settingsStore` exposes `settingsOpen/openSettings/closeSettings`; `SettingsButton` renders the modal from it so other modals can open Settings on top.
- [x] Copy/specs: Monte Carlo `HelpModal`, `specs/release_plan.md`, `specs/authentication.md`, `AGENTS.md`, stale "PAT never persisted" comments.
- [x] Tests rewritten/added (connect modal, sprint-history modal, sync modal, settings modal/button/store, `sourceOf`/`sameProjectUrl`); `AdoSourceSwitch.integration.test.tsx` deleted (the source switch no longer exists).

### Verification Plan
- `cd src/client && npm run build && npm test -- --run` pass; `python3 -m pytest src/server -q` passes.
- Manual: with a saved project, Release Plan "create from ADO", Monte Carlo "load from ADO" and "Sync from ADO" work without typing a PAT; with none saved, the modals show "Open settings".

### Phase Summary
See Final Recap for decisions. The "Save PAT to my settings" button of the original design was dropped because the modals no longer have a PAT field. The REST `pat` field remains optional and wins when present (tests, API clients); the MCP tools still require it.

## Final Recap
Google SSO now protects the hub, and each user keeps their own Azure DevOps projects and PATs.

- **Phase 1 (login):** server-side OIDC code flow with PKCE/state/nonce, signed session cookie (user id only), CSRF header on state-changing requests, `require_user` on every `/api` route except `/api/health`, `/api/auth/*` and `/api/mcp`; login page, route guard, user name and sign-out in the sidebar footer.
- **Phase 2 (settings UI):** gear button opens a Settings modal to add/edit/delete projects (name, URL, PAT never shown; only dots + last 4 characters).
- **Phase 3 (storage):** `ado_credentials` table with Fernet-encrypted PATs, `/api/settings/ado-credentials`, owner-scoped Release Plan boards (`owner_id`, NULL = shared/MCP), `require_user` checks the user row, `/api/ado/*` falls back to the user's stored PAT.
- **Phase 4 (pickers):** the connect (Release Plan, Monte Carlo) and Sync modals no longer take a URL or PAT: users pick a configured project (Sync matches the plan's URL). No one-off PAT override (decision by the user).
- **Verification at the end:** `pytest src/server` 1472 passed / 113 skipped; with real Postgres 17 (`TEST_DATABASE_URL`) 1584 passed; client build ok, 105 files / 1109 tests. QA passed every phase (one Develop <-> QA cycle each, no Blocker/Major left).
- **Never exercised:** a real Google login (needs an OAuth client), the full docker compose stack, `helm template` rendering.

Open minors: stateless logout (cookie valid until expiry); `/api/mcp` unauthenticated by design; board in localStorage survives sign-out; 401 mid-session loses unsaved Monte Carlo input; every protected route (incl. `/validate`, `/simulate`) needs the database; DB unique constraint on credentials is case-sensitive while the app check is case-insensitive (concurrent-create race; a unique index on `(user_id, lower(project_url))` would close it); a non-string `pat` in PUT is treated as "keep"; client URL matching in Sync only trims/lower-cases/strips trailing slashes (the server also drops `/_...` suffixes, query and fragment); Helm DB is `emptyDir`.

## Deployment Plan
1. **Google Cloud Console:** create an OAuth 2.0 Web client; authorized redirect URIs `https://<host>/api/auth/callback` (and `http://localhost:8080/api/auth/callback` for local use).
2. **Secret** `cm-planning-hub-auth-secret` in the `cm-planning-hub` namespace with keys for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` (>= 32 random chars), `PAT_ENCRYPTION_KEY` (Fernet key: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`). Existing deployments must add `patEncryptionKey` before upgrading or the server will not start. Key names follow `auth.secret.*` in `helm/chart/values.yaml`.
3. **Values:** set `PUBLIC_BASE_URL` to the public https URL (cookies become `Secure`, redirect URI is derived from it); optionally `AUTH_ALLOWED_EMAIL_DOMAINS`. `FORWARDED_ALLOW_IPS` is set by compose/Helm so uvicorn trusts the proxy headers.
4. **Deploy** with the manual Deploy workflow. Migrations `0002` (users) and `0003` (credentials, `owner_id`) run at server startup (`DB_MIGRATE_ON_STARTUP`); the chart runs one replica, so there is no race. Existing boards keep `owner_id` NULL and stay visible to all users.
5. **Smoke test:** open the site -> redirected to `/login`; sign in; name appears in the sidebar; add a project in Settings; create a Release Plan from ADO without typing a PAT; `/api/plan` answers 401 without cookie; `/api/mcp` still answers.
6. **Persistence warning:** the Helm DB uses `emptyDir`; users and stored PATs are lost on DB pod restart until a PVC is added. Rotating `PAT_ENCRYPTION_KEY` invalidates stored PATs (users must re-enter them; consider `MultiFernet` later).

