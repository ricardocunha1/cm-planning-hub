import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ADO_CONNECTION_KEY } from "../../lib/monteCarlo/constants";
import { ADO_CONNECTION_KEY as RELEASE_PLAN_KEY } from "../../lib/releasePlan/constants";
import { ADO_CREDENTIALS, makeConnectResponse } from "../../test/adoFixtures";
import { makeSprintHistory } from "../../test/monteCarloFixtures";
import { SignedIn } from "../../test/SignedIn";
import { AdoSprintHistoryModal } from "./AdoSprintHistoryModal";


type Handler = (init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Stubs `fetch`, routing `/api/ado/connect` and `/api/ado/sprint-history` to the handlers (200 fixtures by default). */
function mockFetch(handlers: { connect?: Handler; history?: Handler } = {}): Mock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "/api/ado/connect") {
      return handlers.connect ? handlers.connect(init) : json(makeConnectResponse());
    }
    if (url === "/api/ado/sprint-history") {
      return handlers.history ? handlers.history(init) : json(makeSprintHistory());
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderModal() {
  const onClose = vi.fn();
  const onLoaded = vi.fn();
  const ui = (open: boolean) => (
    <SignedIn credentials={ADO_CREDENTIALS}>
      <AdoSprintHistoryModal open={open} onClose={onClose} onLoaded={onLoaded} />
    </SignedIn>
  );
  const view = render(ui(true));
  return { onClose, onLoaded, ui, ...view };
}

const projectSelect = () => screen.getByLabelText("Project");
const submitButton = () => screen.getByRole("button", { name: /^(Load sprint history|Loading work items…)$/ });

async function fillAndConnect(user: ReturnType<typeof userEvent.setup>, project = "Proj") {
  await user.selectOptions(projectSelect(), project);
  await user.click(screen.getByRole("button", { name: "Connect" }));
}

describe("AdoSprintHistoryModal", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("renders nothing when closed", () => {
    render(
      <SignedIn credentials={ADO_CREDENTIALS}>
        <AdoSprintHistoryModal open={false} onClose={vi.fn()} onLoaded={vi.fn()} />
      </SignedIn>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has the Monte Carlo title, the project list (no source, URL or PAT fields) and a disabled 'Load sprint history'", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Load from Azure DevOps" })).toHaveAttribute("aria-modal", "true");
    expect(projectSelect()).toHaveValue("");
    expect(screen.queryByRole("radio", { name: "On-Prem" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Project URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Personal Access Token")).not.toBeInTheDocument();
    expect(submitButton()).toHaveTextContent("Load sprint history");
    expect(submitButton()).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Sync/ })).not.toBeInTheDocument();
  });

  it("connects with the project's URL and the source inferred from its host, without a PAT", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal();
    await fillAndConnect(user);
    expect(await screen.findByRole("tree", { name: "Iteration path" })).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ado/connect");
    expect(JSON.parse(String(init.body))).toEqual({ source: "cloud", projectUrl: "https://dev.azure.com/org/Proj" });
  });

  it("asks to select a project without a request", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Select an Azure DevOps project.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("after Connect offers only the Iteration tree (no Area/Iteration toggle)", async () => {
    const user = userEvent.setup();
    mockFetch();
    renderModal();
    await fillAndConnect(user);
    expect(await screen.findByRole("tree", { name: "Iteration path" })).toBeInTheDocument();
    expect(screen.queryByRole("tree", { name: "Area path" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Path type" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Area path" })).not.toBeInTheDocument();
    expect(screen.getByTestId("ado-selected-path")).toHaveTextContent("Select an Iteration path (child paths are included).");
    expect(screen.getByLabelText("Search Iteration path")).toBeInTheDocument();
  });

  it("remembers the project under the Monte Carlo key only", async () => {
    const user = userEvent.setup();
    mockFetch();
    renderModal();
    await fillAndConnect(user);
    await screen.findByRole("tree");
    expect(JSON.parse(window.localStorage.getItem(ADO_CONNECTION_KEY) ?? "null")).toEqual({
      source: "cloud",
      projectUrl: "https://dev.azure.com/org/Proj",
    });
    expect(window.localStorage.getItem(RELEASE_PLAN_KEY)).toBeNull();
  });

  it("pre-selects the Monte Carlo remembered project, not Release Plan's", () => {
    window.localStorage.setItem(RELEASE_PLAN_KEY, JSON.stringify({ source: "cloud", projectUrl: "https://dev.azure.com/org/Proj" }));
    window.localStorage.setItem(ADO_CONNECTION_KEY, JSON.stringify({ source: "onprem", projectUrl: "https://tfs.example.com/C/P" }));
    renderModal();
    expect(projectSelect()).toHaveValue("12");
  });

  it("loads the sprint history for the picked Iteration path and hands it over", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    const { onLoaded } = renderModal();
    await fillAndConnect(user);
    const tree = await screen.findByRole("tree", { name: "Iteration path" });
    await user.click(within(tree).getByRole("treeitem", { name: /^Phase 1/ }));
    expect(screen.getByTestId("ado-selected-path")).toHaveTextContent("Proj\\Phase 1");
    await user.click(submitButton());
    await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(onLoaded).toHaveBeenCalledWith(makeSprintHistory(), {
      source: "cloud",
      projectUrl: "https://dev.azure.com/org/Proj",
      scopeType: "iteration",
      scopePath: "Proj\\Phase 1",
    });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/ado/sprint-history");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      source: "cloud",
      projectUrl: "https://dev.azure.com/org/Proj",
      iterationPath: "Proj\\Phase 1",
    });
  });

  it("shows 'Loading work items…' while loading and a 422 inline, keeping the modal open", async () => {
    const user = userEvent.setup();
    const message = "No resolved User Stories or Bugs were found under Iteration path: Proj.";
    let release: (r: Response) => void = () => undefined;
    mockFetch({ history: () => new Promise<Response>((resolve) => (release = resolve)) });
    const { onLoaded } = renderModal();
    await fillAndConnect(user);
    await user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: /^Proj/ }));
    await user.click(submitButton());
    expect(submitButton()).toHaveTextContent("Loading work items…");
    expect(submitButton()).toBeDisabled();
    release(json({ errors: [message] }, 422));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(submitButton()).toBeEnabled();
    expect(projectSelect()).toHaveValue("11");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("aborts the in-flight load when it closes", async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    mockFetch({
      history: (init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init.signal) {
            signals.push(init.signal);
            init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }
        }),
    });
    const { onLoaded, ui, rerender } = renderModal();
    await fillAndConnect(user);
    await user.click(within(await screen.findByRole("tree")).getByRole("treeitem", { name: /^Phase 1/ }));
    await user.click(submitButton());
    expect(signals).toHaveLength(1);
    rerender(ui(false));
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onLoaded).not.toHaveBeenCalled();
  });

  it("Cancel, Escape and the backdrop close", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("ado-connect-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
