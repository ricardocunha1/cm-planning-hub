import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { ToastProvider } from "./components/Toast";
import { ADO_CONNECTION_KEY as MONTE_CARLO_KEY } from "./lib/monteCarlo/constants";
import { ADO_CONNECTION_KEY as RELEASE_PLAN_KEY } from "./lib/releasePlan/constants";
import { ForecastProvider } from "./monteCarloStore";
import { SettingsProvider } from "./settingsStore";
import { ADO_CREDENTIALS, makeBacklog, makeConnectResponse } from "./test/adoFixtures";
import { makeSprintHistory } from "./test/monteCarloFixtures";
import { planDetail } from "./test/planServer";
import { samplePlan } from "./test/releasePlanFixtures";
import { AuthProvider } from "./authStore";
import { TEST_USER } from "./test/authFixtures";

// Full-app integration for the shared AdoConnectModal: the user picks one of the projects stored in
// Settings (source inferred from the URL, no PAT sent); Release Plan sync shows the plan's own connection read-only.
// Real routes, pages, stores and api modules; only `fetch` is mocked.

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path: string, credentials = ADO_CREDENTIALS) {
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
      <AuthProvider initialUser={TEST_USER}>
        <SettingsProvider initialItems={credentials}>
          <ForecastProvider>
            <RouterProvider router={router} />
          </ForecastProvider>
        </SettingsProvider>
      </AuthProvider>
    </ToastProvider>,
  );
}

type User = ReturnType<typeof userEvent.setup>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const location = () => screen.getByTestId("location").textContent;
const FIND = { timeout: 5_000 };
const TIMEOUT = 30_000;
const CLOUD_URL = "https://dev.azure.com/org/Proj";
const ONPREM_SAVED = { source: "onprem", projectUrl: "https://tfs.example.com/C/P" };

/** `POST /api/plan` answer for the create flow (the new plan gets id 42). */
const createdPlan = () =>
  json({ id: 42, name: "Proj", projectType: "cloud", projectName: "Proj", createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z", state: {} }, 201);

function mockFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init: RequestInit = {}) => {
    const handler = routes[String(input)];
    if (!handler) {
      throw new Error(`unexpected ${String(input)}`);
    }
    return handler();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const bodiesTo = (fetchMock: ReturnType<typeof mockFetch>, url: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u) === url).map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

async function openMonteCarloModal(user: User) {
  await user.click(screen.getByRole("button", { name: /Load from Azure DevOps/ }));
  return screen.getByRole("dialog", { name: "Load from Azure DevOps" });
}

async function openReleasePlanCreateModal(user: User) {
  await user.click(screen.getByRole("button", { name: /Create from Azure DevOps/ }));
  return screen.getByRole("dialog", { name: "Create from Azure DevOps" });
}

describe("ADO connection modal – project from Settings (full app)", { timeout: TIMEOUT }, () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("Monte Carlo: selecting a project and Connect sends its URL and the inferred source, no PAT, and loads the sprint history", async () => {
    const fetchMock = mockFetch({
      "/api/ado/connect": () => json(makeConnectResponse()),
      "/api/ado/sprint-history": () => json(makeSprintHistory()),
    });
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const dialog = await openMonteCarloModal(user);
    expect(within(dialog).getByLabelText("Project")).toHaveValue("");
    expect(within(dialog).queryByRole("alert")).toBeNull();

    await user.selectOptions(within(dialog).getByLabelText("Project"), "Proj");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    const tree = await within(dialog).findByRole("tree", { name: "Iteration path" }, FIND);
    expect(bodiesTo(fetchMock, "/api/ado/connect")).toEqual([{ source: "cloud", projectUrl: CLOUD_URL }]);

    await user.click(within(tree).getByRole("treeitem", { name: /^Phase 1/ }));
    await user.click(within(dialog).getByRole("button", { name: "Load sprint history" }));
    await waitFor(() => expect(location()).toBe("/monte-carlo/input"), FIND);
    expect(bodiesTo(fetchMock, "/api/ado/sprint-history")[0]).toEqual({ source: "cloud", projectUrl: CLOUD_URL, iterationPath: "Proj\\Phase 1" });
    expect(JSON.parse(window.localStorage.getItem(MONTE_CARLO_KEY) ?? "null")).toEqual({ source: "cloud", projectUrl: CLOUD_URL });
    expect(window.localStorage.getItem(RELEASE_PLAN_KEY)).toBeNull();
  });

  it("Monte Carlo: Connect without a selected project asks for one and sends nothing", async () => {
    const fetchMock = mockFetch({});
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const dialog = await openMonteCarloModal(user);
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Select an Azure DevOps project.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an on-prem project is connected with source \"onprem\"", async () => {
    const fetchMock = mockFetch({ "/api/ado/connect": () => json(makeConnectResponse({ projectUrl: ONPREM_SAVED.projectUrl })) });
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const dialog = await openMonteCarloModal(user);
    await user.selectOptions(within(dialog).getByLabelText("Project"), "Legacy");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByRole("tree", {}, FIND);
    expect(bodiesTo(fetchMock, "/api/ado/connect")).toEqual([{ source: "onprem", projectUrl: ONPREM_SAVED.projectUrl }]);
  });

  it("with no stored project the modal offers 'Open settings', which opens the real Settings modal", async () => {
    const fetchMock = mockFetch({});
    const user = userEvent.setup();
    renderApp("/release-plan", []);

    const dialog = await openReleasePlanCreateModal(user);
    expect(within(dialog).getByText("No Azure DevOps projects configured yet.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Connect" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/ado/"))).toBe(false);
  });

  it("Release Plan home: the create modal creates a board from the selected project", async () => {
    const fetchMock = mockFetch({
      "/api/ado/connect": () => json(makeConnectResponse()),
      "/api/ado/backlog": () => json(makeBacklog()),
      "/api/plan": createdPlan,
    });
    const user = userEvent.setup();
    renderApp("/release-plan");

    const dialog = await openReleasePlanCreateModal(user);
    await user.selectOptions(within(dialog).getByLabelText("Project"), "Proj");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    const tree = await within(dialog).findByRole("tree", { name: "Area path" }, FIND);
    await user.click(within(tree).getByRole("treeitem", { name: /^Team A/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(location()).toBe("/release-plan/42"), FIND);

    expect(bodiesTo(fetchMock, "/api/ado/connect")[0]).toEqual({ source: "cloud", projectUrl: CLOUD_URL });
    expect(bodiesTo(fetchMock, "/api/ado/backlog")[0]).toMatchObject({ source: "cloud", scopeType: "area" });
    expect(bodiesTo(fetchMock, "/api/ado/backlog")[0]).not.toHaveProperty("pat");
    expect(JSON.parse(window.localStorage.getItem(RELEASE_PLAN_KEY) ?? "null")).toEqual({ source: "cloud", projectUrl: CLOUD_URL });
    expect(window.localStorage.getItem(MONTE_CARLO_KEY)).toBeNull();
    const created = bodiesTo(fetchMock, "/api/plan")[0] as { projectType?: string; state?: { source?: { kind?: string } } };
    expect(created.projectType).toBe("cloud");
    expect(created.state?.source).toMatchObject({ kind: "cloud" });
  });

  it("a remembered project in Release Plan's key does not preselect one in Monte Carlo (and is used by Release Plan)", async () => {
    window.localStorage.setItem(RELEASE_PLAN_KEY, JSON.stringify(ONPREM_SAVED));
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const mc = await openMonteCarloModal(user);
    expect(within(mc).getByLabelText("Project")).toHaveValue("");
    await user.keyboard("{Escape}");

    await user.click(within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name: "Release Plan" }));
    const rp = await openReleasePlanCreateModal(user);
    expect(within(rp).getByLabelText("Project")).toHaveValue("12");
  });

  it("a remembered project in Monte Carlo's key does not preselect one in Release Plan (and is used by Monte Carlo)", async () => {
    window.localStorage.setItem(MONTE_CARLO_KEY, JSON.stringify(ONPREM_SAVED));
    const user = userEvent.setup();
    renderApp("/release-plan");

    const rp = await openReleasePlanCreateModal(user);
    expect(within(rp).getByLabelText("Project")).toHaveValue("");
    await user.keyboard("{Escape}");

    await user.click(within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name: "Monte Carlo" }));
    const mc = await openMonteCarloModal(user);
    expect(within(mc).getByLabelText("Project")).toHaveValue("12");
  });

  it("a malformed or stale remembered connection selects no project", async () => {
    window.localStorage.setItem(MONTE_CARLO_KEY, JSON.stringify({ source: "github", projectUrl: "x" }));
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const mc = await openMonteCarloModal(user);
    expect(within(mc).getByLabelText("Project")).toHaveValue("");
    await user.keyboard("{Escape}");

    window.localStorage.setItem(MONTE_CARLO_KEY, JSON.stringify({ source: "cloud", projectUrl: "https://dev.azure.com/org/Deleted" }));
    const again = await openMonteCarloModal(user);
    expect(within(again).getByLabelText("Project")).toHaveValue("");
  });

  it("Release Plan sync of an old plan (no connection info) ignores the remembered connection: the board isn't linked", async () => {
    mockFetch({ "/api/plan/1": () => json(planDetail(1, samplePlan())) });
    window.localStorage.setItem(RELEASE_PLAN_KEY, JSON.stringify(ONPREM_SAVED));
    const user = userEvent.setup();
    renderApp("/release-plan/1");
    await screen.findByRole("region", { name: "Milestone summary" }, FIND);

    const toolbar = document.querySelector<HTMLElement>(".rp .toolbar");
    expect(toolbar).not.toBeNull();
    await user.click(within(toolbar!).getByRole("button", { name: "Sync from ADO" }));
    const dialog = screen.getByRole("dialog", { name: "Sync from Azure DevOps" });
    expect(dialog).toHaveTextContent("This board isn't linked to an Azure DevOps project, so it can't be synced.");
    expect(dialog).not.toHaveTextContent(ONPREM_SAVED.projectUrl);
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
  });

  it("Release Plan sync of a plan with cloud connection info wins over a remembered On-Prem connection", async () => {
    // Build a plan whose source carries cloud connection info by creating it through the UI first.
    const fetchMock = mockFetch({
      "/api/ado/connect": () => json(makeConnectResponse()),
      "/api/ado/backlog": () => json(makeBacklog()),
      "/api/plan": createdPlan,
    });
    const user = userEvent.setup();
    renderApp("/release-plan");
    const create = await openReleasePlanCreateModal(user);
    await user.selectOptions(within(create).getByLabelText("Project"), "Proj");
    await user.click(within(create).getByRole("button", { name: "Connect" }));
    const tree = await within(create).findByRole("tree", { name: "Area path" }, FIND);
    await user.click(within(tree).getByRole("treeitem", { name: /^Team A/ }));
    await user.click(within(create).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(location()).toBe("/release-plan/42"), FIND);
    expect(fetchMock).toHaveBeenCalled();

    // Another session remembers On-Prem for Release Plan; the plan's own connection must still win.
    window.localStorage.setItem(RELEASE_PLAN_KEY, JSON.stringify(ONPREM_SAVED));
    const toolbar = document.querySelector<HTMLElement>(".rp .toolbar");
    await user.click(within(toolbar!).getByRole("button", { name: "Sync from ADO" }));
    const dialog = screen.getByRole("dialog", { name: "Sync from Azure DevOps" });
    const shown = (label: string) => within(dialog).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(shown("Azure DevOps source")).toBe("Collaboration Hub");
    expect(shown("Project URL")).toBe(CLOUD_URL);
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
  });
});
