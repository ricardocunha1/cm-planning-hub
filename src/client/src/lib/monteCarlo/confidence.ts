import type { Theme } from "../themePreference";

// Mirrors the CM palette CSS custom properties in index.css — duplicated as
// literals because Plotly's config needs real color strings.
export const CONFIDENCE_COLORS: Record<number, string> = {
  50: "#60C5B5", // --cm-teal
  70: "#EBC160", // --cm-gold
  85: "#D8804B", // --cm-orange
  95: "#B64234", // --cm-red
};

const FALLBACK_COLOR = "#4E98D1"; // --cm-light-blue

/**
 * Confidence colors for *text* (P-card labels and counts, chart annotations), per theme. Dark uses the
 * brand colors; light uses darker shades of them that reach 4.5:1 on white. Borders, dashed lines and
 * calendar cells keep the brand colors ({@link confidenceColor}).
 */
export const CONFIDENCE_TEXT_COLORS: Record<Theme, Record<number, string>> = {
  dark: CONFIDENCE_COLORS,
  light: {
    50: "#1D7A6B", // 5.19:1 on white
    70: "#8A6514", // 5.31:1
    85: "#A4531F", // 5.48:1
    95: "#B64234", // 5.50:1 (the brand red already passes)
  },
};

const FALLBACK_TEXT_COLORS: Record<Theme, string> = { dark: FALLBACK_COLOR, light: "#1F68A0" };

export const MAX_SPRINT_WINDOW = 50;
export const OVERFLOW_LABEL = `>${MAX_SPRINT_WINDOW}`;

/** Brand color of a confidence level, for fills, borders and lines (same in both themes). */
export function confidenceColor(level: number): string {
  return CONFIDENCE_COLORS[level] ?? FALLBACK_COLOR;
}

/** Readable text color of a confidence level in `theme`. */
export function confidenceTextColor(level: number, theme: Theme): string {
  return CONFIDENCE_TEXT_COLORS[theme][level] ?? FALLBACK_TEXT_COLORS[theme];
}
