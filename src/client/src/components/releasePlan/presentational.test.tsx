import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeFeature, makeFlag, makeMilestone } from "../../test/releasePlanFixtures";
import { FlagChip } from "./FlagChip";
import { MilestoneChip } from "./MilestoneChip";
import { SizeBadge } from "./SizeBadge";
import { SizeChips } from "./SizeChips";
import { StateMark } from "./StateMark";

describe("SizeChips", () => {
  it("renders colored chips in size order with titles", () => {
    const { container } = render(<SizeChips features={["M", "", "XS", "M"].map((size, i) => makeFeature({ id: i, size }))} />);
    const chips = [...container.querySelectorAll(".szchip")];
    expect(chips.map((c) => c.textContent)).toEqual(["XS1", "M2", "?1"]);
    expect(chips[1]).toHaveAttribute("title", "2 Features of size M");
    expect(chips[0]).toHaveAttribute("title", "1 Feature of size XS");
    expect(chips[2]).toHaveAttribute("title", "1 Feature of size not estimated");
    expect(chips[1]).toHaveStyle({ background: "#EBC160", color: "#3a2a05" });
  });

  it("shows 'No features' when empty", () => {
    render(<SizeChips features={[]} />);
    expect(screen.getByText("No features")).toBeInTheDocument();
  });
});

describe("SizeBadge / StateMark", () => {
  it("shows the size or '?'", () => {
    const { rerender } = render(<SizeBadge size="L" />);
    expect(screen.getByText("L")).toHaveAttribute("title", "Estimated size: L");
    rerender(<SizeBadge size="" />);
    expect(screen.getByText("?")).toHaveClass("tsize", "none");
    expect(screen.getByText("?")).toHaveAttribute("title", "Not estimated");
  });

  it("shows ✓ for done states and a colored dot otherwise", () => {
    const { container, rerender } = render(<StateMark state="Closed" />);
    expect(screen.getByRole("img", { name: "Closed" })).toHaveTextContent("✓");
    rerender(<StateMark state="Active" />);
    expect(container.querySelector(".state")).toHaveStyle({ background: "#274B76" });
    rerender(<StateMark state="Weird" />);
    expect(container.querySelector(".state")).toHaveStyle({ background: "#C7D2E0" });
  });
});

describe("MilestoneChip / FlagChip", () => {
  it("colors a milestone chip and shows a gold Unplanned chip", () => {
    const { rerender } = render(<MilestoneChip milestone={makeMilestone({ id: "a", name: "MVP", color: "#60C5B5" })} />);
    const chip = screen.getByText("MVP");
    expect(chip).toHaveStyle({ borderColor: "#60C5B5", background: "#60C5B52e" });
    // The text color comes from --chip-c (releasePlan.css darkens it in the light theme).
    expect(chip.style.getPropertyValue("--chip-c")).toBe("#60C5B5");
    rerender(<MilestoneChip milestone={null} />);
    expect(screen.getByText("Unplanned")).toHaveClass("chip", "none");
  });

  it("shows the flag name with a date title", () => {
    render(<FlagChip flag={makeFlag({ id: "f", afterMsId: "a", name: "Beta", date: "" })} />);
    expect(screen.getByText("Beta")).toHaveAttribute("title", "Beta");
  });
});
