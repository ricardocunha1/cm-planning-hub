import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { STORAGE_KEY } from "./lib/releasePlan/constants";
import { ForecastProvider } from "./monteCarloStore";

// Release Plan full-app integration (Phase 1): the real App (whose
// ReleasePlanProvider autosaves to the real jsdom localStorage), real pages and
// components. Nothing is mocked; a "reload" is an unmount + a fresh render that
// re-hydrates from the same localStorage. Synthetic data only.

const FLOW_TIMEOUT_MS = 20_000;
const FIND = { timeout: 5_000 };

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path = "/") {
  return render(
    <ToastProvider>
      <ForecastProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <LocationProbe />
        </MemoryRouter>
      </ForecastProvider>
    </ToastProvider>,
  );
}

const location = () => screen.getByTestId("location").textContent;

/**
 * Raw (un-normalized) plan file. Exercises normalization on the way in:
 * Beta's color is not in the palette, "Search" has a padded lower-case size,
 * "Charts" references an unknown milestone (→ Unplanned), "Export" has no
 * iterationPath/description/size keys at all.
 *
 * Expected summary after import:
 * - Alpha: Search (Done, M) + Export (L) → 2 Features, Epics completed: 1 (Epic One).
 * - Beta: Reports (unestimated) → 1 Feature, Epics completed: 0 (Epic Two still has an unplanned Feature).
 * - Unplanned: Charts (S) → 1 Feature, Epics with unplanned features: 1.
 */
const RAW_PLAN = {
  schema: "release-planner-features",
  version: 1,
  mode: "releases",
  name: "Integration Plan",
  source: { system: "Azure DevOps", project: "Synthetic", scope: "Area Path: Synthetic\\Team" },
  iterations: [{ path: "Synthetic\\Sprint 1", finishDate: "2026-11-06" }],
  milestones: [
    { id: "ms_alpha", name: "Alpha", date: "", color: "#4E98D1" },
    { id: "ms_beta", name: "Beta", date: "", color: "#123456" },
  ],
  flags: [],
  epics: [
    {
      id: 101,
      title: "Epic One",
      state: "Active",
      description: "<p>First epic</p>",
      features: [
        { id: 1001, title: "Search", state: "Done", size: " m ", iterationPath: "Synthetic\\Sprint 1", description: "", milestoneId: "ms_alpha" },
        { id: 1002, title: "Export", state: "New", milestoneId: "ms_alpha" },
      ],
    },
    {
      id: 102,
      title: "Epic Two",
      state: "New",
      features: [
        { id: 1003, title: "Reports", state: "New", size: "", iterationPath: "Synthetic", description: "", milestoneId: "ms_beta" },
        { id: 1004, title: "Charts", state: "New", size: "S", iterationPath: "Synthetic\\Sprint 1", description: "", milestoneId: "ms_ghost" },
      ],
    },
  ],
};

function summaryBox(name: string) {
  return within(screen.getByRole("region", { name: "Milestone summary" })).getByRole("group", { name });
}

function savedPlan(): { name: string; milestones: Array<{ id: string; color: string }>; epics: Array<{ features: Array<{ id: number; milestoneId: string | null; size: string }> }> } {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
}

describe("Release Plan – full app flow (Phase 1)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it(
    "saved plan → board summary → Table milestone change → reload restores the plan",
    async () => {
      const user = userEvent.setup();
      // Seed the autosave with the synthetic plan (raw, un-normalized) and open the board.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(RAW_PLAN));
      const first = renderApp("/release-plan/board");
      expect(await screen.findByRole("region", { name: "Milestone summary" }, FIND)).toBeInTheDocument();
      expect(location()).toBe("/release-plan/board");
      expect(document.title).toBe("Planning Hub – Release Plan – Board");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Plan name" })).toHaveValue("Integration Plan");
      expect(screen.getByTestId("source-info")).toHaveTextContent("Azure DevOps · Area Path: Synthetic\\Team");

      // Summary per the expected numbers (normalization applied).
      expect(summaryBox("Alpha")).toHaveTextContent("2 Features");
      expect(summaryBox("Alpha")).toHaveTextContent("Epics completed: 1");
      expect(summaryBox("Beta")).toHaveTextContent("1 Features");
      expect(summaryBox("Beta")).toHaveTextContent("Epics completed: 0");
      expect(summaryBox("Unplanned")).toHaveTextContent("1 Features");
      expect(summaryBox("Unplanned")).toHaveTextContent("Epics with unplanned features: 1");
      expect(summaryBox("Unplanned")).toHaveTextContent("No milestone");
      // Board: epic meta lines and the four cards.
      expect(screen.getByText("Epic #101 · Done in Alpha")).toBeInTheDocument();
      expect(screen.getByText("Epic #102 · Beta · 1 unplanned")).toBeInTheDocument();
      for (const id of [1001, 1002, 1003, 1004]) {
        expect(screen.getByText(`Feature #${id}`)).toBeInTheDocument();
      }

      // Autosaved immediately, normalized.
      const saved = savedPlan();
      expect(saved.name).toBe("Integration Plan");
      expect(saved.milestones.map((m) => m.color)).toEqual(["#4E98D1", "#60C5B5"]);
      expect(saved.epics[0].features[0].size).toBe("M");
      expect(saved.epics[1].features[1].milestoneId).toBeNull();

      // Switch to Table: zoom controls go away, all 4 Features are listed.
      await user.click(screen.getByRole("tab", { name: "Table" }));
      expect(screen.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
      expect(screen.queryByRole("group", { name: "Zoom" })).not.toBeInTheDocument();
      expect(screen.getByText("4 features shown")).toBeInTheDocument();

      // Move "Charts" from Unplanned to Beta through its milestone select.
      const chartsSelect = screen.getByRole("combobox", { name: "Milestone for Charts" });
      expect(chartsSelect).toHaveValue("");
      await user.selectOptions(chartsSelect, "ms_beta");
      expect(screen.getByRole("combobox", { name: "Milestone for Charts" })).toHaveValue("ms_beta");
      expect(summaryBox("Beta")).toHaveTextContent("2 Features");
      expect(summaryBox("Beta")).toHaveTextContent("Epics completed: 1");
      expect(summaryBox("Unplanned")).toHaveTextContent("0 Features");
      expect(summaryBox("Unplanned")).toHaveTextContent("No features");
      expect(summaryBox("Unplanned")).toHaveTextContent("Epics with unplanned features: 0");
      expect(savedPlan().epics[1].features[1].milestoneId).toBe("ms_beta");

      // "Reload": throw the whole app away and mount it again on the board URL.
      first.unmount();
      renderApp("/release-plan/board");
      expect(location()).toBe("/release-plan/board");
      expect(await screen.findByText("Restored your last session", undefined, FIND)).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Plan name" })).toHaveValue("Integration Plan");
      // UI-only state is not persisted: back on the Board view.
      expect(screen.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
      expect(summaryBox("Beta")).toHaveTextContent("2 Features");
      expect(summaryBox("Unplanned")).toHaveTextContent("0 Features");
      expect(screen.getByText("Epic #102 · Done in Beta")).toBeInTheDocument();

      // And the Table still shows the moved Feature in Beta.
      await user.click(screen.getByRole("tab", { name: "Table" }));
      expect(screen.getByRole("combobox", { name: "Milestone for Charts" })).toHaveValue("ms_beta");
    },
    FLOW_TIMEOUT_MS,
  );

  it("redirects /release-plan/board to /release-plan when nothing is saved", () => {
    renderApp("/release-plan/board");
    expect(location()).toBe("/release-plan");
    expect(screen.queryByText("Restored your last session")).not.toBeInTheDocument();
  });

  it("ignores a corrupt autosave (redirects, no toast)", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    renderApp("/release-plan/board");
    expect(location()).toBe("/release-plan");
    expect(screen.queryByText("Restored your last session")).not.toBeInTheDocument();
  });
});
