import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ADO_CONNECTION_KEY } from "../../lib/releasePlan/constants";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import type { AdoCredential } from "../../lib/settings/types";
import { ADO_CREDENTIALS, makeBacklog, makeConnectResponse } from "../../test/adoFixtures";
import { useSettings } from "../../settingsStore";
import { SignedIn } from "../../test/SignedIn";
import { AdoConnectModal } from "./AdoConnectModal";

const PROJECT_URL = "https://dev.azure.com/org/Proj";

type Handler = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Stubs `fetch`, routing `/api/ado/connect`, `/api/ado/backlog` and `POST /api/plan` to the handlers (200 fixtures by default). */
function mockFetch(handlers: { connect?: Handler; backlog?: Handler; plan?: Handler } = {}): Mock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (url === "/api/ado/connect") {
      return handlers.connect ? handlers.connect(body, init) : json(makeConnectResponse());
    }
    if (url === "/api/ado/backlog") {
      return handlers.backlog ? handlers.backlog(body, init) : json(makeBacklog());
    }
    if (url === "/api/plan") {
      return handlers.plan ? handlers.plan(body, init) : json({ id: 7, ...body, projectType: body.projectType, createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" }, 201);
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A fetch handler that never resolves until its request is aborted. */
function hanging(signals: AbortSignal[]): Handler {
  return (_body, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }
    });
}

/** Stands in for the sidebar's SettingsButton: shows whether the Settings modal was asked to open. */
function SettingsProbe() {
  const { settingsOpen } = useSettings();
  return <p data-testid="settings-open">{String(settingsOpen)}</p>;
}

function renderModal(credentials: AdoCredential[] = ADO_CREDENTIALS) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const ui = (open: boolean) => (
    <SignedIn credentials={credentials}>
      <AdoConnectModal open={open} onClose={onClose} onCreated={onCreated} />
      <SettingsProbe />
    </SignedIn>
  );
  const view = render(ui(true));
  return { onClose, onCreated, ui, ...view };
}

const projectSelect = () => screen.getByLabelText("Project");
const connectButton = () => screen.getByRole("button", { name: /^(Connect|Connecting…)$/ });
const nameInput = () => screen.getByLabelText("Plan name");
const submitButton = (name = "Create board") => screen.getByRole("button", { name });

async function fillAndConnect(user: ReturnType<typeof userEvent.setup>, project = "Proj") {
  await user.selectOptions(projectSelect(), project);
  await user.click(connectButton());
}

describe("AdoConnectModal", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("renders nothing when closed", () => {
    render(
      <SignedIn credentials={ADO_CREDENTIALS}>
        <AdoConnectModal open={false} onClose={vi.fn()} onCreated={vi.fn()} />
      </SignedIn>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has the create title, a project list (no source, URL or PAT fields) and a disabled submit", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Create from Azure DevOps" })).toHaveAttribute("aria-modal", "true");
    expect(projectSelect().tagName).toBe("SELECT");
    expect(screen.queryByRole("radio", { name: "On-Prem" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Project URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Personal Access Token")).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("lists the configured projects by name and shows the selected project's URL below", async () => {
    const user = userEvent.setup();
    renderModal();
    expect(within(projectSelect()).getAllByRole("option").map((option) => option.textContent)).toEqual(["Select a project…", "Proj", "Legacy"]);
    expect(projectSelect()).toHaveValue("");
    expect(screen.queryByText(PROJECT_URL)).not.toBeInTheDocument();
    await user.selectOptions(projectSelect(), "Legacy");
    expect(screen.getByText("https://tfs.example.com/C/P")).toBeInTheDocument();
    expect(projectSelect()).toHaveAccessibleDescription("https://tfs.example.com/C/P");
  });

  it("loads the projects when the modal opens and offers Retry after a failure", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? json({ errors: ["boom"] }, 500) : json({ items: ADO_CREDENTIALS });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(
      <SignedIn>
        <AdoConnectModal open onClose={onClose} onCreated={vi.fn()} />
      </SignedIn>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading projects…");
    expect(connectButton()).toBeDisabled();
    expect(await screen.findByText("Could not load your projects.")).toBeInTheDocument();
    expect(connectButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Project")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(connectButton()).toBeEnabled();
  });

  it("with no configured project shows a message, disables Connect and opens Settings from 'Open settings'", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal([]);
    expect(screen.getByText("No Azure DevOps projects configured yet.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
    expect(connectButton()).toBeDisabled();
    expect(screen.getByTestId("settings-open")).toHaveTextContent("false");
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByTestId("settings-open")).toHaveTextContent("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks to select a project without a request, flagging the field", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal();
    await user.click(connectButton());
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Select an Azure DevOps project.");
    expect(projectSelect()).toHaveAttribute("aria-invalid", "true");
    expect(projectSelect().getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.selectOptions(projectSelect(), "Proj");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(projectSelect()).not.toHaveAttribute("aria-invalid");
  });

  it("connects: sends the project URL and inferred source without any PAT, shows the Area tree and remembers the project", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal();
    await fillAndConnect(user);
    expect(await screen.findByRole("tree", { name: "Area path" })).toBeInTheDocument();
    expect(screen.getByText("Proj", { selector: "span.font-medium" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ado/connect");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ source: "cloud", projectUrl: PROJECT_URL });
    expect(JSON.parse(window.localStorage.getItem(ADO_CONNECTION_KEY) ?? "null")).toEqual({ source: "cloud", projectUrl: PROJECT_URL });
  });

  it("infers the on-prem source from a non-Azure host", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal();
    await fillAndConnect(user, "Legacy");
    await screen.findByRole("tree");
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      source: "onprem",
      projectUrl: "https://tfs.example.com/C/P",
    });
  });

  it("shows 'Connecting…' and disables Connect while the request runs", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => undefined;
    mockFetch({ connect: () => new Promise<Response>((resolve) => (release = resolve)) });
    renderModal();
    await fillAndConnect(user);
    expect(connectButton()).toHaveTextContent("Connecting…");
    expect(connectButton()).toBeDisabled();
    release(json(makeConnectResponse()));
    expect(await screen.findByRole("tree")).toBeInTheDocument();
    expect(connectButton()).toHaveTextContent("Connect");
    expect(connectButton()).toBeEnabled();
  });

  it("shows server 422 errors inline (e.g. no PAT stored) with a hint to edit the project in Settings, keeping the selection", async () => {
    const user = userEvent.setup();
    const message = "A Personal Access Token is required. Save one for this project in Settings.";
    mockFetch({ connect: () => json({ errors: [message] }, 422) });
    renderModal();
    await fillAndConnect(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(projectSelect()).toHaveValue("11");
    expect(screen.getByText(/edit the project in/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("settings-open")).toHaveTextContent("true");
    expect(screen.getByRole("dialog", { name: "Create from Azure DevOps" })).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("enables submit only once a path is picked, then fetches the backlog", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    const { onCreated } = renderModal();
    await fillAndConnect(user);
    const tree = await screen.findByRole("tree", { name: "Area path" });
    expect(submitButton()).toBeDisabled();
    await user.click(within(tree).getByRole("treeitem", { name: /^Team A/ }));
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const [id, plan, warnings] = onCreated.mock.calls[0] as [number, ReleasePlan, string[]];
    expect(id).toBe(7);
    expect(plan.name).toBe("Proj – Feature Release Plan");
    expect(plan.source).toMatchObject({ kind: "cloud", projectUrl: "https://dev.azure.com/org/Proj", scopeType: "area", scopePath: "Proj\\Team A" });
    expect(warnings).toEqual(makeBacklog().warnings);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/ado/backlog");
    expect(JSON.parse(String(init.body))).toEqual({
      source: "cloud",
      projectUrl: "https://dev.azure.com/org/Proj",
      scopeType: "area",
      scopePath: "Proj\\Team A",
    });
  });

  it("switches to the Iteration tree, clearing the selection", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    const { onCreated } = renderModal();
    await fillAndConnect(user);
    await user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: /^Team A/ }));
    await user.click(screen.getByRole("radio", { name: "Iteration path" }));
    expect(submitButton()).toBeDisabled();
    const tree = screen.getByRole("tree", { name: "Iteration path" });
    await user.click(within(tree).getByRole("treeitem", { name: /^Phase 1/ }));
    await user.click(submitButton());
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toMatchObject({
      scopeType: "iteration",
      scopePath: "Proj\\Phase 1",
    });
  });

  it("shows 'Loading work items…' while fetching and backlog errors inline", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => undefined;
    mockFetch({ backlog: () => new Promise<Response>((resolve) => (release = resolve)) });
    const { onCreated } = renderModal();
    await fillAndConnect(user);
    await user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: /^Proj/ }));
    await user.click(submitButton());
    expect(screen.getByRole("button", { name: "Loading work items…" })).toBeDisabled();
    expect(connectButton()).toBeDisabled();
    release(json({ errors: ["Unknown Area path: Proj."] }, 422));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown Area path: Proj.");
    expect(submitButton()).toBeEnabled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("locks the path picker while work items load, so the request and the UI can't disagree", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => undefined;
    const fetchMock = mockFetch({ backlog: () => new Promise<Response>((resolve) => (release = resolve)) });
    const { onCreated } = renderModal();
    await fillAndConnect(user);
    const tree = await screen.findByRole("tree", { name: "Area path" });
    await user.click(within(tree).getByRole("treeitem", { name: /^Team A/ }));
    await user.click(submitButton());
    expect(screen.getByRole("radio", { name: "Area path" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Iteration path" })).toBeDisabled();
    expect(screen.getByLabelText("Search Area path")).toBeDisabled();
    expect(tree).toHaveAttribute("aria-disabled", "true");
    await user.click(within(tree).getByRole("treeitem", { name: /^Team B/ }));
    within(tree).getByRole("treeitem", { name: /^Proj/ }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("ado-selected-path")).toHaveTextContent("Proj\\Team A");
    release(json(makeBacklog()));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect((onCreated.mock.calls[0] as [number, ReleasePlan, string[]])[1].source).toMatchObject({ scopeType: "area", scopePath: "Proj\\Team A" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("re-enables the path picker after a failed load", async () => {
    const user = userEvent.setup();
    mockFetch({ backlog: () => json({ errors: ["Unknown Area path: Proj\\Team A."] }, 422) });
    renderModal();
    await fillAndConnect(user);
    await user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: /^Team A/ }));
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown Area path");
    expect(screen.getByRole("radio", { name: "Iteration path" })).toBeEnabled();
    expect(screen.getByRole("tree")).not.toHaveAttribute("aria-disabled");
  });

  it("does not flag the project for a server error", async () => {
    const user = userEvent.setup();
    mockFetch({ connect: () => json({ errors: ["Project not found: Proj. Check the URL."] }, 422) });
    renderModal();
    await fillAndConnect(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Project not found");
    expect(projectSelect()).not.toHaveAttribute("aria-invalid");
  });

  it("changing the project after Connect resets the trees", async () => {
    const user = userEvent.setup();
    mockFetch();
    renderModal();
    await fillAndConnect(user);
    await user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: /^Team B/ }));
    await user.selectOptions(projectSelect(), "Legacy");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("pre-selects the remembered project by URL and ignores one that no longer exists", () => {
    window.localStorage.setItem(ADO_CONNECTION_KEY, JSON.stringify({ source: "onprem", projectUrl: "https://tfs.example.com/C/P" }));
    const first = renderModal();
    expect(projectSelect()).toHaveValue("12");
    expect(screen.getByText("https://tfs.example.com/C/P")).toBeInTheDocument();
    first.unmount();
    window.localStorage.setItem(ADO_CONNECTION_KEY, JSON.stringify({ source: "cloud", projectUrl: "https://dev.azure.com/org/Gone" }));
    renderModal();
    expect(projectSelect()).toHaveValue("");
  });

  it("Cancel, Escape and the backdrop close", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("ado-connect-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("aborts an in-flight request when it closes", async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    mockFetch({ connect: hanging(signals) });
    const { ui, rerender } = renderModal();
    await fillAndConnect(user);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    rerender(ui(false));
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("starts fresh (no tree) when reopened, with the connected project remembered", async () => {
    const user = userEvent.setup();
    mockFetch();
    const { ui, rerender } = renderModal();
    await fillAndConnect(user);
    await screen.findByRole("tree");
    rerender(ui(false));
    rerender(ui(true));
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(projectSelect()).toHaveValue("11");
  });

  describe("plan name", () => {
    async function connectAndPick(user: ReturnType<typeof userEvent.setup>) {
      await fillAndConnect(user);
      await user.click(within(await screen.findByRole("tree", { name: "Area path" })).getByRole("treeitem", { name: /^Team A/ }));
    }

    it("is not shown before Connect", () => {
      renderModal();
      expect(screen.queryByLabelText("Plan name")).not.toBeInTheDocument();
    });

    it("is pre-filled with the default name after Connect and stays editable", async () => {
      const user = userEvent.setup();
      mockFetch();
      renderModal();
      await connectAndPick(user);
      expect(nameInput()).toHaveValue("Proj – Feature Release Plan");
      expect(nameInput()).toBeRequired();
      await user.clear(nameInput());
      await user.type(nameInput(), "My plan");
      expect(nameInput()).toHaveValue("My plan");
    });

    it("rejects a blank name inline without fetching the backlog", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch();
      const { onCreated } = renderModal();
      await connectAndPick(user);
      await user.clear(nameInput());
      await user.type(nameInput(), "   ");
      await user.click(submitButton());
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Plan name is required.");
      expect(nameInput()).toHaveAttribute("aria-invalid", "true");
      expect(nameInput()).toHaveAccessibleDescription("Plan name is required.");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onCreated).not.toHaveBeenCalled();
    });

    it("rejects a name longer than 200 characters but accepts exactly 200", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch();
      const { onCreated } = renderModal();
      await connectAndPick(user);
      await user.clear(nameInput());
      await user.click(nameInput());
      await user.paste("a".repeat(201));
      await user.click(submitButton());
      expect(screen.getByRole("alert")).toHaveTextContent("Plan name must be at most 200 characters.");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await user.clear(nameInput());
      await user.paste("a".repeat(200));
      await user.click(submitButton());
      await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    });

    it("POSTs the trimmed name, project and state, then calls onCreated with the named plan", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch();
      const { onCreated } = renderModal();
      await connectAndPick(user);
      await user.clear(nameInput());
      await user.type(nameInput(), "  Q4 plan  ");
      await user.click(submitButton());
      await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit];
      expect(url).toBe("/api/plan");
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body)) as { name: string; projectType: string; projectName: string; state: ReleasePlan };
      expect(body).toMatchObject({ name: "Q4 plan", projectType: "cloud", projectName: "Proj" });
      expect(body.state.name).toBe("Q4 plan");
      const [id, plan] = onCreated.mock.calls[0] as [number, ReleasePlan];
      expect(id).toBe(7);
      expect(plan.name).toBe("Q4 plan");
    });

    it("shows a POST error inline and keeps the modal open", async () => {
      const user = userEvent.setup();
      mockFetch({ plan: () => json({ errors: ["The release plan database is unavailable."] }, 503) });
      const { onCreated } = renderModal();
      await connectAndPick(user);
      await user.click(submitButton());
      expect(await screen.findByRole("alert")).toHaveTextContent("The release plan database is unavailable.");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(submitButton()).toBeEnabled();
      expect(onCreated).not.toHaveBeenCalled();
    });
  });
});
