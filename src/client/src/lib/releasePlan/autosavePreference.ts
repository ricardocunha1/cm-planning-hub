/** localStorage key holding the Release Plan autosave preference (`"on"` / `"off"`). */
export const AUTOSAVE_KEY = "cmPlanningHub.releasePlan.autosave.v1";

/** Whether autosave to the server is on; `true` when unset, unrecognized or storage is unavailable. */
export function loadAutosave(): boolean {
  try {
    return window.localStorage.getItem(AUTOSAVE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Persists the autosave preference; silently ignores unavailable storage. */
export function saveAutosave(on: boolean): void {
  try {
    window.localStorage.setItem(AUTOSAVE_KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable: the preference only lasts until the next page mount.
  }
}
