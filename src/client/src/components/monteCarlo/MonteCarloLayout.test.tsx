import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MonteCarloLayout } from "./MonteCarloLayout";
import { SignedIn } from "../../test/SignedIn";

function renderView() {
  render(
    <SignedIn>
      <MemoryRouter initialEntries={["/monte-carlo"]}>
        <MonteCarloLayout pageTitle="Data Input" currentStep={1}>
          <p>step content</p>
        </MonteCarloLayout>
      </MemoryRouter>
    </SignedIn>,
  );
}

describe("MonteCarloLayout", () => {
  it("renders the hub header, breadcrumb and content, without a Monte Carlo heading", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "Planning Hub" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Monte Carlo" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByText("step content")).toBeInTheDocument();
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Input");
  });

  it("places the How to Use button on the breadcrumb row", () => {
    renderView();
    const row = screen.getByRole("navigation", { name: "Progress" }).parentElement?.parentElement;
    expect(row).toContainElement(screen.getByRole("button", { name: "How to Use" }));
  });

  it("opens and closes the help modal from the How to Use button", async () => {
    const user = userEvent.setup();
    renderView();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "How to Use" }));
    expect(screen.getByRole("dialog", { name: "How to Use This Application" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
