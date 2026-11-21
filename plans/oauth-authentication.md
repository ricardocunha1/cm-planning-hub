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
Status: Not started

- [ ] Migration `0003`: `ado_credentials` (`id`, `user_id` FK cascade, `project_name`, `project_url`, `pat_encrypted`, `created_at`, `updated_at`, unique `(user_id, project_url)`) and nullable indexed `release_plans.owner_id` FK to `users`; update `app/models.py`.
- [ ] `app/services/credentials.py`: Fernet encrypt/decrypt, CRUD scoped to the user, lookup by normalized project URL.
- [ ] `app/schemas.py` models and `app/api/settings_routes.py` implementing the contract (responses never contain the PAT); reuse `parse_project_url` for URL/host validation; mount in `main.py` behind `require_user`.
- [ ] `app/services/plans.py`: every function takes the owner; visible = `owner_id == user OR owner_id IS NULL`; create sets the owner; update/delete enforce visibility (404 otherwise). MCP tools keep working through the unowned (`NULL`) path.
- [ ] `app/api/ado_routes.py`, `app/schemas.py`, `app/services/ado_http.py::ado_client`, and the `connection_field_errors` check in `ado_url.py`: make `pat` optional and fall back to the stored PAT for the session user; update the MCP `ado_fetch_backlog` wording only if behaviour changes (it should not).
- [ ] Unit tests: encryption round trip, ciphertext differs from plaintext, PAT absent from responses and logs, ownership 404s, duplicate URL 422, plan scoping, ADO fallback to stored PAT. Add the new tables to `clean_db` truncation in `tests/conftest.py`; QA adds Postgres integration tests (`db` marker).

### Verification Plan
- `python3 -m compileall -q src/server/app && python3 -m pytest src/server -q` pass.
- With `TEST_DATABASE_URL` set: `python3 -m pytest src/server -q -m db` passes (migrations `0002`/`0003` apply from scratch).
- Manual: save a PAT, then `SELECT pat_encrypted FROM ado_credentials` shows ciphertext; a second user cannot see or load the first user's boards or PATs.

### Phase Summary
_(write when phase completes)_

## Phase 4: Prefill creation modals from stored PATs
Status: Not started

- [ ] Make `pat` optional in the client request types (`lib/ado/api.ts`, `lib/releasePlan/adoApi.ts`, `lib/monteCarlo/api.ts`) and in `connectionErrors` (`lib/ado/url.ts`) when a stored credential applies.
- [ ] `src/components/ado/AdoConnectModal.tsx`: when the project URL matches a stored credential (from `settingsStore`), show a masked "Using saved PAT (<project name>)" state and omit `pat` from the request; typing a PAT overrides it. Update help text (no longer "never stored").
- [ ] Same behaviour in `src/components/releasePlan/AdoSyncModal.tsx` (`SyncForm`).
- [ ] When no stored credential matches and the user typed a PAT, show a "Save PAT to my settings" button that creates the credential (project name defaulted from the modal's name field or the URL), refreshes the store and shows a toast.
- [ ] Update the matching copy and tests in `monteCarlo/HelpModal.tsx` and any test asserting "never stored"; add tests: prefill on URL match, override, save button only when unmatched with typed PAT, request body has no `pat` when using a saved one.

### Verification Plan
- `cd src/client && npm run build && npm test -- --run` pass; `python3 -m pytest src/server -q` still passes.
- Manual: with a saved PAT, Release Plan "create from ADO" and Monte Carlo "load from ADO" connect without typing a PAT; with none saved, entering a PAT shows "Save PAT to my settings" and saving it makes the next open prefilled.

### Phase Summary
_(write when phase completes)_

## Final Recap
_(write when all phases complete: summary of the entire piece of work)_

## Deployment Plan
_(write when all phases complete: step-by-step deployment instructions)_

### Notes for the Deployment Plan (known facts, to be completed)
- Needs a Google OAuth client with the production redirect URI and a Kubernetes/OpenShift Secret holding `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `PAT_ENCRYPTION_KEY`.
- The Helm DB uses `emptyDir`: users and stored PATs are lost on DB pod restart until a PVC is added.
- Startup migrations run in the server (`DB_MIGRATE_ON_STARTUP`); the chart runs one replica, so there is no migration race.
- Rotating `PAT_ENCRYPTION_KEY` invalidates stored PATs (consider `MultiFernet` later).
