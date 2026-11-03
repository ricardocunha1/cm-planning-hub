import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FlipIcon } from "./FlipIcon";
import { SaveIcon } from "./SaveIcon";
import { SyncIcon } from "./SyncIcon";

describe.each([
  ["SyncIcon", SyncIcon],
  ["FlipIcon", FlipIcon],
  ["SaveIcon", SaveIcon],
] as const)("%s", (_name, Icon) => {
  it("renders a decorative, non-focusable svg that inherits the text color", () => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveClass("h-4", "w-4");
  });

  it("accepts a className", () => {
    const { container } = render(<Icon className="btnIcon" />);
    expect(container.querySelector("svg")).toHaveAttribute("class", "btnIcon");
  });
});
