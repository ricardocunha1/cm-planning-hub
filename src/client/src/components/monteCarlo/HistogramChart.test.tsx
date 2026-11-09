import { act, render, screen } from "@testing-library/react";
import type { Layout } from "plotly.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIDENCE_COLORS, CONFIDENCE_TEXT_COLORS } from "../../lib/monteCarlo/confidence";
import type { Histogram, ResultRow } from "../../lib/monteCarlo/types";
import { applyTheme } from "../../lib/themePreference";
import { resetTheme } from "../../test/theme";
import { setTheme } from "../../themeStore";
import HistogramChart, { CHART_COLORS } from "./HistogramChart";

const layouts: Partial<Layout>[] = [];

vi.mock("plotly.js-basic-dist-min", () => ({ default: {} }));
vi.mock("react-plotly.js/factory", () => ({
  default: () =>
    function PlotStub({ layout }: { layout: Partial<Layout> }) {
      layouts.push(layout);
      return <div data-testid="plot" />;
    },
}));

const histogram: Histogram = { labels: ["1", "2", ">50"], counts: [3, 5, 1] };
const rows: ResultRow[] = [
  { confidence: 50, label: "Likely", sprints: 2, completion_date: "2026-12-01", exceeds_window: false },
  { confidence: 95, label: "Almost certain", sprints: 51, completion_date: null, exceeds_window: true },
];

function lastLayout(): Partial<Layout> {
  const layout = layouts.at(-1);
  if (!layout) {
    throw new Error("Plot was not rendered");
  }
  return layout;
}

afterEach(() => {
  layouts.length = 0;
  resetTheme();
});

describe("HistogramChart", () => {
  it("uses the dark panel colors in the dark theme (unchanged look)", () => {
    applyTheme("dark");
    render(<HistogramChart histogram={histogram} rows={rows} />);
    expect(screen.getByTestId("plot")).toBeInTheDocument();
    expect(lastLayout()).toMatchObject({ paper_bgcolor: "#0f172a", plot_bgcolor: "#0f172a", font: { color: "#e2e8f0" } });
  });

  it("uses light colors in the light theme", () => {
    applyTheme("light");
    render(<HistogramChart histogram={histogram} rows={rows} />);
    const { background, font } = CHART_COLORS.light;
    expect(lastLayout()).toMatchObject({ paper_bgcolor: background, plot_bgcolor: background, font: { color: font } });
    expect(background).not.toBe(CHART_COLORS.dark.background);
  });

  it("re-renders with the new colors when the theme changes", () => {
    applyTheme("dark");
    render(<HistogramChart histogram={histogram} rows={rows} />);
    act(() => setTheme("light"));
    expect(lastLayout()).toMatchObject({ paper_bgcolor: CHART_COLORS.light.background });
  });

  it.each(["dark", "light"] as const)("draws %s-theme text colors for the P-labels and brand colors for the lines", (theme) => {
    applyTheme(theme);
    render(<HistogramChart histogram={histogram} rows={rows} />);
    const { annotations, shapes } = lastLayout();
    expect(annotations?.map((a) => a.font?.color)).toEqual([CONFIDENCE_TEXT_COLORS[theme][50], CONFIDENCE_TEXT_COLORS[theme][95]]);
    expect(shapes?.map((s) => s.line?.color)).toEqual([CONFIDENCE_COLORS[50], CONFIDENCE_COLORS[95]]);
  });
});
