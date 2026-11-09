import { vi } from "vitest";
import { LIGHT_SCHEME_QUERY } from "../lib/themePreference";

/** A stubbed `window.matchMedia` whose `(prefers-color-scheme: light)` answer tests can flip. */
export interface MatchMediaStub {
  /** Changes the OS preference and fires `change` on the registered listeners. */
  setPrefersLight(prefersLight: boolean): void;
  /** How many `change` listeners are currently registered. */
  listenerCount(): number;
}

/**
 * Stubs `window.matchMedia` (jsdom has none) so `(prefers-color-scheme: light)` matches when
 * `prefersLight`; undo with `vi.unstubAllGlobals()`.
 */
export function stubMatchMedia(prefersLight: boolean): MatchMediaStub {
  let matches = prefersLight;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === LIGHT_SCHEME_QUERY && matches;
    },
    media: query,
    addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  }));
  return {
    setPrefersLight(next) {
      matches = next;
      for (const listener of [...listeners]) {
        listener({ matches: next, media: LIGHT_SCHEME_QUERY } as MediaQueryListEvent);
      }
    },
    listenerCount: () => listeners.size,
  };
}

/** Removes any theme applied to `<html>` and the stored choice, so each test starts unthemed. */
export function resetTheme(): void {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  window.localStorage.clear();
}
