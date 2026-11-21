# Authentication (Google SSO)

## Goal
Only signed-in users can use the hub. Sign-in is Google OpenID Connect; the
server runs the flow and keeps a signed session cookie.

## Behaviour
- **Login page** (`/login`, public): heading "CM Planning Hub" with the Critical
  Manufacturing square mark (`/cmlogo-mark.png`, on a white tile) above it, the sentence "Estimate and plan your implementation projects" and a
  "Login with SSO" button that navigates to `/api/auth/login`. `?error=<code>`
  shows a message. A signed-in user is redirected to `/`.
- **Guard**: every other route requires a session. While `/api/auth/me` is
  pending a spinner is shown; anonymous users go to `/login`; a 401 from any
  API call mid-session also sends the user to `/login`.
- **Sidebar footer**: avatar (picture or initial), the user's name and a
  "Sign out" button at the bottom of the left panel. When the sidebar is
  collapsed the name stays available as tooltip / screen-reader text.

## Server contract
- `GET /api/auth/login` -> 302 to Google (PKCE S256, `state`, `nonce`).
- `GET /api/auth/callback` -> 302 to `/`; failure -> 302 to `/login?error=<code>`
  with `state_mismatch`, `access_denied`, `email_not_verified`,
  `domain_not_allowed`, `invalid_claims` or `login_failed`.
- `GET /api/auth/me` -> `{id, name, email, pictureUrl|null}`; 401 `{errors:[str]}` without session.
- `POST /api/auth/logout` -> 204.
- ID token: signature, `iss`, `aud`, `exp`, `nonce` verified; `email_verified` must be `true`;
  optional e-mail domain allowlist (`AUTH_ALLOWED_EMAIL_DOMAINS`).
- Session cookie: signed, holds only `user_id`, HttpOnly, SameSite=Lax, `Secure`
  over https, cleared at login start, on failure and on logout.
- CSRF: POST/PUT/PATCH/DELETE need header `X-Requested-With: planning-hub`
  (403 otherwise); the client adds it to every non-GET request.
- Open paths: `/api/health`, `/api/auth/*`, `/api/mcp`. Everything else under
  `/api` answers 401 `{errors:["Authentication required."]}` without a session.
- `AUTH_ENABLED=false` (environment only) disables enforcement for development and tests.
- `require_user` also reads the user row (one primary-key lookup): a session whose
  user no longer exists is cleared and answers 401.

## Saved Azure DevOps credentials
Each user can save a Personal Access Token per project. The PAT is Fernet-encrypted
with `PAT_ENCRYPTION_KEY` (required at startup when authentication is enabled; it
must be a valid Fernet key) in `ado_credentials` (`user_id`, `project_name`,
`project_url`, `pat_encrypted`, unique `(user_id, project_url)`; deleted with the
user). It is never returned, logged or put in an error message; rotating the key
makes saved PATs unreadable (they must be entered again). The only part of a PAT the
API shows is `patLast4`, its last 4 characters, so users can tell their tokens apart;
it is `null` when the PAT is shorter than 8 characters, or when it cannot be decrypted
(unusable or rotated key) - one unreadable item never fails the list.

- `project_url` is stored and returned in canonical form (the one `parse_project_url`
  produces: https, lower-case host, no trailing slash, query or fragment). The
  server stores no source: the Collaboration Hub shape is tried first, then On-Prem.
  (The Settings form's On-Prem / Collaboration Hub radios only change the URL
  placeholder; on edit the radio is inferred from the host.) Credentials are matched and checked for duplicates case-insensitively
  (`.../Alpha`, `.../alpha/` are one project).
- `GET /api/settings/ado-credentials` -> `{items:[{id, projectName, projectUrl, hasPat:true, patLast4}]}`
  (`patLast4`: string or null).
- `POST` body `{projectName, projectUrl, pat}` -> 201 item (same shape, with `patLast4`). 422 `{errors}` for an empty
  name/URL/PAT, an invalid URL or a host outside `ADO_ALLOWED_HOSTS`, and a project URL
  the user already saved. 503 when the server's encryption key is unusable.
- `PUT /{id}` body `{projectName, projectUrl, pat?}` -> 200 item (with `patLast4` of the current PAT). An omitted or blank
  `pat` keeps the stored one, except when the canonical URL changes: then `pat` is
  required (422), so a PAT is never silently moved to another project.
- `DELETE /{id}` -> 204.
- A credential that is not the user's answers 404 like an unknown id. With
  `AUTH_ENABLED=false` there is no user and these routes answer 409.
- `POST /api/ado/connect|backlog|sprint-history`: `pat` is optional. A PAT in the
  request always wins; otherwise the user's saved PAT for the canonical project URL
  is used; with none (or no user) the answer is 422 "A Personal Access Token is
  required...". A saved PAT that no longer decrypts is a 422 asking to enter it again.
  The MCP tools still require `pat` explicitly (no session there).
  The client's "Create from Azure DevOps" (Release Plan) and "Load from Azure DevOps"
  (Monte Carlo) modals let the user pick one of the saved projects and never send a
  `pat`; the Release Plan "Sync from Azure DevOps" dialog does not ask for a PAT
  either (it shows a read-only field with the redacted PAT, dots plus the last 4): it matches the plan's project URL (case-insensitive, trailing slash ignored)
  against the Settings projects and sends no `pat`. There is no one-off PAT override:
  users register projects in Settings.

## Settings modal (sidebar gear)
- Lists the user's projects: name, URL and the masked PAT (dots plus `patLast4`; the
  PAT itself is never rendered, logged or stored by the client). Add / Edit / Delete are
  icon-only buttons with accessible names (Delete is red and inverts on hover);
  Retry / Save / Cancel / Close are text buttons. Delete asks for confirmation.
- The form has project name, the source radios (placeholder only), project URL and a
  password-type PAT field (required on add; blank on edit keeps the saved one unless the
  URL changes). Server 422s are shown as a toast.
- Opened from the connect / sync dialogs ("Open settings"), it stacks above them: Esc
  closes only the topmost dialog.

## Release Plan ownership
`release_plans.owner_id` references the user (`ON DELETE SET NULL`, so deleting a
user keeps their boards, which become unowned). A user sees, reads, edits and
deletes their own boards and the unowned ones (`owner_id IS NULL`: boards created
before users existed or through MCP); another user's board answers 404. New boards
created through the REST API belong to the session user. MCP has no identity: it
lists/reads/updates every board and creates unowned ones. Editing never changes the
owner.

## Known limitations (accepted)
- Logout is stateless: a copied cookie stays valid until it expires, and the
  expiry slides while it is used. A per-user session version would fix it.
- `/api/mcp` is unauthenticated by design (see `specs/mcp_server.md`).
- The Release Plan board in localStorage survives sign-out in the same browser.
