import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Breadcrumb } from "./Breadcrumb";

describe("Breadcrumb", () => {
  it("marks the current step and styles the others with theme-aware tokens", () => {
    render(<Breadcrumb currentStep={2} />);
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Validation")).toHaveClass("font-semibold", "text-accent-blue");
    expect(screen.getByText("2")).toHaveStyle({ backgroundColor: "var(--cm-light-blue)", color: "#04101d" });

    expect(steps[0]).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Input")).toHaveClass("text-fg-subtle");
    expect(screen.getByText("1")).toHaveClass("bg-surface-raised", "text-fg-subtle");
  });
});
