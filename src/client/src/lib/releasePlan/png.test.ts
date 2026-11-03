import { describe, expect, it } from "vitest";
import { RecordingContext } from "../../test/canvas";
import { makeEpic, makeFeature, makeFlag, makeMilestone, makePlan, samplePlan, sprintsPlan } from "../../test/releasePlanFixtures";
import { L, LF, OK_GREEN, PALETTE, PALETTES, SIZE_COLORS, STATE_COLORS } from "./constants";
import { computeFlippedLayout, computeLayout } from "./layout";
import { drawBoardPng, PNG_HEAD, PNG_MAX_AREA, PNG_MAX_SIDE, pngScale, type PngLogo, wrap } from "./png";
import { fmtDate } from "./selectors";
import { NO_EPIC_ID, NO_EPIC_TITLE, type ReleasePlan } from "./types";

const NOW = new Date("2026-10-21T12:00:00Z");
const NOW_LABEL = NOW.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

function draw(plan: ReleasePlan, logo: PngLogo | null = null, scale = 2) {
  const ctx = new RecordingContext();
  const layout = computeLayout(plan);
  drawBoardPng(ctx, plan, layout, { scale, now: NOW, logo });
  return { ctx, layout };
}

/** Rounded-rect path origins (`moveTo(x + r, y)` then the first `arcTo`) filled in a given color. */
function roundedFills(ctx: RecordingContext, color: string): Array<{ x: number; y: number; w: number; r: number }> {
  const out: Array<{ x: number; y: number; w: number; r: number }> = [];
  ctx.calls.forEach((c, i) => {
    const next = ctx.calls[i + 1];
    if (c.op === "moveTo" && next?.op === "arcTo" && ctx.calls[i - 1]?.op === "beginPath") {
      const r = Number(next.args[4]);
      const x = Number(c.args[0]) - r;
      const fill = ctx.calls.slice(i).find((k) => k.op === "fill");
      if (fill && fill.fillStyle === color) {
        out.push({ x, y: Number(c.args[1]), w: Number(next.args[0]) - x, r });
      }
    }
  });
  return out;
}

describe("pngScale", () => {
  it("uses scale 2 for a small board", () => {
    expect(pngScale(1200, 800)).toBe(2);
  });

  it("is reduced for a wide or a tall board so the side fits", () => {
    expect(pngScale(12000, 300)).toBeCloseTo(PNG_MAX_SIDE / 12000);
    expect(pngScale(300, 10000)).toBeCloseTo(PNG_MAX_SIDE / 10000);
    expect(pngScale(16384, 200)).toBe(1);
  });

  it("is reduced to the area limit for a big square-ish board", () => {
    const s = pngScale(3000, 3000);
    expect(s).not.toBeNull();
    expect(s).toBeLessThan(2);
    expect(s).toBeGreaterThan(1);
    const v = s ?? 0;
    expect(Math.floor(3000 * v) * Math.floor(3000 * v)).toBeLessThanOrEqual(PNG_MAX_AREA);
    expect(pngScale(4096, 4096)).toBe(1);
  });

  it("returns null when even scale 1 doesn't fit", () => {
    expect(pngScale(16385, 100)).toBeNull();
    expect(pngScale(100, 20000)).toBeNull();
    expect(pngScale(5000, 4000)).toBeNull();
  });
});

describe("wrap", () => {
  it("draws text that fits on one line", () => {
    const ctx = new RecordingContext();
    expect(wrap(ctx, "Short title", 5, 10, 200, 15, 2)).toEqual(["Short title"]);
    expect(ctx.ops("fillText").map((c) => c.args)).toEqual([["Short title", 5, 10]]);
  });

  it("wraps on whitespace, one line per lineH", () => {
    const ctx = new RecordingContext();
    // 6 px per char, maxW 60 → at most 10 chars per line.
    expect(wrap(ctx, "alpha beta  gamma delta", 0, 0, 60, 15.5, 3)).toEqual(["alpha beta", "gamma", "delta"]);
    expect(ctx.ops("fillText").map((c) => c.args[2])).toEqual([0, 15.5, 31]);
  });

  it("truncates the last kept line with an ellipsis when there are too many lines", () => {
    const ctx = new RecordingContext();
    const lines = wrap(ctx, "alpha beta gamma delta epsilon", 0, 0, 60, 15, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("alpha beta");
    expect(lines[1].endsWith("…")).toBe(true);
    expect(ctx.measureText(lines[1]).width).toBeLessThanOrEqual(60);
    expect(ctx.texts()).toEqual(lines);
  });
});

describe("drawBoardPng", () => {
  it("scales, uses top baseline and fills the whole canvas with the panel color", () => {
    const { ctx, layout } = draw(samplePlan(), null, 1.5);
    expect(ctx.calls[0]).toMatchObject({ op: "scale", args: [1.5, 1.5] });
    expect(ctx.textBaseline).toBe("top");
    expect(ctx.ops("fillRect")[0]).toMatchObject({ args: [0, 0, layout.width, layout.height + PNG_HEAD], fillStyle: PALETTE.panel });
    expect(ctx.ops("translate").map((c) => c.args)).toEqual([[0, PNG_HEAD]]);
  });

  it("draws the navy header with the plan name and the export subtitle", () => {
    const { ctx, layout } = draw(samplePlan());
    expect(ctx.ops("fillRect")[1]).toMatchObject({ args: [0, 0, layout.width, PNG_HEAD], fillStyle: "#274B76" });
    expect(ctx.text("Sample Release Plan")).toMatchObject({ args: ["Sample Release Plan", 18, 12], fillStyle: "#fff" });
    expect(ctx.text("Sample Release Plan").font).toMatch(/^600 20px /);
    const sub = ctx.text(`Exported ${NOW_LABEL} · Azure DevOps`);
    expect(sub).toMatchObject({ args: [`Exported ${NOW_LABEL} · Azure DevOps`, 18, 38], fillStyle: "rgba(255,255,255,.75)" });
    expect(sub.font).toMatch(/^12px /);
  });

  it("prints 'Manual' when the plan has no source system", () => {
    const { ctx } = draw(samplePlan({ source: {} }));
    expect(ctx.texts()).toContain(`Exported ${NOW_LABEL} · Manual`);
  });

  it("draws the logo on a white rounded plate only when a logo is given", () => {
    const image = document.createElement("img");
    const { ctx, layout } = draw(samplePlan(), { image, width: 176, height: 44 });
    const lw = (176 * 40) / 44; // 160, exact
    const lx = layout.width - lw - 18 - 6;
    expect(ctx.ops("drawImage").map((c) => c.args)).toEqual([[image, lx, 12, lw, 40]]);
    expect(roundedFills(ctx, "#fff")).toContainEqual({ x: lx - 6, y: 6, w: lw + 12, r: 6 });

    const without = draw(samplePlan()).ctx;
    expect(without.ops("drawImage")).toHaveLength(0);
    expect(roundedFills(without, "#fff").some((r) => r.y === 6 && r.r === 6)).toBe(false);
  });

  it("fills one band per milestone plus Unplanned, alternating colors, with a top line and the label divider", () => {
    const plan = makePlan({
      milestones: [makeMilestone({ id: "a" }), makeMilestone({ id: "b" }), makeMilestone({ id: "c" })],
    });
    const { ctx, layout } = draw(plan);
    const bandFills = ctx.ops("fillRect").filter((c) => c.args[0] === 0 && c.args[2] === layout.width && c.args[3] === layout.bands[0].h);
    expect(bandFills.map((c) => [c.args[1], c.fillStyle])).toEqual([
      [layout.bands[0].y, PALETTE.bandA],
      [layout.bands[1].y, PALETTE.bandB],
      [layout.bands[2].y, PALETTE.bandA],
      [layout.bands[3].y, PALETTE.unplanned],
    ]);
    for (const b of layout.bands) {
      expect(ctx.ops("fillRect")).toContainEqual(expect.objectContaining({ args: [0, b.y, layout.width, 1], fillStyle: PALETTE.bandLine }));
      expect(ctx.ops("fillRect")).toContainEqual(expect.objectContaining({ args: [L.LBL_W, b.y, 1, b.h], fillStyle: PALETTE.line }));
    }
  });

  it("draws the band labels: color bar, name, date / 'No date' / 'Not assigned', feature count and size chips", () => {
    const { ctx, layout } = draw(samplePlan());
    const [mvp, r2, unplanned] = layout.bands;
    expect(roundedFills(ctx, "#4E98D1")).toContainEqual({ x: 10, y: mvp.y + 12, w: 4, r: 2 });
    expect(roundedFills(ctx, PALETTE.gold)).toContainEqual({ x: 10, y: unplanned.y + 12, w: 4, r: 2 });
    expect(ctx.text("MVP")).toMatchObject({ args: ["MVP", 22, mvp.y + 12], fillStyle: PALETTE.ink });
    expect(ctx.text(fmtDate("2026-11-30"))).toMatchObject({ args: [fmtDate("2026-11-30"), 22, mvp.y + 50], fillStyle: PALETTE.muted });
    expect(ctx.text("No date").args).toEqual(["No date", 22, r2.y + 50]);
    expect(ctx.text("Not assigned").args).toEqual(["Not assigned", 22, unplanned.y + 50]);
    expect(ctx.ops("fillText").filter((c) => String(c.args[0]).endsWith(" Features")).map((c) => c.args)).toEqual([
      ["2 Features", 22, mvp.y + 66],
      ["2 Features", 22, r2.y + 66],
      ["1 Features", 22, unplanned.y + 66],
    ]);
    // MVP chips: M then XL, side by side from (22, y+84).
    expect(ctx.text("M 1")).toMatchObject({ args: ["M 1", 29, mvp.y + 87], fillStyle: SIZE_COLORS.M.ink });
    expect(ctx.text("XL 1")).toMatchObject({ args: ["XL 1", 22 + 3 * 6 + 14 + 4 + 7, mvp.y + 87], fillStyle: SIZE_COLORS.XL.ink });
    expect(roundedFills(ctx, SIZE_COLORS.M.bg)).toContainEqual({ x: 22, y: mvp.y + 84, w: 3 * 6 + 14, r: 8.5 });
  });

  it("wraps size chips onto a new row when they don't fit the label column", () => {
    const sizes = ["XS", "S", "M", "L", "XL", "XXL", ""];
    const plan = makePlan({ epics: [makeEpic({ id: 1, features: sizes.map((size, i) => makeFeature({ id: i + 1, size })) })] });
    const { ctx, layout } = draw(plan);
    const y = layout.bands[0].y;
    const rows = new Set(ctx.ops("fillText").filter((c) => /^(XS|S|M|L|XL|XXL|\?) 1$/.test(String(c.args[0]))).map((c) => c.args[2]));
    expect([...rows]).toEqual([y + 87, y + 107]);
  });

  it("draws each epic background, header card, centered title and meta line", () => {
    const { ctx, layout } = draw(samplePlan());
    for (const e of layout.epics) {
      expect(roundedFills(ctx, PALETTE.epicbg)).toContainEqual({ x: e.x, y: layout.bandY0 - 4, w: e.w, r: 8 });
      expect(roundedFills(ctx, "#FF7B00")).toContainEqual({ x: e.x, y: L.TOP, w: e.w, r: 6 });
    }
    const title = ctx.text("Wave 1 - MVP");
    expect(title).toMatchObject({ args: ["Wave 1 - MVP", layout.epics[0].x + layout.epics[0].w / 2, L.TOP + 8], textAlign: "center", fillStyle: "#1a1206" });
    expect(title.font).toMatch(/^700 15px /);
    expect(ctx.text("Epic #1 · Done in MVP")).toMatchObject({ globalAlpha: 0.75, textAlign: "center", args: ["Epic #1 · Done in MVP", layout.epics[0].x + layout.epics[0].w / 2, L.TOP + 28] });
    expect(ctx.texts()).toEqual(expect.arrayContaining(["Epic #2 · Release 2 · 1 unplanned", "Epic #3 · No features"]));
    expect(ctx.textAlign).toBe("left");
  });

  it("omits the id in the synthetic Epic's meta line, like the board header", () => {
    const plan = makePlan({ epics: [makeEpic({ id: NO_EPIC_ID, title: NO_EPIC_TITLE, features: [makeFeature({ id: 5 })] })] });
    const { ctx, layout } = draw(plan);
    const meta = ctx.ops("fillText").filter((c) => c.args[1] === layout.epics[0].x + layout.epics[0].w / 2 && c.args[2] === L.TOP + 28);
    expect(meta.map((c) => c.args[0])).toEqual(["Unplanned"]);
    expect(ctx.texts().some((t) => t.includes("#no-epic"))).toBe(false);
  });

  it("draws one card per feature at its column x and its band's y", () => {
    const { ctx, layout } = draw(samplePlan());
    const bandY = (id: string | null) => layout.bands.find((b) => b.band.id === id)?.y ?? NaN;
    const cards = roundedFills(ctx, "#773B93");
    const expected = layout.epics.flatMap((e) => e.cols.map((c) => ({ x: c.x, y: bandY(c.feature.milestoneId) + L.BAND_PAD, w: L.COL_W, r: 4 })));
    expect(cards).toEqual(expected);
    expect(cards).toHaveLength(5);
    const exports = layout.epics[1].cols[1];
    expect(ctx.text("Feature #22")).toMatchObject({ args: ["Feature #22", exports.x + 22, bandY(null) + L.BAND_PAD + 6], globalAlpha: 0.85, fillStyle: "#fff" });
    expect(ctx.text("Login page")).toMatchObject({ args: ["Login page", layout.epics[0].cols[0].x + 7, bandY("ms_mvp") + L.BAND_PAD + 25] });
  });

  it("draws a green check for done features and a state dot otherwise", () => {
    const plan = makePlan({ epics: [makeEpic({ id: 1, features: [makeFeature({ id: 1, state: "Done" }), makeFeature({ id: 2, state: "Active" }), makeFeature({ id: 3, state: "Weird" })] })] });
    const { ctx, layout } = draw(plan);
    const y = layout.bands[0].y + L.BAND_PAD;
    const [c1, c2, c3] = layout.epics[0].cols.map((c) => c.x);
    const arcs = ctx.ops("arc").map((c) => [c.args[0], c.args[1], c.args[2], c.fillStyle]);
    expect(arcs).toEqual([
      [c1 + 12, y + 12, 7, OK_GREEN],
      [c2 + 11, y + 12, 5.5, "rgba(255,255,255,.9)"],
      [c2 + 11, y + 12, 4, STATE_COLORS.Active],
      [c3 + 11, y + 12, 5.5, "rgba(255,255,255,.9)"],
      [c3 + 11, y + 12, 4, "#C7D2E0"],
    ]);
    const strokes = ctx.ops("stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0].strokeStyle).toBe("#fff");
    expect(ctx.ops("moveTo")).toContainEqual(expect.objectContaining({ args: [c1 + 8.5, y + 12] }));
    expect(ctx.ops("lineTo")).toContainEqual(expect.objectContaining({ args: [c1 + 15.5, y + 9.5] }));
  });

  it("draws the size badge, with '?' on a translucent pill for an unestimated feature", () => {
    const plan = makePlan({ epics: [makeEpic({ id: 1, features: [makeFeature({ id: 1, size: "XL" }), makeFeature({ id: 2, size: "" })] })] });
    const { ctx, layout } = draw(plan);
    const y = layout.bands[0].y + L.BAND_PAD;
    const [c1, c2] = layout.epics[0].cols.map((c) => c.x);
    const sw1 = 2 * 6 + 12;
    const sw2 = 6 + 12;
    expect(ctx.ops("fillText")).toContainEqual(expect.objectContaining({ args: ["XL", c1 + L.COL_W - sw1, y + 6], fillStyle: "#4a1f60" }));
    expect(roundedFills(ctx, "#fff")).toContainEqual({ x: c1 + L.COL_W - sw1 - 6, y: y + 4, w: sw1, r: 8 });
    expect(ctx.ops("fillText")).toContainEqual(expect.objectContaining({ args: ["?", c2 + L.COL_W - sw2, y + 6], fillStyle: "#fff" }));
    expect(roundedFills(ctx, "rgba(255,255,255,.35)")).toContainEqual({ x: c2 + L.COL_W - sw2 - 6, y: y + 4, w: sw2, r: 8 });
  });

  it("draws flags: dashes, gold label, name and the tag with its date", () => {
    const { ctx, layout } = draw(sprintsPlan());
    expect(layout.flags).toHaveLength(1);
    const { y, h } = layout.flags[0];
    const cy = y + h / 2;
    const dashes = ctx.ops("fillRect").filter((c) => c.args[1] === cy - 1.5 && c.args[2] === 14 && c.args[3] === 3);
    expect(dashes[0]).toMatchObject({ args: [L.LBL_W, cy - 1.5, 14, 3], fillStyle: PALETTE.gold });
    expect(dashes).toHaveLength(Math.ceil((layout.width - L.LBL_W) / 20));
    expect(roundedFills(ctx, PALETTE.gold)).toContainEqual({ x: 0, y: y + 4, w: L.LBL_W - 14, r: 6 });
    expect(ctx.text("Beta")).toMatchObject({ args: ["Beta", 28, cy - 7], fillStyle: "#3a2a05" });
    const label = `Beta · ${fmtDate("2026-09-25")}`;
    expect(ctx.text(label)).toMatchObject({ args: [label, L.LEFT + 30, cy - 6], fillStyle: "#3a2a05" });
    expect(roundedFills(ctx, PALETTE.gold)).toContainEqual({ x: L.LEFT + 6, y: cy - 10, w: label.length * 6 + 30, r: 10 });
    // Two flag icons: pole rects at (10, cy-7) and (LEFT+14, cy-6).
    expect(ctx.ops("fillRect")).toContainEqual(expect.objectContaining({ args: [10, cy - 7, 1.8, 14], fillStyle: "#3a2a05" }));
    expect(ctx.ops("fillRect")).toContainEqual(expect.objectContaining({ args: [L.LEFT + 14, cy - 6, 1.8, 14], fillStyle: "#3a2a05" }));
  });

  it("omits the date from an undated flag's tag", () => {
    const plan = sprintsPlan({ flags: [makeFlag({ id: "f", name: "GA", date: "", afterMsId: "sp_2" })] });
    const { ctx } = draw(plan);
    expect(ctx.texts().filter((t) => t === "GA")).toHaveLength(2);
  });
});

describe("drawBoardPng (flipped)", () => {
  function drawFlipped(plan: ReleasePlan) {
    const ctx = new RecordingContext();
    const layout = computeFlippedLayout(plan);
    drawBoardPng(ctx, plan, layout, { scale: 2, now: NOW, logo: null });
    return { ctx, layout };
  }

  it("draws the same header strip, then full-height milestone columns with their labels in the header row", () => {
    const { ctx, layout } = drawFlipped(samplePlan());
    expect(ctx.ops("fillRect")[0]).toMatchObject({ args: [0, 0, layout.width, layout.height + PNG_HEAD], fillStyle: PALETTE.panel });
    expect(ctx.texts()).toContain("Sample Release Plan");
    const [mvp, r2, unplanned] = layout.columns;
    expect(ctx.ops("fillRect").filter((c) => c.args[1] === 0 && c.args[3] === layout.height && c.args[2] !== 1).map((c) => [c.args[0], c.fillStyle])).toEqual([
      [mvp.x, PALETTE.bandA],
      [r2.x, PALETTE.bandB],
      [unplanned.x, PALETTE.unplanned],
    ]);
    expect(ctx.text("MVP").args).toEqual(["MVP", mvp.x + 22, 12]);
    expect(ctx.text("No date").args).toEqual(["No date", r2.x + 22, 50]);
    expect(ctx.text("Not assigned").args).toEqual(["Not assigned", unplanned.x + 22, 50]);
    expect(roundedFills(ctx, "#4E98D1")).toContainEqual({ x: mvp.x + 10, y: 12, w: 4, r: 2 });
    expect(ctx.ops("fillRect")).toContainEqual(expect.objectContaining({ args: [0, layout.headH, layout.width, 1], fillStyle: PALETTE.line }));
  });

  it("draws epic backgrounds and header blocks on the left, and each card in its row and milestone column", () => {
    const { ctx, layout } = drawFlipped(samplePlan());
    for (const e of layout.epics) {
      expect(roundedFills(ctx, PALETTE.epicbg)).toContainEqual({ x: layout.colX0 - 4, y: e.y, w: layout.width - layout.colX0 - 8, r: 8 });
      expect(roundedFills(ctx, "#FF7B00")).toContainEqual({ x: LF.LEFT, y: e.y, w: LF.EPIC_W, r: 6 });
    }
    expect(ctx.text("Epic #1 · Done in MVP")).toMatchObject({ textAlign: "center", args: ["Epic #1 · Done in MVP", LF.LEFT + LF.EPIC_W / 2, layout.epics[0].y + layout.epics[0].h / 2 + 14] });
    const colX = (id: string | null) => layout.columns.find((c) => c.band.id === id)?.x ?? NaN;
    const expected = layout.epics.flatMap((e) => e.rows.map((r) => ({ x: colX(r.feature.milestoneId) + L.BAND_PAD, y: r.y, w: L.COL_W, r: 4 })));
    expect(roundedFills(ctx, "#773B93")).toEqual(expected);
    expect(expected).toHaveLength(5);
  });

  it("draws flags as vertical dashes below the header with rotated label and tag", () => {
    const { ctx, layout } = drawFlipped(sprintsPlan());
    const { x, w } = layout.flags[0];
    const cx = x + w / 2;
    const dashes = ctx.ops("fillRect").filter((c) => c.args[0] === cx - 1.5 && c.args[2] === 3 && c.args[3] === 14);
    expect(dashes[0]).toMatchObject({ args: [cx - 1.5, layout.headH, 3, 14], fillStyle: PALETTE.gold });
    expect(dashes).toHaveLength(Math.ceil((layout.height - layout.headH) / 20));
    expect(ctx.ops("rotate").map((c) => c.args)).toEqual([[-Math.PI / 2], [-Math.PI / 2]]);
    const lw = layout.headH - 14;
    expect(ctx.ops("translate").map((c) => c.args)).toContainEqual([cx, lw / 2]);
    expect(ctx.text("Beta")).toMatchObject({ args: ["Beta", -lw / 2 + 28, -7], fillStyle: "#3a2a05" });
    const label = `Beta · ${fmtDate("2026-09-25")}`;
    const tw = label.length * 6 + 30;
    expect(ctx.ops("translate").map((c) => c.args)).toContainEqual([cx, LF.TOP + 6 + tw / 2]);
    expect(ctx.text(label).args).toEqual([label, -tw / 2 + 24, -6]);
    expect(ctx.ops("save").length).toBe(ctx.ops("restore").length);
  });
});

describe("drawBoardPng palettes", () => {
  it("keeps the dark palette as the default and the original look", () => {
    expect(PALETTE).toBe(PALETTES.dark);
    expect(PALETTES.dark).toMatchObject({ panel: "#152A47", ink: "#E9EFF7", bandA: "#12243D", unplanned: "#2A2617" });
  });

  it("defines the same keys for both themes and keeps the brand colors", () => {
    expect(Object.keys(PALETTES.light).sort()).toEqual(Object.keys(PALETTES.dark).sort());
    expect(PALETTES.light.navy).toBe(PALETTES.dark.navy);
    expect(PALETTES.light.gold).toBe(PALETTES.dark.gold);
    expect(PALETTES.light.panel).not.toBe(PALETTES.dark.panel);
  });

  it.each([
    ["standard", computeLayout],
    ["flipped", computeFlippedLayout],
  ] as const)("draws the %s board with the palette it is given", (_name, compute) => {
    const plan = samplePlan();
    const layout = compute(plan);
    const light = PALETTES.light;
    const ctx = new RecordingContext();
    drawBoardPng(ctx, plan, layout, { scale: 1, now: NOW, logo: null, palette: light });

    const fills = new Set(ctx.calls.map((c) => c.fillStyle));
    expect(ctx.ops("fillRect")[0]).toMatchObject({ args: [0, 0, layout.width, layout.height + PNG_HEAD], fillStyle: light.panel });
    expect(ctx.ops("fillRect")[1]).toMatchObject({ args: [0, 0, layout.width, PNG_HEAD], fillStyle: light.navy });
    for (const color of [light.bandA, light.bandB, light.unplanned, light.bandLine, light.line, light.ink, light.muted, light.epicbg]) {
      expect(fills).toContain(color);
    }
    for (const color of [PALETTES.dark.panel, PALETTES.dark.bandA, PALETTES.dark.ink, PALETTES.dark.muted]) {
      expect(fills).not.toContain(color);
    }
  });
});
