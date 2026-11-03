import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireDnd, flushDragTick, mockDataTransfer, stubRects } from "../../test/dnd";
import { samplePlan, sprintsPlan } from "../../test/releasePlanFixtures";
import { BOARD_TEST_TIMEOUT_MS, renderBoard } from "../../test/renderBoard";

const board = () => screen.getByRole("region", { name: "Board" });
const flipButton = () => screen.getByRole("button", { name: "Flip board" });
const flip = () => fireEvent.click(flipButton());
const header = () => screen.getByTestId("frozen-header");
const msLabel = (name: string) => within(header()).getByRole("group", { name: `Milestone ${name}` });
const flagLabel = (name: string) => within(header()).getByRole("group", { name: `Milestone flag ${name}` });
const summaryNames = () =>
  within(screen.getByRole("region", { name: "Milestone summary" }))
    .getAllByRole("group")
    .map((g) => g.getAttribute("aria-label"));
const featureCount = (name: string) =>
  within(screen.getByRole("region", { name: "Milestone summary" })).getByRole("group", { name }).querySelector(".n")?.textContent;
const card = (title: string) => within(board()).getByRole("button", { name: new RegExp(title) });
const cellOf = (title: string) => card(title).closest(".cell") as HTMLElement;
const epicEl = (id: number) => board().querySelector<HTMLElement>(`.epic[data-epic="${id}"]`) as HTMLElement;
const epicTitles = () => [...board().querySelectorAll(".epic .name > span:first-child")].map((n) => n.textContent);
/** The cell of feature `featureId` in milestone column `columnIndex` (cells render column by column per row). */
const cell = (featureId: number, columnIndex: number) => board().querySelectorAll<HTMLElement>(`.fcell[data-feature="${featureId}"]`)[columnIndex];
const cardTitles = (epicId: number) => [...board().querySelectorAll(`.fcell[data-epic="${epicId}"] .fcard .t`)].map((n) => n.textContent);
const highlighted = () => board().querySelectorAll(".valid, .invalid, .over, .dropT, .dropB, .dropL, .dropR, .dragging");

const MVP = 0;
const R2 = 1;
const UNPLANNED = 2;
// Cells/headers are 84px tall at top 0 (stubRects): clientY 10 → above the midpoint (before), 80 → below (after).
const ABOVE = 10;
const BELOW = 80;

describe("Flip board toggle", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  it("defaults to the standard board and toggles aria-pressed, the title and the rendering", () => {
    renderBoard(samplePlan());
    expect(flipButton()).toHaveAttribute("aria-pressed", "false");
    expect(flipButton()).toHaveAttribute("title", "Flip board: show milestones as columns");
    expect(flipButton().querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("frozen-column")).toBeInTheDocument();
    expect(screen.queryByTestId("frozen-header")).not.toBeInTheDocument();

    flip();
    expect(flipButton()).toHaveAttribute("aria-pressed", "true");
    expect(flipButton()).toHaveAttribute("title", "Flip board: show milestones as rows");
    expect(header()).toBeInTheDocument();
    expect(screen.queryByTestId("frozen-column")).not.toBeInTheDocument();

    flip();
    expect(flipButton()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("frozen-column")).toBeInTheDocument();
  });

  it("is hidden in Table view and the orientation is kept when coming back", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    flip();
    await user.click(screen.getByRole("tab", { name: "Table" }));
    expect(screen.queryByRole("button", { name: "Flip board" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Board" }));
    expect(flipButton()).toHaveAttribute("aria-pressed", "true");
    expect(header()).toBeInTheDocument();
  });

  it("is not part of the plan: flipping leaves the plan saved", () => {
    renderBoard(samplePlan());
    flip();
    flip();
    flip();
    expect(screen.getByTestId("save-status")).toHaveTextContent("Saved");
  });
});

describe("Flipped board", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders milestone columns in a frozen header row, epic rows and cards in their milestone column", () => {
    renderBoard(samplePlan());
    flip();
    expect(header().parentElement).toHaveClass("frzTop");
    expect(header()).toHaveStyle({ transform: "scale(1)", width: "778px", height: "158px" });
    expect(within(msLabel("MVP")).getByLabelText("Milestone name")).toHaveValue("MVP");
    expect(msLabel("MVP")).toHaveStyle({ left: "226px", top: "0px", width: "180px", height: "158px" });
    expect(within(header()).getByRole("group", { name: "Unplanned" })).toHaveTextContent("1 Features · not assigned");
    expect(epicTitles()).toEqual(["Wave 1 - MVP", "Wave 2 - Reporting", "Wave 3 - Empty"]);
    expect(epicEl(2)).toHaveStyle({ left: "12px", top: "388px", width: "200px", height: "288px" });
    expect(cellOf("Login page")).toHaveStyle({ left: "226px", top: "184px", width: "180px", height: "84px" });
    expect(cellOf("Charts")).toHaveStyle({ left: "406px", top: "582px" });
    expect(cellOf("Exports")).toHaveStyle({ left: "586px", top: "490px" });
    expect(board().querySelectorAll(".fcard")).toHaveLength(5);
    expect(board().querySelectorAll(".cell")).toHaveLength(15);
    expect(screen.getByTestId("board-scale")).toHaveStyle({ width: "778px", height: "822px" });
  });

  it("adapts the hint wording", () => {
    renderBoard(samplePlan());
    flip();
    expect(screen.getByText(/Click any work item to see its description/)).toHaveTextContent(
      "Drag Epics to reorder them. Drag a Feature card left or right to move it to another milestone, or onto another row of the same Epic to reorder it. Ctrl+click (⌘+click on Mac) selects several Features of the same Epic to move them together. Click any work item to see its description. Use the + between milestones to insert a new one (in Sprint mode, also a milestone flag). ✓ = Resolved / Done / Closed.",
    );
  });

  it("adds the header shadow class only while scrolled vertically", () => {
    renderBoard(samplePlan());
    flip();
    const box = screen.getByTestId("board-scroll");
    box.scrollTop = 60;
    fireEvent.scroll(box);
    expect(box).toHaveClass("scrolledY");
    box.scrollTop = 0;
    fireEvent.scroll(box);
    expect(box).not.toHaveClass("scrolledY");
  });

  it("scales the frozen header with the zoom and fits on the flipped width", () => {
    renderBoard(samplePlan());
    flip();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(header()).toHaveStyle({ transform: "scale(1.1)" });
    // Fit = min(1, (clientWidth - 4) / 778).
    Object.defineProperty(screen.getByTestId("board-scroll"), "clientWidth", { configurable: true, value: 393 });
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(screen.getByTestId("zoom-value")).toHaveTextContent("50%");
  });

  it("moves epics with ▲/▼ (no-op at the ends); only ▲/▼ are not draggable", async () => {
    const user = userEvent.setup();
    const { container } = renderBoard(samplePlan());
    flip();
    expect([...container.querySelectorAll('[draggable="false"]')].map((el) => el.textContent)).toEqual(["▲", "▼", "▲", "▼", "▲", "▼"]);
    await user.click(within(board()).getAllByRole("button", { name: "Move Epic up" })[0]);
    expect(epicTitles()).toEqual(["Wave 1 - MVP", "Wave 2 - Reporting", "Wave 3 - Empty"]);
    await user.click(within(board()).getAllByRole("button", { name: "Move Epic down" })[0]);
    expect(epicTitles()).toEqual(["Wave 2 - Reporting", "Wave 1 - MVP", "Wave 3 - Empty"]);
    await user.click(within(board()).getAllByRole("button", { name: "Move Epic up" })[2]);
    expect(epicTitles()).toEqual(["Wave 2 - Reporting", "Wave 3 - Empty", "Wave 1 - MVP"]);
  });

  it("opens the work item modal from a card and from an epic title", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    flip();
    await user.click(card("Dashboard"));
    expect(screen.getByRole("dialog", { name: "Dashboard" })).toHaveTextContent("FEATURE");
    await user.keyboard("{Escape}");
    await user.click(within(board()).getByRole("button", { name: /Wave 2 - Reporting/ }));
    expect(screen.getByRole("dialog", { name: "Wave 2 - Reporting" })).toHaveTextContent("EPIC");
  });

  it("moves milestones with ◀/▶ (disabled at the ends) and deletes after confirmation", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    flip();
    expect(within(msLabel("MVP")).getByRole("button", { name: "Move left" })).toBeDisabled();
    expect(within(msLabel("MVP")).getByRole("button", { name: "Move left" })).toHaveAttribute("title", "Move milestone left");
    expect(within(msLabel("Release 2")).getByRole("button", { name: "Move right" })).toBeDisabled();
    await user.click(within(msLabel("MVP")).getByRole("button", { name: "Move right" }));
    expect(summaryNames()).toEqual(["Release 2", "MVP", "Unplanned"]);
    expect(cellOf("Login page")).toHaveStyle({ left: "406px" });
    await user.click(within(msLabel("MVP")).getByRole("button", { name: "Delete milestone" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(summaryNames()).toEqual(["Release 2", "Unplanned"]);
    expect(featureCount("Unplanned")).toBe("3");
  });

  it("puts the '+' gap buttons on the header's bottom edge after each milestone and inserts with focus", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    flip();
    const gaps = within(header()).getAllByRole("button", { name: /^Insert after/ });
    expect(gaps.map((b) => b.getAttribute("aria-label"))).toEqual(["Insert after MVP", "Insert after Release 2"]);
    expect(gaps[0]).toHaveStyle({ left: "395px", top: "147px" });
    await user.click(gaps[0]);
    expect(summaryNames()).toEqual(["MVP", "Release 3", "Release 2", "Unplanned"]);
    expect(screen.getByRole("status")).toHaveTextContent("Milestone added");
    expect(within(msLabel("Release 3")).getByLabelText("Milestone name")).toHaveFocus();
  });

  it("renders flags as a dashed column with its tag and a rotated label in the header; the gap menu adds a flag", async () => {
    const user = userEvent.setup();
    renderBoard(sprintsPlan());
    flip();
    expect(flagLabel("Beta")).toHaveClass("flaglbl", "flip");
    expect(within(flagLabel("Beta")).getByLabelText("Flag name")).toHaveValue("Beta");
    const col = board().querySelector<HTMLElement>(".flagcol");
    expect(col).toHaveStyle({ left: "406px", top: "158px", width: "34px" });
    expect(col?.querySelector(".flagtag")).toHaveTextContent(/^Beta · /);
    await user.click(within(flagLabel("Beta")).getByRole("button", { name: "Remove flag" }));
    expect(board().querySelector(".flagcol")).toBeNull();

    await user.click(within(header()).getByRole("button", { name: "Insert after Sprint 2" }));
    await user.click(screen.getByRole("menuitem", { name: /Add milestone flag here/ }));
    expect(screen.getByRole("status")).toHaveTextContent("Milestone flag added after Sprint 2");
    expect(within(flagLabel("Milestone")).getByLabelText("Flag name")).toHaveFocus();
  });
});

describe("Flipped board drag-and-drop", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => stubRects());
  afterEach(() => vi.restoreAllMocks());

  it("moves a feature left/right to another milestone column (no reorder indicator on its own row)", async () => {
    renderBoard(samplePlan());
    flip();
    const dt = mockDataTransfer();
    fireDnd("dragStart", card("Exports"), { dataTransfer: dt });
    await flushDragTick();
    expect(board().querySelectorAll('.fcell[data-epic="2"].valid')).toHaveLength(9);
    expect(board().querySelectorAll('.fcell[data-epic="1"].invalid')).toHaveLength(6);
    const over = fireDnd("dragOver", cell(22, MVP), { dataTransfer: dt, clientY: BELOW });
    expect(over.defaultPrevented).toBe(true);
    expect(cell(22, MVP)).toHaveClass("over");
    expect(cell(22, MVP)).not.toHaveClass("dropB");
    fireDnd("drop", cell(22, MVP), { dataTransfer: dt, clientY: BELOW });
    expect(featureCount("MVP")).toBe("3");
    expect(featureCount("Unplanned")).toBe("0");
    expect(within(cell(22, MVP)).getByRole("button", { name: /Exports/ })).toBeInTheDocument();
    expect(highlighted()).toHaveLength(0);
  });

  it("reorders above another row of the same epic (dropT) by clientY, ignoring clientX", () => {
    renderBoard(samplePlan());
    flip();
    const dt = mockDataTransfer();
    fireDnd("dragStart", card("Charts"), { dataTransfer: dt });
    fireDnd("dragOver", cell(21, R2), { dataTransfer: dt, clientX: 150, clientY: ABOVE });
    expect(cell(21, R2)).toHaveClass("over", "dropT");
    expect(cell(21, R2)).not.toHaveClass("dropR");
    fireDnd("drop", cell(21, R2), { dataTransfer: dt, clientX: 150, clientY: ABOVE });
    expect(cardTitles(2)).toEqual(["Charts", "Reports", "Exports"]);
    expect(featureCount("Release 2")).toBe("2");
  });

  it("reorders below another row (dropB) and into that column", () => {
    renderBoard(samplePlan());
    flip();
    const dt = mockDataTransfer();
    fireDnd("dragStart", card("Reports"), { dataTransfer: dt });
    fireDnd("dragOver", cell(22, UNPLANNED), { dataTransfer: dt, clientY: BELOW });
    expect(cell(22, UNPLANNED)).toHaveClass("over", "dropB");
    fireDnd("drop", cell(22, UNPLANNED), { dataTransfer: dt, clientY: BELOW });
    expect(cardTitles(2)).toEqual(["Exports", "Reports", "Charts"]);
    expect(featureCount("Unplanned")).toBe("2");
  });

  it("ignores a drop on another Epic's row", () => {
    renderBoard(samplePlan());
    flip();
    const dt = mockDataTransfer();
    fireDnd("dragStart", card("Login page"), { dataTransfer: dt });
    expect(fireDnd("dragOver", cell(21, UNPLANNED), { dataTransfer: dt, clientY: ABOVE }).defaultPrevented).toBe(false);
    fireDnd("drop", cell(21, UNPLANNED), { dataTransfer: dt, clientY: ABOVE });
    fireDnd("dragEnd", card("Login page"), { dataTransfer: dt });
    expect(cardTitles(1)).toEqual(["Login page", "Dashboard"]);
    expect(featureCount("MVP")).toBe("2");
    expect(featureCount("Unplanned")).toBe("1");
    expect(highlighted()).toHaveLength(0);
  });

  it("reorders epics above (dropT) and below (dropB) by clientY", async () => {
    renderBoard(samplePlan());
    flip();
    const dt = mockDataTransfer();
    fireDnd("dragStart", epicEl(3), { dataTransfer: dt });
    await flushDragTick();
    expect(epicEl(3)).toHaveClass("dragging");
    fireDnd("dragOver", epicEl(1), { dataTransfer: dt, clientX: 150, clientY: ABOVE });
    expect(epicEl(1)).toHaveClass("dropT");
    fireDnd("drop", epicEl(1), { dataTransfer: dt, clientY: ABOVE });
    expect(epicTitles()).toEqual(["Wave 3 - Empty", "Wave 1 - MVP", "Wave 2 - Reporting"]);

    const dt2 = mockDataTransfer();
    fireDnd("dragStart", epicEl(3), { dataTransfer: dt2 });
    fireDnd("dragOver", epicEl(2), { dataTransfer: dt2, clientY: BELOW });
    expect(epicEl(2)).toHaveClass("dropB");
    fireDnd("drop", epicEl(2), { dataTransfer: dt2, clientY: BELOW });
    expect(epicTitles()).toEqual(["Wave 1 - MVP", "Wave 2 - Reporting", "Wave 3 - Empty"]);
    expect(highlighted()).toHaveLength(0);
  });

  it("Ctrl+click selects two features and dragging moves both; a background click clears the selection", () => {
    renderBoard(samplePlan());
    flip();
    fireEvent.click(card("Reports"), { ctrlKey: true });
    fireEvent.click(card("Exports"), { metaKey: true });
    expect(card("Reports")).toHaveClass("selected");
    const dt = mockDataTransfer();
    fireDnd("dragStart", card("Exports"), { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "feature:21,22");
    fireDnd("dragOver", cell(23, MVP), { dataTransfer: dt, clientY: ABOVE });
    expect(cell(23, MVP)).not.toHaveClass("dropT");
    fireDnd("drop", cell(23, MVP), { dataTransfer: dt, clientY: ABOVE });
    expect(featureCount("MVP")).toBe("4");
    expect(cardTitles(2)).toEqual(["Reports", "Exports", "Charts"]);

    fireEvent.click(card("Charts"), { ctrlKey: true });
    expect(card("Charts")).toHaveClass("selected");
    fireEvent.click(cell(21, UNPLANNED));
    expect(card("Charts")).not.toHaveClass("selected");
  });
});
