import { useSyncExternalStore } from "react";
import {
  applyTheme,
  appliedTheme,
  LIGHT_SCHEME_QUERY,
  loadStoredTheme,
  resolveTheme,
  saveTheme,
  systemTheme,
  type Theme,
} from "./lib/themePreference";

/*
 * App-wide theme state. The source of truth is the `data-theme` attribute on
 * `<html>` (set before React renders by the script in `index.html`), so no
 * provider is needed: every `useTheme` caller subscribes to this module.
 */

const listeners = new Set<() => void>();
let systemQuery: MediaQueryList | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** While the user has made no explicit choice, follow live OS scheme changes. */
function onSystemChange(): void {
  if (loadStoredTheme() === null) {
    applyTheme(systemTheme());
    notify();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window.matchMedia === "function") {
    systemQuery = window.matchMedia(LIGHT_SCHEME_QUERY);
    systemQuery.addEventListener?.("change", onSystemChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && systemQuery) {
      systemQuery.removeEventListener?.("change", onSystemChange);
      systemQuery = null;
    }
  };
}

/** The active theme: the one applied to `<html>`, else the stored choice or OS preference. */
export function currentTheme(): Theme {
  return appliedTheme() ?? resolveTheme();
}

/** Applies `theme` to `<html>`, persists it as the user's explicit choice and re-renders every `useTheme` caller. */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  saveTheme(theme);
  notify();
}

/** The active theme plus setters; components re-render when it changes. */
export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme);
  return { theme, setTheme, toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark") };
}
