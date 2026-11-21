import type { AdoSource } from "./types";

/**
 * The remembered connection: source and canonical project URL only. There is
 * deliberately no token field: the SPA never persists a token in the
 * browser (PATs are stored encrypted on the server, per user, via Settings).
 * Each tool remembers its own under its own localStorage key
 * (Release Plan: `ADO_CONNECTION_KEY` in `lib/releasePlan/constants.ts`,
 * Monte Carlo: `ADO_CONNECTION_KEY` in `lib/monteCarlo/constants.ts`).
 */
export interface SavedAdoConnection {
  source: AdoSource;
  projectUrl: string;
}

/** The connection remembered under `key`, or `null` when absent, malformed or storage is unavailable. */
export function loadAdoConnection(key: string): SavedAdoConnection | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const { source, projectUrl } = value as Record<string, unknown>;
    if ((source !== "onprem" && source !== "cloud") || typeof projectUrl !== "string") {
      return null;
    }
    return { source, projectUrl };
  } catch {
    return null;
  }
}

/** Remembers `{source, projectUrl}` under `key` (any other property is dropped); ignores unavailable storage. */
export function saveAdoConnection(key: string, { source, projectUrl }: SavedAdoConnection): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ source, projectUrl }));
  } catch {
    // Storage unavailable: the form just won't be pre-filled next time.
  }
}
