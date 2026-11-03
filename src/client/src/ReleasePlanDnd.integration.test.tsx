import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { STORAGE_KEY } from "./lib/releasePlan/constants";
import { ForecastProvider } from "./monteCarloStore";
import { fireDnd, flushDragTick, mockDataTransfer, stubRects } from "./test/dnd";

// Release Plan drag-and-drop integration (Phase 2, QA): the real App with its
// real ReleasePlanProvider autosaving to jsdom localStorage, real pages and
// components; only the HTML5 DnD events are synthesized (jsdom has no native
// DnD). A "reload" is an unmount + fresh render re-hydrating from the same
// localStorage. Synthetic data only.

const FLOW_TIMEOUT_MS = 20_000;
const FIND = { timeout: 5_000 };
// stubRects(): every element is 160px wide at left 0 → clientX 10 = L, 150 = R.
const LEFT = 10;
const ALPHA = 0;
const BETA = 1;

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path = "/") {
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

const PLAN = {
  schema: "release-planner-features",
  version: 1,
  mode: "releases",
  name: "DnD Integration Plan",
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
const epicEl = (id: number) => board().querySelector<HTMLElement>(`.epic[data-epic="${id}"]`) as HTMLElement;
const epicTitles = () => [...board().querySelectorAll(".epic .name > span:first-child")].map((n) => n.textContent);
/** Cell of `featureId` in band `bandIndex` (Alpha, Beta, Unplanned). */
const cell = (featureId: number, bandIndex: number) => board().querySelectorAll<HTMLElement>(`.fcell[data-feature="${featureId}"]`)[bandIndex];
const card = (featureId: number) => board().querySelector<HTMLElement>(`.fcard[data-feature="${featureId}"]`) as HTMLElement;
const summaryCount = (name: string) =>
  within(screen.getByRole("region", { name: "Milestone summary" })).getByRole("group", { name }).querySelector(".n")?.textContent;

function savedPlan(): { epics: Array<{ id: number; features: Array<{ id: number; milestoneId: string | null }> }> } {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
}

/** Seeds the autosave with PLAN and opens the board (a saved plan is no longer imported from a JSON file). */
function openBoard(): ReturnType<typeof renderApp> {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(PLAN));
  return renderApp("/release-plan/board");
}

describe("Release Plan – drag-and-drop full app flow (Phase 2)", () => {
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
    "import → drag a Feature to the next milestone → Table shows it → drag an Epic to first → order persists across a re-mount",
    async () => {
      const user = userEvent.setup();
      const first = openBoard();
      await screen.findByRole("region", { name: "Milestone summary" }, FIND);
      expect(screen.getByTestId("location")).toHaveTextContent("/release-plan/board");
      expect(summaryCount("Alpha")).toBe("2");
      expect(summaryCount("Beta")).toBe("1");

      // Drag "Export" (Alpha) down onto its own column in the Beta band.
      const dt = mockDataTransfer();
      fireDnd("dragStart", card(1002), { dataTransfer: dt });
      expect(dt.effectAllowed).toBe("move");
      await flushDragTick();
      expect(card(1002)).toHaveClass("dragging");
      expect(cell(1002, BETA)).toHaveClass("valid");
      expect(cell(1003, BETA)).toHaveClass("invalid");
      // A drop on the other Epic's cell is refused (no preventDefault) and changes nothing.
      expect(fireDnd("dragOver", cell(1003, ALPHA), { dataTransfer: dt, clientX: LEFT }).defaultPrevented).toBe(false);
      const over = fireDnd("dragOver", cell(1002, BETA), { dataTransfer: dt, clientX: LEFT });
      expect(over.defaultPrevented).toBe(true);
      expect(cell(1002, BETA)).toHaveClass("over");
      expect(cell(1002, BETA)).not.toHaveClass("dropL"); // own column: no reorder indicator
      fireDnd("drop", cell(1002, BETA), { dataTransfer: dt, clientX: LEFT });
      fireDnd("dragEnd", document, { dataTransfer: dt });
      expect(board().querySelectorAll(".valid, .invalid, .over, .dropL, .dropR, .dragging")).toHaveLength(0);
      expect(cell(1002, BETA).querySelector(".fcard")).not.toBeNull();
      expect(cell(1002, ALPHA).querySelector(".fcard")).toBeNull();
      expect(summaryCount("Alpha")).toBe("1");
      expect(summaryCount("Beta")).toBe("2");
      expect(savedPlan().epics[0].features.map((f) => [f.id, f.milestoneId])).toEqual([
        [1001, "ms_alpha"],
        [1002, "ms_beta"],
      ]);

      // Table view shows the new milestone.
      await user.click(screen.getByRole("tab", { name: "Table" }));
      expect(screen.getByRole("combobox", { name: "Milestone for Export" })).toHaveValue("ms_beta");
      expect(screen.getByRole("combobox", { name: "Milestone for Search" })).toHaveValue("ms_alpha");

      // Back to the Board: drag "Epic Two" onto the left half of "Epic One" → first position.
      await user.click(screen.getByRole("tab", { name: "Board" }));
      expect(epicTitles()).toEqual(["Epic One", "Epic Two"]);
      const edt = mockDataTransfer();
      fireDnd("dragStart", epicEl(102), { dataTransfer: edt });
      expect(edt.setData).toHaveBeenCalledWith("text/plain", "epic:102");
      await flushDragTick();
      expect(epicEl(102)).toHaveClass("dragging");
      expect(fireDnd("dragOver", epicEl(101), { dataTransfer: edt, clientX: LEFT }).defaultPrevented).toBe(true);
      expect(epicEl(101)).toHaveClass("dropL");
      fireDnd("drop", epicEl(101), { dataTransfer: edt, clientX: LEFT });
      fireDnd("dragEnd", document, { dataTransfer: edt });
      expect(epicTitles()).toEqual(["Epic Two", "Epic One"]);
      expect(board().querySelectorAll(".dragging, .dropL, .dropR")).toHaveLength(0);
      expect(savedPlan().epics.map((e) => e.id)).toEqual([102, 101]);

      // Ctrl+click a card: the selection is UI-only and must not survive the re-mount.
      fireEvent.click(card(1001), { ctrlKey: true });
      expect(card(1001)).toHaveClass("selected");

      // "Reload": a fresh provider re-hydrates from the same storage.
      first.unmount();
      renderApp("/release-plan/board");
      expect(await screen.findByText("Restored your last session", undefined, FIND)).toBeInTheDocument();
      expect(epicTitles()).toEqual(["Epic Two", "Epic One"]);
      expect(cell(1002, BETA).querySelector(".fcard")).not.toBeNull();
      expect(summaryCount("Beta")).toBe("2");
      expect(board().querySelectorAll(".fcard.selected")).toHaveLength(0);
      await user.click(screen.getByRole("tab", { name: "Table" }));
      expect(screen.getByRole("combobox", { name: "Milestone for Export" })).toHaveValue("ms_beta");
    },
    FLOW_TIMEOUT_MS,
  );

  it(
    "leaves no document/window listener, rAF loop, timer or drag ghost behind when the board unmounts mid-drag",
    async () => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 1;
      const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        frames.set(nextFrame, cb);
        return nextFrame++;
      });
      const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
        frames.delete(id);
      });
      const user = userEvent.setup();
      openBoard();
      await screen.findByRole("region", { name: "Milestone summary" }, FIND);

      // Track listeners added/removed from here on (the board is already mounted, so
      // re-mount it through Table → Board to capture its registrations).
      await user.click(screen.getByRole("tab", { name: "Table" }));
      const keyOf = (target: string, type: string, listener: unknown, options: unknown) => {
        const capture = typeof options === "boolean" ? options : Boolean((options as AddEventListenerOptions | undefined)?.capture);
        return { key: `${target}|${type}|${capture}`, listener };
      };
      const listeners = new Map<string, Set<unknown>>();
      let recording = false;
      const boardAdded: Array<{ key: string; listener: unknown }> = [];
      const track = (target: EventTarget, name: string) => {
        const add = target.addEventListener.bind(target);
        const remove = target.removeEventListener.bind(target);
        vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
          const { key } = keyOf(name, type, listener, options);
          if (!listeners.has(key)) listeners.set(key, new Set());
          listeners.get(key)?.add(listener);
          if (recording) boardAdded.push({ key, listener });
          add(type, listener, options);
        });
        vi.spyOn(target, "removeEventListener").mockImplementation((type, listener, options) => {
          const { key } = keyOf(name, type, listener, options);
          listeners.get(key)?.delete(listener);
          remove(type, listener, options);
        });
      };
      track(document, "document");
      track(window, "window");
      const timeouts = new Set<number>();
      const realSetTimeout = window.setTimeout;
      const realClearTimeout = window.clearTimeout;
      vi.spyOn(window, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        const id = realSetTimeout(
          (...a: unknown[]) => {
            timeouts.delete(id);
            (fn as (...x: unknown[]) => void)(...a);
          },
          ms,
          ...args,
        );
        timeouts.add(id);
        return id;
      }) as typeof window.setTimeout);
      vi.spyOn(window, "clearTimeout").mockImplementation((id?: number) => {
        if (id !== undefined) timeouts.delete(id);
        realClearTimeout(id);
      });

      recording = true;
      await user.click(screen.getByRole("tab", { name: "Board" }));
      recording = false;
      const dragTypes = ["dragover", "drop", "dragend", "keydown"];
      for (const type of dragTypes) {
        const registered = boardAdded.some(({ key }) => key.startsWith(`document|${type}|`));
        expect(registered, `board registered a document ${type} listener`).toBe(true);
      }

      // Board box with room to scroll, then a multi-drag (ghost + pending tick) near the bottom edge.
      const box = screen.getByTestId("board-scroll");
      Object.defineProperty(box, "clientHeight", { configurable: true, value: 84 });
      Object.defineProperty(box, "scrollHeight", { configurable: true, value: 2000 });
      fireEvent.click(card(1001), { ctrlKey: true });
      fireEvent.click(card(1002), { ctrlKey: true });
      const dt = mockDataTransfer();
      timeouts.clear();
      fireDnd("dragStart", card(1002), { dataTransfer: dt });
      const dragTimers = new Set(timeouts);
      expect(dt.setDragImage).toHaveBeenCalledTimes(1);
      expect(document.getElementById("dragGhost")).toHaveTextContent("2 features");
      fireDnd("dragOver", document, { clientY: 80 });
      expect(frames.size).toBe(1);
      expect(dragTimers.size, "dragstart scheduled its next-tick work").toBeGreaterThan(0);

      // Leave the board mid-drag (Table view unmounts it).
      await user.click(screen.getByRole("tab", { name: "Table" }));
      expect(frames.size).toBe(0);
      expect(caf).toHaveBeenCalled();
      expect(document.getElementById("dragGhost")).toBeNull();
      expect([...dragTimers].filter((id) => timeouts.has(id)), "no pending drag timers").toEqual([]);
      for (const { key, listener } of boardAdded) {
        expect(listeners.get(key)?.has(listener), `${key} listener removed`).toBe(false);
      }

      // A late dragover/dragend on the page does nothing.
      const before = raf.mock.calls.length;
      fireDnd("dragOver", document, { clientY: 80 });
      fireDnd("dragEnd", document);
      expect(raf.mock.calls.length).toBe(before);
      expect(frames.size).toBe(0);
    },
    FLOW_TIMEOUT_MS,
  );
});
