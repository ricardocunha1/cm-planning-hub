// QA integration tests for "Create from Azure DevOps" (plans/release-plan-ado.md, Phase 3).
// Real App routes, real pages, real store with the real localStorage autosave, real adoApi/api.ts;
// only `fetch` is mocked at the network boundary (synthetic responses, never a real Azure DevOps).
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "../App";
import { ToastProvider } from "../components/Toast";
import { ADO_CONNECTION_KEY } from "../lib/releasePlan/constants";
import type { ReleasePlan } from "../lib/releasePlan/types";
import { normalizePlan } from "../lib/releasePlan/validate";
import { ForecastProvider } from "../monteCarloStore";
import { makeBacklog, makeConnectResponse } from "../test/adoFixtures";

// The home page's saved-plans list is not under test here (and must not count as a request).
vi.mock("../lib/releasePlan/planApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/releasePlan/planApi")>()),
  listPlans: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 10 })),
}));

const PAT = "qa-secret-pat-0123456789";
const CANONICAL = "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/My%20Proj";
const TYPED = "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/My%20Proj/_backlogs/backlog/?a=1";
const TIMEOUT = 30_000;
const FIND = { timeout: 5_000 };

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path: string) {
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
const adoDialog = () => screen.getByRole("dialog", { name: "Create from Azure DevOps" });
const toastTexts = () => screen.queryAllByRole("status").map((s) => s.textContent ?? "");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const connectResponse = () => makeConnectResponse({ project: { id: "guid-1", name: "My Proj" }, projectUrl: CANONICAL });

interface Deferred {
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}

/**
 * Network mock: answers /api/ado/connect and /api/ado/backlog. `hold` keeps a route pending until the test
 * resolves it; held requests honor their AbortSignal unless `ignoreAbort` (a response that "arrives late").
 */
function mockNetwork(
  opts: {
    backlog?: () => Response;
    connect?: () => Response;
    hold?: "connect" | "backlog";
    ignoreAbort?: boolean;
  } = {},
) {
  const held: Deferred[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let created: Record<string, unknown> | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    signals.push(init?.signal ?? undefined);
    if (url === "/api/plan") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      created = { id: 42, ...body, createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" };
      return json(created, 201);
    }
    if (url === "/api/plan/42" && created) {
      return json(created);
    }
    const route = url === "/api/ado/connect" ? "connect" : url === "/api/ado/backlog" ? "backlog" : "other";
    if (route === "other") {
      return json({ errors: [`unexpected ${url}`] }, 500);
    }
    if (opts.hold === route) {
      return new Promise<Response>((resolve, reject) => {
        held.push({ resolve, reject });
        if (!opts.ignoreAbort) {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }
      });
    }
    if (route === "connect") {
      return opts.connect ? opts.connect() : json(connectResponse());
    }
    return opts.backlog
      ? opts.backlog()
      : json(makeBacklog({ project: { id: "guid-1", name: "My Proj" }, projectUrl: CANONICAL, scope: "Iteration Path: Proj\\Phase 1\\Sprint 02" }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, held, signals };
}

function allLocalStorage(): string {
  return Object.keys(window.localStorage)
    .map((k) => `${k}=${window.localStorage.getItem(k)}`)
    .join("\n");
}


async function openAdoFromHome(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Create from Azure DevOps/ }));
  return adoDialog();
}

async function fillConnection(user: ReturnType<typeof userEvent.setup>, { url = TYPED, pat = PAT } = {}) {
  const dialog = adoDialog();
  await user.click(within(dialog).getByRole("radio", { name: "On-Prem" }));
  await user.clear(within(dialog).getByLabelText("Project URL"));
  await user.type(within(dialog).getByLabelText("Project URL"), url);
  await user.type(within(dialog).getByLabelText("Personal Access Token"), pat);
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(within(adoDialog()).getByRole("button", { name: "Connect" }));
}

/** Iteration path → search "sprint 02" → keyboard-select it. */
async function pickSprint02(user: ReturnType<typeof userEvent.setup>) {
  const dialog = adoDialog();
  await screen.findByRole("tree", { name: "Area path" }, FIND);
  await user.click(within(dialog).getByRole("radio", { name: "Iteration path" }));
  await user.type(within(dialog).getByLabelText("Search Iteration path"), "sprint 02");
  const tree = within(dialog).getByRole("tree", { name: "Iteration path" });
  expect(within(tree).getAllByRole("treeitem").map((t) => t.getAttribute("title"))).toEqual([
    "Proj",
    "Proj\\Phase 1",
    "Proj\\Phase 1\\Sprint 02",
  ]);
  within(tree).getAllByRole("treeitem")[0].focus();
  await user.keyboard("{End}{Enter}");
  expect(within(tree).getByRole("treeitem", { name: /Sprint 02/ })).toHaveAttribute("aria-selected", "true");
}

describe("Release Plan – create from Azure DevOps (integration)", { timeout: TIMEOUT }, () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("hub home → Release Plan → ADO modal → connect → pick path → create → board; persists plan + connection, never the PAT; survives a reload", async () => {
    const user = userEvent.setup();
    const warning = "Neither Custom.EstimatedSize nor Custom.FeatureSize exists in this project; sizes are empty.";
    const { fetchMock } = mockNetwork({
      backlog: () =>
        json(
          makeBacklog({
            project: { id: "guid-1", name: "My Proj" },
            projectUrl: CANONICAL,
            scope: "Iteration Path: Proj\\Phase 1\\Sprint 02",
            warnings: [warning, "Only the first 20000 work items were loaded; narrow the scope."],
          }),
        ),
    });
    const view = renderApp("/");
    await user.click(screen.getByRole("link", { name: "Open Release Plan" }));
    expect(location()).toBe("/release-plan");

    await openAdoFromHome(user);
    expect(within(adoDialog()).getByRole("button", { name: "Create board" })).toBeDisabled();
    await fillConnection(user);
    await connect(user);
    await pickSprint02(user);
    expect(within(adoDialog()).getByTestId("ado-selected-path")).toHaveTextContent("Selected: Proj\\Phase 1\\Sprint 02");
    await user.click(within(adoDialog()).getByRole("button", { name: "Create board" }));

    // Board opens with the fetched Epics (synthetic Epic last) and every Feature in MVP.
    await waitFor(() => expect(location()).toBe("/release-plan/42"), FIND);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Plan name")).toHaveValue("My Proj – Feature Release Plan");
    const board = screen.getByRole("region", { name: "Board" });
    const epicTitles = [...board.querySelectorAll(".epic .name > span:first-child")].map((e) => e.textContent);
    expect(epicTitles).toEqual(["Wave 1", "Wave 2", "Features without an Epic"]);
    expect([...board.querySelectorAll(".fcard")].map((c) => c.getAttribute("data-feature"))).toEqual(["102", "104", "105", "106", "107"]);
    expect(screen.getByTestId("source-info")).toHaveTextContent("Azure DevOps · Iteration Path: Proj\\Phase 1\\Sprint 02 · fetched");

    // Toasts: Plan created + each warning; no "Restored your last session".
    const toasts = toastTexts();
    expect(toasts.some((t) => t.includes("Plan created: My Proj – Feature Release Plan"))).toBe(true);
    expect(toasts.some((t) => t.includes(warning))).toBe(true);
    expect(toasts.some((t) => t.includes("Only the first 20000 work items were loaded"))).toBe(true);
    expect(toasts.some((t) => t.includes("Restored your last session"))).toBe(false);

    // Requests: PAT only in the JSON bodies, typed URL sent to connect, canonical URL to backlog, then the plan is saved.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    for (const [url, init] of calls) {
      expect(url).not.toContain(PAT);
      expect(init.method).toBe("POST");
      expect(JSON.stringify(init.headers ?? {})).not.toContain(PAT);
    }
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ source: "onprem", projectUrl: TYPED, pat: PAT });
    expect(JSON.parse(String(calls[1][1].body))).toEqual({
      source: "onprem",
      projectUrl: CANONICAL,
      pat: PAT,
      scopeType: "iteration",
      scopePath: "Proj\\Phase 1\\Sprint 02",
    });
    expect(calls[2][0]).toBe("/api/plan");
    expect(JSON.parse(String(calls[2][1].body))).toMatchObject({ name: "My Proj – Feature Release Plan", projectType: "onprem", projectName: "My Proj" });

    // Persistence: the plan (with the connection in source) is POSTed and the connection remembered; the PAT is stored nowhere.
    const saved = (JSON.parse(String(calls[2][1].body)) as { state: ReleasePlan }).state;
    expect(saved.source).toEqual({
      system: "Azure DevOps",
      project: "My Proj",
      scope: "Iteration Path: Proj\\Phase 1\\Sprint 02",
      fetchedAt: "2026-10-23T10:00:00Z",
      kind: "onprem",
      projectUrl: CANONICAL,
      scopeType: "iteration",
      scopePath: "Proj\\Phase 1\\Sprint 02",
    });
    expect(normalizePlan(saved)).toEqual(saved);
    expect(JSON.parse(window.localStorage.getItem(ADO_CONNECTION_KEY)!)).toEqual({ source: "onprem", projectUrl: CANONICAL });
    expect(allLocalStorage()).not.toContain(PAT);

    // The synthetic Epic opens in the work-item modal like any Epic.
    await user.click(within(board).getByRole("button", { name: /Features without an Epic/ }));
    const wi = await screen.findByRole("dialog", { name: "Features without an Epic" }, FIND);
    expect(wi).toHaveTextContent("No description in Azure DevOps.");
    await user.keyboard("{Escape}");

    // "Reload": a fresh App loads the board from the server; the modal is pre-filled without the PAT.
    view.unmount();
    renderApp("/release-plan/42");
    expect(await screen.findByLabelText("Plan name", undefined, FIND)).toHaveValue("My Proj – Feature Release Plan");
    await user.click(within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name: "Release Plan" }));
    expect(location()).toBe("/release-plan");
    await openAdoFromHome(user);
    expect(within(adoDialog()).getByRole("radio", { name: "On-Prem" })).toBeChecked();
    expect(within(adoDialog()).getByLabelText("Project URL")).toHaveValue(CANONICAL);
    expect(within(adoDialog()).getByLabelText("Personal Access Token")).toHaveValue("");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("ignores a Connect response that arrives after the URL was edited (no tree, nothing remembered)", async () => {
    const user = userEvent.setup();
    const { held, fetchMock } = mockNetwork({ hold: "connect", ignoreAbort: true });
    renderApp("/release-plan");
    await openAdoFromHome(user);
    await fillConnection(user);
    await connect(user);
    expect(within(adoDialog()).getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Edit while in flight, then the stale response lands.
    await user.type(within(adoDialog()).getByLabelText("Project URL"), "x");
    await act(async () => held[0].resolve(json(connectResponse())));
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(within(adoDialog()).getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(within(adoDialog()).getByRole("button", { name: "Create board" })).toBeDisabled();
    expect(window.localStorage.getItem(ADO_CONNECTION_KEY)).toBeNull();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends a single Connect request for a double submit (click + Enter)", async () => {
    const user = userEvent.setup();
    const { held, fetchMock } = mockNetwork({ hold: "connect" });
    renderApp("/release-plan");
    await openAdoFromHome(user);
    await fillConnection(user);
    await connect(user);
    await user.click(within(adoDialog()).getByLabelText("Personal Access Token"));
    // Enter in a field would submit the form again; the busy guard must stop it without editing anything.
    await user.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => held[0].resolve(json(connectResponse())));
    expect(await screen.findByRole("tree", { name: "Area path" }, FIND)).toBeInTheDocument();
  });

  it("closing the modal (Esc) while work items load aborts the request: no plan, no navigation, no toast", async () => {
    const user = userEvent.setup();
    const { held, signals, fetchMock } = mockNetwork({ hold: "backlog" });
    renderApp("/release-plan");
    const card = screen.getByRole("button", { name: /Create from Azure DevOps/ });
    await openAdoFromHome(user);
    await fillConnection(user);
    await connect(user);
    await pickSprint02(user);
    await user.click(within(adoDialog()).getByRole("button", { name: "Create board" }));
    expect(within(adoDialog()).getByRole("button", { name: "Loading work items…" })).toBeDisabled();
    expect(held).toHaveLength(1);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(signals[1]?.aborted).toBe(true);
    await act(async () => held[0].resolve(json(makeBacklog())));
    expect(location()).toBe("/release-plan");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/plan")).toBe(false);
    expect(toastTexts().some((t) => t.includes("Plan created"))).toBe(false);
    expect(card).toHaveFocus();

    // Reopening starts fresh: URL pre-filled from the remembered connection, PAT forgotten, no tree.
    await openAdoFromHome(user);
    expect(within(adoDialog()).getByLabelText("Project URL")).toHaveValue(CANONICAL);
    expect(within(adoDialog()).getByLabelText("Personal Access Token")).toHaveValue("");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("shows a backlog 422 inline, keeps the modal, path and PAT, and creates nothing", async () => {
    const user = userEvent.setup();
    const { fetchMock } = mockNetwork({ backlog: () => json({ errors: ["Unknown Iteration path: Proj\\Phase 1\\Sprint 02."] }, 422) });
    renderApp("/release-plan");
    await openAdoFromHome(user);
    await fillConnection(user);
    await connect(user);
    await pickSprint02(user);
    await user.click(within(adoDialog()).getByRole("button", { name: "Create board" }));
    expect(await within(adoDialog()).findByRole("alert", {}, FIND)).toHaveTextContent("Unknown Iteration path: Proj\\Phase 1\\Sprint 02.");
    expect(within(adoDialog()).getByLabelText("Personal Access Token")).toHaveValue(PAT);
    expect(within(adoDialog()).getByTestId("ado-selected-path")).toHaveTextContent("Proj\\Phase 1\\Sprint 02");
    expect(within(adoDialog()).getByRole("button", { name: "Create board" })).toBeEnabled();
    expect(location()).toBe("/release-plan");
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/plan")).toBe(false);
  });

  it("shows a Connect 422 (PAT rejected) and a network failure inline, without a tree", async () => {
    const user = userEvent.setup();
    const rejected = "Azure DevOps rejected the Personal Access Token (invalid, expired or missing the Work Items (Read) scope).";
    let mode: "422" | "down" = "422";
    const { fetchMock } = mockNetwork({
      connect: () => {
        if (mode === "down") {
          throw new TypeError("Failed to fetch");
        }
        return json({ errors: [rejected] }, 422);
      },
    });
    renderApp("/release-plan");
    await openAdoFromHome(user);
    await fillConnection(user);
    await connect(user);
    expect(await within(adoDialog()).findByRole("alert", {}, FIND)).toHaveTextContent(rejected);
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ADO_CONNECTION_KEY)).toBeNull();

    mode = "down";
    await connect(user);
    expect(await within(adoDialog()).findByRole("alert", {}, FIND)).toHaveTextContent("Could not reach the server: Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(within(adoDialog()).getByLabelText("Personal Access Token")).toHaveValue(PAT);
  });

  it("checks the URL shape for the selected source client-side, with the server's message and no request", async () => {
    const user = userEvent.setup();
    const { fetchMock } = mockNetwork();
    renderApp("/release-plan");
    await openAdoFromHome(user);
    await user.click(within(adoDialog()).getByRole("radio", { name: "Collaboration Hub" }));
    await user.type(within(adoDialog()).getByLabelText("Project URL"), CANONICAL);
    await user.type(within(adoDialog()).getByLabelText("Personal Access Token"), PAT);
    await connect(user);
    expect(within(adoDialog()).getByRole("alert")).toHaveTextContent(
      "Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
