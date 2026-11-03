// QA integration tests for Release Plan "Export PNG" (plans/release-plan-import-export.md, Phase 2).
// Real board page through the router, real store seeded with the plan, real useExportPng / drawBoardPng /
// computeLayout / downloadBlob. Only the browser boundaries jsdom lacks are stubbed: Image (FakeImage), canvas
// getContext/toBlob (RecordingContext via stubCanvas), URL.createObjectURL/revokeObjectURL and the anchor click.
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L, PALETTE } from "../lib/releasePlan/constants";
import { computeLayout } from "../lib/releasePlan/layout";
import { PNG_HEAD, pngScale } from "../lib/releasePlan/png";
import { fmtDate } from "../lib/releasePlan/selectors";
import { normalizePlan } from "../lib/releasePlan/validate";
import type { ReleasePlan } from "../lib/releasePlan/types";
import { FakeImage, RecordingContext, stubCanvas } from "../test/canvas";
import { makeEpic, makePlan, samplePlan, sprintsPlan } from "../test/releasePlanFixtures";
import { renderAt } from "../test/render";
import { BOARD_TEST_TIMEOUT_MS } from "../test/renderBoard";
import { ReleasePlanBoardPage } from "./ReleasePlanBoardPage";
import { ReleasePlanHomePage } from "./ReleasePlanHomePage";

const NOW = new Date("2026-10-21T09:15:00.000Z");
const PNG_BLOB = new Blob(["\x89PNG"], { type: "image/png" });
const TOO_LARGE = "The board is too large to export as PNG.";
const FAILED = "Could not export the PNG.";

const exportButton = () => screen.getByRole("button", { name: "Export PNG" });
const infoTexts = () => screen.queryAllByRole("status").map((s) => s.textContent);
const errorTexts = () => screen.queryAllByRole("alert").map((a) => a.textContent ?? "");
const exportedDate = (d: Date) => d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

function renderBoardPage(plan: ReleasePlan) {
  return renderAt("/release-plan/:id", <ReleasePlanBoardPage />, {
    initialPlan: plan,
    initialPlanId: 1,
    initialEntry: "/release-plan/1",
    routes: { "/release-plan": <ReleasePlanHomePage /> },
  });
}

/**
 * A Releases plan too wide for a canvas even at scale 1, with as few rendered elements as possible: 83 empty
 * Epics (one 180 px column each + 18 px gap → 16 636 px > PNG_MAX_SIDE) and no Features, bands or flags, so the
 * board stays small enough for the full (parallel) suite.
 */
function hugePlan(): ReleasePlan {
  return makePlan({ name: "Huge Plan", epics: Array.from({ length: 83 }, (_, i) => makeEpic({ id: i + 1 })) });
}

/** Waits for the export started by a click to settle (FakeImage + toBlob resolve on microtasks). */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("Release Plan Export PNG integration", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  let blobs: Blob[];
  let downloads: Array<{ name: string; href: string }>;
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

  beforeEach(() => {
    document.querySelectorAll("a[download]").forEach((a) => a.remove());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("Image", FakeImage);
    FakeImage.reset();
    blobs = [];
    downloads = [];
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return `blob:png-${blobs.length}`;
      },
      revokeObjectURL: () => undefined,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, href: this.getAttribute("href") ?? "" });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeImage.reset();
    Object.assign(URL, { createObjectURL: original.create, revokeObjectURL: original.revoke });
  });

  it("Board view: downloads <name>_<today>.png made from the toBlob output, draws the plan at scale 2 and toasts; the store is untouched", async () => {
    const user = userEvent.setup();
    const ctx = new RecordingContext();
    const canvases = stubCanvas({ context: ctx, blob: PNG_BLOB });
    const plan = samplePlan();
    renderBoardPage(plan);

    await user.click(exportButton());
    expect(await screen.findByText("PNG exported")).toBeInTheDocument();

    expect(downloads).toEqual([{ name: "Sample_Release_Plan_2026-10-21.png", href: "blob:png-1" }]);
    expect(blobs).toEqual([PNG_BLOB]);
    expect(HTMLCanvasElement.prototype.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");

    const layout = computeLayout(plan);
    expect(canvases).toHaveLength(1);
    expect([canvases[0].width, canvases[0].height]).toEqual([layout.width * 2, (layout.height + PNG_HEAD) * 2]);
    expect(ctx.calls[0]).toMatchObject({ op: "scale", args: [2, 2] });

    // Header, logo plate, bands, epics and cards come from the plan in the store.
    const texts = ctx.texts();
    expect(texts).toContain("Sample Release Plan");
    expect(texts).toContain(`Exported ${exportedDate(NOW)} · Azure DevOps`);
    expect(ctx.ops("drawImage")).toHaveLength(1);
    expect(texts).toEqual(expect.arrayContaining(["MVP", "Release 2", "Unplanned", "Not assigned", "No date", fmtDate("2026-11-30")]));
    expect(texts).toEqual(expect.arrayContaining(["Wave 1 - MVP", "Wave 2 - Reporting", "Wave 3 - Empty"]));
    expect(texts).toEqual(expect.arrayContaining(["Feature #11", "Feature #12", "Feature #21", "Feature #22", "Feature #23"]));
    expect(texts.filter((t) => t.startsWith("Feature #"))).toHaveLength(5);

    expect(errorTexts()).toEqual([]);
    expect(exportButton()).toBeEnabled();
    expect(screen.getByTestId("save-status")).toHaveTextContent("Saved");
  });

  it("Table view: Export PNG still draws the board (not the table) and downloads the .png", async () => {
    const user = userEvent.setup();
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: PNG_BLOB });
    renderBoardPage(samplePlan());

    await user.click(screen.getByRole("tab", { name: "Table" }));
    expect(screen.getByRole("region", { name: "Table" })).toBeInTheDocument();
    await user.click(exportButton());
    expect(await screen.findByText("PNG exported")).toBeInTheDocument();

    expect(downloads.map((d) => d.name)).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
    expect(ctx.texts()).toEqual(expect.arrayContaining(["Wave 1 - MVP", "Feature #22", "MVP"]));
    expect(ctx.ops("drawImage")).toHaveLength(1);
    // The view is kept.
    expect(screen.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
  });

  it("exports the current state after edits: renamed plan (file name + header) and a Feature moved in the Table view", async () => {
    const user = userEvent.setup();
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: PNG_BLOB });
    renderBoardPage(samplePlan());

    const name = screen.getByLabelText("Plan name");
    await user.clear(name);
    await user.type(name, "Q4 Roadmap / v2{Enter}");
    await user.click(screen.getByRole("tab", { name: "Table" }));
    // Move #22 "Exports" from Unplanned to MVP.
    await user.selectOptions(screen.getByLabelText("Milestone for Exports"), "ms_mvp");

    await user.click(exportButton());
    expect(await screen.findByText("PNG exported")).toBeInTheDocument();
    expect(downloads.map((d) => d.name)).toEqual(["Q4_Roadmap_v2_2026-10-21.png"]);
    expect(ctx.texts()).toContain("Q4 Roadmap / v2");

    // The card of #22 is drawn in the MVP band (y = band.y + BAND_PAD, header translated away).
    const moved = normalizePlan({ ...samplePlan(), name: "Q4 Roadmap / v2" });
    moved.epics[1].features[1].milestoneId = "ms_mvp";
    const layout = computeLayout(moved);
    const mvp = layout.bands.find((b) => b.band.id === "ms_mvp");
    const col = layout.epics[1].cols[1];
    expect(col.feature.id).toBe(22);
    expect(ctx.text("Feature #22").args).toEqual(["Feature #22", col.x + 22, (mvp?.y ?? NaN) + L.BAND_PAD + 6]);
    // MVP now counts 3 Features, Unplanned 0.
    expect(ctx.texts()).toEqual(expect.arrayContaining(["3 Features", "0 Features"]));
  });

  it("Export PNG of a Sprints plan with a dated flag", async () => {
    const user = userEvent.setup();
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: PNG_BLOB });
    renderBoardPage(sprintsPlan());
    expect(screen.getByLabelText("Plan name")).toHaveValue("Sprint Plan");

    await user.click(exportButton());
    expect(await screen.findByText("PNG exported")).toBeInTheDocument();
    expect(downloads.map((d) => d.name)).toEqual(["Sprint_Plan_2026-10-21.png"]);
    const texts = ctx.texts();
    expect(texts).toContain("Sprint Plan");
    expect(texts).not.toContain("Sample Release Plan");
    // sprintsPlan has no source system → "Manual".
    expect(texts).toContain(`Exported ${exportedDate(NOW)} · Manual`);
    // The flag row: name in the gold plate and the "name · date" pill.
    expect(texts).toContain("Beta");
    const label = `Beta · ${fmtDate("2026-09-25")}`;
    expect(ctx.text(label)).toMatchObject({ fillStyle: PALETTE.flagInk, args: [label, L.LEFT + 30, expect.any(Number)] });
  });

  it("a board beyond the canvas limits shows the too-large error toast, creates no canvas and downloads nothing; the button is re-enabled", async () => {
    const plan = hugePlan();
    const layout = computeLayout(plan);
    expect(pngScale(layout.width, layout.height + PNG_HEAD)).toBeNull();
    const canvases = stubCanvas({ context: new RecordingContext(), blob: PNG_BLOB });
    renderBoardPage(plan);

    // Queries are scoped (toolbar / toast text) instead of page-wide *ByRole: role queries over the whole wide
    // board are what made this test slow under the parallel suite. fireEvent for the same reason.
    const toolbar = screen.getByLabelText("Plan name").closest<HTMLElement>(".toolbar");
    if (!toolbar) throw new Error("toolbar not found");
    const button = within(toolbar).getByRole("button", { name: "Export PNG" });
    fireEvent.click(button);
    expect((await screen.findByText(TOO_LARGE)).closest('[role="alert"]')).not.toBeNull();
    await settle();
    expect(canvases).toHaveLength(0);
    expect(downloads).toEqual([]);
    expect(screen.queryByText("PNG exported")).toBeNull();
    expect(button).toBeEnabled();
  });

  it("no 2D context shows 'Could not export the PNG.' and downloads nothing; a retry with a working canvas succeeds", async () => {
    const user = userEvent.setup();
    stubCanvas({ context: null, blob: PNG_BLOB });
    renderBoardPage(samplePlan());

    await user.click(exportButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
    expect(downloads).toEqual([]);
    expect(exportButton()).toBeEnabled();

    vi.restoreAllMocks();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, href: this.getAttribute("href") ?? "" });
    });
    stubCanvas({ context: new RecordingContext(), blob: PNG_BLOB });
    await user.click(exportButton());
    expect(await screen.findByText("PNG exported")).toBeInTheDocument();
    expect(downloads.map((d) => d.name)).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
  });

  it("toBlob yielding null shows 'Could not export the PNG.' and downloads nothing", async () => {
    const user = userEvent.setup();
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: null });
    renderBoardPage(samplePlan());

    await user.click(exportButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
    expect(ctx.calls.length).toBeGreaterThan(0);
    expect(blobs).toEqual([]);
    expect(downloads).toEqual([]);
    expect(infoTexts()).not.toContain("PNG exported");
    expect(exportButton()).toBeEnabled();
  });

  it("an exception while drawing shows 'Could not export the PNG.' (no crash) and the board stays usable", async () => {
    const user = userEvent.setup();
    const ctx = new RecordingContext();
    ctx.fillText = () => {
      throw new Error("boom");
    };
    stubCanvas({ context: ctx, blob: PNG_BLOB });
    renderBoardPage(samplePlan());

    await user.click(exportButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(FAILED);
    expect(downloads).toEqual([]);
    expect(exportButton()).toBeEnabled();
    expect(screen.getByRole("region", { name: "Board" })).toBeInTheDocument();
  });

  it("a logo that fails to load still exports the PNG, without the logo plate image", async () => {
    const user = userEvent.setup();
    FakeImage.fail = true;
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: PNG_BLOB });
    renderBoardPage(samplePlan());

    await user.click(exportButton());
    expect(await screen.findByText("PNG exported")).toBeInTheDocument();
    expect(ctx.ops("drawImage")).toHaveLength(0);
    expect(downloads.map((d) => d.name)).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
    expect(errorTexts()).toEqual([]);
  });

  it("a logo that never loads: the PNG is exported without it after the 3 s timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    FakeImage.hold = true;
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: PNG_BLOB });
    renderBoardPage(samplePlan());

    fireEvent.click(exportButton());
    await settle();
    expect(exportButton()).toBeDisabled();
    expect(downloads).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });
    expect(downloads).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    expect(downloads.map((d) => d.name)).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
    expect(ctx.ops("drawImage")).toHaveLength(0);
    expect(screen.getByText("PNG exported")).toBeInTheDocument();
    expect(exportButton()).toBeEnabled();
  });

  it("a double click while the export runs produces a single download (button disabled meanwhile)", async () => {
    FakeImage.hold = true;
    const canvases = stubCanvas({ context: new RecordingContext(), blob: PNG_BLOB });
    renderBoardPage(samplePlan());

    fireEvent.click(exportButton());
    fireEvent.click(exportButton());
    await settle();
    expect(exportButton()).toBeDisabled();
    fireEvent.click(exportButton());
    act(() => FakeImage.release());
    expect(await screen.findByText("PNG exported")).toBeInTheDocument();
    expect(canvases).toHaveLength(1);
    expect(downloads).toHaveLength(1);
    expect(exportButton()).toBeEnabled();
  });

  it("unmounting the page while an export is pending does not throw", async () => {
    FakeImage.hold = true;
    stubCanvas({ context: new RecordingContext(), blob: PNG_BLOB });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderBoardPage(samplePlan());

    fireEvent.click(exportButton());
    await settle();
    view.unmount();
    await act(async () => {
      FakeImage.release();
    });
    await settle();
    expect(errors).not.toHaveBeenCalled();
  });
});
