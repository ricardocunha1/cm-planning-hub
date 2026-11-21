import { Navigate, Outlet, type RouteObject } from "react-router-dom";
import { useAuth } from "./authStore";
import { LoginPage } from "./pages/LoginPage";
import { ScrollToTop } from "./components/ScrollToTop";
import { ConfirmPage } from "./pages/monteCarlo/ConfirmPage";
import { DataSourcePage } from "./pages/monteCarlo/DataSourcePage";
import { HubHomePage } from "./pages/HubHomePage";
import { InputPage } from "./pages/monteCarlo/InputPage";
import { ReleasePlanBoardPage } from "./pages/ReleasePlanBoardPage";
import { ReleasePlanHomePage } from "./pages/ReleasePlanHomePage";
import { ResultsPage } from "./pages/monteCarlo/ResultsPage";
import { ReleasePlanProvider } from "./releasePlanStore";

/**
 * Root layout: mounts the `ReleasePlanProvider` (in-memory board state) and
 * `ScrollToTop` around the matched route.
 */
export function App() {
  return (
    <ReleasePlanProvider>
      <ScrollToTop />
      <Outlet />
    </ReleasePlanProvider>
  );
}

/**
 * Route guard: renders the matched child routes only for a signed-in user. Shows
 * a spinner while the session is being checked and redirects to `/login` when anonymous.
 */
export function RequireAuth() {
  const { status } = useAuth();
  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center" role="status" aria-label="Checking your session">
        <span className="h-8 w-8 animate-spin rounded-full border-4 border-line border-t-[color:var(--cm-light-blue)]" aria-hidden="true" />
      </div>
    );
  }
  if (status === "anonymous") {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

/** `/login`: the login page, or a redirect home when already signed in (spinner while checking). */
function LoginRoute() {
  const { status } = useAuth();
  if (status === "authenticated") {
    return <Navigate to="/" replace />;
  }
  return status === "loading" ? <RequireAuth /> : <LoginPage />;
}

/**
 * Route table (data router; `main.tsx` passes it to `createBrowserRouter`, which
 * the unsaved-changes guard's `useBlocker` needs): hub home at `/`, the Monte
 * Carlo flow under `/monte-carlo` (data source choice at `/monte-carlo`,
 * parameters form at `/monte-carlo/input`, then `/confirm` and `/results`),
 * Release Plan under `/release-plan` (the plan list, and the board at
 * `/release-plan/:id`; the old `/release-plan/board` redirects to the list),
 * anything else redirects home. Everything renders inside {@link App}; all but
 * `/login` sits behind {@link RequireAuth} (anonymous visitors are sent to `/login`).
 */
export const appRoutes: RouteObject[] = [
  {
    element: <App />,
    children: [
      { path: "/login", element: <LoginRoute /> },
      {
        element: <RequireAuth />,
        children: [
          { path: "/", element: <HubHomePage /> },
          { path: "/monte-carlo", element: <DataSourcePage /> },
          { path: "/monte-carlo/input", element: <InputPage /> },
          { path: "/monte-carlo/confirm", element: <ConfirmPage /> },
          { path: "/monte-carlo/results", element: <ResultsPage /> },
          { path: "/release-plan", element: <ReleasePlanHomePage /> },
          { path: "/release-plan/board", element: <Navigate to="/release-plan" replace /> },
          { path: "/release-plan/:id", element: <ReleasePlanBoardPage /> },
          { path: "*", element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
];
