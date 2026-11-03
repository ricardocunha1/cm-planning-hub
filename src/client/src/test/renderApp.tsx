import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { appRoutes } from "../App";
import { ToastProvider } from "../components/Toast";
import { ForecastProvider } from "../monteCarloStore";
import { ProbeLayout } from "./render";

/** Renders the real app routes in a memory data router at `path`, with a `data-testid="location"` probe. */
export function renderApp(path = "/") {
  const router = createMemoryRouter([{ element: <ProbeLayout />, children: appRoutes }], { initialEntries: [path] });
  return render(
    <ToastProvider>
      <ForecastProvider>
        <RouterProvider router={router} />
      </ForecastProvider>
    </ToastProvider>,
  );
}
