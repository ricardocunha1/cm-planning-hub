import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ADO_CONNECTION_KEY } from "../../lib/releasePlan/constants";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import { PLACEHOLDER } from "../../lib/ado/url";
import { makeBacklog, makeConnectResponse } from "../../test/adoFixtures";
import { AdoConnectModal } from "./AdoConnectModal";

const PAT = "s3cr3t-pat-value";
const URL_OK = "https://dev.azure.com/org/Proj/";

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

function renderModal() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const view = render(<AdoConnectModal open onClose={onClose} onCreated={onCreated} />);
  return { onClose, onCreated, ...view };
}

const urlInput = () => screen.getByLabelText("Project URL");
const patInput = () => screen.getByLabelText("Personal Access Token");
const connectButton = () => screen.getByRole("button", { name: /^(Connect|Connecting…)$/ });
const nameInput = () => screen.getByLabelText("Plan name");
const submitButton = (name = "Create board") => screen.getByRole("button", { name });

async function fillAndConnect(user: ReturnType<typeof userEvent.setup>, { source = "Collaboration Hub", url = URL_OK, pat = PAT } = {}) {
  await user.click(screen.getByRole("radio", { name: source }));
  await user.clear(urlInput());
  await user.type(urlInput(), url);
  await user.type(patInput(), pat);
  await user.click(connectButton());
}

describe("AdoConnectModal", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("clears the Project URL (not the PAT) when the source changes, showing the new placeholder", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(urlInput(), URL_OK);
    await user.type(patInput(), PAT);
    await user.click(screen.getByRole("radio", { name: "On-Prem" }));
    expect(urlInput()).toHaveValue("");
    expect(urlInput()).toHaveAttribute("placeholder", PLACEHOLDER.onprem);
    expect(patInput()).toHaveValue(PAT);
    await user.type(urlInput(), "https://x/y");
    await user.click(screen.getByRole("radio", { name: "Collaboration Hub" }));
    expect(urlInput()).toHaveValue("");
    expect(urlInput()).toHaveAttribute("placeholder", PLACEHOLDER.cloud);
    expect(patInput()).toHaveValue(PAT);
  });

  it("renders nothing when closed", () => {
    render(<AdoConnectModal open={false} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has the create title, the fields and a disabled submit", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Create from Azure DevOps" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("radio", { name: "On-Prem" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Collaboration Hub" })).toBeChecked();
    expect(patInput()).toHaveAttribute("type", "password");
    expect(patInput()).toHaveAttribute("autocomplete", "off");
    expect(submitButton()).toBeDisabled();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("defaults to Collaboration Hub with its URL placeholder when nothing is remembered", () => {
    renderModal();
    expect(screen.getByRole("radio", { name: "Collaboration Hub" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "On-Prem" })).not.toBeChecked();
    expect(urlInput()).toHaveValue("");
    expect(urlInput()).toHaveAttribute("placeholder", "https://dev.azure.com/<ORGANIZATION>/<PROJECT_NAME>");
  });

  it("switches the URL placeholder with the source", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole("radio", { name: "On-Prem" }));
    expect(urlInput()).toHaveAttribute("placeholder", "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/<PROJECT_NAME>");
    await user.click(screen.getByRole("radio", { name: "Collaboration Hub" }));
    expect(urlInput()).toHaveAttribute("placeholder", "https://dev.azure.com/<ORGANIZATION>/<PROJECT_NAME>");
  });

  it("reports blank fields together, in order, without a request", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal();
    await user.click(connectButton());
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Enter the Azure DevOps project URL.Enter a Personal Access Token.");
    expect(alert).not.toHaveTextContent("Choose the Azure DevOps source");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a URL shape error inline without a request", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal();
    await fillAndConnect(user, { url: "https://dev.azure.com/org" });
    expect(screen.getByRole("alert")).toHaveTextContent("Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>.");
    await user.clear(urlInput());
    await user.type(urlInput(), "http://dev.azure.com/org/Proj");
    await user.click(connectButton());
    expect(screen.getByRole("alert")).toHaveTextContent("The URL must start with https://.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("connects: sends the PAT in the JSON body only, shows the Area tree and remembers the connection", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal();
    await fillAndConnect(user);
    expect(await screen.findByRole("tree", { name: "Area path" })).toBeInTheDocument();
    expect(screen.getByText("Proj", { selector: "span.font-medium" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ado/connect");
    expect(url).not.toContain(PAT);
    expect(init.method).toBe("POST");
    expect(JSON.stringify(init.headers)).not.toContain(PAT);
    expect(JSON.parse(String(init.body))).toEqual({ source: "cloud", projectUrl: URL_OK, pat: PAT });
    expect(JSON.parse(window.localStorage.getItem(ADO_CONNECTION_KEY) ?? "null")).toEqual({
      source: "cloud",
      projectUrl: "https://dev.azure.com/org/Proj",
    });
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i) ?? "";
      expect(window.localStorage.getItem(key)).not.toContain(PAT);
    }
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

  it("shows server 422 errors inline and keeps the PAT", async () => {
    const user = userEvent.setup();
    const message = "Azure DevOps rejected the Personal Access Token (invalid, expired or missing the Work Items (Read) scope).";
    mockFetch({ connect: () => json({ errors: [message] }, 422) });
    renderModal();
    await fillAndConnect(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(patInput()).toHaveValue(PAT);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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
      pat: PAT,
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

  it("links invalid fields to the inline error (aria-invalid / aria-describedby)", async () => {
    const user = userEvent.setup();
    mockFetch();
    renderModal();
    await user.click(connectButton());
    const alert = screen.getByRole("alert");
    expect(alert.id).not.toBe("");
    expect(urlInput()).toHaveAttribute("aria-invalid", "true");
    expect(urlInput()).toHaveAttribute("aria-describedby", alert.id);
    expect(patInput()).toHaveAttribute("aria-invalid", "true");
    expect(patInput().getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(patInput()).toHaveAccessibleDescription(/Needs the Work Items \(Read\) scope.*Enter a Personal Access Token\./);
    // A source is always selected (Collaboration Hub by default), so it is never flagged.
    expect(screen.getByRole("group", { name: "Azure DevOps source" })).not.toHaveAttribute("aria-describedby");
    // Only the URL is wrong now: the PAT is no longer flagged.
    await fillAndConnect(user, { url: "https://dev.azure.com/org" });
    expect(urlInput()).toHaveAttribute("aria-invalid", "true");
    expect(urlInput()).toHaveAccessibleDescription("Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>.");
    expect(patInput()).not.toHaveAttribute("aria-invalid");
    expect(patInput()).toHaveAccessibleDescription(/^Needs the Work Items \(Read\) scope\. It is sent only to connect and is never stored\.$/);
    expect(screen.getByRole("group", { name: "Azure DevOps source" })).not.toHaveAttribute("aria-describedby");
    // Editing clears the error and the flags.
    await user.type(urlInput(), "/Proj");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(urlInput()).not.toHaveAttribute("aria-invalid");
    expect(urlInput()).not.toHaveAttribute("aria-describedby");
  });

  it("does not flag a field for a server error", async () => {
    const user = userEvent.setup();
    mockFetch({ connect: () => json({ errors: ["Project not found: Proj. Check the URL."] }, 422) });
    renderModal();
    await fillAndConnect(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Project not found");
    expect(urlInput()).not.toHaveAttribute("aria-invalid");
    expect(patInput()).not.toHaveAttribute("aria-invalid");
  });

  it("asks password managers to ignore the PAT input", () => {
    renderModal();
    expect(patInput()).toHaveAttribute("data-1p-ignore", "true");
    expect(patInput()).toHaveAttribute("data-lpignore", "true");
    expect(patInput()).toHaveAttribute("data-form-type", "other");
  });

  it.each([
    ["the URL", () => urlInput(), "x"],
    ["the PAT", () => patInput(), "x"],
  ])("editing %s after Connect resets the trees", async (_name, field, extra) => {
    const user = userEvent.setup();
    mockFetch();
    renderModal();
    await fillAndConnect(user);
    await user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: /^Team B/ }));
    await user.type(field(), extra);
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("changing the source after Connect resets the trees", async () => {
    const user = userEvent.setup();
    mockFetch();
    renderModal();
    await fillAndConnect(user);
    await screen.findByRole("tree");
    await user.click(screen.getByRole("radio", { name: "On-Prem" }));
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
  });

  it("pre-fills from the remembered connection (never a PAT)", () => {
    window.localStorage.setItem(ADO_CONNECTION_KEY, JSON.stringify({ source: "onprem", projectUrl: "https://tfs.example.com/C/P" }));
    renderModal();
    expect(screen.getByRole("radio", { name: "On-Prem" })).toBeChecked();
    expect(urlInput()).toHaveValue("https://tfs.example.com/C/P");
    expect(patInput()).toHaveValue("");
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
    const { onCreated, rerender, onClose } = renderModal();
    await fillAndConnect(user);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    rerender(<AdoConnectModal open={false} onClose={onClose} onCreated={onCreated} />);
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("starts fresh (no PAT, no tree) when reopened", async () => {
    const user = userEvent.setup();
    mockFetch();
    const { onCreated, rerender, onClose } = renderModal();
    await fillAndConnect(user);
    await screen.findByRole("tree");
    rerender(<AdoConnectModal open={false} onClose={onClose} onCreated={onCreated} />);
    rerender(<AdoConnectModal open onClose={onClose} onCreated={onCreated} />);
    expect(patInput()).toHaveValue("");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(urlInput()).toHaveValue("https://dev.azure.com/org/Proj");
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
      expect(JSON.stringify(body)).not.toContain(PAT);
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
