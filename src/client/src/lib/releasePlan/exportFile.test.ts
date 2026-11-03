import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOWNLOAD_REVOKE_MS, downloadBlob, fileBase } from "./exportFile";

const NOW = new Date("2026-10-21T12:34:56.789Z");

describe("fileBase", () => {
  it("appends the UTC date to the plan name", () => {
    expect(fileBase("Q4_plan-v2", NOW)).toBe("Q4_plan-v2_2026-10-21");
  });

  it("replaces every run of non-word, non-dash characters with one underscore", () => {
    expect(fileBase("My plan: v1.0 / Team #3", NOW)).toBe("My_plan_v1_0_Team_3_2026-10-21");
    expect(fileBase("Ação Plan", NOW)).toBe("A_o_Plan_2026-10-21");
  });

  it("falls back to 'feature-plan' for an empty name", () => {
    expect(fileBase("", NOW)).toBe("feature-plan_2026-10-21");
  });

  it("uses the UTC calendar day, not the local one", () => {
    expect(fileBase("p", new Date("2026-10-21T23:59:59.999Z"))).toBe("p_2026-10-21");
    expect(fileBase("p", new Date("2026-10-22T00:00:00.000Z"))).toBe("p_2026-10-22");
  });
});

describe("downloadBlob", () => {
  const createObjectURL = vi.fn((_blob: Blob) => "blob:mock-url");
  const revokeObjectURL = vi.fn((_url: string) => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clicks a temporary download anchor, then revokes the URL and removes it after 500 ms", () => {
    let clicked: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked = this;
      expect(document.body.contains(this)).toBe(true);
    });
    const blob = new Blob(["{}"], { type: "application/json" });
    downloadBlob(blob, "plan_2026-10-21.json");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked).not.toBeNull();
    const anchor = document.querySelector<HTMLAnchorElement>("a[download]");
    expect(anchor).toBe(clicked);
    expect(anchor?.download).toBe("plan_2026-10-21.json");
    expect(anchor?.getAttribute("href")).toBe("blob:mock-url");

    vi.advanceTimersByTime(DOWNLOAD_REVOKE_MS - 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(document.querySelector("a[download]")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(DOWNLOAD_REVOKE_MS).toBe(500);
  });
});
