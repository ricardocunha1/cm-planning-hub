/** The hub's color themes; `dark` is the original look. */
export type Theme = "light" | "dark";

/**
 * localStorage key holding the user's explicit theme choice (`"light"` or `"dark"`).
 * The pre-render script in `index.html` reads the same key: keep both in sync.
 */
export const THEME_KEY = "cmPlanningHub.theme.v1";

/** Media query matched when the OS asks for a light color scheme. */
export const LIGHT_SCHEME_QUERY = "(prefers-color-scheme: light)";

/** Type guard for a stored or applied theme value. */
export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** The theme the user explicitly chose, or `null` when none is stored (or storage is unavailable). */
export function loadStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persists the user's explicit theme choice; silently ignores unavailable storage. */
export function saveTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable: the choice only lasts until the next page load.
  }
}

/** The OS preference: `light` only when it asks for light, otherwise (or when `matchMedia` is unavailable) `dark`. */
export function systemTheme(): Theme {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(LIGHT_SCHEME_QUERY).matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The theme to show on load: the stored explicit choice, else the OS preference. */
export function resolveTheme(): Theme {
  return loadStoredTheme() ?? systemTheme();
}

/** Applies `theme` to `root` (`data-theme` drives the CSS variables, `color-scheme` the native controls). */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** The theme currently applied to `root`, or `null` when none has been applied yet. */
export function appliedTheme(root: HTMLElement = document.documentElement): Theme | null {
  const value = root.dataset.theme;
  return isTheme(value) ? value : null;
}
