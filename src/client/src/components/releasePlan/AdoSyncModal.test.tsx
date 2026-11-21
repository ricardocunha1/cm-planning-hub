import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { AdoCredential } from "../../lib/settings/types";
import { useSettings } from "../../settingsStore";
import { SignedIn } from "../../test/SignedIn";
import type { PlanSource } from "../../lib/releasePlan/types";
import { makeBacklog } from "../../test/adoFixtures";
import { AdoSyncModal } from "./AdoSyncModal";

const CLOUD_CREDENTIAL: AdoCredential = { id: 1, projectName: "Proj Saved", projectUrl: "https://DEV.azure.com/org/Proj/", hasPat: true, patLast4: "abcd" };
const ONPREM_CREDENTIAL: AdoCredential = { id: 2, projectName: "My Proj", projectUrl: "https://tfs.example.com/Coll/My%20Proj", hasPat: true, patLast4: null };
const CREDENTIALS = [CLOUD_CREDENTIAL, ONPREM_CREDENTIAL];
const CLOUD_SOURCE: PlanSource = {
  system: "Azure DevOps",
  project: "Proj",
  scope: "Area Path: Proj\\Team A",
  fetchedAt: "2026-10-23T10:00:00Z",
  kind: "cloud",
  projectUrl: "https://dev.azure.com/org/Proj",
  scopeType: "area",
  scopePath: "Proj\\Team A",
};
const ONPREM_SOURCE: PlanSource = {
  kind: "onprem",
  projectUrl: "https://tfs.example.com/Coll/My%20Proj",
  scopeType: "iteration",
  scopePath: "My Proj\\Phase 1",
};

type Handler = (init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(handler: Handler = () => json(makeBacklog())): Mock {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (String(input) !== "/api/ado/backlog") {
      throw new Error(`unexpected ${String(input)}`);
    }
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stands in for the sidebar's SettingsButton: shows whether the Settings modal was asked to open. */
function SettingsProbe() {
  const { settingsOpen } = useSettings();
  return <p data-testid="settings-open">{String(settingsOpen)}</p>;
}

function renderModal(source: PlanSource = CLOUD_SOURCE, credentials: AdoCredential[] = CREDENTIALS) {
  const onClose = vi.fn();
  const onBacklog = vi.fn();
  const ui = (open: boolean) => (
    <SignedIn credentials={credentials}>
      <AdoSyncModal open={open} source={source} onClose={onClose} onBacklog={onBacklog} />
      <SettingsProbe />
    </SignedIn>
  );
  const view = render(ui(true));
  return { onClose, onBacklog, ui, ...view };
}

const previewButton = () => screen.getByRole("button", { name: /^(Preview changes|Loading work items…)$/ });
/** The `<dd>` shown next to a `<dt>` label. */
const valueOf = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

describe("AdoSyncModal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders nothing when closed", () => {
    render(
      <SignedIn credentials={CREDENTIALS}>
        <AdoSyncModal open={false} source={CLOUD_SOURCE} onClose={vi.fn()} onBacklog={vi.fn()} />
      </SignedIn>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a Collaboration Hub Area-path connection read-only, with only the redacted read-only PAT input", () => {
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "Sync from Azure DevOps" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(valueOf("Azure DevOps source")).toBe("Collaboration Hub");
    expect(valueOf("Project URL")).toBe("https://dev.azure.com/org/Proj");
    expect(valueOf("Area path")).toBe("Proj\\Team A");
    expect(screen.queryByText("Iteration path")).not.toBeInTheDocument();
    expect(dialog.querySelectorAll("input")).toHaveLength(1);
    expect(dialog).not.toHaveTextContent("never stored");
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("shows an On-Prem Iteration-path connection", () => {
    renderModal(ONPREM_SOURCE);
    expect(valueOf("Azure DevOps source")).toBe("On-Prem");
    expect(valueOf("Project URL")).toBe("https://tfs.example.com/Coll/My%20Proj");
    expect(valueOf("Iteration path")).toBe("My Proj\\Phase 1");
    expect(screen.queryByText("Area path")).not.toBeInTheDocument();
  });

  it("names the matching Settings project (case-insensitive, trailing slash ignored) and enables Preview", () => {
    renderModal();
    const pat = screen.getByLabelText("Personal Access Token");
    expect(pat).toHaveAttribute("type", "text");
    expect(pat).toHaveAttribute("readonly");
    expect(pat).toHaveValue("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 abcd");
    expect(screen.getByText(/Saved in Settings as/)).toHaveTextContent("Saved in Settings as Proj Saved");
    expect(previewButton()).toBeEnabled();
  });

  it("shows only the dots when the last 4 characters are unknown", () => {
    renderModal(ONPREM_SOURCE);
    expect(screen.getByLabelText("Personal Access Token")).toHaveValue("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");
  });

  it("without a matching project says so, disables Preview and opens Settings from 'Open settings'", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    renderModal(CLOUD_SOURCE, [ONPREM_CREDENTIAL]);
    expect(screen.getByText("No saved Personal Access Token for this project.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Personal Access Token")).not.toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
    expect(screen.getByTestId("settings-open")).toHaveTextContent("false");
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByTestId("settings-open")).toHaveTextContent("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the projects when it opens and offers Retry after a failure", async () => {
    const user = userEvent.setup();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? json({ errors: ["boom"] }, 500) : json({ items: CREDENTIALS });
      }),
    );
    render(
      <SignedIn>
        <AdoSyncModal open source={CLOUD_SOURCE} onClose={vi.fn()} onBacklog={vi.fn()} />
      </SignedIn>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading your projects…");
    expect(previewButton()).toBeDisabled();
    expect(await screen.findByText("Could not load your projects.")).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Personal Access Token")).toBeInTheDocument();
    expect(previewButton()).toBeEnabled();
  });

  it("posts the plan's connection without a PAT and hands the backlog and connection to onBacklog", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    const { onBacklog } = renderModal(ONPREM_SOURCE);
    await user.click(previewButton());
    await vi.waitFor(() => expect(onBacklog).toHaveBeenCalledTimes(1));
    const connection = { source: "onprem", projectUrl: "https://tfs.example.com/Coll/My%20Proj", scopeType: "iteration", scopePath: "My Proj\\Phase 1" };
    expect(onBacklog).toHaveBeenCalledWith(makeBacklog(), connection);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ado/backlog");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual(connection);
    expect(body).not.toHaveProperty("pat");
  });

  it("shows 'Loading work items…' while loading and a server error inline with a Settings hint, keeping the modal open", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => undefined;
    mockFetch(() => new Promise<Response>((resolve) => (release = resolve)));
    const { onBacklog, onClose } = renderModal();
    await user.click(previewButton());
    expect(previewButton()).toHaveTextContent("Loading work items…");
    expect(previewButton()).toBeDisabled();
    release(json({ errors: ["The stored Personal Access Token has expired."] }, 422));
    expect(await screen.findByRole("alert")).toHaveTextContent("The stored Personal Access Token has expired.");
    expect(previewButton()).toHaveTextContent("Preview changes");
    expect(previewButton()).toBeEnabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onBacklog).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("settings-open")).toHaveTextContent("true");
  });

  it("shows a network failure inline", async () => {
    const user = userEvent.setup();
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    renderModal();
    await user.click(previewButton());
    expect(await screen.findByRole("alert")).not.toBeEmptyDOMElement();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Cancel, Escape and the backdrop close", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("ado-sync-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("aborts an in-flight request when it closes, and starts fresh when reopened", async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    mockFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (signal) {
            signals.push(signal);
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          }
        }),
    );
    const { ui, rerender } = renderModal();
    await user.click(previewButton());
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    rerender(ui(false));
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(ui(true));
    expect(previewButton()).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["an empty source", {}],
    ["a source without a scope path", { ...CLOUD_SOURCE, scopePath: undefined }],
    ["a source without a project URL", { ...ONPREM_SOURCE, projectUrl: undefined }],
  ] as [string, PlanSource][])("explains that a board with %s can't be synced, with only a Close button", async (_name, source) => {
    const user = userEvent.setup();
    const fetchMock = mockFetch();
    const { onClose } = renderModal(source);
    const dialog = screen.getByRole("dialog", { name: "Sync from Azure DevOps" });
    expect(dialog).toHaveTextContent("This board isn't linked to an Azure DevOps project, so it can't be synced.");
    expect(dialog).toHaveTextContent("create the board from Azure DevOps");
    expect(screen.queryByRole("button", { name: "Preview changes" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
