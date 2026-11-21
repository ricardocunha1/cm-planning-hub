import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { appRoutes } from "../App";
import { AuthProvider } from "../authStore";
import { ToastProvider } from "../components/Toast";
import type { AuthUser } from "../lib/auth/types";
import type { AdoCredential } from "../lib/settings/types";
import { ForecastProvider } from "../monteCarloStore";
import { SettingsProvider } from "../settingsStore";
import { TEST_USER } from "./authFixtures";
import { ProbeLayout } from "./render";

/** Renders the real app routes in a memory data router at `path`, with a `data-testid="location"` probe.
 * Signed in as `TEST_USER` by default; `initialUser: null` renders an anonymous visitor. No `/api/auth/me`
 * request is made (the user is given to the auth store directly), so tests' `fetch` mocks see only their own calls. */
export function renderApp(path = "/", {
    initialUser = TEST_USER,
    initialCredentials,
  }: { initialUser?: AuthUser | null; initialCredentials?: AdoCredential[] } = {},) {
  const router = createMemoryRouter([{ element: <ProbeLayout />, children: appRoutes }], { initialEntries: [path] });
  return render(
    <ToastProvider>
      <AuthProvider initialUser={initialUser}>
        <SettingsProvider initialItems={initialCredentials}>
          <ForecastProvider>
            <RouterProvider router={router} />
          </ForecastProvider>
        </SettingsProvider>
      </AuthProvider>
    </ToastProvider>,
  );
}
