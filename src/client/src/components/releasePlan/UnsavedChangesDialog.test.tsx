import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UNSAVED_TITLE, UnsavedChangesDialog } from "./UnsavedChangesDialog";

function setup(over: Partial<Parameters<typeof UnsavedChangesDialog>[0]> = {}) {
  const handlers = { onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() };
  render(<UnsavedChangesDialog open saving={false} failed={false} {...handlers} {...over} />);
  return handlers;
}

describe("UnsavedChangesDialog", () => {
  it("renders nothing when closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a labelled modal dialog with Save focused", () => {
    setup();
    expect(screen.getByRole("dialog", { name: UNSAVED_TITLE })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["Save", "onSave"],
    ["Discard", "onDiscard"],
    ["Cancel", "onCancel"],
  ] as const)("%s calls %s", async (label, handler) => {
    const handlers = setup();
    await userEvent.setup().click(screen.getByRole("button", { name: label }));
    expect(handlers[handler]).toHaveBeenCalledTimes(1);
    for (const other of Object.keys(handlers).filter((h) => h !== handler)) {
      expect(handlers[other as keyof typeof handlers]).not.toHaveBeenCalled();
    }
  });

  it("Esc and the backdrop cancel", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("unsaved-dialog-backdrop"));
    expect(handlers.onCancel).toHaveBeenCalledTimes(2);
  });

  it("disables the buttons and says Saving… while saving", () => {
    setup({ saving: true });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("shows an alert after a failed save", () => {
    setup({ failed: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });
});
