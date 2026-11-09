import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIDENCE_COLORS, CONFIDENCE_TEXT_COLORS } from "../../lib/monteCarlo/confidence";
import { applyTheme } from "../../lib/themePreference";
import { result } from "../../test/monteCarloFixtures";
import { renderAt } from "../../test/render";
import { resetTheme } from "../../test/theme";
import { ResultsPage } from "./ResultsPage";

// Plotly needs a real browser (canvas, WebGL); stub the lazy chart.
vi.mock("../../components/monteCarlo/HistogramChart", () => ({
  default: ({ histogram }: { histogram: { labels: string[] } }) => (
    <div data-testid="histogram">{histogram.labels.length} buckets</div>
  ),
}));

describe("ResultsPage", () => {
  afterEach(() => {
    resetTheme();
  });

  it("redirects to the input step without results", () => {
    renderAt("/monte-carlo/results", <ResultsPage />);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/monte-carlo$/);
  });

  it("renders percentile cards, including the >50 sentinel", async () => {
    renderAt("/monte-carlo/results", <ResultsPage />, {
      execution: { result, sprintStartDate: "2026-01-05" },
    });

    expect(screen.getByText("100 Items Resolved")).toBeInTheDocument();
    const p50 = screen.getByTestId("card-p50");
    expect(p50).toHaveTextContent("P50 - Optimistic");
    expect(p50).toHaveTextContent("9 sprints");
    expect(p50).toHaveTextContent("2026-05-08");

    const p95 = screen.getByTestId("card-p95");
    expect(p95).toHaveTextContent("P95 - Safe Target");
    expect(p95).toHaveTextContent(">50 sprints");
    expect(p95).toHaveTextContent("Not reached within window");
    expect(p95).not.toHaveTextContent("51");

    expect(await screen.findByTestId("histogram")).toHaveTextContent("51 buckets");
  });

  it("renders the calendar without the unreached percentile", () => {
    renderAt("/monte-carlo/results", <ResultsPage />, {
      execution: { result, sprintStartDate: "2026-01-05" },
    });
    expect(screen.getByText("Calendar View")).toBeInTheDocument();
    expect(screen.getByText("January 2026")).toBeInTheDocument();
    expect(screen.getByText("June 2026")).toBeInTheDocument();
    expect(screen.queryByText("P95")).not.toBeInTheDocument();
  });

  it("lists only non-empty histogram buckets in the count table", () => {
    renderAt("/monte-carlo/results", <ResultsPage />, {
      execution: { result, sprintStartDate: "2026-01-05" },
    });
    const table = screen.getByRole("columnheader", { name: "Count" }).closest("table")!;
    const bodyRows = within(table).getAllByRole("row").slice(1);
    expect(bodyRows.map((row) => row.textContent)).toEqual(["9600", "10200", "11150", ">5050"]);
  });

  it.each(["dark", "light"] as const)("colors the card text with the %s text variant and keeps the brand border", (theme) => {
    applyTheme(theme);
    renderAt("/monte-carlo/results", <ResultsPage />, {
      execution: { result, sprintStartDate: "2026-01-05" },
    });
    for (const level of [50, 70, 85]) {
      const card = screen.getByTestId(`card-p${level}`);
      expect(card).toHaveStyle({ borderTop: `3px solid ${CONFIDENCE_COLORS[level]}` });
      expect(within(card).getByText(new RegExp(`^P${level} - `))).toHaveStyle({ color: CONFIDENCE_TEXT_COLORS[theme][level] });
    }
  });

});
