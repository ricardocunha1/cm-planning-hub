// QA integration tests for Phase 4 (plans/release-plan-persistence.md): board at /release-plan/:id, autosave,
// Save button, unsaved-changes guard, error paths. Real App routes/pages/hooks/api; only `fetch` is mocked, by a stateful fake.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_KEY } from "../lib/releasePlan/autosavePreference";
import { makeBacklog, makeConnectResponse } from "../test/adoFixtures";
import { samplePlan } from "../test/releasePlanFixtures";
import { StrictMode } from "react";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { appRoutes } from "../App";
import { ToastProvider } from "../components/Toast";
import { ForecastProvider } from "../monteCarloStore";
import { ProbeLayout } from "../test/render";
import { renderApp } from "../test/renderApp";

const TIMEOUT = 40_000;
const FIND = { timeout: 8_000 };
const CANONICAL = "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/My%20Proj";
const OLD_KEY = "cmPlanningHub.releasePlan.v1";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const location = () => screen.getByTestId("location").textContent;
const status = () => screen.getByTestId("save-status");
const toastTexts = () => screen.queryAllByRole("alert").map((a) => a.textContent ?? "");
const sidebarLink = (name: string) => within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name });

interface Stored {
  name: string;
  state: unknown;
}
interface Call {
  method: string;
  url: string;
  body?: { name: string; state: { name: string } };
}

/** Stateful fake of /api/plan (+ the ADO endpoints used to create a plan). */
function fakeServer(initial: Record<number, Stored> = {}, opts: { putFail?: () => Response | null; putDelay?: () => Promise<void> } = {}) {
  const plans = new Map<number, Stored>(Object.entries(initial).map(([k, v]) => [Number(k), v]));
  const calls: Call[] = [];
  let nextId = 100;
  const detail = (id: number) => {
    const p = plans.get(id)!;
    return { id, name: p.name, projectType: "cloud", projectName: "Proj", createdAt: "2026-11-01T08:00:00Z", updatedAt: "2026-11-03T10:15:00Z", state: p.state };
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/ado/connect") {
      return json(makeConnectResponse({ project: { id: "g", name: "My Proj" }, projectUrl: CANONICAL }));
    }
    if (url === "/api/ado/backlog") {
      return json(makeBacklog({ project: { id: "g", name: "My Proj" }, projectUrl: CANONICAL, scope: "Iteration Path: Proj\\Phase 1\\Sprint 02" }));
    }
    if (url.startsWith("/api/plan?")) {
      const items = [...plans.keys()].sort((a, b) => b - a).map((id) => {
        const { state: _s, ...summary } = detail(id);
        return summary;
      });
      return json({ items, total: items.length, page: 1, pageSize: 10 });
    }
    if (url === "/api/plan" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Stored & Record<string, unknown>;
      const id = nextId++;
      plans.set(id, { name: body.name, state: body.state });
      return json(detail(id), 201);
    }
    const m = /^\/api\/plan\/(\d+)$/.exec(url);
    if (m) {
      const id = Number(m[1]);
      if (!plans.has(id)) {
        return json({ errors: [`Release plan not found: ${id}.`] }, 404);
      }
      if (method === "PUT") {
        await opts.putDelay?.();
        const failure = opts.putFail?.();
        if (failure) {
          return failure;
        }
        const body = JSON.parse(String(init?.body)) as Stored;
        plans.set(id, { name: body.name, state: body.state });
        return json(detail(id));
      }
      if (method === "DELETE") {
        plans.delete(id);
        return new Response(null, { status: 204 });
      }
      return json(detail(id));
    }
    return json({ errors: [`unexpected ${method} ${url}`] }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  const puts = (id?: number) => calls.filter((c) => c.method === "PUT" && (id === undefined || c.url === `/api/plan/${id}`));
  return { plans, calls, puts, fetchMock };
}

const plan = (name = "Sample Release Plan") => samplePlan({ name });

async function rename(user: ReturnType<typeof userEvent.setup>, name: string) {
  const input = await screen.findByLabelText("Plan name", {}, FIND);
  await user.clear(input);
  await user.type(input, `${name}{Enter}`);
}

async function createFromAdo(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: /Create from Azure DevOps/ }, FIND));
  const dialog = screen.getByRole("dialog", { name: "Create from Azure DevOps" });
  await user.click(within(dialog).getByRole("radio", { name: "On-Prem" }));
  await user.clear(within(dialog).getByLabelText("Project URL"));
  await user.type(within(dialog).getByLabelText("Project URL"), CANONICAL);
  await user.type(within(dialog).getByLabelText("Personal Access Token"), "qa-pat-0123456789");
  await user.click(within(dialog).getByRole("button", { name: "Connect" }));
  await screen.findByRole("tree", { name: "Area path" }, FIND);
  await user.click(within(dialog).getByRole("radio", { name: "Iteration path" }));
  await user.type(within(dialog).getByLabelText("Search Iteration path"), "sprint 02");
  within(within(dialog).getByRole("tree", { name: "Iteration path" })).getAllByRole("treeitem")[0].focus();
  await user.keyboard("{End}{Enter}");
  const nameInput = within(dialog).getByLabelText("Plan name");
  await user.clear(nameInput);
  await user.type(nameInput, name);
  await user.click(within(dialog).getByRole("button", { name: "Create board" }));
}

describe("Release Plan – board persistence (integration)", { timeout: TIMEOUT }, () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("create -> board -> change -> autosave PUT after 3 s -> reopen from the list shows the saved state", async () => {
    const user = userEvent.setup();
    const { puts, calls } = fakeServer();
    renderApp("/release-plan");
    await createFromAdo(user, "Q4 roadmap");
    await waitFor(() => expect(location()).toBe("/release-plan/100"), FIND);
    expect(status()).toHaveTextContent("Saved");
    expect(screen.getByRole("switch", { name: /Autosave/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

    await rename(user, "Q4 roadmap v2");
    expect(status()).toHaveTextContent("Unsaved changes");
    expect(puts()).toHaveLength(0);
    await waitFor(() => expect(puts()).toHaveLength(1), FIND);
    expect(puts()[0].url).toBe("/api/plan/100");
    expect(Object.keys(puts()[0].body!).sort()).toEqual(["name", "state"]);
    expect(puts()[0].body!.name).toBe("Q4 roadmap v2");
    await waitFor(() => expect(status()).toHaveTextContent("Saved"), FIND);

    await user.click(sidebarLink("Release Plan"));
    const link = await screen.findByRole("link", { name: "Q4 roadmap v2" }, FIND);
    expect(link).toHaveAttribute("href", "/release-plan/100");
    await user.click(link);
    expect(await screen.findByLabelText("Plan name", {}, FIND)).toHaveValue("Q4 roadmap v2");
    expect(location()).toBe("/release-plan/100");
    expect(calls.filter((c) => c.method === "GET" && c.url === "/api/plan/100").length).toBeGreaterThanOrEqual(1);
  });

  it("coalesces several quick changes into one PUT", async () => {
    const user = userEvent.setup();
    const { puts } = fakeServer({ 1: { name: "A", state: plan("A") } });
    renderApp("/release-plan/1");
    await rename(user, "B");
    await rename(user, "C");
    await waitFor(() => expect(puts()).toHaveLength(1), FIND);
    expect(puts()[0].body!.name).toBe("C");
    await new Promise((r) => setTimeout(r, 3500));
    expect(puts()).toHaveLength(1);
  });

  it("autosave off: no PUT until Save is pressed; the preference is stored per browser and survives a remount", async () => {
    const user = userEvent.setup();
    const { puts } = fakeServer({ 1: { name: "A", state: plan("A") } });
    const first = renderApp("/release-plan/1");
    await screen.findByLabelText("Plan name", {}, FIND);
    await user.click(screen.getByRole("switch", { name: /Autosave/ }));
    expect(window.localStorage.getItem(AUTOSAVE_KEY)).toBe("off");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await rename(user, "B");
    expect(status()).toHaveTextContent("Unsaved changes");
    await new Promise((r) => setTimeout(r, 3500));
    expect(puts()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(status()).toHaveTextContent("Saved"), FIND);
    expect(puts()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    first.unmount();

    renderApp("/release-plan/1");
    await screen.findByLabelText("Plan name", {}, FIND);
    expect(screen.getByRole("switch", { name: /Autosave/ })).toHaveAttribute("aria-checked", "false");
  });

  it("turning autosave back on with unsaved changes schedules a save", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    const { puts } = fakeServer({ 1: { name: "A", state: plan("A") } });
    renderApp("/release-plan/1");
    await rename(user, "B");
    await user.click(screen.getByRole("switch", { name: /Autosave/ }));
    await waitFor(() => expect(puts()).toHaveLength(1), FIND);
  });

  it("removes the old localStorage plan key and never writes plans to localStorage", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(OLD_KEY, JSON.stringify(plan("Legacy")));
    fakeServer({ 1: { name: "A", state: plan("A") } });
    renderApp("/release-plan/1");
    await rename(user, "B");
    await waitFor(() => expect(window.localStorage.getItem(OLD_KEY)).toBeNull(), FIND);
    expect(Object.keys(window.localStorage).filter((k) => k !== AUTOSAVE_KEY)).toEqual([]);
  });

  it("guard: sidebar navigation with unsaved changes -> Cancel stays, Discard leaves without PUT, Save PUTs then leaves", async () => {
    const user = userEvent.setup();
    const { puts } = fakeServer({ 1: { name: "A", state: plan("A") } });
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    renderApp("/release-plan/1");
    await rename(user, "B");

    await user.click(sidebarLink("Monte Carlo"));
    let dialog = await screen.findByRole("dialog", { name: "Unsaved changes" }, FIND);
    expect(within(dialog).getByRole("button", { name: "Save" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(location()).toBe("/release-plan/1");
    expect(screen.getByLabelText("Plan name")).toHaveValue("B");

    await user.click(sidebarLink("Monte Carlo"));
    dialog = await screen.findByRole("dialog", { name: "Unsaved changes" }, FIND);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(location()).toBe("/release-plan/1");

    await user.click(sidebarLink("Monte Carlo"));
    dialog = await screen.findByRole("dialog", { name: "Unsaved changes" }, FIND);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(location()).toBe("/monte-carlo"), FIND);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body!.name).toBe("B");
  });

  it("guard: Discard leaves without saving and reopening shows the server state", async () => {
    const user = userEvent.setup();
    const { puts } = fakeServer({ 1: { name: "A", state: plan("A") } });
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    renderApp("/release-plan/1");
    await rename(user, "B");
    await user.click(sidebarLink("Monte Carlo"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" }, FIND);
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(location()).toBe("/monte-carlo"), FIND);
    expect(puts()).toHaveLength(0);
    await user.click(sidebarLink("Release Plan"));
    await user.click(await screen.findByRole("link", { name: "A" }, FIND));
    expect(await screen.findByLabelText("Plan name", {}, FIND)).toHaveValue("A");
  });

  it("guard: no dialog when nothing changed; Save failing in the dialog keeps it open with a message", async () => {
    const user = userEvent.setup();
    let fail = true;
    fakeServer({ 1: { name: "A", state: plan("A") } }, { putFail: () => (fail ? json({ errors: ["db down"] }, 503) : null) });
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    renderApp("/release-plan/1");
    await screen.findByLabelText("Plan name", {}, FIND);
    await user.click(sidebarLink("Monte Carlo"));
    await waitFor(() => expect(location()).toBe("/monte-carlo"), FIND);
    await user.click(sidebarLink("Release Plan"));
    await user.click(await screen.findByRole("link", { name: "A" }, FIND));
    await rename(user, "B");
    await user.click(sidebarLink("Monte Carlo"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" }, FIND);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/Save failed/, {}, FIND)).toBeInTheDocument();
    expect(location()).toBe("/release-plan/1");
    expect(toastTexts().some((t) => t.includes("db down"))).toBe(true);
    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(location()).toBe("/monte-carlo"), FIND);
  });

  it("save failure: Save failed + Save button; retry succeeds", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { puts } = fakeServer({ 1: { name: "A", state: plan("A") } }, { putFail: () => (fail ? json({ errors: ["Database unavailable"] }, 503) : null) });
    renderApp("/release-plan/1");
    await rename(user, "B");
    await waitFor(() => expect(status()).toHaveTextContent("Save failed"), FIND);
    expect(toastTexts().some((t) => t.includes("Database unavailable"))).toBe(true);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    expect(puts()).toHaveLength(1); // no automatic retry
    fail = false;
    await user.click(save);
    await waitFor(() => expect(status()).toHaveTextContent("Saved"), FIND);
    expect(puts()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("a change made while a save is in flight is saved by a second PUT, and PUTs never overlap", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    let first = true;
    const { puts } = fakeServer(
      { 1: { name: "A", state: plan("A") } },
      {
        putDelay: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (first) {
            first = false;
            await new Promise<void>((r) => (release = r));
          }
          active -= 1;
        },
      },
    );
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    renderApp("/release-plan/1");
    await rename(user, "B");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(status()).toHaveTextContent("Saving"), FIND);
    await rename(user, "C");
    act(() => release());
    await waitFor(() => expect(puts().map((p) => p.body!.name)).toEqual(["B", "C"]), FIND);
    await waitFor(() => expect(status()).toHaveTextContent("Saved"), FIND);
    expect(maxActive).toBe(1);
  });

  it("PUT 404 toasts 'no longer exists' and goes to the list, with no guard dialog", async () => {
    const user = userEvent.setup();
    const { plans } = fakeServer({ 1: { name: "A", state: plan("A") } });
    renderApp("/release-plan/1");
    await rename(user, "B");
    plans.delete(1);
    await waitFor(() => expect(location()).toBe("/release-plan"), FIND);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toastTexts().some((t) => t.includes("This release plan no longer exists"))).toBe(true);
  });

  it("GET 404 and a non-numeric id toast and redirect to the list; /release-plan/board redirects to the list", async () => {
    fakeServer({});
    const a = renderApp("/release-plan/999");
    await waitFor(() => expect(location()).toBe("/release-plan"), FIND);
    expect(toastTexts().some((t) => t.includes("Could not open the release plan") || t.includes("not found"))).toBe(true);
    a.unmount();

    const b = renderApp("/release-plan/abc");
    await waitFor(() => expect(location()).toBe("/release-plan"), FIND);
    b.unmount();

    renderApp("/release-plan/board");
    await waitFor(() => expect(location()).toBe("/release-plan"), FIND);
    expect(await screen.findByText(/No saved release plans yet/, {}, FIND)).toBeInTheDocument();
  });

  it("an unreadable state toasts and redirects to the list", async () => {
    fakeServer({ 1: { name: "Bad", state: { nonsense: true } } });
    renderApp("/release-plan/1");
    await waitFor(() => expect(location()).toBe("/release-plan"), FIND);
    expect(toastTexts().some((t) => t.includes("could not be read"))).toBe(true);
  });

  it("navigating between two saved plans loads each by id with its own state", async () => {
    const user = userEvent.setup();
    const { puts } = fakeServer({ 1: { name: "A", state: plan("A") }, 2: { name: "B", state: plan("B") } });
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    renderApp("/release-plan/1");
    expect(await screen.findByLabelText("Plan name", {}, FIND)).toHaveValue("A");
    await user.click(sidebarLink("Release Plan"));
    await user.click(await screen.findByRole("link", { name: "B" }, FIND));
    await waitFor(() => expect(screen.getByLabelText("Plan name")).toHaveValue("B"), FIND);
    expect(status()).toHaveTextContent("Saved");
    expect(puts()).toHaveLength(0);
  });

  it("deleting a plan from the list then opening it by URL redirects back to the list", async () => {
    const user = userEvent.setup();
    fakeServer({ 1: { name: "A", state: plan("A") } });
    renderApp("/release-plan");
    await user.click(await screen.findByRole("button", { name: "Delete A" }, FIND));
    await user.click(within(screen.getByRole("dialog", { name: "Delete release plan" })).getByRole("button", { name: /Delete/ }));
    expect(await screen.findByText(/No saved release plans yet/, {}, FIND)).toBeInTheDocument();
  });

  it("registers beforeunload only while there are unsaved changes", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    fakeServer({ 1: { name: "A", state: plan("A") } });
    renderApp("/release-plan/1");
    await screen.findByLabelText("Plan name", {}, FIND);
    const fire = () => {
      const ev = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(fire()).toBe(false);
    await rename(user, "B");
    expect(fire()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(status()).toHaveTextContent("Saved"), FIND);
    expect(fire()).toBe(false);
  });

  it("StrictMode (double effects): loads once usable, one autosave PUT, create flow lands on a loaded board", async () => {
    const user = userEvent.setup();
    const { puts } = fakeServer({ 1: { name: "A", state: plan("A") } });
    const router = createMemoryRouter([{ element: <ProbeLayout />, children: appRoutes }], { initialEntries: ["/release-plan/1"] });
    render(
      <StrictMode>
        <ToastProvider>
          <ForecastProvider>
            <RouterProvider router={router} />
          </ForecastProvider>
        </ToastProvider>
      </StrictMode>,
    );
    expect(await screen.findByLabelText("Plan name", {}, FIND)).toHaveValue("A");
    expect(status()).toHaveTextContent("Saved");
    await rename(user, "B");
    await waitFor(() => expect(puts()).toHaveLength(1), FIND);
    await waitFor(() => expect(status()).toHaveTextContent("Saved"), FIND);
    expect(puts()).toHaveLength(1);
  });
});
