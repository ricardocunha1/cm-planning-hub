// QA full-stack-in-the-browser flow (plans/oauth-authentication.md, Phase 2 UI follow-up): the real
// app (routes, stores, modals, api.ts) against a stateful in-memory fake of the server, mocked at the
// network boundary only. The fake behaves like the real backend contract: it stores the PAT given to
// POST /api/settings/ado-credentials, answers patLast4, canonicalizes the project URL, and resolves
// the PAT of /api/ado/* from the user's saved credential (422 without one; it rejects a request that
// carries a `pat`). Flow: signed in (faked) -> empty picker -> Open settings (stacked dialogs) -> add a
// project -> pick it without a PAT -> create a board -> Sync from ADO. The PAT must never leave the
// Settings POST body, nor reach the DOM text, storage or the console.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { AuthProvider } from "./authStore";
import { ToastProvider } from "./components/Toast";
import { ForecastProvider } from "./monteCarloStore";
import { SettingsProvider } from "./settingsStore";
import { makeBacklog, makeConnectResponse } from "./test/adoFixtures";
import { TEST_USER } from "./test/authFixtures";
import { ProbeLayout } from "./test/render";

const SECRET = "QA-SECRET-PAT-0123456789wxyz";
const PAT_LAST4 = SECRET.slice(-4);
const LIST = "/api/settings/ado-credentials";
const CANONICAL = "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/My%20Proj";
const FIND = { timeout: 5_000 };
const TIMEOUT = 40_000;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const location = () => screen.getByTestId("location").textContent;

interface Cred {
  id: number;
  projectName: string;
  projectUrl: string;
  pat: string;
}

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** Canonical form the real server stores: lower-case host, no trailing slash/query. Enough for these URLs. */
function canonical(raw: string): string {
  const url = new URL(raw.trim());
  const path = url.pathname.replace(/\/+$/, "").replace(/ /g, "%20");
  return `https://${url.host.toLowerCase()}${path}`;
}

function startServer(options: { backlogStatus?: number; connectStatus?: number } = {}) {
  const creds: Cred[] = [];
  const recorded: Recorded[] = [];
  let nextId = 1;
  let plan: Record<string, unknown> | null = null;
  const find = (url: string) => creds.find((c) => c.projectUrl.toLowerCase() === canonical(url).toLowerCase());
  const item = (c: Cred) => ({ id: c.id, projectName: c.projectName, projectUrl: c.projectUrl, hasPat: true, patLast4: c.pat.slice(-4) });

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    recorded.push({ method, url, body });

    if (url === LIST && method === "GET") {
      return json({ items: creds.map(item) });
    }
    if (url === LIST && method === "POST") {
      const cred = { id: nextId++, projectName: String(body?.projectName), projectUrl: canonical(String(body?.projectUrl)), pat: String(body?.pat) };
      creds.push(cred);
      return json(item(cred), 201);
    }
    if (url.startsWith(`${LIST}/`) && method === "DELETE") {
      const index = creds.findIndex((c) => c.id === Number(url.slice(LIST.length + 1)));
      creds.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (url === "/api/ado/connect" || url === "/api/ado/backlog") {
      if ("pat" in (body ?? {})) {
        return json({ errors: ["the SPA must not send a pat"] }, 500);
      }
      const status = url === "/api/ado/connect" ? options.connectStatus : options.backlogStatus;
      if (status && status !== 200) {
        return json({ errors: ["Authentication required."] }, status);
      }
      if (!find(String(body?.projectUrl))) {
        return json({ errors: ["A Personal Access Token is required: enter one, or save one for this project in Settings."] }, 422);
      }
      return json(
        url === "/api/ado/connect"
          ? makeConnectResponse({ project: { id: "g", name: "My Proj" }, projectUrl: CANONICAL })
          : makeBacklog({ project: { id: "g", name: "My Proj" }, projectUrl: CANONICAL, scope: "Area Path: Proj\\Team A" }),
      );
    }
    if (url === "/api/plan" && method === "POST") {
      plan = { id: 42, ...body, createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" };
      return json(plan, 201);
    }
    if (url === "/api/plan/42") {
      if (method === "PUT") {
        plan = { ...plan, ...body };
      }
      return json(plan);
    }
    if (url.startsWith("/api/plan") && method === "GET") {
      return json({ items: [], total: 0, page: 1, pageSize: 10 });
    }
    return json({ errors: [`unexpected ${method} ${url}`] }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { creds, recorded, fetchMock, calls: (prefix: string) => recorded.filter((r) => r.url.startsWith(prefix)) };
}

function renderApp(path: string) {
  const router = createMemoryRouter([{ element: <ProbeLayout />, children: appRoutes }], { initialEntries: [path] });
  return render(
    <ToastProvider>
      <AuthProvider initialUser={TEST_USER}>
        <SettingsProvider>
          <ForecastProvider>
            <RouterProvider router={router} />
          </ForecastProvider>
        </SettingsProvider>
      </AuthProvider>
    </ToastProvider>,
  );
}

type User = ReturnType<typeof userEvent.setup>;
const pickerDialog = () => screen.getByRole("dialog", { name: "Create from Azure DevOps" });

async function addProjectInSettings(user: User, name = "My Proj", url = "https://TFS-Projects.cmf.criticalmanufacturing.com/ImplementationProjects/My Proj/") {
  const settings = await screen.findByRole("dialog", { name: "Settings" }, FIND);
  await user.click(await within(settings).findByRole("button", { name: "Add project" }, FIND));
  await user.type(within(settings).getByLabelText("Project name"), name);
  await user.type(within(settings).getByLabelText("Project URL"), url);
  await user.type(within(settings).getByLabelText("Personal Access Token"), SECRET);
  await user.click(within(settings).getByRole("button", { name: "Save" }));
  await within(settings).findByRole("img", { name: "Personal Access Token ending in wxyz" }, FIND);
  return settings;
}

function expectSecretNowhere(server: ReturnType<typeof startServer>, consoleSpies: ReturnType<typeof vi.spyOn>[]) {
  expect(document.body.textContent).not.toContain(SECRET);
  expect(document.documentElement.innerHTML).not.toContain(SECRET);
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
  expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
  for (const call of server.recorded) {
    if (call.method === "POST" && call.url === LIST) {
      continue; // the only request allowed to carry it
    }
    expect(JSON.stringify(call)).not.toContain(SECRET);
  }
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
  }
}

describe("Settings + ADO picker + Sync full flow (fake server)", { timeout: TIMEOUT }, () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    consoleSpies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("empty picker -> Open settings (stacked) -> add project -> connect without a PAT -> create board -> sync without a PAT", async () => {
    const server = startServer();
    const user = userEvent.setup();
    renderApp("/release-plan");

    await user.click(await screen.findByRole("button", { name: /Create from Azure DevOps/ }, FIND));
    const picker = pickerDialog();
    expect(await within(picker).findByText("No Azure DevOps projects configured yet.", undefined, FIND)).toBeInTheDocument();
    expect(within(picker).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(within(picker).queryByLabelText(/Personal Access Token/)).not.toBeInTheDocument();
    expect(within(picker).queryByLabelText(/Project URL/)).not.toBeInTheDocument();

    // Stacked dialogs: Settings opens above the picker; Esc closes only the topmost.
    const openSettings = within(picker).getByRole("button", { name: "Open settings" });
    await user.click(openSettings);
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(settings.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(pickerDialog()).toBeInTheDocument();
    expect(document.activeElement).toBe(openSettings); // focus returns to the opener (still mounted: nothing was added)

    // Add the project from Settings while the picker stays open underneath.
    await user.click(openSettings);
    const dialog = await addProjectInSettings(user);
    // The list shows the masked PAT with only the last 4, never the PAT.
    expect(within(dialog).getByText("•••••••• wxyz")).toBeInTheDocument();
    expect(within(dialog).getByText(CANONICAL)).toBeInTheDocument(); // canonical URL from the server
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    // The picker (no reload) now lists the project. Connect sends the stored URL and the inferred source, no PAT.
    const select = await within(pickerDialog()).findByLabelText("Project", undefined, FIND);
    await user.selectOptions(select, "My Proj");
    await user.click(within(pickerDialog()).getByRole("button", { name: "Connect" }));
    const tree = await within(pickerDialog()).findByRole("tree", { name: "Area path" }, FIND);
    await user.click(within(tree).getByRole("treeitem", { name: /^Team A/ }));
    await user.click(within(pickerDialog()).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(location()).toBe("/release-plan/42"), FIND);

    expect(server.calls("/api/ado/connect")[0].body).toEqual({ source: "onprem", projectUrl: CANONICAL });

    expect(server.calls("/api/ado/backlog")).toHaveLength(1); // the one that created the board
    expect(server.calls("/api/ado/backlog")[0].body).not.toHaveProperty("pat");

    // Sync: connection read-only, credential matched, backlog requested without a PAT.
    await user.click(await screen.findByRole("button", { name: "Sync from ADO" }, FIND));
    const sync = await screen.findByRole("dialog", { name: "Sync from Azure DevOps" });
    expect(await within(sync).findByLabelText("Personal Access Token", undefined, FIND)).toHaveValue("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 " + PAT_LAST4);
    expect(within(sync).getByText(/Saved in Settings as/)).toHaveTextContent("My Proj");
    await user.click(within(sync).getByRole("button", { name: "Preview changes" }));
    await screen.findByRole("button", { name: "Apply" }, FIND);
    const backlogCalls = server.calls("/api/ado/backlog");
    expect(backlogCalls).toHaveLength(2);
    expect(backlogCalls[1].body).toEqual({ source: "onprem", projectUrl: CANONICAL, scopeType: "area", scopePath: "Proj\\Team A" });

    expectSecretNowhere(server, consoleSpies);
  });

  it("Sync with no matching Settings project: Preview stays disabled, Open settings stacks above the sync dialog", async () => {
    const server = startServer();
    const user = userEvent.setup();
    renderApp("/release-plan");
    // Create the board from a saved project, then delete that project in Settings.
    await user.click(await screen.findByRole("button", { name: /Create from Azure DevOps/ }, FIND));
    await user.click(within(pickerDialog()).getByRole("button", { name: "Open settings" }));
    const settings = await addProjectInSettings(user);
    await user.click(within(settings).getByRole("button", { name: "Close" }));
    await user.selectOptions(await within(pickerDialog()).findByLabelText("Project", undefined, FIND), "My Proj");
    await user.click(within(pickerDialog()).getByRole("button", { name: "Connect" }));
    const tree = await within(pickerDialog()).findByRole("tree", { name: "Area path" }, FIND);
    await user.click(within(tree).getByRole("treeitem", { name: /^Team A/ }));
    await user.click(within(pickerDialog()).getByRole("button", { name: "Create board" }));
    await waitFor(() => expect(location()).toBe("/release-plan/42"), FIND);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const again = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(await within(again).findByRole("button", { name: "Delete My Proj" }, FIND));
    await user.click(within(await screen.findByRole("dialog", { name: "Delete project?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(again).getByText("No saved projects yet.")).toBeInTheDocument());
    await user.click(within(again).getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: "Sync from ADO" }));
    const sync = await screen.findByRole("dialog", { name: "Sync from Azure DevOps" });
    expect(within(sync).getByText("No saved Personal Access Token for this project.")).toBeInTheDocument();
    expect(within(sync).getByRole("button", { name: "Preview changes" })).toBeDisabled();
    await user.click(within(sync).getByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Sync from Azure DevOps" })).toBeInTheDocument();
    expect(server.calls("/api/ado/backlog")).toHaveLength(1); // only the board creation; the disabled Preview sent nothing
  });

  it("a 401 on Connect sends the user to /login (no PAT involved)", async () => {
    startServer({ connectStatus: 401 });
    const user = userEvent.setup();
    renderApp("/release-plan");
    await user.click(await screen.findByRole("button", { name: /Create from Azure DevOps/ }, FIND));
    await user.click(within(pickerDialog()).getByRole("button", { name: "Open settings" }));
    const settings = await addProjectInSettings(user);
    await user.click(within(settings).getByRole("button", { name: "Close" }));
    await user.selectOptions(await within(pickerDialog()).findByLabelText("Project", undefined, FIND), "My Proj");
    await user.click(within(pickerDialog()).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(location()).toBe("/login"), FIND);
  });

  // KNOWN DEFECT (Minor, frontend): the opener ("Open settings") unmounts once the first project exists, so useDialog's
  // focus restore targets a detached node and focus falls to <body> behind the modal. `it.fails` keeps the suite green
  // while documenting it; remove `.fails` when fixed (e.g. restore focus to the Project select).
  it("focus after adding the first project from the picker's empty state stays inside an open dialog", async () => {
    startServer();
    const user = userEvent.setup();
    renderApp("/release-plan");
    await user.click(await screen.findByRole("button", { name: /Create from Azure DevOps/ }, FIND));
    await user.click(within(pickerDialog()).getByRole("button", { name: "Open settings" }));
    const settings = await addProjectInSettings(user);
    await user.click(within(settings).getByRole("button", { name: "Close" }));
    // "Open settings" was replaced by the project select: focus must not be lost to <body>.
    expect(pickerDialog().contains(document.activeElement)).toBe(true);
  });

  // KNOWN DEFECT (Minor, frontend): AdoConnectModal keeps `connected` (tree, "Connected to ...", enabled submit) after the
  // selected project was deleted in Settings, while the select shows "Select a project...". Submitting then gets a 422 from
  // the server. `it.fails` documents it; remove `.fails` when fixed (clear the connection when `selected` disappears).
  it("deleting the selected project after Connect does not leave a usable stale connection", async () => {
    startServer();
    const user = userEvent.setup();
    renderApp("/release-plan");
    await user.click(await screen.findByRole("button", { name: /Create from Azure DevOps/ }, FIND));
    await user.click(within(pickerDialog()).getByRole("button", { name: "Open settings" }));
    const settings = await addProjectInSettings(user);
    await user.click(within(settings).getByRole("button", { name: "Close" }));
    await user.selectOptions(await within(pickerDialog()).findByLabelText("Project", undefined, FIND), "My Proj");
    await user.click(within(pickerDialog()).getByRole("button", { name: "Connect" }));
    await within(pickerDialog()).findByRole("tree", { name: "Area path" }, FIND);

    // Delete the project through Settings while the picker is open and connected.
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const again = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(await within(again).findByRole("button", { name: "Delete My Proj" }, FIND));
    await user.click(within(await screen.findByRole("dialog", { name: "Delete project?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(again).getByText("No saved projects yet.")).toBeInTheDocument());
    await user.click(within(again).getByRole("button", { name: "Close" }));

    // The picker no longer has the project: it must not still offer a connected tree for it.
    expect(within(pickerDialog()).queryByRole("tree")).not.toBeInTheDocument();
  });
});
