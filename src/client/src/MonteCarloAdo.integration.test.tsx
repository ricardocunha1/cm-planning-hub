import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { ToastProvider } from "./components/Toast";
import { ADO_CONNECTION_KEY as MONTE_CARLO_KEY } from "./lib/monteCarlo/constants";
import { ADO_CONNECTION_KEY as RELEASE_PLAN_KEY } from "./lib/releasePlan/constants";
import { ForecastProvider } from "./monteCarloStore";
import { makeConnectResponse } from "./test/adoFixtures";
import { makeSprintHistory, result, validation } from "./test/monteCarloFixtures";

// QA full-app integration for the Monte Carlo "Load from Azure DevOps" data
// source: real routes, pages, stores, modals and api.ts; only `fetch` (at the
// network boundary) and the Plotly chart are mocked. Synthetic data only.
vi.mock("./components/monteCarlo/HistogramChart", () => ({
  default: ({ histogram }: { histogram: { labels: string[] } }) => (
    <div data-testid="histogram">{histogram.labels.length} buckets</div>
  ),
}));

function RouterProbe() {
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="location">{useLocation().pathname}</div>
      <button type="button" data-testid="go-input" onClick={() => navigate("/monte-carlo/input")} />
    </div>
  );
}

function renderApp(path = "/monte-carlo") {
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <Outlet />
            <RouterProbe />
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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PAT = "qa-sprint-history-pat-0123";
const URL_OK = "https://dev.azure.com/org/Proj";
const FLOW_TIMEOUT_MS = 30_000;
const FIND = { timeout: 5_000 };
const WARNING = "The field Microsoft.VSTS.Scheduling.StoryPoints does not exist in this project; story points are 0.";

type Route = (init: RequestInit) => Response | Promise<Response>;

/** Routes fetch by URL; each route's responses are consumed in order (last one repeats). */
function mockFetch(routes: Record<string, Route[]>) {
  const used: Record<string, number> = {};
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const handlers = routes[url];
    if (!handlers) {
      throw new Error(`unexpected ${url}`);
    }
    const index = Math.min(used[url] ?? 0, handlers.length - 1);
    used[url] = (used[url] ?? 0) + 1;
    return handlers[index](init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof mockFetch>, url: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u) === url).map(([, init]) => init as RequestInit);

const location = () => screen.getByTestId("location").textContent;
const adoCard = () => screen.getByRole("button", { name: /Load from Azure DevOps/ });
const adoDialog = () => screen.getByRole("dialog", { name: "Load from Azure DevOps" });
const adoSourceCard = () => screen.getByRole("region", { name: "Data source: Azure DevOps" });

/** /monte-carlo → ADO card → connection → Connect → pick `pathName` → Load sprint history. */
async function loadFromAdo(user: ReturnType<typeof userEvent.setup>, pathName = /^Phase 1/) {
  await user.click(adoCard());
  const dialog = adoDialog();
  await user.click(within(dialog).getByRole("radio", { name: "Collaboration Hub" }));
  await user.clear(within(dialog).getByLabelText("Project URL"));
  await user.type(within(dialog).getByLabelText("Project URL"), URL_OK);
  await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
  await user.click(within(dialog).getByRole("button", { name: "Connect" }));
  const tree = await within(dialog).findByRole("tree", { name: "Iteration path" }, FIND);
  await user.click(within(tree).getByRole("treeitem", { name: pathName }));
  await user.click(within(dialog).getByRole("button", { name: "Load sprint history" }));
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, { skip = false } = {}) {
  await user.type(screen.getByLabelText(/Target Value/), "100");
  fireEvent.change(screen.getByLabelText(/Sprint Start Date/), { target: { value: "2026-01-05" } });
  if (skip) {
    await user.click(screen.getByLabelText(/Skip Historical Sprint Validation/));
  }
  fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
}

function assertNoPatAnywhere(fetchMock: ReturnType<typeof mockFetch>) {
  for (let i = 0; i < window.localStorage.length; i++) {
    expect(window.localStorage.getItem(window.localStorage.key(i) ?? "")).not.toContain(PAT);
  }
  for (const [url, init] of fetchMock.mock.calls) {
    if (String(url) === "/api/ado/connect" || String(url) === "/api/ado/sprint-history") {
      continue;
    }
    const body = (init as RequestInit | undefined)?.body;
    const text = body instanceof FormData ? JSON.stringify([...body.entries()].map(([k, v]) => [k, String(v)])) : String(body ?? "");
    expect(text).not.toContain(PAT);
  }
}

describe("Monte Carlo – Load from Azure DevOps (full app)", () => {
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("ADO → input → confirm → results: posts the work items verbatim as sprint_history_items, then the validate response to simulate", async () => {
    const history = makeSprintHistory({ warnings: [WARNING] });
    const fetchMock = mockFetch({
      "/api/ado/connect": [() => json(makeConnectResponse())],
      "/api/ado/sprint-history": [() => json(history)],
      "/api/validate": [() => json(validation)],
      "/api/simulate": [() => json(result)],
    });
    const user = userEvent.setup();
    renderApp();

    await loadFromAdo(user);
    await waitFor(() => expect(location()).toBe("/monte-carlo/input"), FIND);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // The sprint-history request: connection + picked path, PAT in the JSON body only.
    const [historyInit] = callsTo(fetchMock, "/api/ado/sprint-history");
    expect(JSON.parse(String(historyInit.body))).toEqual({ source: "cloud", projectUrl: URL_OK, pat: PAT, iterationPath: "Proj\\Phase 1" });

    // Warnings become info toasts; the source card summarizes the load.
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toContain(WARNING);
    const card = adoSourceCard();
    expect(card).toHaveTextContent("MES Core");
    expect(card).toHaveTextContent("MES Core\\Release 11");
    expect(within(card).getByText("Work items").nextElementSibling).toHaveTextContent("3");

    await fillAndSubmit(user);
    const confirm = await screen.findByRole("button", { name: "Confirm and Run Simulation" }, FIND);
    expect(location()).toBe("/monte-carlo/confirm");

    const [validateInit] = callsTo(fetchMock, "/api/validate");
    const form = validateInit.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.has("sprint_history_file")).toBe(false);
    expect(form.getAll("sprint_history_items")).toHaveLength(1);
    expect(JSON.parse(String(form.get("sprint_history_items")))).toEqual(history.workItems);
    expect(form.get("target_value")).toBe("100");

    await user.click(confirm);
    expect(await screen.findByText("Calendar View", undefined, FIND)).toBeInTheDocument();
    expect(location()).toBe("/monte-carlo/results");
    const [simulateInit] = callsTo(fetchMock, "/api/simulate");
    expect(JSON.parse(String(simulateInit.body))).toEqual({ summary: validation.summary, params: validation.params });

    assertNoPatAnywhere(fetchMock);
    expect(JSON.parse(window.localStorage.getItem(MONTE_CARLO_KEY) ?? "null")).toEqual({ source: "cloud", projectUrl: URL_OK });
    expect(window.localStorage.getItem(RELEASE_PLAN_KEY)).toBeNull();
  }, FLOW_TIMEOUT_MS);

  it("skip validation goes from the ADO source straight to results with the same request bodies", async () => {
    const fetchMock = mockFetch({
      "/api/ado/connect": [() => json(makeConnectResponse())],
      "/api/ado/sprint-history": [() => json(makeSprintHistory())],
      "/api/validate": [() => json({ ...validation, params: { ...validation.params, skip_validation: true } })],
      "/api/simulate": [() => json(result)],
    });
    const user = userEvent.setup();
    renderApp();

    await loadFromAdo(user);
    await waitFor(() => expect(location()).toBe("/monte-carlo/input"), FIND);
    await fillAndSubmit(user, { skip: true });
    expect(await screen.findByText("Calendar View", undefined, FIND)).toBeInTheDocument();
    expect(location()).toBe("/monte-carlo/results");

    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual([
      "/api/ado/connect",
      "/api/ado/sprint-history",
      "/api/validate",
      "/api/simulate",
    ]);
    const form = callsTo(fetchMock, "/api/validate")[0].body as FormData;
    expect(form.get("skip_validation")).toBe("on");
    expect(JSON.parse(String(form.get("sprint_history_items")))).toEqual(makeSprintHistory().workItems);
  }, FLOW_TIMEOUT_MS);

  it("a sprint-history 422 stays in the modal (inline error, no navigation, nothing stored)", async () => {
    const message = "No resolved User Stories or Bugs were found under Iteration path: Proj\\Phase 1.";
    mockFetch({
      "/api/ado/connect": [() => json(makeConnectResponse())],
      "/api/ado/sprint-history": [() => json({ errors: [message] }, 422)],
    });
    const user = userEvent.setup();
    renderApp();

    await loadFromAdo(user);
    expect(await within(adoDialog()).findByText(message, undefined, FIND)).toBeInTheDocument();
    expect(location()).toBe("/monte-carlo");
    expect(within(adoDialog()).getByRole("button", { name: "Load sprint history" })).toBeEnabled();

    await user.click(within(adoDialog()).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByTestId("go-input"));
    expect(location()).toBe("/monte-carlo"); // no data source was stored
  }, FLOW_TIMEOUT_MS);

  it("a validate 422 for the ADO items is an error toast; the page and the ADO source card stay", async () => {
    const message = "The Azure DevOps sprint history is invalid.";
    mockFetch({
      "/api/ado/connect": [() => json(makeConnectResponse())],
      "/api/ado/sprint-history": [() => json(makeSprintHistory())],
      "/api/validate": [() => json({ errors: [message, "Target Value must be a positive number."] }, 422)],
    });
    const user = userEvent.setup();
    renderApp();

    await loadFromAdo(user);
    await waitFor(() => expect(location()).toBe("/monte-carlo/input"), FIND);
    await fillAndSubmit(user);
    const alert = await screen.findByRole("alert", undefined, FIND);
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent("Target Value must be a positive number.");
    expect(location()).toBe("/monte-carlo/input");
    expect(adoSourceCard()).toBeInTheDocument();
  }, FLOW_TIMEOUT_MS);

  it("switching from the ADO source to an Excel file sends the file and no sprint_history_items", async () => {
    const fetchMock = mockFetch({
      "/api/ado/connect": [() => json(makeConnectResponse())],
      "/api/ado/sprint-history": [() => json(makeSprintHistory())],
      "/api/validate": [() => json(validation)],
    });
    const user = userEvent.setup();
    renderApp();

    await loadFromAdo(user);
    await waitFor(() => expect(location()).toBe("/monte-carlo/input"), FIND);
    await user.click(screen.getByRole("link", { name: "Change data source" }));
    expect(location()).toBe("/monte-carlo");

    await user.click(screen.getByRole("button", { name: /Import an Excel file/ }));
    const file = new File(["xlsx"], "Sprint_History.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const excel = screen.getByRole("dialog", { name: "Import an Excel file" });
    await user.upload(within(excel).getByLabelText("Sprint history file"), file);
    await user.click(within(excel).getByRole("button", { name: "Continue" }));
    expect(location()).toBe("/monte-carlo/input");
    expect(screen.getByRole("region", { name: "Data source: Excel file" })).toHaveTextContent("Sprint_History.xlsx");

    await fillAndSubmit(user);
    await screen.findByRole("button", { name: "Confirm and Run Simulation" }, FIND);
    const form = callsTo(fetchMock, "/api/validate")[0].body as FormData;
    expect(form.get("sprint_history_file")).toBe(file);
    expect(form.has("sprint_history_items")).toBe(false);
  }, FLOW_TIMEOUT_MS);

  it("re-opening the modal pre-fills Monte Carlo's remembered connection (never the PAT); Release Plan's modal is not affected", async () => {
    mockFetch({
      "/api/ado/connect": [() => json(makeConnectResponse())],
      "/api/ado/sprint-history": [() => json(makeSprintHistory())],
    });
    window.localStorage.setItem(RELEASE_PLAN_KEY, JSON.stringify({ source: "onprem", projectUrl: "https://tfs.example.com/Coll/Other" }));
    const user = userEvent.setup();
    renderApp();

    await loadFromAdo(user);
    await waitFor(() => expect(location()).toBe("/monte-carlo/input"), FIND);
    await user.click(screen.getByRole("link", { name: "Change data source" }));

    await user.click(adoCard());
    expect(within(adoDialog()).getByRole("radio", { name: "Collaboration Hub" })).toBeChecked();
    expect(within(adoDialog()).getByLabelText("Project URL")).toHaveValue(URL_OK);
    expect(within(adoDialog()).getByLabelText("Personal Access Token")).toHaveValue("");
    await user.keyboard("{Escape}");

    // Release Plan keeps its own remembered connection.
    await user.click(within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name: "Release Plan" }));
    await user.click(screen.getByRole("button", { name: /Create from Azure DevOps/ }));
    const rp = screen.getByRole("dialog", { name: "Create from Azure DevOps" });
    expect(within(rp).getByRole("radio", { name: "On-Prem" })).toBeChecked();
    expect(within(rp).getByLabelText("Project URL")).toHaveValue("https://tfs.example.com/Coll/Other");
    expect(JSON.parse(window.localStorage.getItem(RELEASE_PLAN_KEY) ?? "null")).toEqual({ source: "onprem", projectUrl: "https://tfs.example.com/Coll/Other" });
  }, FLOW_TIMEOUT_MS);

  it("closing the modal while the sprint history loads aborts the request and changes nothing", async () => {
    let historySignal: AbortSignal | undefined;
    mockFetch({
      "/api/ado/connect": [() => json(makeConnectResponse())],
      "/api/ado/sprint-history": [
        (init) =>
          new Promise<Response>((_, reject) => {
            historySignal = init.signal ?? undefined;
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }),
      ],
    });
    const user = userEvent.setup();
    renderApp();

    await loadFromAdo(user);
    expect(await within(adoDialog()).findByRole("button", { name: "Loading work items…" }, FIND)).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(historySignal?.aborted).toBe(true);
    expect(location()).toBe("/monte-carlo");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  }, FLOW_TIMEOUT_MS);
});
