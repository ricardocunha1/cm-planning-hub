import { getJson, postJson } from "../ado/api";
import type { AuthUser } from "./types";

/** Where the browser goes (full-page navigation) to start the Google sign-in. */
export const LOGIN_URL = "/api/auth/login";

/**
 * GET /api/auth/me: the user of the current session.
 * @throws ApiError with status 401 when there is no session.
 */
export function getMe(signal?: AbortSignal): Promise<AuthUser> {
  return getJson<AuthUser>("/api/auth/me", signal);
}

/** POST /api/auth/logout: ends the session (204). */
export function logout(): Promise<void> {
  return postJson<void>("/api/auth/logout", {});
}
