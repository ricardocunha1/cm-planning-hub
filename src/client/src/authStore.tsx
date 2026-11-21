import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useToast } from "./components/Toast";
import { getMe, logout } from "./lib/auth/api";
import { onUnauthorized } from "./lib/auth/session";
import type { AuthUser } from "./lib/auth/types";
import { ApiError } from "./lib/monteCarlo/api";

/** `loading` until `/api/auth/me` answers; then `anonymous` (no session) or `authenticated`. */
export type AuthStatus = "loading" | "anonymous" | "authenticated";

/** Value of {@link useAuth}. */
export interface AuthState {
  status: AuthStatus;
  /** The signed-in user; `null` unless `status` is `authenticated`. */
  user: AuthUser | null;
  /** Ends the session on the server and flags the app as anonymous (an error toast if the server call fails). */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Holds the session state above the routes. On mount it asks `GET /api/auth/me`
 * (401 = anonymous); any later 401 from the API client (expired session) flips
 * it to anonymous, which makes the route guard redirect to `/login`.
 * `initialUser` skips the initial request (tests): a user = authenticated, `null` = anonymous.
 */
export function AuthProvider({ children, initialUser }: { children: ReactNode; initialUser?: AuthUser | null }) {
  const { showError } = useToast();
  const [user, setUser] = useState<AuthUser | null>(initialUser ?? null);
  const [resolved, setResolved] = useState(initialUser !== undefined);

  useEffect(() => {
    if (initialUser !== undefined) {
      return;
    }
    const controller = new AbortController();
    getMe(controller.signal)
      .then((me) => {
        setUser(me);
        setResolved(true);
      })
      .catch((exc: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        // Any failure (401 or the server being down) leaves the user on the login page.
        if (!(exc instanceof ApiError)) {
          console.error(exc);
        }
        setUser(null);
        setResolved(true);
      });
    return () => controller.abort();
  }, [initialUser]);

  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setResolved(true);
      }),
    [],
  );

  const signOut = useCallback(async () => {
    try {
      await logout();
      setUser(null);
      setResolved(true);
    } catch (exc) {
      if (exc instanceof ApiError && exc.status === 401) {
        return; // already signed out; the 401 handler took care of the state
      }
      showError(exc instanceof ApiError ? exc.errors : ["Could not sign out."], "Could not sign out");
    }
  }, [showError]);

  const value = useMemo<AuthState>(
    () => ({ status: !resolved ? "loading" : user ? "authenticated" : "anonymous", user, signOut }),
    [resolved, user, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The auth state; must be used inside {@link AuthProvider}. */
export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside an AuthProvider");
  }
  return value;
}
