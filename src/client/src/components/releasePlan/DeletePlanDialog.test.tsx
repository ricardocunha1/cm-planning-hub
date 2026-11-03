import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DeletePlanDialog } from "./DeletePlanDialog";

describe("DeletePlanDialog", () => {
  it("renders nothing while name is null", () => {
    render(<DeletePlanDialog name={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks to delete the named plan", () => {
    render(<DeletePlanDialog name="Q4 plan" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Delete release plan" });
    expect(dialog).toHaveTextContent("Delete Q4 plan? This cannot be undone.");
  });

  it("calls onConfirm from Delete and onCancel from Cancel and Escape", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DeletePlanDialog name="Q4 plan" onConfirm={onConfirm} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
