import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireDnd, flushDragTick, mockDataTransfer, stubRects } from "../../test/dnd";
import { samplePlan } from "../../test/releasePlanFixtures";
import { BOARD_TEST_TIMEOUT_MS, renderBoard } from "../../test/renderBoard";

// Cells are 160px wide at left 0 (stubRects): clientX 10 → L, 150 → R.
const LEFT = 10;
const RIGHT = 150;
const MVP = 0;
const R2 = 1;
const UNPLANNED = 2;

const board = () => screen.getByRole("region", { name: "Board" });
const epicEl = (id: number) => board().querySelector<HTMLElement>(`.epic[data-epic="${id}"]`) as HTMLElement;
const epicTitles = () => [...board().querySelectorAll(".epic .name > span:first-child")].map((n) => n.textContent);
/** The cell of feature `featureId` in band `bandIndex` (cells render band by band per column). */
const cell = (featureId: number, bandIndex: number) => board().querySelectorAll<HTMLElement>(`.fcell[data-feature="${featureId}"]`)[bandIndex];
const card = (title: string) => within(board()).getByRole("button", { name: new RegExp(title) });
const cardTitles = (epicId: number) => [...board().querySelectorAll(`.fcell[data-epic="${epicId}"] .fcard .t`)].map((n) => n.textContent);
const featureCount = (name: string) =>
  within(screen.getByRole("region", { name: "Milestone summary" })).getByRole("group", { name }).querySelector(".n")?.textContent;
const highlighted = () => board().querySelectorAll(".valid, .invalid, .over, .dropL, .dropR, .dragging");

describe("Board drag-and-drop", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => stubRects());
  afterEach(() => vi.restoreAllMocks());

  describe("epics", () => {
    it("drags an epic before another one (dropL)", async () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", epicEl(3), { dataTransfer: dt });
      expect(dt.effectAllowed).toBe("move");
      expect(dt.setData).toHaveBeenCalledWith("text/plain", "epic:3");
      await flushDragTick();
      expect(epicEl(3)).toHaveClass("dragging");
      const over = fireDnd("dragOver", epicEl(1), { dataTransfer: dt, clientX: LEFT });
      expect(over.defaultPrevented).toBe(true);
      expect(epicEl(1)).toHaveClass("dropL");
      fireDnd("drop", epicEl(1), { dataTransfer: dt, clientX: LEFT });
      expect(epicTitles()).toEqual(["Wave 3 - Empty", "Wave 1 - MVP", "Wave 2 - Reporting"]);
      expect(highlighted()).toHaveLength(0);
    });

    it("drags an epic after another one (dropR)", () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", epicEl(1), { dataTransfer: dt });
      fireDnd("dragOver", epicEl(3), { dataTransfer: dt, clientX: RIGHT });
      expect(epicEl(3)).toHaveClass("dropR");
      fireDnd("drop", epicEl(3), { dataTransfer: dt, clientX: RIGHT });
      expect(epicTitles()).toEqual(["Wave 2 - Reporting", "Wave 3 - Empty", "Wave 1 - MVP"]);
    });

    it("ignores a dragover on itself and clears the indicator on a real dragleave and on dragend", () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", epicEl(1), { dataTransfer: dt });
      expect(fireDnd("dragOver", epicEl(1), { dataTransfer: dt, clientX: RIGHT }).defaultPrevented).toBe(false);
      expect(epicEl(1)).not.toHaveClass("dropR");
      fireDnd("dragOver", epicEl(2), { dataTransfer: dt, clientX: RIGHT });
      // Moving onto a child of the header is not a leave.
      fireDnd("dragLeave", epicEl(2), { relatedTarget: within(epicEl(2)).getByRole("button", { name: /Wave 2/ }) });
      expect(epicEl(2)).toHaveClass("dropR");
      fireDnd("dragLeave", epicEl(2), { relatedTarget: board() });
      expect(epicEl(2)).not.toHaveClass("dropR");
      fireDnd("dragOver", epicEl(2), { dataTransfer: dt, clientX: LEFT });
      expect(epicEl(2)).toHaveClass("dropL");
      fireDnd("dragEnd", epicEl(1), { dataTransfer: dt });
      expect(highlighted()).toHaveLength(0);
      expect(epicTitles()).toEqual(["Wave 1 - MVP", "Wave 2 - Reporting", "Wave 3 - Empty"]);
    });

    it("keeps ◀/▶ out of the drag (draggable=false)", () => {
      renderBoard(samplePlan());
      expect(epicEl(1)).toHaveAttribute("draggable", "true");
      within(epicEl(1))
        .getAllByRole("button", { name: /Move Epic/ })
        .forEach((b) => expect(b).toHaveAttribute("draggable", "false"));
    });
  });

  describe("features", () => {
    it("moves a feature to another band (summary counts update)", async () => {
      renderBoard(samplePlan());
      expect(featureCount("MVP")).toBe("2");
      expect(featureCount("Unplanned")).toBe("1");
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Exports"), { dataTransfer: dt });
      expect(dt.effectAllowed).toBe("move");
      expect(dt.setDragImage).not.toHaveBeenCalled();
      await flushDragTick();
      expect(card("Exports")).toHaveClass("dragging");
      const over = fireDnd("dragOver", cell(22, MVP), { dataTransfer: dt, clientX: RIGHT });
      expect(over.defaultPrevented).toBe(true);
      expect(dt.dropEffect).toBe("move");
      // Its own column: highlighted, but no reorder indicator.
      expect(cell(22, MVP)).toHaveClass("over");
      expect(cell(22, MVP)).not.toHaveClass("dropR");
      fireDnd("drop", cell(22, MVP), { dataTransfer: dt, clientX: RIGHT });
      expect(featureCount("MVP")).toBe("3");
      expect(featureCount("Unplanned")).toBe("0");
      expect(within(cell(22, MVP)).getByRole("button", { name: /Exports/ })).toBeInTheDocument();
      expect(highlighted()).toHaveLength(0);
    });

    it("moves a feature to Unplanned", () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Charts"), { dataTransfer: dt });
      fireDnd("dragOver", cell(23, UNPLANNED), { dataTransfer: dt });
      fireDnd("drop", cell(23, UNPLANNED), { dataTransfer: dt });
      expect(featureCount("Unplanned")).toBe("2");
      expect(featureCount("Release 2")).toBe("1");
    });

    it("reorders a feature to the left of another column (dropL)", () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Charts"), { dataTransfer: dt });
      fireDnd("dragOver", cell(21, R2), { dataTransfer: dt, clientX: LEFT });
      expect(cell(21, R2)).toHaveClass("over", "dropL");
      fireDnd("drop", cell(21, R2), { dataTransfer: dt, clientX: LEFT });
      expect(cardTitles(2)).toEqual(["Charts", "Reports", "Exports"]);
      expect(featureCount("Release 2")).toBe("2");
    });

    it("reorders a feature to the right of another column (dropR) and into that band", () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Reports"), { dataTransfer: dt });
      fireDnd("dragOver", cell(22, UNPLANNED), { dataTransfer: dt, clientX: RIGHT });
      expect(cell(22, UNPLANNED)).toHaveClass("over", "dropR");
      fireDnd("drop", cell(22, UNPLANNED), { dataTransfer: dt, clientX: RIGHT });
      expect(cardTitles(2)).toEqual(["Exports", "Reports", "Charts"]);
      expect(featureCount("Unplanned")).toBe("2");
    });

    it("clears .over/.dropL only on a dragleave out of the cell", () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Charts"), { dataTransfer: dt });
      fireDnd("dragOver", cell(21, R2), { dataTransfer: dt, clientX: LEFT });
      fireDnd("dragLeave", cell(21, R2), { relatedTarget: card("Reports") });
      expect(cell(21, R2)).toHaveClass("over", "dropL");
      fireDnd("dragLeave", cell(21, R2), { relatedTarget: cell(21, MVP) });
      expect(cell(21, R2)).not.toHaveClass("over");
      expect(cell(21, R2)).not.toHaveClass("dropL");
    });

    it("ignores a drop on another Epic's cell", () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Login page"), { dataTransfer: dt });
      expect(fireDnd("dragOver", cell(21, UNPLANNED), { dataTransfer: dt, clientX: LEFT }).defaultPrevented).toBe(false);
      expect(cell(21, UNPLANNED)).not.toHaveClass("over");
      fireDnd("drop", cell(21, UNPLANNED), { dataTransfer: dt, clientX: LEFT });
      fireDnd("dragEnd", card("Login page"), { dataTransfer: dt });
      expect(cardTitles(1)).toEqual(["Login page", "Dashboard"]);
      expect(cardTitles(2)).toEqual(["Reports", "Exports", "Charts"]);
      expect(featureCount("MVP")).toBe("2");
      expect(featureCount("Unplanned")).toBe("1");
    });

    it("ignores an epic drag over a feature cell", () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", epicEl(1), { dataTransfer: dt });
      expect(fireDnd("dragOver", cell(11, R2), { dataTransfer: dt }).defaultPrevented).toBe(false);
      fireDnd("drop", cell(11, R2), { dataTransfer: dt });
      expect(featureCount("MVP")).toBe("2");
    });

    it("applies .valid to the epic's cells and .invalid to the others during a drag, and removes them on dragend", async () => {
      renderBoard(samplePlan());
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Reports"), { dataTransfer: dt });
      await flushDragTick();
      expect(board().querySelectorAll('.fcell[data-epic="2"].valid')).toHaveLength(9);
      expect(board().querySelectorAll('.fcell[data-epic="1"].invalid')).toHaveLength(6);
      expect(board().querySelectorAll(".fcell.valid")).toHaveLength(9);
      expect(board().querySelectorAll(".fcell.invalid")).toHaveLength(6);
      fireDnd("dragEnd", card("Reports"), { dataTransfer: dt });
      expect(highlighted()).toHaveLength(0);
    });

    it("marks the plan as having unsaved changes after a drop", () => {
      renderBoard(samplePlan());
      expect(screen.getByTestId("save-status")).toHaveTextContent("Saved");
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Exports"), { dataTransfer: dt });
      fireDnd("dragOver", cell(22, R2), { dataTransfer: dt });
      fireDnd("drop", cell(22, R2), { dataTransfer: dt });
      expect(screen.getByTestId("save-status")).toHaveTextContent("Unsaved changes");
    });
  });

  describe("selection", () => {
    it("Ctrl+click selects two features of an epic (✓ badge, no modal) and dragging moves both", async () => {
      renderBoard(samplePlan());
      fireEvent.click(card("Reports"), { ctrlKey: true });
      fireEvent.click(card("Exports"), { metaKey: true });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(card("Reports")).toHaveClass("selected");
      expect(card("Exports")).toHaveClass("selected");
      expect(card("Charts")).not.toHaveClass("selected");
      expect(card("Reports").querySelector(".chk")).toHaveTextContent("✓");

      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Exports"), { dataTransfer: dt });
      expect(dt.setDragImage).toHaveBeenCalledTimes(1);
      const [ghost, x, y] = dt.setDragImage.mock.calls[0];
      expect([x, y]).toEqual([10, 10]);
      expect(ghost).toHaveAttribute("id", "dragGhost");
      expect(ghost).toHaveTextContent("2 features");
      expect(document.getElementById("dragGhost")).not.toBeNull();
      expect(dt.setData).toHaveBeenCalledWith("text/plain", "feature:21,22");
      await flushDragTick();
      expect(document.getElementById("dragGhost")).toBeNull();
      expect(card("Reports")).toHaveClass("dragging");
      expect(card("Exports")).toHaveClass("dragging");
      expect(card("Charts")).not.toHaveClass("dragging");

      // A multi-drop never reorders, even on another column.
      fireDnd("dragOver", cell(23, MVP), { dataTransfer: dt, clientX: LEFT });
      expect(cell(23, MVP)).toHaveClass("over");
      expect(cell(23, MVP)).not.toHaveClass("dropL");
      fireDnd("drop", cell(23, MVP), { dataTransfer: dt, clientX: LEFT });
      expect(featureCount("MVP")).toBe("4");
      expect(featureCount("Unplanned")).toBe("0");
      expect(cardTitles(2)).toEqual(["Reports", "Exports", "Charts"]);
      expect(board().querySelectorAll(".fcard.selected")).toHaveLength(0);
    });

    it("Ctrl+click toggles, and a Ctrl+click in another epic resets the selection", () => {
      renderBoard(samplePlan());
      fireEvent.click(card("Reports"), { ctrlKey: true });
      fireEvent.click(card("Charts"), { ctrlKey: true });
      fireEvent.click(card("Charts"), { ctrlKey: true });
      expect(card("Charts")).not.toHaveClass("selected");
      expect(card("Reports")).toHaveClass("selected");
      fireEvent.click(card("Login page"), { ctrlKey: true });
      expect(card("Reports")).not.toHaveClass("selected");
      expect(card("Login page")).toHaveClass("selected");
    });

    it("a plain click clears the selection and opens the modal", () => {
      renderBoard(samplePlan());
      fireEvent.click(card("Reports"), { ctrlKey: true });
      fireEvent.click(card("Charts"));
      expect(screen.getByRole("dialog", { name: "Charts" })).toBeInTheDocument();
      expect(board().querySelectorAll(".fcard.selected")).toHaveLength(0);
    });

    it("dragging a card outside the selection clears it and drags only that card", () => {
      renderBoard(samplePlan());
      fireEvent.click(card("Reports"), { ctrlKey: true });
      fireEvent.click(card("Exports"), { ctrlKey: true });
      const dt = mockDataTransfer();
      fireDnd("dragStart", card("Charts"), { dataTransfer: dt });
      expect(board().querySelectorAll(".fcard.selected")).toHaveLength(0);
      expect(dt.setDragImage).not.toHaveBeenCalled();
      fireDnd("dragOver", cell(23, MVP), { dataTransfer: dt });
      fireDnd("drop", cell(23, MVP), { dataTransfer: dt });
      expect(featureCount("MVP")).toBe("3");
      expect(featureCount("Unplanned")).toBe("1");
    });

    it("Esc clears the selection, but not while a dialog is open", async () => {
      const user = userEvent.setup();
      renderBoard(samplePlan());
      fireEvent.click(card("Reports"), { ctrlKey: true });
      // Enter opens the details without touching the selection.
      card("Charts").focus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("dialog", { name: "Charts" })).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(card("Reports")).toHaveClass("selected");
      await user.keyboard("{Escape}");
      expect(card("Reports")).not.toHaveClass("selected");
    });

    it("a click on the board background clears the selection (not with Ctrl, not on a card)", () => {
      renderBoard(samplePlan());
      fireEvent.click(card("Reports"), { ctrlKey: true });
      fireEvent.click(screen.getByTestId("board-scroll"), { ctrlKey: true });
      expect(card("Reports")).toHaveClass("selected");
      fireEvent.click(cell(21, UNPLANNED));
      expect(card("Reports")).not.toHaveClass("selected");
    });
  });
});
