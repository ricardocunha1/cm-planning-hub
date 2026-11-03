import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTheme, stubMatchMedia } from "../test/theme";
import {
  appliedTheme,
  applyTheme,
  isTheme,
  loadStoredTheme,
  resolveTheme,
  saveTheme,
  systemTheme,
  THEME_KEY,
} from "./themePreference";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTheme();
});

describe("themePreference", () => {
  it("uses the versioned storage key", () => {
    expect(THEME_KEY).toBe("cmPlanningHub.theme.v1");
  });

  it("recognises only the two themes", () => {
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("blue")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it("has no stored choice by default and ignores invalid values", () => {
    expect(loadStoredTheme()).toBeNull();
    window.localStorage.setItem(THEME_KEY, "sepia");
    expect(loadStoredTheme()).toBeNull();
  });

  it("round-trips the explicit choice", () => {
    saveTheme("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
    expect(loadStoredTheme()).toBe("light");
    saveTheme("dark");
    expect(loadStoredTheme()).toBe("dark");
  });

  it("follows the OS preference, defaulting to dark", () => {
    expect(systemTheme()).toBe("dark"); // jsdom has no matchMedia
    stubMatchMedia(true);
    expect(systemTheme()).toBe("light");
    stubMatchMedia(false);
    expect(systemTheme()).toBe("dark");
  });

  it("falls back to dark when matchMedia throws", () => {
    vi.stubGlobal("matchMedia", () => {
      throw new Error("unsupported");
    });
    expect(systemTheme()).toBe("dark");
  });

  it("resolves the stored choice over the OS preference", () => {
    stubMatchMedia(true);
    expect(resolveTheme()).toBe("light");
    saveTheme("dark");
    expect(resolveTheme()).toBe("dark");
  });

  it("falls back to the OS preference and swallows errors when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    stubMatchMedia(true);
    expect(loadStoredTheme()).toBeNull();
    expect(() => saveTheme("dark")).not.toThrow();
    expect(resolveTheme()).toBe("light");
  });

  it("applies the theme to <html> as data-theme and color-scheme", () => {
    expect(appliedTheme()).toBeNull();
    applyTheme("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(appliedTheme()).toBe("light");
    applyTheme("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(appliedTheme()).toBe("dark");
  });
});
