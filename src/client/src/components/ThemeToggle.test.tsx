import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, THEME_KEY } from "../lib/themePreference";
import { resetTheme } from "../test/theme";
import { ThemeToggle } from "./ThemeToggle";

afterEach(() => {
  resetTheme();
});

describe("ThemeToggle", () => {
  it("offers the light theme while dark, then the dark theme, persisting each choice", async () => {
    applyTheme("dark");
    render(<ThemeToggle />);

    const toLight = screen.getByRole("button", { name: "Switch to light theme" });
    expect(toLight).toHaveAttribute("title", "Switch to light theme");
    await userEvent.click(toLight);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");

    await userEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
  });

  it("starts from the applied light theme", () => {
    applyTheme("light");
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
  });

  it("is keyboard operable", async () => {
    applyTheme("dark");
    render(<ThemeToggle />);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
