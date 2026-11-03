// QA integration tests for the read-only "Sync from ADO" connection (only the PAT is entered; the
// project URL and Area/Iteration path come from plan.source).
// Real App routes, pages, store with the real localStorage autosave and real adoApi; only `fetch`
// and the browser download boundary are mocked.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { ToastProvider } from "../components/Toast";
import { STORAGE_KEY } from "../lib/releasePlan/constants";
import { planFromBacklog } from "../lib/releasePlan/fromBacklog";
import type { ReleasePlan } from "../lib/releasePlan/types";
import { ForecastProvider } from "../monteCarloStore";
import { makeBacklog, makeConnection } from "../test/adoFixtures";
import { sequentialIds } from "../test/releasePlanFixtures";

const PAT = "qa-readonly-sync-pat-0123456789";
const TIMEOUT = 30_000;
const FIND = { timeout: 5_000 };

const CLOUD = makeConnection({
  source: "cloud",
  projectUrl: "https://dev.azure.com/contoso/Board%20A",
  scopeType: "iteration",
  scopePath: "Board A\\Phase 1",
});

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const toolbar = () => {
  const el = document.querySelector<HTMLElement>(".rp .toolbar");
  if (!el) throw new Error("toolbar not rendered");
  return el;
};
const syncDialog = () => screen.getByRole("dialog", { name: "Sync from Azure DevOps" });
const shown = (dialog: HTMLElement, label: string) => within(dialog).queryByText(label, { selector: "dt" })?.nextElementSibling?.textContent ?? null;

function linkedPlan(connection: typeof CLOUD, name: string): ReleasePlan {
  const backlog = makeBacklog({ projectUrl: connection.projectUrl, scope: `${connection.scopeType}: ${connection.scopePath}` });
  return { ...planFromBacklog(backlog, connection, sequentialIds()), name };
}

function mockBacklog() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input) === "/api/ado/backlog") {
      return json(makeBacklog());
    }
    return json({ errors: [`unexpected ${String(input)}`] }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openSync(user: User) {
  await user.click(within(toolbar()).getByRole("button", { name: "Sync from ADO" }));
  return syncDialog();
}

async function closeSync(user: User, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole("button", { name: /^(Cancel|Close)$/ }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
}

function expectConnectionShown(dialog: HTMLElement, c: typeof CLOUD) {
  expect(shown(dialog, "Azure DevOps source")).toBe(c.source === "cloud" ? "Collaboration Hub" : "On-Prem");
  expect(shown(dialog, "Project URL")).toBe(c.projectUrl);
  expect(shown(dialog, c.scopeType === "area" ? "Area path" : "Iteration path")).toBe(c.scopePath);
  expect(shown(dialog, c.scopeType === "area" ? "Iteration path" : "Area path")).toBeNull();
  // Nothing about the connection is editable: the PAT is the only form control besides the buttons.
  expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
  expect(within(dialog).queryAllByRole("textbox")).toHaveLength(0);
  expect(within(dialog).queryByRole("tree")).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  expect(dialog.querySelectorAll("input")).toHaveLength(1);
  expect(within(dialog).getByLabelText("Personal Access Token")).toHaveValue("");
}

describe("Release Plan – read-only Sync connection restored from storage (integration)", { timeout: TIMEOUT }, () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("shows the stored plan's connection read-only and Sync posts it with the typed PAT", async () => {
    const user = userEvent.setup();
    const fetchMock = mockBacklog();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(linkedPlan(CLOUD, "Board A")));
    renderApp("/release-plan/board");
    const dialog = await openSync(user);
    expectConnectionShown(dialog, CLOUD);
    await user.type(within(dialog).getByLabelText("Personal Access Token"), PAT);
    await user.click(within(dialog).getByRole("button", { name: "Preview changes" }));
    await screen.findByRole("button", { name: "Apply" }, FIND);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ ...CLOUD, pat: PAT });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await closeSync(user, await openSync(user));
  });

  it("a whitespace-only scopePath from JSON is shown as-is and the server's 422 appears inline (no crash, nothing saved)", async () => {
    const user = userEvent.setup();
    const plan = linkedPlan(CLOUD, "Blank path");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...plan, source: { ...plan.source, scopePath: "   " } }));
    const fetchMock = vi.fn(async () => json({ errors: ["Select an Area or Iteration path."] }, 422));
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/release-plan/board");
    const dialog = await openSync(user);
    const before = window.localStorage.getItem(STORAGE_KEY);
    expect(within(dialog).getByLabelText("Personal Access Token")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Personal Access Token"), `${PAT}{Enter}`);
    expect(await within(dialog).findByRole("alert", {}, FIND)).toHaveTextContent("Select an Area or Iteration path.");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(before);
  });

  it("focus goes to the PAT input on open and returns to the Sync button on close", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(linkedPlan(CLOUD, "Board A")));
    renderApp("/release-plan/board");
    const button = within(toolbar()).getByRole("button", { name: "Sync from ADO" });
    await user.click(button);
    const dialog = syncDialog();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByLabelText("Personal Access Token")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});
