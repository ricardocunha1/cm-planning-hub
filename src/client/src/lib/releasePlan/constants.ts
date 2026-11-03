/** Constants of the Feature release plan board (ported from the template, see the plan's Template reference). */

/** `schema` value of a Feature release plan file; `version` written for new plans. */
export const SCHEMA = "release-planner-features";
export const VERSION = 1;

/** localStorage key of the last successful Azure DevOps connection (`lib/ado/connectionStorage.ts`; never a PAT). */
export const ADO_CONNECTION_KEY = "cmPlanningHub.releasePlan.adoConnection.v1";

/** Fallback when a plan name is empty. */
export const DEFAULT_PLAN_NAME = "Feature Release Plan";
/** Fallback when a milestone or flag name is empty; also the name of a new flag. */
export const DEFAULT_MILESTONE_NAME = "Milestone";

/** Known T-shirt sizes, in display order. */
export const SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;

export interface ChipColor {
  bg: string;
  ink: string;
}

/** T-shirt size chip colors; `"?"` is "not estimated" and the fallback for unknown sizes. */
export const SIZE_COLORS: Readonly<Record<string, ChipColor>> = {
  XS: { bg: "#22A06B", ink: "#fff" },
  S: { bg: "#8BC34A", ink: "#1d3008" },
  M: { bg: "#EBC160", ink: "#3a2a05" },
  L: { bg: "#D8804B", ink: "#fff" },
  XL: { bg: "#B64234", ink: "#fff" },
  XXL: { bg: "#7A1F16", ink: "#fff" },
  "?": { bg: "#98A2B3", ink: "#fff" },
};

/** Chip colors for a size key, falling back to `"?"`. */
export function sizeColor(key: string): ChipColor {
  return SIZE_COLORS[key] ?? SIZE_COLORS["?"];
}

/** States shown with the green ✓ (case-sensitive). */
export const DONE_STATES: readonly string[] = ["Resolved", "Done", "Closed"];

/** Color of the done ✓ mark. */
export const OK_GREEN = "#22A06B";
/** State dot color for any state not in `STATE_COLORS`. */
export const DEFAULT_STATE_COLOR = "#C7D2E0";

/** State dot colors by ADO state. */
export const STATE_COLORS: Readonly<Record<string, string>> = {
  New: "#C7D2E0",
  Active: "#274B76",
  Resolved: OK_GREEN,
  Done: OK_GREEN,
  Closed: OK_GREEN,
};

/** Milestone palette, in order. */
export const MS_COLORS: readonly string[] = ["#4E98D1", "#60C5B5", "#EBC160", "#D8804B", "#B64234", "#802D6C", "#0362A4", "#274B76"];

/** Azure DevOps work item colors. */
export const ADO = {
  epic: { color: "#FF7B00", ink: "#1a1206" },
  feature: { color: "#773B93", ink: "#fff" },
  /** Drag ghost (Phase 2). */
  story: { color: "#009CCC", ink: "#04212e" },
} as const;

/**
 * Dark board palette, for drawing outside the DOM (the PNG export). Mirrors the
 * `--navy`, `--panel`, `--ink`, `--muted`, `--line`, `--band-a`, `--band-b`,
 * `--band-line`, `--unplanned`, `--epicbg` and `--gold` variables at the top of
 * `releasePlan.css`; keep both in sync. `flagInk` is the flag chip text color.
 */
export const PALETTE = {
  navy: "#274B76",
  panel: "#152A47",
  ink: "#E9EFF7",
  muted: "#9FB3CC",
  line: "#2A4A73",
  bandA: "#12243D",
  bandB: "#172C4A",
  bandLine: "#2F5180",
  unplanned: "#2A2617",
  epicbg: "rgba(255,255,255,.035)",
  gold: "#EBC160",
  flagInk: "#3a2a05",
} as const;

/** Board geometry, in unscaled px. */
export const L = {
  FLAG_H: 34,
  LBL_W: 180,
  LEFT: 196,
  TOP: 12,
  EPIC_H: 48,
  GAP_H: 14,
  COL_W: 160,
  COL_GAP: 8,
  EPIC_PAD: 10,
  EPIC_GAP: 18,
  CARD_H: 84,
  BAND_PAD: 10,
  BAND_MIN: 158,
  RIGHT: 24,
} as const;

/**
 * Geometry of the flipped board (milestones as columns, Epic/Feature rows), in
 * unscaled px; the standard {@link L} values are reused where they transpose.
 * `HEAD_H` is the frozen milestone header row (= the standard band height),
 * `EPIC_W` the Epic header block on the left of each group, `LEFT` its left
 * margin, `GAP_W` the space before the first column, `TOP` the first Epic row
 * (`HEAD_H + 16`, like the standard `LEFT - LBL_W`), `COL_MIN` the minimum
 * column width (= `LBL_W`), `BOTTOM` the bottom margin and `MIN_W`/`MIN_H` the
 * minimum board size.
 */
export const LF = {
  HEAD_H: 158,
  EPIC_W: 200,
  LEFT: 12,
  GAP_W: 14,
  TOP: 174,
  COL_MIN: 180,
  BOTTOM: 24,
  MIN_W: 700,
  MIN_H: 360,
} as const;

/** Zoom bounds and step. */
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.1;

/** Flag icon path (viewBox 0 0 24 24). */
export const FLAG_PATH = "M5 22V3h1.8v1H19l-2.6 4.5L19 13H6.8v9z";

/** Random id with a prefix (`ms_`, `fl_`), as in the template. */
export function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 9);
}

/** Id generator signature, injectable for deterministic tests. */
export type IdFactory = (prefix: string) => string;
