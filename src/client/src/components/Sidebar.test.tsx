import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_USER } from "../test/authFixtures";
import type { AuthUser } from "../lib/auth/types";
import { Sidebar, type SidebarProps } from "./Sidebar";
import { SignedIn } from "../test/SignedIn";

function renderSidebar(path: string, props: SidebarProps = {}, user: AuthUser | null = TEST_USER) {
  render(
    <SignedIn user={user}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar {...props} />
      </MemoryRouter>
    </SignedIn>,
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

  describe("user footer", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("shows the user's name visibly with an initial avatar and a sign-out button when expanded", () => {
      renderSidebar("/", { onToggleCollapsed: vi.fn() });
      const footer = screen.getByTestId("sidebar-footer");
      expect(within(footer).getByText("Test User")).not.toHaveClass("md:sr-only");
      expect(within(footer).getByText("T")).toBeInTheDocument();
      expect(within(footer).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
      expect(footer).toHaveClass("mt-auto");
    });

    it("shows the profile picture instead of the initial when there is one", () => {
      renderSidebar("/", {}, { ...TEST_USER, pictureUrl: "https://example.com/me.png" });
      const footer = screen.getByTestId("sidebar-footer");
      expect(footer.querySelector("img")).toHaveAttribute("src", "https://example.com/me.png");
      expect(within(footer).queryByText("T")).not.toBeInTheDocument();
    });

    it("keeps the name accessible and as a tooltip, and the sign-out button, when collapsed", () => {
      renderSidebar("/", { collapsed: true });
      const footer = screen.getByTestId("sidebar-footer");
      expect(within(footer).getByText("Test User")).toHaveClass("md:sr-only");
      expect(footer.querySelector('[title="Test User"]')).not.toBeNull();
      expect(within(footer).getByRole("button", { name: "Sign out" })).toHaveAttribute("title", "Sign out");
    });

    it("has a Settings button next to Sign out that opens the settings modal", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      renderSidebar("/");
      const footer = screen.getByTestId("sidebar-footer");
      const settings = within(footer).getByRole("button", { name: "Settings" });
      expect(settings).toHaveAttribute("title", "Settings");
      expect(fetchMock).not.toHaveBeenCalled();
      await userEvent.click(settings);
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
      expect(await screen.findByText("No saved projects yet.")).toBeInTheDocument();
      expect(fetchMock.mock.calls[0][0]).toBe("/api/settings/ado-credentials");
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("keeps the Settings and Sign out buttons stacked and reachable when collapsed", () => {
      renderSidebar("/", { collapsed: true });
      const footer = screen.getByTestId("sidebar-footer");
      const settings = within(footer).getByRole("button", { name: "Settings" });
      expect(settings).toHaveAttribute("title", "Settings");
      expect(settings.parentElement).toHaveClass("md:flex-col");
      expect(settings.parentElement).toContainElement(within(footer).getByRole("button", { name: "Sign out" }));
    });

    it("renders no footer without a user", () => {
      renderSidebar("/", {}, null);
      expect(screen.queryByTestId("sidebar-footer")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    });

    it("signs out through POST /api/auth/logout and drops the footer", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);
      renderSidebar("/");
      await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
      await waitFor(() => expect(screen.queryByTestId("sidebar-footer")).not.toBeInTheDocument());
    });

    it("keeps the user signed in and shows an error toast when sign-out fails", async () => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ errors: ["boom"] }), { status: 500 })));
      renderSidebar("/");
      await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("boom");
      expect(screen.getByTestId("sidebar-footer")).toBeInTheDocument();
    });
  });
});
