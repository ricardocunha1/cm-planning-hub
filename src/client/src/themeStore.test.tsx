import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, THEME_KEY } from "./lib/themePreference";
import { resetTheme, stubMatchMedia } from "./test/theme";
import { currentTheme, setTheme, useTheme } from "./themeStore";

afterEach(() => {
  vi.unstubAllGlobals();
  resetTheme();
});

describe("themeStore", () => {
  it("reads the theme applied to <html> (as the index.html script does)", () => {
    applyTheme("light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
  });

  it("falls back to the stored choice, then the OS preference, when nothing is applied", () => {
    stubMatchMedia(true);
    expect(currentTheme()).toBe("light");
    window.localStorage.setItem(THEME_KEY, "dark");
    expect(currentTheme()).toBe("dark");
  });

  it("toggles, applying the theme to <html> and persisting the explicit choice", () => {
    applyTheme("dark");
    const { result } = renderHook(() => useTheme());

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");

    act(() => result.current.toggleTheme());
    expect(result.current.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("re-renders every subscriber when the theme is set", () => {
    applyTheme("dark");
    const first = renderHook(() => useTheme());
    const second = renderHook(() => useTheme());
    act(() => setTheme("light"));
    expect(first.result.current.theme).toBe("light");
    expect(second.result.current.theme).toBe("light");
  });

  it("follows OS changes until the user makes an explicit choice", () => {
    const media = stubMatchMedia(false);
    applyTheme("dark");
    const { result, unmount } = renderHook(() => useTheme());
    expect(media.listenerCount()).toBe(1);

    act(() => media.setPrefersLight(true));
    expect(result.current.theme).toBe("light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();

    act(() => result.current.setTheme("dark"));
    act(() => media.setPrefersLight(true));
    expect(result.current.theme).toBe("dark");

    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});
