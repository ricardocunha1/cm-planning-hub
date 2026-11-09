import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { ToastProvider } from "./components/Toast";
import { SIDEBAR_COLLAPSED_KEY } from "./lib/sidebarPreference";
import { ForecastProvider } from "./monteCarloStore";
import { stubPlanServer } from "./test/planServer";
import { samplePlan } from "./test/releasePlanFixtures";

// Collapsible sidebar, full-app integration: the real App routes and pages
// (each page mounts its own Layout), real jsdom localStorage. Nothing is mocked
// besides window.scrollTo (ScrollToTop). A "reload" is an unmount + fresh render.

const FLOW_TIMEOUT_MS = 20_000;
const ACTIVE_CLASSES = ["bg-surface-raised", "text-accent-teal"];

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path = "/") {
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <Outlet />
            <LocationProbe />
          </>
        ),
        children: appRoutes,
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <ToastProvider>
      <ForecastProvider>
        <RouterProvider router={router} />
      </ForecastProvider>
    </ToastProvider>,
  );
}

const location = () => screen.getByTestId("location").textContent;

// Each page renders its own Layout, so re-query after every navigation.
const nav = () => screen.getByRole("navigation", { name: "Hub navigation" });
const toolLink = (name: string) => within(nav()).getByRole("link", { name });
const aside = () => {
  const el = nav().closest("aside");
  if (!el) throw new Error("sidebar <aside> not found");
  return el;
};

function expectCollapsed() {
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument();
  expect(aside()).toHaveClass("md:w-16");
  expect(aside()).not.toHaveClass("md:w-60");
  for (const name of ["Monte Carlo", "Release Plan"]) {
    expect(toolLink(name)).toHaveAttribute("title", name);
    expect(toolLink(name).querySelector("svg")).not.toBeNull();
    expect(within(toolLink(name)).getByText(name)).toHaveClass("md:sr-only");
  }
}

function expectExpanded() {
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true");
  expect(aside()).toHaveClass("md:w-60");
  expect(aside()).not.toHaveClass("md:w-16");
  for (const name of ["Monte Carlo", "Release Plan"]) {
    expect(toolLink(name)).not.toHaveAttribute("title");
    expect(within(toolLink(name)).getByText(name)).not.toHaveClass("md:sr-only");
  }
}

function expectActive(active: string, inactive: string) {
  expect(toolLink(active)).toHaveAttribute("aria-current", "page");
  expect(toolLink(active)).toHaveClass(...ACTIVE_CLASSES);
  expect(toolLink(inactive)).not.toHaveAttribute("aria-current");
  expect(toolLink(inactive)).not.toHaveClass("bg-surface-raised");
}

describe("Sidebar collapse – full app", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(
    "collapses on home, stays collapsed across tools via the icons, and the highlight follows the route",
    async () => {
      const user = userEvent.setup();
      renderApp("/");
      expectExpanded();

      await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expectCollapsed();
      expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("1");
      expect(toolLink("Monte Carlo")).not.toHaveAttribute("aria-current");
      expect(toolLink("Release Plan")).not.toHaveAttribute("aria-current");

      // Icon → Monte Carlo (new page, new Layout mount): still collapsed, MC highlighted.
      await user.click(toolLink("Monte Carlo"));
      expect(location()).toBe("/monte-carlo");
      expect(document.title).toBe("Planning Hub – Monte Carlo – Data Source");
      expectCollapsed();
      expectActive("Monte Carlo", "Release Plan");

      // Icon → Release Plan: still collapsed, highlight moves.
      await user.click(toolLink("Release Plan"));
      expect(location()).toBe("/release-plan");
      expectCollapsed();
      expectActive("Release Plan", "Monte Carlo");

      // Expand on Release Plan, go back home via the logo: expanded there too.
      await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expectExpanded();
      expectActive("Release Plan", "Monte Carlo");
      await user.click(screen.getByRole("link", { name: /Planning Hub home/i }));
      expect(location()).toBe("/");
      expectExpanded();
      expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("0");
    },
    FLOW_TIMEOUT_MS,
  );

  it("restores a persisted collapsed state on a fresh mount, including through the no-data redirect", () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
    renderApp("/monte-carlo/results");
    expect(location()).toBe("/monte-carlo");
    expectCollapsed();
    expectActive("Monte Carlo", "Release Plan");
  });

  it(
    "survives a reload after expanding again",
    async () => {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
      const user = userEvent.setup();
      const first = renderApp("/release-plan");
      expectCollapsed();
      await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
      first.unmount();

      renderApp("/release-plan");
      expectExpanded();
      expectActive("Release Plan", "Monte Carlo");
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    "keeps the Release Plan board usable and highlighted with the collapsed sidebar",
    async () => {
      stubPlanServer(samplePlan());
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
      const user = userEvent.setup();
      renderApp("/release-plan/1");
      await screen.findByRole("region", { name: "Milestone summary" }, { timeout: 5_000 });
      expect(location()).toBe("/release-plan/1");
      expectCollapsed();
      expectActive("Release Plan", "Monte Carlo");
      expect(screen.getByRole("button", { name: "Sync from ADO" })).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Milestone summary" })).toBeInTheDocument();

      // Toggling the sidebar on the board does not remount/lose the board view state.
      await user.click(screen.getByRole("tab", { name: "Table" }));
      await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
      expectExpanded();
      expect(screen.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
      expectActive("Release Plan", "Monte Carlo");
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    "is operable from the keyboard and keeps focus on the toggle",
    async () => {
      const user = userEvent.setup();
      renderApp("/monte-carlo");
      const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
      toggle.focus();
      await user.keyboard("{Enter}");
      const expand = screen.getByRole("button", { name: "Expand sidebar" });
      expect(expand).toBe(toggle);
      expect(expand).toHaveFocus();
      expectCollapsed();

      await user.keyboard(" ");
      expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveFocus();
      expectExpanded();

      // Tab order: the toggle comes before the tool links.
      await user.tab();
      expect(toolLink("Monte Carlo")).toHaveFocus();
    },
    FLOW_TIMEOUT_MS,
  );

  it("falls back to expanded and still toggles when localStorage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const user = userEvent.setup();
    renderApp("/");
    expectExpanded();
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expectCollapsed();
  });
});
