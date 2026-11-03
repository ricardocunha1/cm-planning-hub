import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_KEY, loadAutosave, saveAutosave } from "./autosavePreference";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("autosavePreference", () => {
  it("defaults to on", () => {
    expect(loadAutosave()).toBe(true);
  });

  it("round-trips on/off with the on/off values", () => {
    saveAutosave(false);
    expect(window.localStorage.getItem(AUTOSAVE_KEY)).toBe("off");
    expect(loadAutosave()).toBe(false);
    saveAutosave(true);
    expect(window.localStorage.getItem(AUTOSAVE_KEY)).toBe("on");
    expect(loadAutosave()).toBe(true);
  });

  it("treats an unrecognized value as on", () => {
    window.localStorage.setItem(AUTOSAVE_KEY, "garbage");
    expect(loadAutosave()).toBe(true);
  });

  it("falls back to on and swallows errors when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadAutosave()).toBe(true);
    expect(() => saveAutosave(false)).not.toThrow();
  });
});
