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

## Known limitations (accepted)
- Logout is stateless: a copied cookie stays valid until it expires, and the
  expiry slides while it is used. A per-user session version would fix it.
- `require_user` does not read the user row; a deleted user keeps access until
  the cookie expires (revisit when plans become owner-scoped).
- `/api/mcp` is unauthenticated by design (see `specs/mcp_server.md`).
- The Release Plan board in localStorage survives sign-out in the same browser.
