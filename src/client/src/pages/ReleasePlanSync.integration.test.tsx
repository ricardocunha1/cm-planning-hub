// QA integration tests for "Sync from ADO" (plans/release-plan-ado.md, Phase 4).
// Real App routes, real pages, real store with the real localStorage autosave, real adoApi;
// only `fetch` is mocked at the network boundary (synthetic responses, never a real Azure DevOps).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { ToastProvider } from "../components/Toast";
import type { AdoBacklog } from "../lib/releasePlan/adoTypes";
import { STORAGE_KEY } from "../lib/releasePlan/constants";
import { planFromBacklog } from "../lib/releasePlan/fromBacklog";
import { planReducer } from "../lib/releasePlan/reducer";
import { NO_EPIC_ID, type ReleasePlan } from "../lib/releasePlan/types";
import { normalizePlan } from "../lib/releasePlan/validate";
import { ForecastProvider } from "../monteCarloStore";
import { makeBacklog, makeConnectResponse, makeConnection, makeEpicItem, makeFeatureItem } from "../test/adoFixtures";
import { samplePlan, sequentialIds } from "../test/releasePlanFixtures";

// The home page's saved-plans list is not under test here (and must not count as a request).
vi.mock("../lib/releasePlan/planApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/releasePlan/planApi")>()),
  listPlans: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 10 })),
}));

const PAT = "qa-sync-secret-pat-9876543210";
const CANONICAL = "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/My%20Proj";
const PROJECT = { id: "guid-1", name: "My Proj" };
const TIMEOUT = 30_000;
const FIND = { timeout: 5_000 };

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path: string) {
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

type User = ReturnType<typeof userEvent.setup>;

const location = () => screen.getByTestId("location").textContent;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const toastTexts = () => screen.queryAllByRole("status").map((s) => s.textContent ?? "");
const syncDialog = () => screen.getByRole("dialog", { name: "Sync from Azure DevOps" });
const toolbar = () => {
  const el = document.querySelector<HTMLElement>(".rp .toolbar");
  if (!el) throw new Error("toolbar not rendered");
  return el;
};

/** The board's backlog at creation time (Epic 101: 102, 104; Epic 103: 105; orphans 106, 107). */
const initialBacklog = (): AdoBacklog => makeBacklog({ project: PROJECT, projectUrl: CANONICAL, scope: "Area Path: Proj\\Team A" });

/**
 * The changed backlog: 102 renamed, new Feature 108 under 101, new Epic 110 with Feature 111, 105 gone,
 * 104 moved to Epic 103, orphan 106 moved to Epic 101 (107 stays orphan), one more iteration, one warning.
 */
function changedBacklog(): AdoBacklog {
  const base = initialBacklog();
  return {
    ...base,
    fetchedAt: "2026-10-30T08:00:00Z",
    warnings: ["Neither Custom.EstimatedSize nor Custom.FeatureSize exists in this project; sizes are empty."],
    workItems: [
      ...base.workItems
        .filter((i) => i.id !== 105)
        .map((i) => (i.id === 102 ? { ...i, title: "Sign in" } : i.id === 104 ? { ...i, parentId: 103 } : i.id === 106 ? { ...i, parentId: 101 } : i)),
      makeFeatureItem({ id: 108, title: "Search", parentId: 101 }),
      makeEpicItem({ id: 110, title: "Wave 3" }),
      makeFeatureItem({ id: 111, title: "Billing", parentId: 110 }),
    ],
    iterations: [...base.iterations, { path: "Proj\\Phase 2", finishDate: "2026-12-31" }],
  };
}

function mockNetwork(backlogs: (() => Response)[]) {
  let backlogCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/plan") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ id: 42, ...body, createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" }, 201);
    }
    if (url === "/api/ado/connect") {
      return json(makeConnectResponse({ project: PROJECT, projectUrl: CANONICAL }));
    }
    if (url === "/api/ado/backlog") {
      const respond = backlogs[Math.min(backlogCalls, backlogs.length - 1)];
      backlogCalls++;
      return respond();
    }
    return json({ errors: [`unexpected ${url}`] }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function storedPlan(): ReleasePlan {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as ReleasePlan;
}
const allLocalStorage = () =>
  Object.keys(window.localStorage)
    .map((k) => `${k}=${window.localStorage.getItem(k)}`)
    .join("\n");
const layoutOf = (plan: ReleasePlan) => plan.epics.map((e) => [e.id, e.features.map((f) => f.id)]);
const milestoneOf = (plan: ReleasePlan, id: number) => plan.epics.flatMap((e) => e.features).find((f) => f.id === id)?.milestoneId;
const epicTitles = () => [...screen.getByRole("region", { name: "Board" }).querySelectorAll(".epic .name > span:first-child")].map((e) => e.textContent);

/** Counts autosaves of the plan key from now on (spyOn reuses an existing spy, so count from a baseline). */
function spyPlanSaves() {
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  const count = () => setItem.mock.calls.filter(([k]) => k === STORAGE_KEY).length;
  const start = count();
  return () => count() - start;
}

/** Home → "Create from Azure DevOps" → On-Prem + URL + PAT → Connect → Area "Team A" → Create board. */
async function createFromAdo(user: User) {
  await user.click(screen.getByRole("button", { name: /Create from Azure DevOps/ }));
  const dialog = screen.getByRole("dialog", { name: "Create from Azure DevOps" });
  await user.click(within(dialog).getByRole("radio", { name: "On-Prem" }));
  await user.clear(within(dialog).getByLabelText("Project URL"));
  await user.type(within(dialog).getByLabelText("Project URL"), CANONICAL);
  await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
  await user.click(within(dialog).getByRole("button", { name: "Connect" }));
  const tree = await within(dialog).findByRole("tree", { name: "Area path" }, FIND);
  await user.click(within(tree).getByRole("treeitem", { name: /^Team A/ }));
  await user.click(within(dialog).getByRole("button", { name: "Create board" }));
  await waitFor(() => expect(location()).toBe("/release-plan/42"), FIND);
}

/** Read-only value shown next to a label in the sync dialog. */
const shownValue = (dialog: HTMLElement, label: string) => within(dialog).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

/** Toolbar "Sync from ADO" → (connection shown read-only from the plan) → PAT → Preview changes. */
async function openSyncPreview(user: User) {
  await user.click(within(toolbar()).getByRole("button", { name: "Sync from ADO" }));
  const dialog = syncDialog();
  expect(shownValue(dialog, "Azure DevOps source")).toBe("On-Prem");
  expect(shownValue(dialog, "Project URL")).toBe(CANONICAL);
  expect(shownValue(dialog, "Area path")).toBe("Proj\\Team A");
  expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
  expect(within(dialog).getByLabelText("Personal Access Token")).toHaveValue("");
  await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
  await user.click(within(dialog).getByRole("button", { name: "Preview changes" }));
  await screen.findByRole("button", { name: "Apply" }, FIND);
  return syncDialog();
}

/** Adds a milestone after MVP ("Release 1") and moves Feature "Dashboard" (104) into it via the Table view. */
async function planDashboardInNewMilestone(user: User): Promise<string> {
  // Releases mode: the gap "+" inserts a milestone directly (no menu).
  await user.click(screen.getByRole("button", { name: "Insert after MVP" }));
  const plan = storedPlan();
  expect(plan.milestones).toHaveLength(2);
  const r2 = plan.milestones[1].id;
  await user.click(within(toolbar()).getByRole("tab", { name: "Table" }));
  await user.selectOptions(screen.getByLabelText("Milestone for Dashboard"), r2);
  await user.click(within(toolbar()).getByRole("tab", { name: "Board" }));
  expect(milestoneOf(storedPlan(), 104)).toBe(r2);
  return r2;
}

describe("Release Plan – Sync from Azure DevOps (integration)", { timeout: TIMEOUT }, () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  for (const removeGone of [false, true]) {
    it(`create → plan a Feature → sync a changed backlog → preview → Apply (${removeGone ? "removing" : "keeping"} gone items) in one autosave`, async () => {
      const user = userEvent.setup();
      const fetchMock = mockNetwork([() => json(initialBacklog()), () => json(changedBacklog())]);
      renderApp("/release-plan");
      await createFromAdo(user);
      expect(epicTitles()).toEqual(["Wave 1", "Wave 2", "Features without an Epic"]);
      const r2 = await planDashboardInNewMilestone(user);
      const before = storedPlan();

      const preview = await openSyncPreview(user);
      expect([...preview.querySelectorAll("summary")].map((s) => s.textContent)).toEqual([
        "2 new Features",
        "1 new Epic",
        "3 updated",
        "1 no longer in scope",
      ]);
      const items = [...preview.querySelectorAll("li")].map((li) => li.textContent);
      expect(items).toEqual(
        expect.arrayContaining(["#108 Search (in Wave 1)", "#111 Billing (in Wave 3)", "#110 Wave 3", "#102 Sign in (title)", "#104 Dashboard (Epic)", "#106 Loose (Epic)", "#105 Reports"]),
      );
      const box = within(preview).getByRole("checkbox", { name: "Remove items no longer in scope" });
      expect(box).not.toBeChecked();
      if (removeGone) {
        await user.click(box);
      }

      const saves = spyPlanSaves();
      await user.click(within(preview).getByRole("button", { name: "Apply" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(saves()).toBe(1);

      const after = storedPlan();
      expect(layoutOf(after)).toEqual([
        [101, [102, 106, 108]],
        [103, removeGone ? [104] : [105, 104]],
        [110, [111]],
        [NO_EPIC_ID, [107]],
      ]);
      expect(epicTitles()).toEqual(["Wave 1", "Wave 2", "Wave 3", "Features without an Epic"]);
      // Planning preserved: moved Feature keeps its new milestone, others keep MVP, new ones Unplanned.
      expect(milestoneOf(after, 104)).toBe(r2);
      expect(milestoneOf(after, 102)).toBe(before.milestones[0].id);
      expect(milestoneOf(after, 106)).toBe(before.milestones[0].id);
      expect(milestoneOf(after, 108)).toBeNull();
      expect(milestoneOf(after, 111)).toBeNull();
      expect(after.milestones).toEqual(before.milestones);
      expect(after.name).toBe(before.name);
      expect(after.mode).toBe("releases");
      expect(after.iterations).toEqual(changedBacklog().iterations);
      expect(after.source).toEqual({ ...before.source, fetchedAt: "2026-10-30T08:00:00Z" });
      expect(normalizePlan(after)).toEqual(after);
      expect(screen.getByRole("region", { name: "Board" })).toHaveTextContent("Sign in");

      const toasts = toastTexts();
      expect(toasts.some((t) => t.includes("Board synchronized with Azure DevOps"))).toBe(true);
      expect(toasts.some((t) => t.includes("Neither Custom.EstimatedSize nor Custom.FeatureSize exists"))).toBe(true);
      expect(allLocalStorage()).not.toContain(PAT);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // A second sync of the same backlog: up to date (when removed), or only the gone item left.
      fetchMock.mockClear();
      const again = await openSyncPreview(user);
      if (removeGone) {
        expect(again).toHaveTextContent("The board is up to date with Azure DevOps.");
      } else {
        expect([...again.querySelectorAll("summary")].map((s) => s.textContent)).toEqual(["1 no longer in scope"]);
      }
      const saves2 = spyPlanSaves();
      await user.click(within(again).getByRole("button", { name: "Apply" }));
      // Nothing at all changed → the reducer keeps the reference → no autosave.
      expect(saves2()).toBe(0);
    });
  }

  it("Cancel in the preview (and Esc in the sync dialog) changes nothing and saves nothing", async () => {
    const user = userEvent.setup();
    mockNetwork([() => json(initialBacklog()), () => json(changedBacklog())]);
    renderApp("/release-plan");
    await createFromAdo(user);
    const before = window.localStorage.getItem(STORAGE_KEY);
    const saves = spyPlanSaves();

    await user.click(within(toolbar()).getByRole("button", { name: "Sync from ADO" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const preview = await openSyncPreview(user);
    await user.click(within(preview).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(saves()).toBe(0);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(epicTitles()).toEqual(["Wave 1", "Wave 2", "Features without an Epic"]);
    expect(toastTexts().some((t) => t.includes("Board synchronized"))).toBe(false);
  });

  it("an old plan without connection info can't be synced and sends no request", async () => {
    const user = userEvent.setup();
    const old = samplePlan();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(old));
    const fetchMock = mockNetwork([() => json(initialBacklog())]);
    renderApp("/release-plan/board");

    await user.click(within(toolbar()).getByRole("button", { name: "Sync from ADO" }));
    const dialog = syncDialog();
    expect(dialog).toHaveTextContent("This board isn't linked to an Azure DevOps project, so it can't be synced.");
    expect(within(dialog).queryByLabelText("Personal Access Token")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Preview changes" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedPlan()).toEqual(old);
  });

  it("a backlog 422 during sync shows inline in the dialog, keeps the PAT, opens no preview and changes nothing", async () => {
    const user = userEvent.setup();
    mockNetwork([() => json(initialBacklog()), () => json({ errors: ["Unknown Area path: Proj\\Team A."] }, 422)]);
    renderApp("/release-plan");
    await createFromAdo(user);
    const before = window.localStorage.getItem(STORAGE_KEY);

    await user.click(within(toolbar()).getByRole("button", { name: "Sync from ADO" }));
    const dialog = syncDialog();
    await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
    await user.click(within(dialog).getByRole("button", { name: "Preview changes" }));
    expect(await within(dialog).findByRole("alert", {}, FIND)).toHaveTextContent("Unknown Area path: Proj\\Team A.");
    expect(within(dialog).getByLabelText("Personal Access Token")).toHaveValue(PAT);
    expect(shownValue(dialog, "Area path")).toBe("Proj\\Team A");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(allLocalStorage()).not.toContain(PAT);
  });

  it("a Sprints-mode plan: sprints, flags and every Feature's sprint survive; new Features Unplanned; iterations replaced", async () => {
    const user = userEvent.setup();
    const created = planFromBacklog(initialBacklog(), makeConnection({ source: "onprem", projectUrl: CANONICAL }), sequentialIds());
    const sprints = planReducer(created, { type: "setMode", mode: "sprints" })!;
    expect(sprints.mode).toBe("sprints");
    const withFlag: ReleasePlan = { ...sprints, flags: [{ id: "fl_1", name: "Go-live", date: "", afterMsId: sprints.milestones[0].id }] };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(withFlag));
    mockNetwork([() => json(changedBacklog())]);
    renderApp("/release-plan/board");
    expect(screen.getByRole("radio", { name: /Sprints/ })).toHaveAttribute("aria-checked", "true");

    const preview = await openSyncPreview(user);
    await user.click(within(preview).getByRole("checkbox", { name: "Remove items no longer in scope" }));
    const saves = spyPlanSaves();
    await user.click(within(preview).getByRole("button", { name: "Apply" }));
    expect(saves()).toBe(1);

    const after = storedPlan();
    expect(after.mode).toBe("sprints");
    expect(after.milestones).toEqual(withFlag.milestones);
    expect(after.flags).toEqual(withFlag.flags);
    for (const id of [102, 104, 106, 107]) {
      expect(milestoneOf(after, id)).toBe(milestoneOf(withFlag, id));
    }
    expect(milestoneOf(after, 108)).toBeNull();
    expect(milestoneOf(after, 111)).toBeNull();
    expect(after.iterations).toEqual(changedBacklog().iterations);
    expect(normalizePlan(after)).toEqual(after);
  });
});
