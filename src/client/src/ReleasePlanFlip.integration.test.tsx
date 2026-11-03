import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L } from "./lib/releasePlan/constants";
import { computeFlippedLayout, computeLayout } from "./lib/releasePlan/layout";
import { PNG_HEAD } from "./lib/releasePlan/png";
import { normalizePlan } from "./lib/releasePlan/validate";
import { FakeImage, RecordingContext, stubCanvas } from "./test/canvas";
import { disableAutosave, stubPlanServer } from "./test/planServer";
import { renderApp } from "./test/renderApp";
import { fireDnd, flushDragTick, mockDataTransfer, stubRects } from "./test/dnd";

// Release Plan "Flip board" (QA integration): the real App with its real
// ReleasePlanProvider autosaving to jsdom localStorage, real pages and
// components. Only the browser primitives jsdom lacks are synthesized: HTML5
// DnD events, element rects, canvas/Image and the download anchor. A "reload"
// is an unmount + fresh render re-hydrating from the same localStorage.
// Synthetic data only.

const FLOW_TIMEOUT_MS = 20_000;
const FIND = { timeout: 5_000 };
// stubRects(): every element is 160x84 at (0,0) → clientX 10 = left half, 150 = right half;
// clientY 10 = upper half, 80 = lower half.
const LEFT = 10;
const RIGHT = 150;
const ABOVE = 10;
const BELOW = 80;
// Flipped columns / standard bands, in order.
const ALPHA = 0;
const BETA = 1;

const PLAN = {
  schema: "release-planner-features",
  version: 1,
  mode: "releases",
  name: "Flip Integration Plan",
  source: { system: "Azure DevOps", project: "Synthetic", scope: "Area Path: Synthetic\\Team" },
  iterations: [],
  milestones: [
    { id: "ms_alpha", name: "Alpha", date: "2026-11-06", color: "#4E98D1" },
    { id: "ms_beta", name: "Beta", date: "2026-12-04", color: "#60C5B5" },
  ],
  flags: [],
  epics: [
    {
      id: 101,
      title: "Epic One",
      state: "Active",
      description: "",
      features: [
        { id: 1001, title: "Search", state: "Done", size: "M", iterationPath: "", description: "", milestoneId: "ms_alpha" },
        { id: 1002, title: "Export", state: "New", size: "L", iterationPath: "", description: "", milestoneId: "ms_alpha" },
      ],
    },
    {
      id: 102,
      title: "Epic Two",
      state: "New",
      description: "",
      features: [{ id: 1003, title: "Reports", state: "New", size: "S", iterationPath: "", description: "", milestoneId: "ms_beta" }],
    },
  ],
};


const board = () => screen.getByRole("region", { name: "Board" });
const flipButton = () => screen.getByRole("button", { name: "Flip board" });
const isFlipped = () => screen.queryByTestId("frozen-header") !== null;
const epicEl = (id: number) => board().querySelector<HTMLElement>(`.epic[data-epic="${id}"]`) as HTMLElement;
const epicTitles = () => [...board().querySelectorAll(".epic .name > span:first-child")].map((n) => n.textContent);
/** Cell of `featureId` in milestone `index` (Alpha, Beta, Unplanned): a band when standard, a column when flipped. */
const cell = (featureId: number, index: number) => board().querySelectorAll<HTMLElement>(`.fcell[data-feature="${featureId}"]`)[index];
const card = (featureId: number) => board().querySelector<HTMLElement>(`.fcard[data-feature="${featureId}"]`) as HTMLElement;
const featureOrder = (epicId: number) => [...board().querySelectorAll(`.fcell[data-epic="${epicId}"] .fcard`)].map((n) => n.getAttribute("data-feature"));
const summaryCount = (name: string) =>
  within(screen.getByRole("region", { name: "Milestone summary" })).getByRole("group", { name }).querySelector(".n")?.textContent;
const highlighted = () => board().querySelectorAll(".valid, .invalid, .over, .dropT, .dropB, .dropL, .dropR, .dragging");

type Saved = { epics: Array<{ id: number; features: Array<{ id: number; milestoneId: string | null }> }> } & Record<string, unknown>;
let server: ReturnType<typeof stubPlanServer>;

/** Saves with the Save button (autosave is off in these tests) and returns what the server received last. */
async function savedPlan(user: ReturnType<typeof userEvent.setup>): Promise<Saved> {
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByTestId("save-status")).toHaveTextContent("Saved"));
  return server.puts[server.puts.length - 1].state as Saved;
}

/** The server holds PLAN (autosave off, so tests save explicitly); opens its board. */
function openBoard(): ReturnType<typeof renderApp> {
  server = stubPlanServer(PLAN);
  disableAutosave();
  return renderApp("/release-plan/1");
}

/** Drags a Feature card and drops it on `target` at (`clientX`, `clientY`). */
async function dragFeature(featureId: number, target: HTMLElement, clientX: number, clientY: number) {
  const dt = mockDataTransfer();
  fireDnd("dragStart", card(featureId), { dataTransfer: dt });
  await flushDragTick();
  const over = fireDnd("dragOver", target, { dataTransfer: dt, clientX, clientY });
  const accepted = over.defaultPrevented;
  const classes = [...target.classList];
  fireDnd("drop", target, { dataTransfer: dt, clientX, clientY });
  fireDnd("dragEnd", document, { dataTransfer: dt });
  return { accepted, classes };
}

async function dragEpic(epicId: number, targetId: number, clientX: number, clientY: number) {
  const dt = mockDataTransfer();
  fireDnd("dragStart", epicEl(epicId), { dataTransfer: dt });
  await flushDragTick();
  fireDnd("dragOver", epicEl(targetId), { dataTransfer: dt, clientX, clientY });
  const classes = [...epicEl(targetId).classList];
  fireDnd("drop", epicEl(targetId), { dataTransfer: dt, clientX, clientY });
  fireDnd("dragEnd", document, { dataTransfer: dt });
  return classes;
}

describe("Release Plan – Flip board full app flow (QA)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    stubRects();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it(
    "import → standard by default → flip → drag a Feature across milestone columns → autosaved; Table → Board keeps flipped; reload is standard again",
    async () => {
      const user = userEvent.setup();
      const first = openBoard();
      await screen.findByRole("region", { name: "Milestone summary" }, FIND);
      expect(screen.getByTestId("location")).toHaveTextContent("/release-plan/1");
      expect(flipButton()).toHaveAttribute("aria-pressed", "false");
      expect(isFlipped()).toBe(false);

      await user.click(flipButton());
      expect(flipButton()).toHaveAttribute("aria-pressed", "true");
      expect(isFlipped()).toBe(true);
      // Flipping is UI-only: the plan has nothing to save.
      expect(screen.getByTestId("save-status")).toHaveTextContent("Saved");

      // Drag "Export" right into the Beta column of its own row (clientY irrelevant on its own row).
      const own = await dragFeature(1002, cell(1002, BETA), RIGHT, BELOW);
      expect(own.accepted).toBe(true);
      expect(own.classes).toContain("over");
      expect(own.classes).not.toContain("dropB");
      expect(own.classes).not.toContain("dropR");
      expect(highlighted()).toHaveLength(0);
      expect(cell(1002, BETA).querySelector(".fcard")).not.toBeNull();
      expect(cell(1002, ALPHA).querySelector(".fcard")).toBeNull();
      expect(summaryCount("Alpha")).toBe("1");
      expect(summaryCount("Beta")).toBe("2");
      expect((await savedPlan(user)).epics[0].features.map((f) => [f.id, f.milestoneId])).toEqual([
        [1001, "ms_alpha"],
        [1002, "ms_beta"],
      ]);

      // A drop on another Epic's row is refused.
      const other = await dragFeature(1003, cell(1001, ALPHA), LEFT, ABOVE);
      expect(other.accepted).toBe(false);
      expect((await savedPlan(user)).epics[1].features[0].milestoneId).toBe("ms_beta");

      // Table shows the move; the orientation survives Table → Board.
      await user.click(screen.getByRole("tab", { name: "Table" }));
      expect(screen.queryByRole("button", { name: "Flip board" })).not.toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Milestone for Export" })).toHaveValue("ms_beta");
      await user.click(screen.getByRole("tab", { name: "Board" }));
      expect(isFlipped()).toBe(true);
      expect(flipButton()).toHaveAttribute("aria-pressed", "true");
      expect(cell(1002, BETA).querySelector(".fcard")).not.toBeNull();

      // Nothing orientation-related is stored in the plan.
      expect(JSON.stringify((await savedPlan(user)))).not.toMatch(/orientation|flipped/i);

      // "Reload": the move is restored, the board is standard again.
      first.unmount();
      renderApp("/release-plan/1");
      await screen.findByRole("region", { name: "Milestone summary" }, FIND);
      expect(isFlipped()).toBe(false);
      expect(flipButton()).toHaveAttribute("aria-pressed", "false");
      expect(cell(1002, BETA).querySelector(".fcard")).not.toBeNull();
      expect(summaryCount("Beta")).toBe("2");
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    "flipped: same-epic reorder and epic reorder use clientY; after flipping back the standard board uses clientX again",
    async () => {
      const user = userEvent.setup();
      openBoard();
      await screen.findByRole("region", { name: "Milestone summary" }, FIND);
      await user.click(flipButton());

      // "Export" dropped in the upper half of the "Search" row, Beta column → before Search, moved to Beta.
      const re = await dragFeature(1002, cell(1001, BETA), RIGHT, ABOVE);
      expect(re.accepted).toBe(true);
      expect(re.classes).toContain("dropT");
      expect(featureOrder(101)).toEqual(["1002", "1001"]);
      expect((await savedPlan(user)).epics[0].features.map((f) => [f.id, f.milestoneId])).toEqual([
        [1002, "ms_beta"],
        [1001, "ms_alpha"],
      ]);

      // Epic Two dropped on the upper half of Epic One (right half by X) → first.
      const ep = await dragEpic(102, 101, RIGHT, ABOVE);
      expect(ep).toContain("dropT");
      expect(ep).not.toContain("dropR");
      expect(epicTitles()).toEqual(["Epic Two", "Epic One"]);
      expect((await savedPlan(user)).epics.map((e) => e.id)).toEqual([102, 101]);

      // ▼ on Epic Two moves it back down (moveEpic).
      await user.click(within(epicEl(102)).getByRole("button", { name: "Move Epic down" }));
      expect(epicTitles()).toEqual(["Epic One", "Epic Two"]);
      expect((await savedPlan(user)).epics.map((e) => e.id)).toEqual([101, 102]);

      // Flip back: the hook reads the orientation through a ref — the side must follow clientX now.
      await user.click(flipButton());
      expect(isFlipped()).toBe(false);
      const std = await dragEpic(102, 101, LEFT, BELOW);
      expect(std).toContain("dropL");
      expect(std).not.toContain("dropB");
      expect(epicTitles()).toEqual(["Epic Two", "Epic One"]);
      // Standard same-epic reorder: right half of the Search column (any Y) → Export after Search, into Alpha.
      const sre = await dragFeature(1002, cell(1001, ALPHA), RIGHT, ABOVE);
      expect(sre.classes).toContain("dropR");
      expect(sre.classes).not.toContain("dropT");
      expect(featureOrder(101)).toEqual(["1001", "1002"]);
      expect((await savedPlan(user)).epics[1].features.map((f) => [f.id, f.milestoneId])).toEqual([
        [1001, "ms_alpha"],
        [1002, "ms_alpha"],
      ]);
    },
    FLOW_TIMEOUT_MS,
  );
});

describe("Release Plan – Flip board + Export PNG through the app (QA)", () => {
  let downloads: string[];

  beforeEach(() => {
    window.localStorage.clear();
    server = stubPlanServer(PLAN);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.stubGlobal("Image", FakeImage);
    FakeImage.reset();
    downloads = [];
    Object.assign(URL, { createObjectURL: () => "blob:png", revokeObjectURL: () => undefined });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeImage.reset();
  });

  async function exportOnce(ctx: RecordingContext) {
    const canvases = stubCanvas({ context: ctx, blob: new Blob(["png"], { type: "image/png" }) });
    fireEvent.click(screen.getByRole("button", { name: "Export PNG" }));
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    return canvases;
  }

  /** Top-left of each Feature card as drawn in the PNG ("Feature #id" is drawn at card + (22, 6)). */
  function pngCards(ctx: RecordingContext): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    for (const c of ctx.ops("fillText")) {
      const m = /^Feature #(\d+)$/.exec(String(c.args[0]));
      if (m) out.set(m[1], [Number(c.args[1]) - 22, Number(c.args[2]) - 6]);
    }
    return out;
  }

  /** Top-left of each Feature card in the DOM, from its cell's inline geometry and padding. */
  function domCards(flipped: boolean): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    for (const cardEl of board().querySelectorAll<HTMLElement>(".fcard")) {
      const cellEl = cardEl.closest<HTMLElement>(".fcell") as HTMLElement;
      const left = parseFloat(cellEl.style.left);
      const top = parseFloat(cellEl.style.top);
      out.set(String(cardEl.getAttribute("data-feature")), flipped ? [left + L.BAND_PAD, top] : [left, top + L.BAND_PAD]);
    }
    return out;
  }

  it(
    "exports the orientation shown (also from Table view) with card positions matching the DOM board",
    async () => {
      renderApp("/release-plan/1");
      await screen.findByRole("region", { name: "Milestone summary" }, FIND);
      const plan = normalizePlan(PLAN);

      const std = new RecordingContext();
      const stdCanvas = await exportOnce(std);
      expect(stdCanvas[0].width).toBe(computeLayout(plan).width * 2);
      expect(pngCards(std)).toEqual(domCards(false));
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockRestore();
      vi.mocked(HTMLCanvasElement.prototype.toBlob).mockRestore();

      fireEvent.click(flipButton());
      const flippedLayout = computeFlippedLayout(plan);
      const fl = new RecordingContext();
      const flCanvas = await exportOnce(fl);
      expect(flCanvas[0].width).toBe(flippedLayout.width * 2);
      expect(flCanvas[0].height).toBe((flippedLayout.height + PNG_HEAD) * 2);
      expect(pngCards(fl)).toEqual(domCards(true));
      expect(pngCards(fl).size).toBe(3);
      // Board DOM size equals the PNG layout (zoom 1).
      const scale = screen.getByTestId("board-scale");
      expect(parseFloat(scale.style.width)).toBe(flippedLayout.width);
      expect(parseFloat(scale.style.height)).toBe(flippedLayout.height);
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockRestore();
      vi.mocked(HTMLCanvasElement.prototype.toBlob).mockRestore();

      // Table view keeps the flipped orientation for the export.
      fireEvent.click(screen.getByRole("tab", { name: "Table" }));
      const tb = new RecordingContext();
      const tbCanvas = await exportOnce(tb);
      expect(tbCanvas[0].width).toBe(flippedLayout.width * 2);
      expect(downloads).toHaveLength(3);
      downloads.forEach((d) => expect(d).toMatch(/^Flip_Integration_Plan_\d{4}-\d{2}-\d{2}\.png$/));
    },
    FLOW_TIMEOUT_MS,
  );
});
