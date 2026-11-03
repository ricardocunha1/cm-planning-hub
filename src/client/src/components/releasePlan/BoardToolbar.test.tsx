import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { samplePlan } from "../../test/releasePlanFixtures";
import { renderAt } from "../../test/render";
import { BoardToolbar } from "./BoardToolbar";
import type { SaveStatus } from "./usePlanPersistence";

function setup(saveStatus: SaveStatus, autosave: boolean) {
  const onAutosaveChange = vi.fn();
  const onSave = vi.fn();
  renderAt(
    "/board",
    <BoardToolbar
      plan={samplePlan()}
      view="board"
      onViewChange={() => undefined}
      zoom={1}
      onZoomIn={() => undefined}
      onZoomOut={() => undefined}
      onFit={() => undefined}
      orientation="standard"
      onFlip={() => undefined}
      onSync={() => undefined}
      onExportPng={() => undefined}
      exporting={false}
      saveStatus={saveStatus}
      autosave={autosave}
      onAutosaveChange={onAutosaveChange}
      onSave={onSave}
    />,
  );
  return { onAutosaveChange, onSave };
}

const statusText = () => screen.getByTestId("save-status");

describe("BoardToolbar save controls", () => {
  it.each([
    ["saved", "Saved"],
    ["dirty", "Unsaved changes"],
    ["saving", "Saving…"],
    ["error", "Save failed"],
  ] as const)("shows %s as '%s' in a polite live region", (status, text) => {
    setup(status, true);
    expect(statusText()).toHaveTextContent(new RegExp(`^${text}$`));
    expect(statusText()).toHaveAttribute("aria-live", "polite");
  });

  it("the Autosave switch reflects the preference and toggles it", async () => {
    const { onAutosaveChange } = setup("saved", true);
    const toggle = screen.getByRole("switch", { name: "Autosave" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.setup().click(toggle);
    expect(onAutosaveChange).toHaveBeenCalledWith(false);
  });

  it("turning autosave on is requested from an off switch", async () => {
    const { onAutosaveChange } = setup("saved", false);
    const toggle = screen.getByRole("switch", { name: "Autosave" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.setup().click(toggle);
    expect(onAutosaveChange).toHaveBeenCalledWith(true);
  });

  it("hides Save while autosave is on and the last save worked", () => {
    setup("dirty", true);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("shows an enabled Save when autosave is off and there are changes", async () => {
    const { onSave } = setup("dirty", false);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    await userEvent.setup().click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("disables Save when autosave is off and everything is saved", () => {
    setup("saved", false);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows an enabled Save after a failed save even with autosave on", () => {
    setup("error", true);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("the Autosave toggle is a labelled checkbox switch whose checked state follows the prop", () => {
    setup("saved", true);
    const toggle = screen.getByRole("switch", { name: "Autosave" });
    expect(toggle).toHaveAttribute("type", "checkbox");
    expect(toggle).toBeChecked();
  });

  it("the Autosave toggle is unchecked when autosave is off", () => {
    setup("saved", false);
    expect(screen.getByRole("switch", { name: "Autosave" })).not.toBeChecked();
  });

  it("the Save button shows a decorative icon and keeps the name Save", () => {
    setup("dirty", false);
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.querySelector("svg")).not.toBeNull();
    expect(save).toHaveClass("withIcon");
  });
});
