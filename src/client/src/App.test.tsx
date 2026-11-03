import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { ToastProvider } from "./components/Toast";
import type { DataSource } from "./lib/monteCarlo/types";
import { ForecastProvider } from "./monteCarloStore";
import { excelSource } from "./test/monteCarloFixtures";

function renderApp(path: string, dataSource: DataSource | null = null) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(
    <ToastProvider>
      <ForecastProvider initialDataSource={dataSource}>
        <RouterProvider router={router} />
      </ForecastProvider>
    </ToastProvider>,
  );
}

describe("App routing", () => {
  // ScrollToTop calls window.scrollTo, which jsdom does not implement.
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders the hub home page at /", () => {
    renderApp("/");
    expect(screen.getByRole("link", { name: "Open Monte Carlo" })).toBeInTheDocument();
  });

  it("renders the Monte Carlo data source selection at /monte-carlo", () => {
    renderApp("/monte-carlo");
    expect(screen.queryByRole("heading", { name: "Monte Carlo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How to Use" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Load sprint history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import an Excel file/ })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Target Value/)).not.toBeInTheDocument();
  });

  it("renders the Monte Carlo input form at /monte-carlo/input once a data source is chosen", () => {
    renderApp("/monte-carlo/input", excelSource("history.xlsx"));
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Input");
    expect(screen.getByRole("region", { name: "Data source: Excel file" })).toHaveTextContent("history.xlsx");
    expect(screen.getByLabelText(/Target Value/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How to Use" })).toBeInTheDocument();
  });

  it("redirects /monte-carlo/input to the data source page without a data source", () => {
    renderApp("/monte-carlo/input");
    expect(screen.getByRole("heading", { name: "Load sprint history" })).toBeInTheDocument();
  });

  it("redirects unknown paths to the hub home page", () => {
    renderApp("/confirm");
    expect(screen.getByRole("link", { name: "Open Monte Carlo" })).toBeInTheDocument();
  });

  it("redirects Monte Carlo steps without data to the data source step", () => {
    renderApp("/monte-carlo/results");
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Source");
  });
});
