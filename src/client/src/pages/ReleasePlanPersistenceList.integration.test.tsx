// QA integration tests for the saved-plans list and create-with-name (plans/release-plan-persistence.md, Phase 3).
// Real App routes, pages and components, real planApi/api.ts; only `fetch` is mocked at the network boundary.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "../App";
import { ToastProvider } from "../components/Toast";
import type { PlanSummary } from "../lib/releasePlan/planTypes";
import { ForecastProvider } from "../monteCarloStore";
import { makeBacklog, makeConnectResponse } from "../test/adoFixtures";

const PAT = "qa-secret-pat-0123456789";
const CANONICAL = "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/My%20Proj";
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const toastTexts = () => screen.queryAllByRole("status").map((s) => s.textContent ?? "");

const summary = (id: number, name = `Plan ${id}`): PlanSummary => ({
  id,
  name,
  projectType: id % 2 ? "onprem" : "cloud",
  projectName: `Proj ${id}`,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T11:30:00Z",
});

/** A fake server with `total` plans (ids total..1, newest first), 10 per page. */
function fakeServer(total: number, opts: { listFail?: () => Response | null; postFail?: () => Response | null } = {}) {
  const ids = Array.from({ length: total }, (_, i) => total - i);
  const calls: { method: string; url: string; body?: unknown; signal?: AbortSignal }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal ?? undefined });
    if (url.startsWith("/api/plan") && method === "GET" && !/\/api\/plan\/\d+/.test(url)) {
      const failure = opts.listFail?.();
      if (failure) {
        return failure;
      }
      const page = Number(new URL(url, "http://x").searchParams.get("page") ?? "1");
      const slice = ids.slice((page - 1) * 10, page * 10);
      return json({ items: slice.map((id) => summary(id)), total: ids.length, page, pageSize: 10 });
    }
    const del = /^\/api\/plan\/(\d+)$/.exec(url);
    if (del && method === "DELETE") {
      const id = Number(del[1]);
      ids.splice(ids.indexOf(id), 1);
      return new Response(null, { status: 204 });
    }
    if (url === "/api/plan" && method === "POST") {
      const failure = opts.postFail?.();
      if (failure) {
        return failure;
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ id: 77, ...body, createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" }, 201);
    }
    if (url === "/api/ado/connect") {
      return json(makeConnectResponse({ project: { id: "guid-1", name: "My Proj" }, projectUrl: CANONICAL }));
    }
    if (url === "/api/ado/backlog") {
      return json(
        makeBacklog({
          project: { id: "guid-1", name: "My Proj" },
          projectUrl: CANONICAL,
          scope: "Iteration Path: Proj\\Phase 1\\Sprint 02",
          warnings: ["A backlog warning."],
        }),
      );
    }
    return json({ errors: [`unexpected ${method} ${url}`] }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, ids };
}

const rows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
const adoDialog = () => screen.getByRole("dialog", { name: "Create from Azure DevOps" });

async function reachPlanNameStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Create from Azure DevOps/ }));
  const dialog = adoDialog();
  await user.click(within(dialog).getByRole("radio", { name: "On-Prem" }));
  await user.clear(within(dialog).getByLabelText("Project URL"));
  await user.type(within(dialog).getByLabelText("Project URL"), CANONICAL);
  await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
  await user.click(within(dialog).getByRole("button", { name: "Connect" }));
  await screen.findByRole("tree", { name: "Area path" }, FIND);
  await user.click(within(dialog).getByRole("radio", { name: "Iteration path" }));
  await user.type(within(dialog).getByLabelText("Search Iteration path"), "sprint 02");
  const tree = within(dialog).getByRole("tree", { name: "Iteration path" });
  within(tree).getAllByRole("treeitem")[0].focus();
  await user.keyboard("{End}{Enter}");
}

describe("Release Plan – saved plans list and create-with-name (integration)", { timeout: TIMEOUT }, () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("lists page 1 with columns, links and labels; pages forward and back; hides the pager for <= 10 plans", async () => {
    const user = userEvent.setup();
    const { calls } = fakeServer(25);
    renderApp("/release-plan");
    expect(screen.getByText("Loading saved release plans…")).toBeInTheDocument();
    await waitFor(() => expect(rows()).toHaveLength(10), FIND);
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Name",
      "Project",
      "Created On",
      "Last modified",
      "Actions",
    ]);
    const first = rows()[0];
    expect(within(first).getByRole("link", { name: "Plan 25" })).toHaveAttribute("href", "/release-plan/25");
    expect(first).toHaveTextContent("On Prem · Proj 25");
    expect(first).toHaveTextContent(new Date("2026-10-01T10:00:00Z").toLocaleString());
    expect(first).toHaveTextContent(new Date("2026-10-02T11:30:00Z").toLocaleString());
    expect(rows()[1]).toHaveTextContent("Collaboration Hub · Proj 24");
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("link", { name: "Plan 15" }, FIND);
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("link", { name: "Plan 5" }, FIND);
    expect(rows()).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByRole("link", { name: "Plan 15" }, FIND);
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url)).toEqual([
      "/api/plan?page=1",
      "/api/plan?page=2",
      "/api/plan?page=3",
      "/api/plan?page=2",
    ]);
  });

  it("shows no pager for exactly 10 plans and the exact empty text for none", async () => {
    fakeServer(10);
    const first = renderApp("/release-plan");
    await waitFor(() => expect(rows()).toHaveLength(10), FIND);
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    first.unmount();

    fakeServer(0);
    renderApp("/release-plan");
    expect(await screen.findByText("No saved release plans yet. Create one from Azure DevOps.", {}, FIND)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("delete: Cancel keeps the plan; confirm sends DELETE, toasts and refetches the page", async () => {
    const user = userEvent.setup();
    const { calls } = fakeServer(12);
    renderApp("/release-plan");
    await waitFor(() => expect(rows()).toHaveLength(10), FIND);

    await user.click(screen.getByRole("button", { name: "Delete Plan 12" }));
    let dialog = screen.getByRole("dialog", { name: "Delete release plan" });
    expect(dialog).toHaveTextContent("Delete Plan 12? This cannot be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete Plan 12" }));
    dialog = screen.getByRole("dialog", { name: "Delete release plan" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Plan 12" })).not.toBeInTheDocument(), FIND);
    expect(await screen.findByRole("link", { name: "Plan 2" }, FIND)).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument(); // 11 plans left -> still 2 pages
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/plan/12"]);
    expect(toastTexts().some((t) => t.includes("Plan deleted: Plan 12"))).toBe(true);
  });

  it("deleting the only plan on the last page goes back one page", async () => {
    const user = userEvent.setup();
    const { calls } = fakeServer(11);
    renderApp("/release-plan");
    await waitFor(() => expect(rows()).toHaveLength(10), FIND);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("link", { name: "Plan 1" }, FIND);
    expect(rows()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Delete Plan 1" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rows()).toHaveLength(10), FIND);
    expect(screen.getByRole("link", { name: "Plan 10" })).toBeInTheDocument();
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url).pop()).toBe("/api/plan?page=1");
  });

  it("a failed delete toasts an error and keeps the list", async () => {
    const user = userEvent.setup();
    const server = fakeServer(3);
    const inner = server.fetchMock.getMockImplementation()!;
    server.fetchMock.mockImplementation(async (input, init) =>
      init?.method === "DELETE" ? json({ errors: ["Plan 3 not found."] }, 404) : inner(input, init),
    );
    renderApp("/release-plan");
    await waitFor(() => expect(rows()).toHaveLength(3), FIND);
    await user.click(screen.getByRole("button", { name: "Delete Plan 3" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Plan 3 not found\./, {}, FIND)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(rows()).toHaveLength(3);
  });

  it("a list error (503) shows the server's message with Retry; Retry refetches and recovers", async () => {
    const user = userEvent.setup();
    let failing = true;
    const { calls } = fakeServer(2, {
      listFail: () => (failing ? json({ errors: ["The database is unavailable."] }, 503) : null),
    });
    renderApp("/release-plan");
    expect(await screen.findByRole("alert", {}, FIND)).toHaveTextContent("The database is unavailable.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    failing = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(rows()).toHaveLength(2), FIND);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("a network failure on the list shows the error and Retry", async () => {
    fakeServer(1, {
      listFail: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderApp("/release-plan");
    expect(await screen.findByRole("alert", {}, FIND)).toHaveTextContent("Could not reach the server: Failed to fetch");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("aborts the in-flight list request on unmount and on page change; a stale response is ignored", async () => {
    const user = userEvent.setup();
    const pending: { resolve: (r: Response) => void; url: string; signal?: AbortSignal }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((resolve) => {
          pending.push({ resolve, url: String(input), signal: init?.signal ?? undefined });
        });
      }),
    );
    const page = (n: number) =>
      json({ items: [summary(n * 100, `Page${n} plan`)], total: 30, page: n, pageSize: 10 });
    const view = renderApp("/release-plan");
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0].resolve(page(1)));
    await screen.findByRole("link", { name: "Page1 plan" }, FIND);

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(pending).toHaveLength(2));
    // Page 2 is in flight; the user goes Previous -> a third request, the second is aborted.
    expect(screen.getByText("Loading saved release plans…")).toBeInTheDocument();
    view.unmount();
    expect(pending[1].signal?.aborted).toBe(true);
    // A late response after unmount must not blow up.
    await act(async () => pending[1].resolve(page(2)));
  });

  it("create from ADO: name pre-filled, edited, POST body exact, lands on /release-plan/<id> with the board and toasts", async () => {
    const user = userEvent.setup();
    const { calls } = fakeServer(0);
    renderApp("/release-plan");
    await reachPlanNameStep(user);
    const dialog = adoDialog();
    const nameInput = within(dialog).getByLabelText("Plan name");
    expect(nameInput).toHaveValue("My Proj – Feature Release Plan");
    await user.clear(nameInput);
    await user.type(nameInput, "   Q4 roadmap   ");
    await user.click(within(dialog).getByRole("button", { name: "Create board" }));

    await waitFor(() => expect(location()).toBe("/release-plan/77"), FIND);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Plan name")).toHaveValue("Q4 roadmap");
    expect(screen.getByRole("region", { name: "Board" })).toBeInTheDocument();
    const toasts = toastTexts();
    expect(toasts.some((t) => t.includes("Plan created: Q4 roadmap"))).toBe(true);
    expect(toasts.some((t) => t.includes("A backlog warning."))).toBe(true);

    const post = calls.find((c) => c.method === "POST" && c.url === "/api/plan");
    expect(post).toBeDefined();
    const body = post!.body as { name: string; projectType: string; projectName: string; state: { name: string; source: { kind: string } } };
    expect(Object.keys(body).sort()).toEqual(["name", "projectName", "projectType", "state"]);
    expect(body.name).toBe("Q4 roadmap");
    expect(body.projectType).toBe("onprem");
    expect(body.projectName).toBe("My Proj");
    expect(body.state.name).toBe("Q4 roadmap");
    expect(body.state.source.kind).toBe("onprem");
    expect(JSON.stringify(calls.filter((c) => c.url === "/api/plan"))).not.toContain(PAT);
  });

  it("validates the plan name inline (empty, > 200 chars) without any POST", async () => {
    const user = userEvent.setup();
    const { calls } = fakeServer(0);
    renderApp("/release-plan");
    await reachPlanNameStep(user);
    const dialog = adoDialog();
    const nameInput = within(dialog).getByLabelText("Plan name");
    await user.clear(nameInput);
    await user.type(nameInput, "   ");
    await user.click(within(dialog).getByRole("button", { name: "Create board" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Plan name is required.");
    expect(nameInput).toHaveAttribute("aria-invalid", "true");

    await user.clear(nameInput);
    await user.click(nameInput);
    await user.paste("x".repeat(201));
    await user.click(within(dialog).getByRole("button", { name: "Create board" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Plan name must be at most 200 characters.");
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/plan")).toBe(false);
    expect(location()).toBe("/release-plan");
  });

  it("accepts exactly 200 characters", async () => {
    const user = userEvent.setup();
    const { calls } = fakeServer(0);
    renderApp("/release-plan");
    await reachPlanNameStep(user);
    const dialog = adoDialog();
    const nameInput = within(dialog).getByLabelText("Plan name");
    await user.clear(nameInput);
    await user.click(nameInput);
    await user.paste("y".repeat(200));
    await user.click(within(dialog).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(location()).toBe("/release-plan/77"), FIND);
    expect((calls.find((c) => c.url === "/api/plan" && c.method === "POST")!.body as { name: string }).name).toHaveLength(200);
  });

  it("a POST 422 shows the server errors inline, keeps the modal and the name, and can be retried", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { calls } = fakeServer(0, {
      postFail: () => (fail ? json({ errors: ["name: String should have at most 200 characters"] }, 422) : null),
    });
    renderApp("/release-plan");
    await reachPlanNameStep(user);
    const dialog = adoDialog();
    await user.click(within(dialog).getByRole("button", { name: "Create board" }));
    expect(await within(dialog).findByRole("alert", {}, FIND)).toHaveTextContent("name: String should have at most 200 characters");
    expect(location()).toBe("/release-plan");
    expect(within(dialog).getByLabelText("Plan name")).toHaveValue("My Proj – Feature Release Plan");
    expect(within(dialog).getByRole("button", { name: "Create board" })).toBeEnabled();
    expect(toastTexts().some((t) => t.includes("Plan created"))).toBe(false);

    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(location()).toBe("/release-plan/77"), FIND);
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/plan")).toHaveLength(2);
  });

  it("a POST 503 (database unavailable) is shown inline and nothing is created", async () => {
    const user = userEvent.setup();
    fakeServer(0, { postFail: () => json({ errors: ["The database is unavailable."] }, 503) });
    renderApp("/release-plan");
    await reachPlanNameStep(user);
    await user.click(within(adoDialog()).getByRole("button", { name: "Create board" }));
    expect(await within(adoDialog()).findByRole("alert", {}, FIND)).toHaveTextContent("The database is unavailable.");
    expect(location()).toBe("/release-plan");
  });

  it("each plan's name links to /release-plan/<id>", async () => {
    fakeServer(2);
    renderApp("/release-plan");
    // Interim (Phase 3): the board route only shows the in-memory plan and has no fetch by id yet (Phase 4),
    // so following the link ends up redirected back to /release-plan. Only the target is asserted for now.
    expect(await screen.findByRole("link", { name: "Plan 2" }, FIND)).toHaveAttribute("href", "/release-plan/2");
  });
});
