import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, type RouteObject } from "react-router-dom";
import { ToastProvider } from "../components/Toast";
import type { ReleasePlan } from "../lib/releasePlan/types";
import { ReleasePlanProvider } from "../releasePlanStore";
import { ForecastProvider, type Execution } from "../monteCarloStore";
import type { DataSource, ValidateResponse } from "../lib/monteCarlo/types";

/** Renders the current pathname as `data-testid="location"`. */
export function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

/** Root route element: the matched page plus the location probe (inside the router, so hooks work). */
export function ProbeLayout() {
  return (
    <>
      <Outlet />
      <LocationProbe />
    </>
  );
}

/** Renders `element` at `path` (a route pattern; `initialEntry` is the URL to open, default `path`) with stub pages for the other routes, so a
 * navigation shows up as `location` changing. Uses a memory *data* router, so `useBlocker` works. The Monte Carlo store starts
 * from `dataSource` / `validation` / `execution` (default none). The Release Plan store starts
 * from `initialPlan` (default none) saved as `initialPlanId` (default none). */
export function renderAt(
  path: string,
  element: ReactElement,
  {
    dataSource = null,
    validation = null,
    execution = null,
    routes = {},
    initialPlan = null,
    initialPlanId = null,
    initialEntry = path,
  }: {
    dataSource?: DataSource | null;
    validation?: ValidateResponse | null;
    execution?: Execution | null;
    routes?: Record<string, ReactElement>;
    initialPlan?: ReleasePlan | null;
    initialPlanId?: number | null;
    initialEntry?: string;
  } = {},
) {
  const stubs: Record<string, ReactElement> = {
    "/": <p>hub home page</p>,
    "/monte-carlo": <p>data source page</p>,
    "/monte-carlo/input": <p>input page</p>,
    "/monte-carlo/confirm": <p>confirm page</p>,
    "/monte-carlo/results": <p>results page</p>,
    "/release-plan": <p>release plan home page</p>,
    "/release-plan/:id": <p>release plan board page</p>,
    ...routes,
    [path]: element,
  };
  const children: RouteObject[] = Object.entries(stubs).map(([routePath, routeElement]) => ({ path: routePath, element: routeElement }));
  const router = createMemoryRouter([{ element: <ProbeLayout />, children }], { initialEntries: [initialEntry] });
  return render(
    <ToastProvider>
      <ForecastProvider initialDataSource={dataSource} initialValidation={validation} initialExecution={execution}>
        <ReleasePlanProvider initialPlan={initialPlan} initialPlanId={initialPlanId}>
          <RouterProvider router={router} />
        </ReleasePlanProvider>
      </ForecastProvider>
    </ToastProvider>,
  );
}
