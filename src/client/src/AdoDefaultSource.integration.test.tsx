import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { ToastProvider } from "./components/Toast";
import { PLACEHOLDER } from "./lib/ado/url";
import { ADO_CONNECTION_KEY as MONTE_CARLO_KEY } from "./lib/monteCarlo/constants";
import { ADO_CONNECTION_KEY as RELEASE_PLAN_KEY } from "./lib/releasePlan/constants";
import { ForecastProvider } from "./monteCarloStore";
import { makeBacklog, makeConnectResponse } from "./test/adoFixtures";
import { makeSprintHistory } from "./test/monteCarloFixtures";
import { planDetail } from "./test/planServer";
import { samplePlan } from "./test/releasePlanFixtures";

// QA full-app integration for "Collaboration Hub selected by default" in the
// shared AdoConnectModal (Monte Carlo load + Release Plan create; Release Plan
// sync shows the plan's own connection read-only).
// Real routes, pages, stores and api modules; only `fetch` is mocked.

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

type User = ReturnType<typeof userEvent.setup>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const location = () => screen.getByTestId("location").textContent;
const FIND = { timeout: 5_000 };
const TIMEOUT = 30_000;
const PAT = "qa-default-source-pat-42";
const CLOUD_URL = "https://dev.azure.com/org/Proj";
const ONPREM_SAVED = { source: "onprem", projectUrl: "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/Other" };

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

/** Exactly one source radio is checked, and it is `checked`. */
function expectSourceChecked(dialog: HTMLElement, checked: "Collaboration Hub" | "On-Prem") {
  const radios = within(dialog).getAllByRole("radio").filter((r) => r.getAttribute("name") === "ado-source");
  expect(radios).toHaveLength(2);
  expect(radios.filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1);
  expect(within(dialog).getByRole("radio", { name: checked })).toBeChecked();
}

async function openMonteCarloModal(user: User) {
  await user.click(screen.getByRole("button", { name: /Load from Azure DevOps/ }));
  return screen.getByRole("dialog", { name: "Load from Azure DevOps" });
}

async function openReleasePlanCreateModal(user: User) {
  await user.click(screen.getByRole("button", { name: /Create from Azure DevOps/ }));
  return screen.getByRole("dialog", { name: "Create from Azure DevOps" });
}

describe("ADO connection modal – Collaboration Hub by default (full app)", { timeout: TIMEOUT }, () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("Monte Carlo: Connect without touching the radios sends source \"cloud\" and loads the sprint history", async () => {
    const fetchMock = mockFetch({
      "/api/ado/connect": () => json(makeConnectResponse()),
      "/api/ado/sprint-history": () => json(makeSprintHistory()),
    });
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const dialog = await openMonteCarloModal(user);
    expectSourceChecked(dialog, "Collaboration Hub");
    const url = within(dialog).getByLabelText("Project URL");
    expect(url).toHaveValue("");
    expect(url).toHaveAttribute("placeholder", PLACEHOLDER.cloud);
    expect(within(dialog).queryByRole("alert")).toBeNull();

    await user.type(url, CLOUD_URL);
    await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    const tree = await within(dialog).findByRole("tree", { name: "Iteration path" }, FIND);
    expect(bodiesTo(fetchMock, "/api/ado/connect")).toEqual([{ source: "cloud", projectUrl: CLOUD_URL, pat: PAT }]);

    await user.click(within(tree).getByRole("treeitem", { name: /^Phase 1/ }));
    await user.click(within(dialog).getByRole("button", { name: "Load sprint history" }));
    await waitFor(() => expect(location()).toBe("/monte-carlo/input"), FIND);
    expect(bodiesTo(fetchMock, "/api/ado/sprint-history")[0]).toMatchObject({ source: "cloud", projectUrl: CLOUD_URL });
    expect(JSON.parse(window.localStorage.getItem(MONTE_CARLO_KEY) ?? "null")).toEqual({ source: "cloud", projectUrl: CLOUD_URL });
    expect(window.localStorage.getItem(RELEASE_PLAN_KEY)).toBeNull();
  });

  it("Monte Carlo: an empty form with the default source shows the URL/PAT errors only (never the source-required one) and sends nothing", async () => {
    const fetchMock = mockFetch({});
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const dialog = await openMonteCarloModal(user);
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    const alert = within(dialog).getByRole("alert");
    expect(alert).not.toHaveTextContent("Choose the Azure DevOps source");
    expect(alert).toHaveTextContent("project URL");
    expect(within(dialog).getByRole("group", { name: "Azure DevOps source" })).not.toHaveAttribute("aria-describedby");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keyboard: Tab lands on the checked Collaboration Hub radio; an arrow key moves to On-Prem and updates the placeholder and the request", async () => {
    const fetchMock = mockFetch({ "/api/ado/connect": () => json(makeConnectResponse({ projectUrl: ONPREM_SAVED.projectUrl })) });
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const dialog = await openMonteCarloModal(user);
    const cloud = within(dialog).getByRole("radio", { name: "Collaboration Hub" });
    const onprem = within(dialog).getByRole("radio", { name: "On-Prem" });
    cloud.focus();
    expect(cloud).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(onprem).toBeChecked());
    expectSourceChecked(dialog, "On-Prem");
    expect(within(dialog).getByLabelText("Project URL")).toHaveAttribute("placeholder", PLACEHOLDER.onprem);

    await user.type(within(dialog).getByLabelText("Project URL"), ONPREM_SAVED.projectUrl);
    await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByRole("tree", {}, FIND);
    expect(bodiesTo(fetchMock, "/api/ado/connect")[0]).toMatchObject({ source: "onprem" });
  });

  it("Release Plan home: the create modal defaults to Collaboration Hub with the cloud placeholder and creates a board without touching the radios", async () => {
    const fetchMock = mockFetch({
      "/api/ado/connect": () => json(makeConnectResponse()),
      "/api/ado/backlog": () => json(makeBacklog()),
      "/api/plan": createdPlan,
    });
    const user = userEvent.setup();
    renderApp("/release-plan");

    const dialog = await openReleasePlanCreateModal(user);
    expectSourceChecked(dialog, "Collaboration Hub");
    expect(within(dialog).getByLabelText("Project URL")).toHaveAttribute("placeholder", PLACEHOLDER.cloud);
    await user.type(within(dialog).getByLabelText("Project URL"), CLOUD_URL);
    await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    const tree = await within(dialog).findByRole("tree", { name: "Area path" }, FIND);
    await user.click(within(tree).getByRole("treeitem", { name: /^Team A/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(location()).toBe("/release-plan/42"), FIND);

    expect(bodiesTo(fetchMock, "/api/ado/connect")[0]).toMatchObject({ source: "cloud" });
    expect(bodiesTo(fetchMock, "/api/ado/backlog")[0]).toMatchObject({ source: "cloud", scopeType: "area" });
    expect(JSON.parse(window.localStorage.getItem(RELEASE_PLAN_KEY) ?? "null")).toEqual({ source: "cloud", projectUrl: CLOUD_URL });
    expect(window.localStorage.getItem(MONTE_CARLO_KEY)).toBeNull();
    const created = bodiesTo(fetchMock, "/api/plan")[0] as { projectType?: string; state?: { source?: { kind?: string } } };
    expect(created.projectType).toBe("cloud");
    expect(created.state?.source).toMatchObject({ kind: "cloud" });
  });

  it("a remembered On-Prem connection in Release Plan's key does not change Monte Carlo's default (and is used by Release Plan)", async () => {
    window.localStorage.setItem(RELEASE_PLAN_KEY, JSON.stringify(ONPREM_SAVED));
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const mc = await openMonteCarloModal(user);
    expectSourceChecked(mc, "Collaboration Hub");
    expect(within(mc).getByLabelText("Project URL")).toHaveValue("");
    await user.keyboard("{Escape}");

    await user.click(within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name: "Release Plan" }));
    const rp = await openReleasePlanCreateModal(user);
    expectSourceChecked(rp, "On-Prem");
    expect(within(rp).getByLabelText("Project URL")).toHaveValue(ONPREM_SAVED.projectUrl);
    expect(within(rp).getByLabelText("Project URL")).toHaveAttribute("placeholder", PLACEHOLDER.onprem);
  });

  it("a remembered On-Prem connection in Monte Carlo's key does not change Release Plan's default (and is used by Monte Carlo)", async () => {
    window.localStorage.setItem(MONTE_CARLO_KEY, JSON.stringify(ONPREM_SAVED));
    const user = userEvent.setup();
    renderApp("/release-plan");

    const rp = await openReleasePlanCreateModal(user);
    expectSourceChecked(rp, "Collaboration Hub");
    expect(within(rp).getByLabelText("Project URL")).toHaveValue("");
    await user.keyboard("{Escape}");

    await user.click(within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name: "Monte Carlo" }));
    const mc = await openMonteCarloModal(user);
    expectSourceChecked(mc, "On-Prem");
    expect(within(mc).getByLabelText("Project URL")).toHaveValue(ONPREM_SAVED.projectUrl);
  });

  it("a malformed remembered connection falls back to the Collaboration Hub default", async () => {
    window.localStorage.setItem(MONTE_CARLO_KEY, JSON.stringify({ source: "github", projectUrl: "x" }));
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const mc = await openMonteCarloModal(user);
    expectSourceChecked(mc, "Collaboration Hub");
    expect(within(mc).getByLabelText("Project URL")).toHaveValue("");
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
    await user.type(within(create).getByLabelText("Project URL"), CLOUD_URL);
    await user.type(within(create).getByLabelText("Personal Access Token"), PAT);
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
