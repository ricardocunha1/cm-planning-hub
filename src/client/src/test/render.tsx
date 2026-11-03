import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "../components/Toast";
import type { PlanStorage } from "../lib/releasePlan/storage";
import type { ReleasePlan } from "../lib/releasePlan/types";
import { ReleasePlanProvider } from "../releasePlanStore";
import { ForecastProvider, type Execution } from "../monteCarloStore";
import type { DataSource, ValidateResponse } from "../lib/monteCarlo/types";

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

/** Renders `element` at `path` with stub pages for the other routes, so a
 * navigation shows up as `location` changing. The Monte Carlo store starts
 * from `dataSource` / `validation` / `execution` (default none). The Release Plan store starts
 * from `initialPlan` (default none) and is in-memory unless `planStorage` is
 * given (then it hydrates from and saves to it). */
export function renderAt(
  path: string,
  element: ReactElement,
  {
    dataSource = null,
    validation = null,
    execution = null,
    routes = {},
    initialPlan,
    planStorage = null,
  }: {
    dataSource?: DataSource | null;
    validation?: ValidateResponse | null;
    execution?: Execution | null;
    routes?: Record<string, ReactElement>;
    initialPlan?: ReleasePlan | null;
    planStorage?: PlanStorage | null;
  } = {},
) {
  const stubs: Record<string, ReactElement> = {
    "/": <p>hub home page</p>,
    "/monte-carlo": <p>data source page</p>,
    "/monte-carlo/input": <p>input page</p>,
    "/monte-carlo/confirm": <p>confirm page</p>,
    "/monte-carlo/results": <p>results page</p>,
    "/release-plan": <p>release plan home page</p>,
    "/release-plan/board": <p>release plan board page</p>,
    "/release-plan/:id": <p>release plan board page</p>,
    ...routes,
    [path]: element,
  };
  return render(
    <ToastProvider>
    <ForecastProvider initialDataSource={dataSource} initialValidation={validation} initialExecution={execution}>
      <ReleasePlanProvider initialPlan={planStorage ? initialPlan : (initialPlan ?? null)} storage={planStorage}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            {Object.entries(stubs).map(([routePath, routeElement]) => (
              <Route key={routePath} path={routePath} element={routeElement} />
            ))}
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </ReleasePlanProvider>
    </ForecastProvider>
    </ToastProvider>,
  );
}
