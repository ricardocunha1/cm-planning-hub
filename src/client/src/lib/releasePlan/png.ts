/**
 * PNG export of the board: a canvas port of the template's `exportPng` (see
 * *Template reference → Export PNG* in `plans/release-plan-import-export.md`).
 * Pure apart from the calls on the 2D context it is given.
 */
import { ADO, type BoardPalette, DEFAULT_STATE_COLOR, L, LF, OK_GREEN, PALETTES, sizeColor, STATE_COLORS } from "./constants";
import type { AnyBoardLayout, BoardLayout, FlippedLayout } from "./layout";
import { epicMetaText, epicMsLabel, featuresInBand, fmtDate, isDone, sizeCounts } from "./selectors";
import type { Band, Feature, ReleasePlan } from "./types";

/** Height of the navy header strip above the board, in unscaled px. */
export const PNG_HEAD = 64;
/** Largest canvas side, in device px. */
export const PNG_MAX_SIDE = 16384;
/** Largest canvas area, in device px (Safari's limit). */
export const PNG_MAX_AREA = 16_777_216;
/** Preferred export scale (crisp on high-DPI screens). */
export const PNG_SCALE = 2;

const F = '"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif';
const LOGO_H = 40;
const LOGO_PAD = 6;

/**
 * The subset of `CanvasRenderingContext2D` used by the PNG drawing, so tests
 * can pass a recording mock (jsdom has no canvas).
 */
export interface PngContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

/** A loaded logo image and its natural size. */
export interface PngLogo {
  image: CanvasImageSource;
  width: number;
  height: number;
}

/** Options of {@link drawBoardPng}. */
export interface DrawBoardPngOptions {
  /** Device px per layout px (see {@link pngScale}). */
  scale: number;
  /** Export date shown in the header subtitle. */
  now: Date;
  /** CM logo drawn on a white plate at the top right; `null` = no logo. */
  logo: PngLogo | null;
  /** Board colors, normally `PALETTES[theme]` for the active theme; defaults to the dark palette. */
  palette?: BoardPalette;
}

/**
 * Largest scale ≤ {@link PNG_SCALE} so that a `width × height` image (height
 * including {@link PNG_HEAD}) fits {@link PNG_MAX_SIDE} per side and
 * {@link PNG_MAX_AREA} in area; `null` when that scale is below 1 (too large).
 */
export function pngScale(width: number, height: number): number | null {
  const s = Math.min(PNG_SCALE, PNG_MAX_SIDE / width, PNG_MAX_SIDE / height, Math.sqrt(PNG_MAX_AREA / (width * height)));
  return s >= 1 ? s : null;
}

/** Builds a rounded-rectangle path (via `arcTo`); the caller fills it. */
export function rr(ctx: PngContext, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws `text` word-wrapped to `maxW` (greedy, by `measureText`), one line per
 * `lineH` from `y`. Beyond `maxLines` the last kept line is shortened until it
 * fits with a trailing "…". Returns the drawn lines.
 */
export function wrap(ctx: PngContext, text: string, x: number, y: number, maxW: number, lineH: number, maxLines: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxW) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineH));
  return lines;
}

/** The flag icon (pole + pennant), 12×14 px from `(x, y)`, in `color`. */
export function drawFlagIcon(ctx: PngContext, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1.8, 14);
  ctx.beginPath();
  ctx.moveTo(x + 1.8, y + 1);
  ctx.lineTo(x + 12, y + 1);
  ctx.lineTo(x + 9.5, y + 5);
  ctx.lineTo(x + 12, y + 9);
  ctx.lineTo(x + 1.8, y + 9);
  ctx.closePath();
  ctx.fill();
}

function shadowCard(ctx: PngContext, x: number, y: number, w: number, h: number, r: number, color: string): void {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.18)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = color;
  rr(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();
}

function circle(ctx: PngContext, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawHeader(ctx: PngContext, p: BoardPalette, plan: ReleasePlan, width: number, now: Date, logo: PngLogo | null): void {
  ctx.fillStyle = p.navy;
  ctx.fillRect(0, 0, width, PNG_HEAD);
  ctx.fillStyle = "#fff";
  ctx.font = `600 20px ${F}`;
  ctx.fillText(plan.name, 18, 12);
  ctx.fillStyle = "rgba(255,255,255,.75)";
  ctx.font = `12px ${F}`;
  const date = now.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  ctx.fillText(`Exported ${date} · ${plan.source.system || "Manual"}`, 18, 38);
  if (logo && logo.width > 0 && logo.height > 0) {
    const lw = (logo.width * LOGO_H) / logo.height;
    const lx = width - lw - 18 - LOGO_PAD;
    const ly = (PNG_HEAD - LOGO_H) / 2;
    ctx.fillStyle = "#fff";
    rr(ctx, lx - LOGO_PAD, ly - LOGO_PAD, lw + 2 * LOGO_PAD, LOGO_H + 2 * LOGO_PAD, 6);
    ctx.fill();
    ctx.drawImage(logo.image, lx, ly, lw, LOGO_H);
  }
}

function bandFill(p: BoardPalette, unplanned: boolean, i: number): string {
  return unplanned ? p.unplanned : i % 2 ? p.bandB : p.bandA;
}

/** A band label (color bar, name, date, count, size chips) in the `labelW`-wide box at `(ox, oy)`. */
function drawBandLabel(ctx: PngContext, p: BoardPalette, plan: ReleasePlan, band: Band, ox: number, oy: number, labelW: number): void {
  ctx.fillStyle = band.unplanned ? p.gold : band.milestone.color;
  rr(ctx, ox + 10, oy + 12, 4, 40, 2);
  ctx.fill();

  ctx.fillStyle = p.ink;
  ctx.font = `700 15px ${F}`;
  wrap(ctx, band.name, ox + 22, oy + 12, labelW - 30, 18, 2);

  const features = featuresInBand(plan, band.id);
  ctx.fillStyle = p.muted;
  ctx.font = `12px ${F}`;
  ctx.fillText(band.unplanned ? "Not assigned" : fmtDate(band.milestone.date) || "No date", ox + 22, oy + 50);
  ctx.fillText(`${features.length} Features`, ox + 22, oy + 66);

  ctx.font = `700 11px ${F}`;
  let cx = ox + 22;
  let cy = oy + 84;
  for (const [key, n] of sizeCounts(features)) {
    const text = `${key} ${n}`;
    const w = ctx.measureText(text).width + 14;
    if (cx + w > ox + labelW - 8) {
      cx = ox + 22;
      cy += 20;
    }
    const color = sizeColor(key);
    ctx.fillStyle = color.bg;
    rr(ctx, cx, cy, w, 17, 8.5);
    ctx.fill();
    ctx.fillStyle = color.ink;
    ctx.fillText(text, cx + 7, cy + 3);
    cx += w + 4;
  }
}

function drawBands(ctx: PngContext, p: BoardPalette, plan: ReleasePlan, layout: BoardLayout): void {
  layout.bands.forEach(({ band, y, h }, i) => {
    ctx.fillStyle = bandFill(p, band.unplanned, i);
    ctx.fillRect(0, y, layout.width, h);
    ctx.fillStyle = p.bandLine;
    ctx.fillRect(0, y, layout.width, 1);
    ctx.fillStyle = p.line;
    ctx.fillRect(L.LBL_W, y, 1, h);
    drawBandLabel(ctx, p, plan, band, 0, y, L.LBL_W);
  });
}

function drawEpics(ctx: PngContext, p: BoardPalette, plan: ReleasePlan, layout: BoardLayout): void {
  for (const { epic, x, w } of layout.epics) {
    ctx.fillStyle = p.epicbg;
    rr(ctx, x, layout.bandY0 - 4, w, layout.height - layout.bandY0 - 8, 8);
    ctx.fill();
    shadowCard(ctx, x, L.TOP, w, L.EPIC_H, 6, ADO.epic.color);
    ctx.textAlign = "center";
    ctx.fillStyle = ADO.epic.ink;
    ctx.font = `700 15px ${F}`;
    wrap(ctx, epic.title, x + w / 2, L.TOP + 8, w - 20, 18, 1);
    ctx.font = `11px ${F}`;
    ctx.globalAlpha = 0.75;
    ctx.fillText(epicMetaText(epic, epicMsLabel(plan, epic)), x + w / 2, L.TOP + 28);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }
}

function drawFeatureCard(ctx: PngContext, feature: Feature, x: number, y: number): void {
  shadowCard(ctx, x, y, L.COL_W, L.CARD_H, 4, ADO.feature.color);
  if (isDone(feature)) {
    circle(ctx, x + 12, y + 12, 7, OK_GREEN);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 8.5, y + 12);
    ctx.lineTo(x + 11, y + 14.5);
    ctx.lineTo(x + 15.5, y + 9.5);
    ctx.stroke();
  } else {
    circle(ctx, x + 11, y + 12, 5.5, "rgba(255,255,255,.9)");
    circle(ctx, x + 11, y + 12, 4, STATE_COLORS[feature.state] ?? DEFAULT_STATE_COLOR);
  }
  ctx.fillStyle = "#fff";
  ctx.globalAlpha = 0.85;
  ctx.font = `10.5px ${F}`;
  ctx.fillText(`Feature #${feature.id}`, x + 22, y + 6);
  ctx.globalAlpha = 1;

  ctx.font = `700 11px ${F}`;
  const label = feature.size || "?";
  const sw = ctx.measureText(label).width + 12;
  ctx.fillStyle = feature.size ? "#fff" : "rgba(255,255,255,.35)";
  rr(ctx, x + L.COL_W - sw - 6, y + 4, sw, 16, 8);
  ctx.fill();
  ctx.fillStyle = feature.size ? "#4a1f60" : "#fff";
  ctx.fillText(label, x + L.COL_W - sw, y + 6);

  ctx.fillStyle = "#fff";
  ctx.font = `600 12.5px ${F}`;
  wrap(ctx, feature.title, x + 7, y + 25, L.COL_W - 14, 15.5, 3);
}

function drawCards(ctx: PngContext, layout: BoardLayout): void {
  const bandY = new Map(layout.bands.map((b) => [b.band.id, b.y]));
  for (const { cols } of layout.epics) {
    for (const { feature, x } of cols) {
      const top = bandY.get(feature.milestoneId ?? null) ?? bandY.get(null);
      if (top !== undefined) {
        drawFeatureCard(ctx, feature, x, top + L.BAND_PAD);
      }
    }
  }
}

function drawFlags(ctx: PngContext, p: BoardPalette, layout: BoardLayout): void {
  for (const { flag, y, h } of layout.flags) {
    const cy = y + h / 2;
    const label = flag.name + (flag.date ? ` · ${fmtDate(flag.date)}` : "");
    ctx.fillStyle = p.gold;
    for (let x: number = L.LBL_W; x < layout.width; x += 20) {
      ctx.fillRect(x, cy - 1.5, 14, 3);
    }
    rr(ctx, 0, y + 4, L.LBL_W - 14, h - 8, 6);
    ctx.fill();
    drawFlagIcon(ctx, 10, cy - 7, p.flagInk);
    ctx.font = `700 12px ${F}`;
    wrap(ctx, flag.name, 28, cy - 7, L.LBL_W - 46, 14, 1);

    ctx.font = `700 11px ${F}`;
    const tw = ctx.measureText(label).width + 30;
    ctx.fillStyle = p.gold;
    rr(ctx, L.LEFT + 6, cy - 10, tw, 20, 10);
    ctx.fill();
    drawFlagIcon(ctx, L.LEFT + 14, cy - 6, p.flagInk);
    ctx.fillText(label, L.LEFT + 30, cy - 6);
  }
}

/** Flipped board: full-height milestone columns, their labels in the header row and the header divider. */
function drawColumns(ctx: PngContext, p: BoardPalette, plan: ReleasePlan, layout: FlippedLayout): void {
  layout.columns.forEach(({ band, x, w }, i) => {
    ctx.fillStyle = bandFill(p, band.unplanned, i);
    ctx.fillRect(x, 0, w, layout.height);
    ctx.fillStyle = p.bandLine;
    ctx.fillRect(x, 0, 1, layout.height);
    drawBandLabel(ctx, p, plan, band, x, 0, w);
  });
  ctx.fillStyle = p.line;
  ctx.fillRect(0, layout.headH, layout.width, 1);
}

/** Flipped board: Epic group backgrounds and the Epic header blocks on the left. */
function drawFlippedEpics(ctx: PngContext, p: BoardPalette, plan: ReleasePlan, layout: FlippedLayout): void {
  for (const { epic, y, h } of layout.epics) {
    ctx.fillStyle = p.epicbg;
    rr(ctx, layout.colX0 - 4, y, layout.width - layout.colX0 - 8, h, 8);
    ctx.fill();
    shadowCard(ctx, LF.LEFT, y, LF.EPIC_W, h, 6, ADO.epic.color);
    const cx = LF.LEFT + LF.EPIC_W / 2;
    ctx.textAlign = "center";
    ctx.fillStyle = ADO.epic.ink;
    ctx.font = `700 15px ${F}`;
    wrap(ctx, epic.title, cx, y + h / 2 - 24, LF.EPIC_W - 20, 18, 2);
    ctx.font = `11px ${F}`;
    ctx.globalAlpha = 0.75;
    ctx.fillText(epicMetaText(epic, epicMsLabel(plan, epic)), cx, y + h / 2 + 14);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  }
}

/** Flipped board: one card per Feature, in its row and its milestone's column. */
function drawFlippedCards(ctx: PngContext, layout: FlippedLayout): void {
  const colX = new Map(layout.columns.map((c) => [c.band.id, c.x]));
  for (const { rows } of layout.epics) {
    for (const { feature, y } of rows) {
      const left = colX.get(feature.milestoneId ?? null) ?? colX.get(null);
      if (left !== undefined) {
        drawFeatureCard(ctx, feature, left + L.BAND_PAD, y);
      }
    }
  }
}

/**
 * Flipped board flags: a vertical dashed gold line below the header, the flag
 * label in the header and the tag at the top of the rows, both rotated -90°.
 */
function drawFlippedFlags(ctx: PngContext, p: BoardPalette, layout: FlippedLayout): void {
  const lw = layout.headH - 14;
  const lh = L.FLAG_H - 8;
  for (const { flag, x, w } of layout.flags) {
    const cx = x + w / 2;
    const label = flag.name + (flag.date ? ` · ${fmtDate(flag.date)}` : "");
    ctx.fillStyle = p.gold;
    for (let y: number = layout.headH; y < layout.height; y += 20) {
      ctx.fillRect(cx - 1.5, y, 3, 14);
    }

    ctx.save();
    ctx.translate(cx, lw / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = p.gold;
    rr(ctx, -lw / 2, -lh / 2, lw, lh, 6);
    ctx.fill();
    drawFlagIcon(ctx, -lw / 2 + 10, -7, p.flagInk);
    ctx.font = `700 12px ${F}`;
    wrap(ctx, flag.name, -lw / 2 + 28, -7, lw - 46, 14, 1);
    ctx.restore();

    ctx.font = `700 11px ${F}`;
    const tw = ctx.measureText(label).width + 30;
    ctx.save();
    ctx.translate(cx, LF.TOP + 6 + tw / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = p.gold;
    rr(ctx, -tw / 2, -10, tw, 20, 10);
    ctx.fill();
    drawFlagIcon(ctx, -tw / 2 + 8, -6, p.flagInk);
    ctx.fillText(label, -tw / 2 + 24, -6);
    ctx.restore();
  }
}

/**
 * Draws the whole PNG (header strip with name, export date, source and logo,
 * then the board: bands, epics, feature cards, flags) from `layout`, in layout
 * px scaled by `scale`. The canvas must be `layout.width × (layout.height +
 * PNG_HEAD)` times `scale`. Selection, drag highlights, "+" buttons and zoom
 * are not drawn. A flipped `layout` is drawn transposed (milestone columns with
 * their labels in the top header row, Epic groups of Feature rows, vertical
 * flag lines). Neutral colors come from `palette`, so the image matches the
 * active theme.
 */
export function drawBoardPng(
  ctx: PngContext,
  plan: ReleasePlan,
  layout: AnyBoardLayout,
  { scale, now, logo, palette = PALETTES.dark }: DrawBoardPngOptions,
): void {
  const p = palette;
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = p.panel;
  ctx.fillRect(0, 0, layout.width, layout.height + PNG_HEAD);
  drawHeader(ctx, p, plan, layout.width, now, logo);
  ctx.translate(0, PNG_HEAD);
  if (layout.orientation === "flipped") {
    drawColumns(ctx, p, plan, layout);
    drawFlippedEpics(ctx, p, plan, layout);
    drawFlippedCards(ctx, layout);
    drawFlippedFlags(ctx, p, layout);
    return;
  }
  drawBands(ctx, p, plan, layout);
  drawEpics(ctx, p, plan, layout);
  drawCards(ctx, layout);
  drawFlags(ctx, p, layout);
}
