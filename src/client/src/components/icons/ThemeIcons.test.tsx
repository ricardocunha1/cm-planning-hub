import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MoonIcon } from "./MoonIcon";
import { SunIcon } from "./SunIcon";

describe.each([
  ["SunIcon", SunIcon],
  ["MoonIcon", MoonIcon],
] as const)("%s", (_name, Icon) => {
  it("renders a decorative, non-focusable svg that inherits the text color", () => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveClass("h-5", "w-5");
  });

  it("accepts a className", () => {
    const { container } = render(<Icon className="h-4 w-4" />);
    expect(container.querySelector("svg")).toHaveAttribute("class", "h-4 w-4");
  });
});
