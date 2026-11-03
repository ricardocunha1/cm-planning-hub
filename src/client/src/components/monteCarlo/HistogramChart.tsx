import Plotly from "plotly.js-basic-dist-min";
import createPlotlyComponent from "react-plotly.js/factory";
import { confidenceColor, confidenceTextColor, OVERFLOW_LABEL } from "../../lib/monteCarlo/confidence";
import type { Histogram, ResultRow } from "../../lib/monteCarlo/types";
import type { Theme } from "../../lib/themePreference";
import { useTheme } from "../../themeStore";

const Plot = createPlotlyComponent(Plotly);

/** Chart background and text colors per theme; they match the surrounding panel (`bg-surface`, `text-fg-soft`). */
export const CHART_COLORS: Record<Theme, { background: string; font: string }> = {
  dark: { background: "#0f172a", font: "#e2e8f0" },
  light: { background: "#ffffff", font: "#1e293b" },
};

// Port of the legacy results.html Plotly chart. The x axis is categorical
// ("1".."50", ">50"), so the non-convergence bucket is its own bar.
// Default export so ResultsPage can lazy-load Plotly. Colors follow the active theme (P-label
// annotations use the readable text variant; the dashed lines keep the brand colors).
export default function HistogramChart({
  histogram,
  rows,
}: {
  histogram: Histogram;
  rows: ResultRow[];
}) {
  const { theme } = useTheme();
  const colors = CHART_COLORS[theme];
  const markers = rows.map((row) => ({
    label: `P${row.confidence}`,
    x: row.exceeds_window ? OVERFLOW_LABEL : String(row.sprints),
    color: confidenceColor(row.confidence),
    textColor: confidenceTextColor(row.confidence, theme),
  }));

  return (
    <Plot
      className="h-full w-full"
      useResizeHandler
      data={[
        {
          x: histogram.labels,
          y: histogram.counts,
          type: "bar",
          marker: { color: "#4E98D1" },
          hovertemplate: "%{y}<extra></extra>",
        },
      ]}
      layout={{
        autosize: true,
        paper_bgcolor: colors.background,
        plot_bgcolor: colors.background,
        font: { color: colors.font },
        margin: { t: 40, r: 20, b: 60, l: 50 },
        xaxis: { title: { text: "Sprints to Reach Target" }, tickangle: -45, type: "category" },
        yaxis: { title: { text: "Simulation Count" } },
        shapes: markers.map((marker) => ({
          type: "line",
          xref: "x",
          x0: marker.x,
          x1: marker.x,
          yref: "paper",
          y0: 0,
          y1: 1,
          line: { color: marker.color, width: 2, dash: "dash" },
        })),
        annotations: markers.map((marker, index) => ({
          x: marker.x,
          y: 1,
          yref: "paper",
          yanchor: "bottom",
          yshift: (index % 2) * 16,
          showarrow: false,
          text: marker.label,
          font: { color: marker.textColor, size: 11 },
        })),
      }}
      config={{ displayModeBar: false, responsive: true }}
    />
  );
}
