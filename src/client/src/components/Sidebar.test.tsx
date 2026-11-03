import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps } from "./Sidebar";

function renderSidebar(path: string, props: SidebarProps = {}) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

describe("Sidebar", () => {
  it("shows the Estimations group with a Monte Carlo link", () => {
    renderSidebar("/");
    const group = screen.getByRole("group", { name: "Estimations" });
    const link = within(group).getByRole("link", { name: "Monte Carlo" });
    expect(link).toHaveAttribute("href", "/monte-carlo");
  });

  it("does not mark Monte Carlo active on the hub home page", () => {
    renderSidebar("/");
    expect(screen.getByRole("link", { name: "Monte Carlo" })).not.toHaveAttribute("aria-current");
  });

  it.each(["/monte-carlo", "/monte-carlo/input", "/monte-carlo/confirm", "/monte-carlo/results"])(
    "marks Monte Carlo active on %s",
    (path) => {
      renderSidebar(path);
      expect(screen.getByRole("link", { name: "Monte Carlo" })).toHaveAttribute("aria-current", "page");
    },
  );

  it("shows the groups in order: Estimations, then Planning", () => {
    renderSidebar("/");
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-labelledby"))).toEqual([
      "sidebar-group-estimations",
      "sidebar-group-planning",
    ]);
  });

  it("lists only Monte Carlo under Estimations", () => {
    renderSidebar("/");
    const group = screen.getByRole("group", { name: "Estimations" });
    expect(within(group).getAllByRole("link").map((link) => link.textContent)).toEqual(["Monte Carlo"]);
  });

  it("shows the Planning group with a Release Plan link", () => {
    renderSidebar("/");
    const group = screen.getByRole("group", { name: "Planning" });
    const links = within(group).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Release Plan"]);
    expect(links[0]).toHaveAttribute("href", "/release-plan");
  });

  it.each(["/release-plan", "/release-plan/board"])("marks Release Plan (and only it) active on %s", (path) => {
    renderSidebar(path);
    expect(screen.getByRole("link", { name: "Release Plan" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Monte Carlo" })).not.toHaveAttribute("aria-current");
  });

  it("does not mark Release Plan active on Monte Carlo pages", () => {
    renderSidebar("/monte-carlo");
    expect(screen.getByRole("link", { name: "Release Plan" })).not.toHaveAttribute("aria-current");
  });

  it("has no collapse button when no toggle handler is given", () => {
    renderSidebar("/");
    expect(screen.queryByRole("button", { name: /sidebar/i })).not.toBeInTheDocument();
  });

  it("offers an expanded toggle controlling the nav and calls the handler on click", async () => {
    const onToggleCollapsed = vi.fn();
    renderSidebar("/", { onToggleCollapsed });
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const nav = screen.getByRole("navigation", { name: "Hub navigation" });
    expect(toggle).toHaveAttribute("aria-controls", nav.id);
    await userEvent.click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("shows tool names and group labels visibly when expanded", () => {
    renderSidebar("/", { onToggleCollapsed: vi.fn() });
    expect(screen.getByText("Monte Carlo")).not.toHaveClass("md:sr-only");
    expect(screen.getByText("Estimations")).not.toHaveClass("md:sr-only");
    expect(screen.getByRole("link", { name: "Monte Carlo" })).not.toHaveAttribute("title");
  });

  describe("collapsed", () => {
    it("labels the toggle as expand, with aria-expanded false", () => {
      renderSidebar("/", { collapsed: true, onToggleCollapsed: vi.fn() });
      expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
    });

    it("visually hides names and group labels but keeps icons, accessible names and tooltips", () => {
      renderSidebar("/", { collapsed: true });
      for (const name of ["Monte Carlo", "Release Plan"]) {
        const link = screen.getByRole("link", { name });
        expect(link).toHaveAttribute("title", name);
        expect(link.querySelector("svg")).not.toBeNull();
        expect(within(link).getByText(name)).toHaveClass("md:sr-only");
      }
      expect(screen.getByText("Estimations")).toHaveClass("md:sr-only");
      expect(screen.getByRole("group", { name: "Estimations" })).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Planning" })).toBeInTheDocument();
    });

    it.each([
      ["/monte-carlo/results", "Monte Carlo", "Release Plan"],
      ["/release-plan/board", "Release Plan", "Monte Carlo"],
    ])("highlights the active tool on %s like the expanded panel", (path, active, inactive) => {
      renderSidebar(path, { collapsed: true });
      const activeLink = screen.getByRole("link", { name: active });
      expect(activeLink).toHaveAttribute("aria-current", "page");
      expect(activeLink).toHaveClass("bg-surface-raised", "text-accent-teal");
      const inactiveLink = screen.getByRole("link", { name: inactive });
      expect(inactiveLink).not.toHaveAttribute("aria-current");
      expect(inactiveLink).not.toHaveClass("bg-surface-raised");
    });
  });
});
