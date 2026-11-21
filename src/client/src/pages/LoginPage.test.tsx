import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAt } from "../test/render";
import { LoginPage } from "./LoginPage";

function renderLogin(entry = "/login") {
  return renderAt("/login", <LoginPage />, { initialEntry: entry, initialUser: null });
}

afterEach(() => vi.restoreAllMocks());

describe("LoginPage", () => {
  it("shows the hub name, the welcome sentence and the SSO button", () => {
    renderLogin();
    expect(screen.getByRole("heading", { level: 1, name: "CM Planning Hub" })).toBeInTheDocument();
    expect(screen.getByText("Estimate and plan your implementation projects")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Login with SSO" });
    expect(button.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Critical Manufacturing" })).toHaveAttribute("src", "/cmlogo-mark.png");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.title).toBe("Planning Hub – Login");
  });

  it("navigates the whole page to /api/auth/login on click", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign });
    renderLogin();
    await userEvent.click(screen.getByRole("button", { name: "Login with SSO" }));
    expect(assign).toHaveBeenCalledWith("/api/auth/login");
  });

  it.each([
    ["access_denied", /cancelled/],
    ["domain_not_allowed", /domain/],
    ["email_not_verified", /not verified/],
    ["state_mismatch", /expired or was invalid/],
    ["invalid_claims", /valid identity/],
    ["login_failed", /contact an administrator/],
    ["something_else", /Sign-in failed/],
  ])("shows a message for ?error=%s", (code, pattern) => {
    renderLogin(`/login?error=${code}`);
    expect(screen.getByRole("alert")).toHaveTextContent(pattern);
  });
});
