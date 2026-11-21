import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ReleasePlanLayout } from "./ReleasePlanLayout";
import { SignedIn } from "../../test/SignedIn";

function renderView(page?: string) {
  render(
    <SignedIn>
      <MemoryRouter initialEntries={["/release-plan"]}>
        <ReleasePlanLayout page={page}>
          <p>page content</p>
        </ReleasePlanLayout>
      </MemoryRouter>
    </SignedIn>,
  );
}

describe("ReleasePlanLayout", () => {
  it("renders the hub header and content, without a Release Plan heading", () => {
    renderView();
    expect(screen.getByRole("heading", { level: 1, name: "Planning Hub" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Release Plan" })).not.toBeInTheDocument();
    expect(screen.getByText("page content")).toBeInTheDocument();
  });

  it("sets the home document title without a page", () => {
    renderView();
    expect(document.title).toBe("Planning Hub – Release Plan");
  });

  it("appends the page to the document title", () => {
    renderView("Board");
    expect(document.title).toBe("Planning Hub – Release Plan – Board");
  });
});
