import { act, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PALETTES } from "../../lib/releasePlan/constants";
import { PNG_HEAD } from "../../lib/releasePlan/png";
import { applyTheme } from "../../lib/themePreference";
import { resetTheme } from "../../test/theme";
import { computeFlippedLayout, computeLayout } from "../../lib/releasePlan/layout";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import { FakeImage, RecordingContext, stubCanvas } from "../../test/canvas";
import { makeEpic, makeFeature, makePlan, samplePlan } from "../../test/releasePlanFixtures";
import { ToastProvider } from "../Toast";
import { PNG_FAILED, PNG_TOO_LARGE, useExportPng } from "./useExportPng";

const NOW = new Date("2026-10-21T09:15:00.000Z");
const PNG = new Blob(["png"], { type: "image/png" });

function wrapper({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

function setup(plan: ReleasePlan, orientation: "standard" | "flipped" = "standard") {
  return renderHook(() => useExportPng(plan, orientation), { wrapper });
}

const infos = () => screen.queryAllByRole("status").map((s) => s.textContent);
const errorText = () => screen.queryAllByRole("alert").map((a) => a.textContent ?? "");

describe("useExportPng", () => {
  let blobs: Blob[] = [];
  let downloads: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("Image", FakeImage);
    FakeImage.reset();
    blobs = [];
    downloads = [];
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return "blob:png";
      },
      revokeObjectURL: () => undefined,
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    FakeImage.reset();
    resetTheme();
  });

  it("draws the board at scale 2 with the logo, downloads <base>.png and toasts", async () => {
    const ctx = new RecordingContext();
    const canvases = stubCanvas({ context: ctx, blob: PNG });
    const plan = samplePlan();
    const { result } = setup(plan);
    await act(() => result.current.exportPng());

    const layout = computeLayout(plan);
    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBe(layout.width * 2);
    expect(canvases[0].height).toBe((layout.height + PNG_HEAD) * 2);
    expect(ctx.calls[0]).toMatchObject({ op: "scale", args: [2, 2] });
    expect(ctx.texts()).toContain("Sample Release Plan");
    const images = ctx.ops("drawImage");
    expect(images).toHaveLength(1);
    expect(images[0].args[0]).toBeInstanceOf(FakeImage);
    expect(downloads).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
    expect(blobs).toEqual([PNG]);
    expect(infos()).toContain("PNG exported");
    expect(errorText()).toEqual([]);
    expect(result.current.exporting).toBe(false);
  });

  it("draws the flipped layout when the board is flipped", async () => {
    const ctx = new RecordingContext();
    const canvases = stubCanvas({ context: ctx, blob: PNG });
    const plan = samplePlan();
    const { result } = setup(plan, "flipped");
    await act(() => result.current.exportPng());
    const layout = computeFlippedLayout(plan);
    expect(layout.width).not.toBe(computeLayout(plan).width);
    expect(canvases[0].width).toBe(layout.width * 2);
    expect(canvases[0].height).toBe((layout.height + PNG_HEAD) * 2);
    expect(ctx.ops("fillRect")).toContainEqual(expect.objectContaining({ args: [0, layout.headH, layout.width, 1] }));
    expect(downloads).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
  });

  it.each(["dark", "light"] as const)("draws with the %s palette in the %s theme", async (theme) => {
    applyTheme(theme);
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: PNG });
    const plan = samplePlan();
    const { result } = setup(plan);
    await act(() => result.current.exportPng());
    const layout = computeLayout(plan);
    expect(ctx.ops("fillRect")[0]).toMatchObject({ args: [0, 0, layout.width, layout.height + PNG_HEAD], fillStyle: PALETTES[theme].panel });
    expect(ctx.ops("fillRect")).toContainEqual(expect.objectContaining({ fillStyle: PALETTES[theme].bandA }));
    expect(downloads).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
  });

  it("still exports, without the logo, when the logo fails to load", async () => {
    FakeImage.fail = true;
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: PNG });
    const { result } = setup(samplePlan());
    await act(() => result.current.exportPng());
    expect(ctx.ops("drawImage")).toHaveLength(0);
    expect(downloads).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
    expect(infos()).toContain("PNG exported");
  });

  it("shows the too-large error and downloads nothing for a board beyond the canvas limits", async () => {
    const ctx = new RecordingContext();
    const canvases = stubCanvas({ context: ctx, blob: PNG });
    const features = Array.from({ length: 110 }, (_, i) => makeFeature({ id: i + 1 }));
    const { result } = setup(makePlan({ epics: [makeEpic({ id: 1, features })] }));
    await act(() => result.current.exportPng());
    expect(errorText().join(" ")).toContain(PNG_TOO_LARGE);
    expect(canvases).toHaveLength(0);
    expect(downloads).toEqual([]);
    expect(infos()).not.toContain("PNG exported");
    expect(result.current.exporting).toBe(false);
  });

  it("shows the export error and downloads nothing when there is no 2D context", async () => {
    stubCanvas({ context: null, blob: PNG });
    const { result } = setup(samplePlan());
    await act(() => result.current.exportPng());
    expect(errorText().join(" ")).toContain(PNG_FAILED);
    expect(downloads).toEqual([]);
    expect(infos()).not.toContain("PNG exported");
  });

  it("shows the export error and downloads nothing when toBlob yields null", async () => {
    const ctx = new RecordingContext();
    stubCanvas({ context: ctx, blob: null });
    const { result } = setup(samplePlan());
    await act(() => result.current.exportPng());
    expect(ctx.calls.length).toBeGreaterThan(0);
    expect(errorText().join(" ")).toContain(PNG_FAILED);
    expect(downloads).toEqual([]);
    expect(infos()).not.toContain("PNG exported");
  });

  it("is 'exporting' while running and ignores a second call meanwhile", async () => {
    FakeImage.hold = true;
    const canvases = stubCanvas({ context: new RecordingContext(), blob: PNG });
    const { result } = setup(samplePlan());
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.exportPng();
    });
    expect(result.current.exporting).toBe(true);
    await act(() => result.current.exportPng());
    await act(async () => {
      FakeImage.release();
      await first;
    });
    expect(canvases).toHaveLength(1);
    expect(downloads).toEqual(["Sample_Release_Plan_2026-10-21.png"]);
    expect(result.current.exporting).toBe(false);
  });
});
