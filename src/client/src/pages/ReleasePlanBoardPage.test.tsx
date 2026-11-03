import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoBacklog } from "../lib/releasePlan/adoTypes";
import { planFromBacklog } from "../lib/releasePlan/fromBacklog";
import type { ReleasePlan } from "../lib/releasePlan/types";
import { FakeImage, RecordingContext, stubCanvas } from "../test/canvas";
import { makeBacklog, makeConnection, makeFeatureItem } from "../test/adoFixtures";
import { makeEpic, makeFeature, samplePlan, sequentialIds, sprintsPlan } from "../test/releasePlanFixtures";
import { BOARD_TEST_TIMEOUT_MS, renderBoard } from "../test/renderBoard";

const summaryBox = (name: string) => within(screen.getByRole("region", { name: "Milestone summary" })).getByRole("group", { name });
const featureCount = (name: string) => summaryBox(name).querySelector(".n")?.textContent;
const zoomValue = () => screen.getByTestId("zoom-value").textContent;

describe("ReleasePlanBoardPage", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  it("renders the board with its title, toolbar, summary and hint; only epic headers and cards are draggable", () => {
    const { container } = renderBoard(samplePlan());
    expect(document.title).toBe("Planning Hub – Release Plan – Board");
    expect(container.querySelector(".rp")).not.toBeNull();
    expect(screen.getByLabelText("Plan name")).toHaveValue("Sample Release Plan");
    expect(screen.getByTestId("source-info")).toHaveTextContent("Azure DevOps · Area Path: Proj\\Team");
    expect(screen.getByText(/Click any work item to see its description/)).toHaveTextContent(
      "Drag Epics to reorder them. Drag a Feature card up or down to move it to another milestone, or onto another column of the same Epic to reorder it. Ctrl+click (⌘+click on Mac) selects several Features of the same Epic to move them together. Click any work item to see its description. Use the + between milestones to insert a new one (in Sprint mode, also a milestone flag). ✓ = Resolved / Done / Closed.",
    );
    expect(screen.getByText("Ctrl+click").tagName).toBe("B");
    const draggable = [...container.querySelectorAll('[draggable="true"]')];
    expect(draggable.every((el) => el.matches(".epic, .fcard"))).toBe(true);
    expect(draggable).toHaveLength(3 + 5);
    expect([...container.querySelectorAll('[draggable="false"]')].map((el) => el.textContent)).toEqual(["◀", "▶", "◀", "▶", "◀", "▶"]);
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeInTheDocument();
  });

  it("renames the plan on commit (trimmed; empty → 'Feature Release Plan') and sizes the input", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    const name = screen.getByLabelText("Plan name");
    expect(name).toHaveStyle({ width: `${"Sample Release Plan".length + 3}ch` });
    await user.clear(name);
    await user.type(name, "  Q4 plan  ");
    await user.tab();
    expect(name).toHaveValue("Q4 plan");
    await user.clear(name);
    await user.tab();
    expect(name).toHaveValue("Feature Release Plan");
  });

  it("switches between Board and Table tabs and hides zoom in Table view", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    const boardTab = screen.getByRole("tab", { name: "Board" });
    const tableTab = screen.getByRole("tab", { name: "Table" });
    expect(boardTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("group", { name: "Zoom" })).toBeInTheDocument();
    await user.click(tableTab);
    expect(tableTab).toHaveAttribute("aria-selected", "true");
    expect(boardTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Zoom" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Board" })).not.toBeInTheDocument();
    // The summary stays in both views.
    expect(summaryBox("MVP")).toBeInTheDocument();
  });

  it("zooms with −/+ in 0.1 steps clamped to [30%, 150%], scales the board, and fits the scroll box", () => {
    // ~25 clicks that each re-render the whole board: fireEvent (not userEvent) and the buttons are looked up
    // once (role queries over the full board are slow), so this stays fast under parallel load.
    renderBoard(samplePlan());
    const zoomGroup = within(screen.getByRole("group", { name: "Zoom" }));
    const zoomInBtn = zoomGroup.getByRole("button", { name: "Zoom in" });
    const zoomOutBtn = zoomGroup.getByRole("button", { name: "Zoom out" });
    const fitBtn = zoomGroup.getByRole("button", { name: "Fit" });
    expect(zoomValue()).toBe("100%");
    fireEvent.click(zoomInBtn);
    expect(zoomValue()).toBe("110%");
    for (let i = 1; i < 8; i++) {
      fireEvent.click(zoomInBtn);
    }
    expect(zoomValue()).toBe("150%");
    expect(screen.getByTestId("board-scale")).toHaveStyle({ transform: "scale(1.5)", width: "1950px", height: "840px" });
    fireEvent.click(zoomOutBtn);
    expect(zoomValue()).toBe("140%");
    for (let i = 1; i < 15; i++) {
      fireEvent.click(zoomOutBtn);
    }
    expect(zoomValue()).toBe("30%");
    // Fit = min(1, (clientWidth - 4) / layout.width); the sample layout is 1300px wide.
    Object.defineProperty(screen.getByTestId("board-scroll"), "clientWidth", { configurable: true, value: 654 });
    fireEvent.click(fitBtn);
    expect(zoomValue()).toBe("50%");
    Object.defineProperty(screen.getByTestId("board-scroll"), "clientWidth", { configurable: true, value: 5000 });
    fireEvent.click(fitBtn);
    expect(zoomValue()).toBe("100%");
  });

  it("adds the frozen-column shadow class when scrolled horizontally", () => {
    renderBoard(samplePlan());
    const box = screen.getByTestId("board-scroll");
    box.scrollLeft = 40;
    fireEvent.scroll(box);
    expect(box).toHaveClass("scrolledX");
    box.scrollLeft = 0;
    fireEvent.scroll(box);
    expect(box).not.toHaveClass("scrolledX");
  });

  describe("Releases/Sprints switch", () => {
    const radio = (name: string) => within(screen.getByRole("radiogroup", { name: "Milestones as" })).getByRole("radio", { name });

    it("reflects the mode and ignores clicking the current one", async () => {
      const user = userEvent.setup();
      renderBoard(samplePlan());
      expect(radio("Releases")).toHaveAttribute("aria-checked", "true");
      expect(radio("Sprints")).toHaveAttribute("aria-checked", "false");
      await user.click(radio("Releases"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("confirms with the template text; Cancel keeps the milestones", async () => {
      const user = userEvent.setup();
      renderBoard(samplePlan());
      await user.click(radio("Sprints"));
      const dialog = screen.getByRole("dialog", { name: "Switch milestone type" });
      expect(within(dialog).getByText(/^Switch milestones to Sprints\?/).textContent).toBe(
        "Switch milestones to Sprints?\n\nThe current milestones will be replaced by 3 sprints (Sprint 1, Sprint 2, Sprint 10) and ALL Features will be reset to their initial milestone: the sprint of their Iteration Path (e.g. Sprint 1).\n1 Features without a sprint will go to Unplanned.\n\nAny manual planning (and milestone flags) will be lost. Save the plan first if you want to keep it.",
      );
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(radio("Releases")).toHaveAttribute("aria-checked", "true");
      expect(summaryBox("MVP")).toBeInTheDocument();
    });

    it("switches to Sprints on confirm, then back to Releases", async () => {
      const user = userEvent.setup();
      renderBoard(samplePlan());
      await user.click(radio("Sprints"));
      await user.click(screen.getByRole("button", { name: "Switch" }));
      expect(radio("Sprints")).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("status")).toHaveTextContent("Milestones switched to Sprints");
      expect(featureCount("Sprint 10")).toBe("1");
      expect(featureCount("Unplanned")).toBe("1");

      await user.click(radio("Releases"));
      expect(screen.getByRole("dialog")).toHaveTextContent('replaced by a single "MVP" milestone');
      await user.click(screen.getByRole("button", { name: "Switch" }));
      expect(radio("Releases")).toHaveAttribute("aria-checked", "true");
      expect(featureCount("MVP")).toBe("5");
      expect(screen.getByText("Milestones switched to Releases")).toBeInTheDocument();
    });

    it("toasts and aborts when no feature has a sprint below the project root", async () => {
      const user = userEvent.setup();
      const plan = samplePlan({ epics: [makeEpic({ id: 9, features: [makeFeature({ id: 91, iterationPath: "Proj" })] })] });
      renderBoard(plan);
      await user.click(radio("Sprints"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("No Iteration Paths below the project root were found");
      expect(radio("Releases")).toHaveAttribute("aria-checked", "true");
    });
  });

  it("shows Sync from ADO and Export PNG in both the Board and Table views", () => {
    renderBoard(samplePlan());
    const toolbarButtons = () => screen.getAllByRole("button").filter((b) => b.closest(".toolbar")).map((b) => b.textContent);
    expect(toolbarButtons().slice(-2)).toEqual(["Sync from ADO", "Export PNG"]);
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    expect(screen.queryByRole("group", { name: "Zoom" })).not.toBeInTheDocument();
    expect(toolbarButtons().slice(-2)).toEqual(["Sync from ADO", "Export PNG"]);
    expect(screen.queryByRole("button", { name: "Load Plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save Plan" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export PNG" })).toHaveClass("btn", "primary");
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeEnabled();
    expect(document.querySelector(".rp .toolbar .spacer")).not.toBeNull();
  });

  it("shows a decorative icon before the Sync from ADO label in both views", () => {
    const { container } = renderBoard(samplePlan());
    const toolbar = () => {
      const el = container.querySelector<HTMLElement>(".rp .toolbar");
      if (!el) throw new Error("toolbar not rendered");
      return el;
    };
    const expectIcons = () => {
      for (const name of ["Sync from ADO"]) {
        const button = within(toolbar()).getByRole("button", { name });
        const svg = button.querySelector("svg");
        expect(svg).not.toBeNull();
        expect(svg).toHaveAttribute("aria-hidden", "true");
        expect(button.firstElementChild).toBe(svg);
        expect(button).toHaveTextContent(name);
      }
    };
    expectIcons();
    fireEvent.click(within(toolbar()).getByRole("tab", { name: "Table" }));
    expectIcons();
  });

  describe("Export PNG", () => {
    const NOW = new Date("2026-10-21T09:15:00.000Z");
    let downloads: string[] = [];

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      vi.stubGlobal("Image", FakeImage);
      FakeImage.reset();
      downloads = [];
      Object.assign(URL, { createObjectURL: () => "blob:png", revokeObjectURL: () => undefined });
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
      stubCanvas({ context: new RecordingContext(), blob: new Blob(["png"], { type: "image/png" }) });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      FakeImage.reset();
    });

    for (const view of ["Board", "Table"] as const) {
      it(`downloads <name>_<date>.png and toasts from the ${view} view`, async () => {
        renderBoard(samplePlan());
        fireEvent.click(screen.getByRole("tab", { name: view }));
        fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
        expect(await screen.findByText("PNG exported")).toBeInTheDocument();
        expect(downloads).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
      });
    }

    it("disables Export PNG while an export is running", async () => {
      FakeImage.hold = true;
      renderBoard(samplePlan());
      const button = screen.getByRole("button", { name: "Export PNG" });
      fireEvent.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      fireEvent.click(button);
      act(() => FakeImage.release());
      expect(await screen.findByText("PNG exported")).toBeInTheDocument();
      expect(button).toBeEnabled();
      expect(downloads).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
    });
  });

  describe("Sync from ADO", () => {
    const PAT = "sync-pat-value";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    /** The board created from the default backlog (Epic 101: 102, 104; Epic 103: 105; synthetic: 106, 107). */
    const adoPlan = () => planFromBacklog(makeBacklog(), makeConnection(), sequentialIds());
    /** Default backlog with Feature 102 renamed, a new Feature 108 under Epic 101, Feature 105 gone, and one warning. */
    const changedBacklog = () => {
      const base = makeBacklog();
      return makeBacklog({
        fetchedAt: "2026-10-24T09:00:00Z",
        warnings: ["Neither Custom.EstimatedSize nor Custom.FeatureSize exists in this project; sizes are empty."],
        workItems: [
          ...base.workItems.filter((i) => i.id !== 105).map((i) => (i.id === 102 ? { ...i, title: "Sign in" } : i)),
          makeFeatureItem({ id: 108, title: "Search", parentId: 101 }),
        ],
      });
    };
    const connectDialog = () => screen.getByRole("dialog", { name: "Sync from Azure DevOps" });
    const toasts = () => screen.queryAllByRole("status").map((s) => s.textContent);

    function mockFetch(backlog: AdoBacklog = changedBacklog()) {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/ado/backlog") {
          return json(backlog);
        }
        if (url === "/api/plan/1" && _init?.method === "PUT") {
          return json({ id: 1 });
        }
        throw new Error(`unexpected ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    /** Toolbar → sync dialog (connection read-only from plan.source) → PAT → Preview changes → the preview dialog. */
    async function openPreview(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole("button", { name: "Sync from ADO" }));
      await user.type(within(connectDialog()).getByLabelText("Personal Access Token"), PAT);
      await user.click(within(connectDialog()).getByRole("button", { name: "Preview changes" }));
      return screen.findByRole("button", { name: "Apply" });
    }
    /** The read-only value shown next to a label in the sync dialog. */
    const shown = (label: string) => within(connectDialog()).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

    beforeEach(() => window.localStorage.clear());
    afterEach(() => {
      vi.unstubAllGlobals();
      window.localStorage.clear();
    });

    it("shows the connection from plan.source read-only and asks only for the PAT", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch();
      renderBoard(adoPlan());
      await user.click(screen.getByRole("button", { name: "Sync from ADO" }));
      const dialog = connectDialog();
      expect(shown("Azure DevOps source")).toBe("Collaboration Hub");
      expect(shown("Project URL")).toBe("https://dev.azure.com/org/Proj");
      expect(shown("Area path")).toBe("Proj\\Team A");
      expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
      expect(within(dialog).queryAllByRole("textbox")).toHaveLength(0);
      expect(within(dialog).queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText("Personal Access Token")).toHaveValue("");
      await openPreviewFromOpenDialog(user);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ ...makeConnection(), pat: PAT });
    });

    async function openPreviewFromOpenDialog(user: ReturnType<typeof userEvent.setup>) {
      await user.type(within(connectDialog()).getByLabelText("Personal Access Token"), PAT);
      await user.click(within(connectDialog()).getByRole("button", { name: "Preview changes" }));
      await screen.findByRole("button", { name: "Apply" });
    }

    it("says an old plan without connection info can't be synced; the toolbar button stays enabled", async () => {
      const user = userEvent.setup();
      renderBoard(samplePlan());
      expect(screen.getByRole("button", { name: "Sync from ADO" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Sync from ADO" }));
      const dialog = connectDialog();
      expect(dialog).toHaveTextContent("This board isn't linked to an Azure DevOps project, so it can't be synced.");
      expect(within(dialog).queryByLabelText("Personal Access Token")).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Preview changes" })).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows a backlog error inline and opens no preview", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn(async () => json({ errors: ["Unknown Area path: Proj\\Team A."] }, 422));
      vi.stubGlobal("fetch", fetchMock);
      renderBoard(adoPlan());
      await user.click(screen.getByRole("button", { name: "Sync from ADO" }));
      await user.type(within(connectDialog()).getByLabelText("Personal Access Token"), PAT);
      await user.click(within(connectDialog()).getByRole("button", { name: "Preview changes" }));
      expect(await within(connectDialog()).findByRole("alert")).toHaveTextContent("Unknown Area path: Proj\\Team A.");
      expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    });

    it("previews the diff; Apply updates the board as one change, closes the work-item modal and toasts with the warnings", async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetch();
      renderBoard(adoPlan());
      // Manual saving, so the PUT can be inspected without waiting for the autosave delay.
      await user.click(screen.getByRole("switch", { name: "Autosave" }));
      await openPreview(user);
      const preview = screen.getByRole("dialog", { name: "Sync from Azure DevOps" });
      expect(within(preview).queryByLabelText("Personal Access Token")).not.toBeInTheDocument();
      expect([...preview.querySelectorAll("summary")].map((s) => s.textContent)).toEqual(["1 new Feature", "1 updated", "1 no longer in scope"]);
      expect(within(preview).getByRole("checkbox", { name: "Remove items no longer in scope" })).not.toBeChecked();
      expect(screen.getByTestId("save-status")).toHaveTextContent("Saved");
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByTestId("save-status")).toHaveTextContent("Unsaved changes");
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.getByTestId("save-status")).toHaveTextContent("Saved"));
      const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
      expect(puts).toHaveLength(1);
      const saved = (JSON.parse(String(puts[0][1]?.body)) as { state: ReleasePlan }).state;
      expect(saved.epics[0].features.map((f) => [f.id, f.title, f.milestoneId])).toEqual([
        [102, "Sign in", "ms_1"],
        [104, "Dashboard", "ms_1"],
        [108, "Search", null],
      ]);
      // Not removed: the box was unticked.
      expect(saved.epics[1].features.map((f) => f.id)).toEqual([105]);
      expect(saved.source.fetchedAt).toBe("2026-10-24T09:00:00Z");
      const board = within(screen.getByRole("region", { name: "Board" }));
      expect(board.getByText("Sign in")).toBeInTheDocument();
      expect(board.getByText("Search")).toBeInTheDocument();
      expect(toasts()).toEqual(
        expect.arrayContaining(["Board synchronized with Azure DevOps", "Neither Custom.EstimatedSize nor Custom.FeatureSize exists in this project; sizes are empty."]),
      );
      for (let i = 0; i < window.localStorage.length; i++) {
        expect(window.localStorage.getItem(window.localStorage.key(i) ?? "")).not.toContain(PAT);
      }
    });

    it("removes the items no longer in scope when the box is ticked", async () => {
      const user = userEvent.setup();
      mockFetch();
      renderBoard(adoPlan());
      await openPreview(user);
      await user.click(screen.getByRole("checkbox", { name: "Remove items no longer in scope" }));
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(within(screen.getByRole("region", { name: "Board" })).queryByText("Reports")).not.toBeInTheDocument();
    });

    it("closes a work-item modal that was open when the sync is applied", async () => {
      const user = userEvent.setup();
      mockFetch();
      renderBoard(adoPlan());
      fireEvent.click(within(screen.getByRole("region", { name: "Board" })).getByRole("button", { name: /Reports/ }));
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      await openPreview(user);
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("says the board is up to date when nothing changed", async () => {
      const user = userEvent.setup();
      mockFetch(makeBacklog());
      renderBoard(adoPlan());
      await openPreview(user);
      expect(screen.getByText("The board is up to date with Azure DevOps.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(toasts()).toContain("Board synchronized with Azure DevOps");
    });

    it("Cancel in the preview changes nothing and leaves the plan saved", async () => {
      const user = userEvent.setup();
      mockFetch();
      renderBoard(adoPlan());
      await openPreview(user);
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByTestId("save-status")).toHaveTextContent("Saved");
      const board = within(screen.getByRole("region", { name: "Board" }));
      expect(board.getByText("Login")).toBeInTheDocument();
      expect(board.queryByText("Search")).not.toBeInTheDocument();
      // queryAll: there may be no toast at all.
      expect(screen.queryAllByRole("status").map((s) => s.textContent)).not.toContain("Board synchronized with Azure DevOps");
    });
  });

  it("shows flag boxes in the summary for a Sprints plan", () => {
    renderBoard(sprintsPlan());
    const box = summaryBox("Flag Beta");
    expect(box).toHaveTextContent("after Sprint 1");
    expect(box).toHaveTextContent("1 Features (cumulative)");
    expect(box).toHaveTextContent("Epics completed by this flag: 0");
  });
});
