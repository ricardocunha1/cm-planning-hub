// QA cross-file consistency tests for the light/dark theme (plans/light-theme.md, Phase 2).
// The theme lives in several hand-synchronised places: the pre-render script in index.html vs
// lib/themePreference.ts, the --ui-* tokens in index.css vs tailwind.config.js and the original Tailwind slate
// shades, the Release Plan board variables in releasePlan.css vs PALETTES (PNG export), and CHART_COLORS vs the
// panel tokens. These tests read the real sources (Vite ?raw) and check that they agree, and that text keeps
// readable contrast in the light theme.
import colors from "tailwindcss/colors";
import { afterEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import tailwindConfig from "../tailwind.config.js?raw";
import { CHART_COLORS } from "./components/monteCarlo/HistogramChart";
import { CONFIDENCE_COLORS, CONFIDENCE_TEXT_COLORS, confidenceColor, confidenceTextColor } from "./lib/monteCarlo/confidence";
import { MS_COLORS, PALETTE, PALETTES, type BoardPalette } from "./lib/releasePlan/constants";
import { appliedTheme, LIGHT_SCHEME_QUERY, resolveTheme, THEME_KEY, type Theme } from "./lib/themePreference";
import { readSource } from "./test/readSource";
import { resetTheme, stubMatchMedia } from "./test/theme";

// CSS must be read from disk: with `css: false` a `?raw` CSS import is empty.
const indexCss = readSource("../index.css");
const releasePlanCss = readSource("../components/releasePlan/releasePlan.css");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTheme();
});

// ---------- helpers ----------

function preRenderScript(): string {
  const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts).toHaveLength(1);
  return scripts[0];
}

function runPreRenderScript(): Theme | null {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  new Function(preRenderScript())();
  return appliedTheme();
}

/** Custom properties declared in the first CSS block whose selector list is exactly `selector`. */
function cssVars(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const block = new RegExp(`(?:^|\\})\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  if (!block) {
    throw new Error(`block ${selector} not found`);
  }
  const vars: Record<string, string> = {};
  for (const m of block[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

const channels = (value: string): Rgb => value.split(/\s+/).map(Number) as Rgb;
const rgbHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `fg` with `alpha` composited over `bg`. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as Rgb;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------- index.html pre-render script vs themePreference ----------

describe("index.html pre-render script agrees with lib/themePreference", () => {
  it("uses the same storage key and media query", () => {
    const script = preRenderScript();
    expect(script).toContain(`"${THEME_KEY}"`);
    expect(script).toContain(`"${LIGHT_SCHEME_QUERY}"`);
  });

  it("the body no longer hard-codes the dark slate classes", () => {
    const body = /<body([^>]*)>/.exec(indexHtml)?.[1] ?? "";
    expect(body).not.toMatch(/slate-/);
    expect(body).toMatch(/\bbg-canvas\b/);
    expect(body).toMatch(/\btext-fg\b/);
  });

  const stored = [null, "light", "dark", "sepia"] as const;
  const os = ["light", "dark", "unsupported", "throws"] as const;
  const cases = stored.flatMap((s) => os.map((o) => [s, o] as const));

  it.each(cases)("stored=%s, OS=%s: same theme as resolveTheme()", (storedValue, osPreference) => {
    if (storedValue !== null) {
      window.localStorage.setItem(THEME_KEY, storedValue);
    }
    if (osPreference === "light" || osPreference === "dark") {
      stubMatchMedia(osPreference === "light");
    } else if (osPreference === "throws") {
      vi.stubGlobal("matchMedia", () => {
        throw new Error("matchMedia blocked");
      });
    }
    const fromScript = runPreRenderScript();
    expect(document.documentElement.style.colorScheme).toBe(fromScript);
    resetTheme();
    if (storedValue !== null) {
      window.localStorage.setItem(THEME_KEY, storedValue);
    }
    expect(fromScript).toBe(resolveTheme());
  });

  it.each([true, false])("localStorage throwing (blocked storage), OS prefers light=%s: same theme as resolveTheme()", (prefersLight) => {
    stubMatchMedia(prefersLight);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    // Spec (plans/light-theme.md, Key decisions): with no explicit choice, the first visit follows the OS.
    expect(resolveTheme()).toBe(prefersLight ? "light" : "dark");
    expect(runPreRenderScript()).toBe(resolveTheme());
  });
});

// ---------- index.css tokens ----------

describe("index.css theme tokens", () => {
  const dark = cssVars(indexCss, ':root,\n[data-theme="dark"]');
  const light = cssVars(indexCss, '[data-theme="light"]');

  /** The Tailwind classes the app hard-coded before the theme work, per token (plans/light-theme.md: dark unchanged). */
  const ORIGINAL: Record<string, string> = {
    "ui-canvas": colors.slate[950],
    "ui-surface": colors.slate[900],
    "ui-surface-raised": colors.slate[800],
    "ui-surface-overlay": colors.slate[700],
    "ui-surface-strong": colors.slate[600],
    "ui-line": colors.slate[800],
    "ui-line-strong": colors.slate[700],
    "ui-line-bold": colors.slate[600],
    "ui-fg": colors.slate[100],
    "ui-fg-soft": colors.slate[200],
    "ui-fg-muted": colors.slate[300],
    "ui-fg-subtle": colors.slate[400],
    "ui-fg-faint": colors.slate[500],
    "ui-fg-dim": colors.slate[600],
    "ui-accent-blue": "#4e98d1",
    "ui-accent-teal": "#60c5b5",
    "ui-danger": colors.red[400],
  };

  it("dark values are exactly the original slate shades / brand colors", () => {
    const actual = Object.fromEntries(Object.entries(dark).map(([k, v]) => [k, rgbHex(channels(v))]));
    expect(actual).toEqual(Object.fromEntries(Object.entries(ORIGINAL).map(([k, v]) => [k, v.toLowerCase()])));
  });

  it("the brand accents match the --cm-* brand colors", () => {
    const cm = cssVars(indexCss, ":root");
    expect(rgbHex(channels(dark["ui-accent-blue"]))).toBe(cm["cm-light-blue"].toLowerCase());
    expect(rgbHex(channels(dark["ui-accent-teal"]))).toBe(cm["cm-teal"].toLowerCase());
  });

  it("the light theme overrides every token, and every Tailwind ui() token is defined", () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    const used = [...tailwindConfig.matchAll(/ui\("([\w-]+)"\)/g)].map((m) => `ui-${m[1]}`);
    expect(used.length).toBeGreaterThan(0);
    for (const token of used) {
      expect(dark).toHaveProperty(token);
    }
  });

  it("light text tokens are readable on the light surfaces (WCAG AA 4.5:1)", () => {
    const L = (name: string) => channels(light[name]);
    const surfaces = ["ui-surface", "ui-canvas"];
    const report: Record<string, number> = {};
    for (const fg of ["ui-fg", "ui-fg-soft", "ui-fg-muted", "ui-fg-subtle", "ui-fg-faint", "ui-accent-blue", "ui-danger"]) {
      for (const bg of surfaces) {
        report[`${fg} on ${bg}`] = round2(contrast(L(fg), L(bg)));
      }
    }
    report["ui-accent-teal on ui-surface-raised"] = round2(contrast(L("ui-accent-teal"), L("ui-surface-raised")));
    for (const [pair, ratio] of Object.entries(report)) {
      expect({ pair, ok: ratio >= 4.5 }).toEqual({ pair, ok: true });
    }
  });

  it("CHART_COLORS match the panel the chart sits in (bg-surface, text-fg-soft) in both themes", () => {
    expect(CHART_COLORS.dark).toEqual({ background: rgbHex(channels(dark["ui-surface"])), font: rgbHex(channels(dark["ui-fg-soft"])) });
    expect(CHART_COLORS.light).toEqual({ background: rgbHex(channels(light["ui-surface"])), font: rgbHex(channels(light["ui-fg-soft"])) });
  });
});

// ---------- Release Plan board ----------

describe("releasePlan.css board variables agree with PALETTES (PNG export)", () => {
  const darkCss = cssVars(releasePlanCss, ".rp");
  const lightCss = { ...darkCss, ...cssVars(releasePlanCss, '[data-theme="light"] .rp') };
  const VAR: Record<Exclude<keyof BoardPalette, "flagInk">, string> = {
    navy: "navy",
    panel: "panel",
    ink: "ink",
    muted: "muted",
    line: "line",
    bandA: "band-a",
    bandB: "band-b",
    bandLine: "band-line",
    unplanned: "unplanned",
    epicbg: "epicbg",
    gold: "gold",
  };
  const norm = (v: string) => v.replace(/\s+/g, "").toLowerCase();

  it.each([
    ["dark", darkCss],
    ["light", lightCss],
  ] as const)("%s palette mirrors the CSS variables", (theme, vars) => {
    for (const [key, name] of Object.entries(VAR)) {
      expect({ key, value: norm(PALETTES[theme][key as keyof BoardPalette]) }).toEqual({ key, value: norm(vars[name]) });
    }
  });

  it("the dark palette is unchanged (PALETTE alias) and the flag ink is the CSS flag text color", () => {
    expect(PALETTE).toBe(PALETTES.dark);
    expect(releasePlanCss).toMatch(new RegExp(`\\.rp \\.flagchip \\{[^}]*color: ${PALETTES.dark.flagInk}`, "i"));
    expect(PALETTES.light.flagInk).toBe(PALETTES.dark.flagInk);
  });

  it("light board text is readable on the light board surfaces (4.5:1)", () => {
    const v = (name: string) => hexToRgb(lightCss[name]);
    for (const fg of ["ink", "muted", "link"]) {
      for (const bg of ["panel", "panel2", "band-a", "band-b", "unplanned", "bg"]) {
        const ratio = round2(contrast(v(fg), v(bg)));
        expect({ pair: `${fg} on ${bg}`, ok: ratio >= 4.5 }).toEqual({ pair: `${fg} on ${bg}`, ok: true });
      }
    }
  });

  it("selected tabs / pressed Flip use a legible --sel-bg/--sel-ink pair in both themes", () => {
    const resolve = (vars: Record<string, string>, value: string) => {
      const ref = /var\(--([\w-]+)\)/.exec(value);
      return hexToRgb(ref ? vars[ref[1]] : value);
    };
    for (const vars of [darkCss, lightCss]) {
      expect(contrast(resolve(vars, vars["sel-bg"]), resolve(vars, vars["sel-ink"]))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("light milestone chips (color-mix 55% with black on color+2e over the panel) are readable for every default milestone color", () => {
    expect(releasePlanCss).toMatch(/\[data-theme="light"\] \.rp \.chip \{ color: color-mix\(in srgb, var\(--chip-c\) 55%, #000\); \}/);
    const panel = hexToRgb(lightCss.panel);
    for (const color of MS_COLORS) {
      const c = hexToRgb(color);
      const text = c.map((x) => Math.round(x * 0.55)) as Rgb;
      const bg = over(c, 0x2e / 255, panel);
      const ratio = round2(contrast(text, bg));
      expect({ color, ok: ratio >= 4.5 }).toEqual({ color, ok: true });
    }
  });
});

// ---------- Monte Carlo results ----------

describe("Monte Carlo results colored text in the light theme", () => {
  // ResultsPage renders "P<n> - <label>" (text-sm) and the sprint count (text-2xl) in confidenceTextColor() on the
  // bg-surface card; HistogramChart draws the P-labels in the same colors on CHART_COLORS[theme].background.
  // Key decisions: text must keep sufficient contrast in both themes. The label is small text, so AA 4.5:1.
  // That the page and the chart really use these colors is covered in Theme.integration.test.tsx.
  const light = cssVars(indexCss, '[data-theme="light"]');
  const dark = cssVars(indexCss, ':root,\n[data-theme="dark"]');

  it.each(Object.keys(CONFIDENCE_COLORS).map(Number))("P%s light text color is readable on the light card and chart (4.5:1)", (level) => {
    const color = confidenceTextColor(level, "light");
    for (const bg of [channels(light["ui-surface"]), hexToRgb(CHART_COLORS.light.background)]) {
      expect(round2(contrast(hexToRgb(color), bg)), `P${level} ${color} contrast ratio`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("covers every confidence level the server returns (50/70/85/95) in both themes, and the fallback is readable too", () => {
    expect(Object.keys(CONFIDENCE_TEXT_COLORS.light).sort()).toEqual(Object.keys(CONFIDENCE_COLORS).sort());
    const fallback = confidenceTextColor(99, "light");
    expect(contrast(hexToRgb(fallback), channels(light["ui-surface"]))).toBeGreaterThanOrEqual(4.5);
  });

  it("dark mode is unchanged: text colors are the brand colors, and fills/lines stay brand in both themes", () => {
    for (const level of [50, 70, 85, 95, 99]) {
      expect(confidenceTextColor(level, "dark")).toBe(confidenceColor(level));
    }
    expect(CONFIDENCE_COLORS).toEqual({ 50: "#60C5B5", 70: "#EBC160", 85: "#D8804B", 95: "#B64234" });
    expect(confidenceColor(99)).toBe("#4E98D1");
  });

  it.each(Object.entries(CONFIDENCE_COLORS))("P%s brand color is readable on the dark card (baseline)", (level, color) => {
    const ratio = round2(contrast(hexToRgb(color), channels(dark["ui-surface"])));
    expect(ratio, `P${level} ${color} contrast ratio`).toBeGreaterThanOrEqual(3);
  });
});

describe("Release Plan drop/selection indicator", () => {
  const darkCss = cssVars(releasePlanCss, ".rp");
  const lightCss = { ...darkCss, ...cssVars(releasePlanCss, '[data-theme="light"] .rp') };

  it("is unchanged (gold) in dark mode and visible (3:1) on every light board surface", () => {
    expect(darkCss["drop-gold"]).toBe("var(--gold)");
    const gold = hexToRgb(lightCss["drop-gold"]);
    for (const bg of ["panel", "band-a", "band-b", "unplanned", "bg"]) {
      expect(round2(contrast(gold, hexToRgb(lightCss[bg]))), `--drop-gold on --${bg}`).toBeGreaterThanOrEqual(3);
    }
    for (const rule of [".rp .cell.dropL", ".rp .cell.dropR", ".rp .cell.dropT", ".rp .cell.dropB", ".rp .fcard.selected"]) {
      const body = new RegExp(`${rule.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(releasePlanCss)?.[1] ?? "";
      expect({ rule, usesDropGold: body.includes("var(--drop-gold)") }).toEqual({ rule, usesDropGold: true });
    }
  });
});
