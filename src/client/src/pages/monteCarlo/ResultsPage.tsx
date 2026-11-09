import { lazy, Suspense, useMemo } from "react";
import { Navigate } from "react-router-dom";
import { MonteCarloLayout } from "../../components/monteCarlo/MonteCarloLayout";
import { buildCalendarData, type CalendarData } from "../../lib/monteCarlo/calendar";
import { confidenceColor, confidenceTextColor, OVERFLOW_LABEL } from "../../lib/monteCarlo/confidence";
import { MONTE_CARLO_ROUTES } from "../../lib/monteCarlo/routes";
import { useForecast } from "../../monteCarloStore";
import { useTheme } from "../../themeStore";
import type { SimulateResponse } from "../../lib/monteCarlo/types";

const HistogramChart = lazy(() => import("../../components/monteCarlo/HistogramChart"));

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

// Port of results.html. Execution failures are reported as toasts by the
// page that ran the simulation, so this page only renders successes.
export function ResultsPage() {
  const { execution } = useForecast();

  if (!execution) {
    return <Navigate to={MONTE_CARLO_ROUTES.dataSource} replace />;
  }

  return <Results result={execution.result} sprintStartDate={execution.sprintStartDate} />;
}

function Results({ result, sprintStartDate }: { result: SimulateResponse; sprintStartDate: string }) {
  const calendarData = useMemo(
    () => buildCalendarData(sprintStartDate, result.rows),
    [sprintStartDate, result.rows],
  );
  const { histogram } = result;
  const { theme } = useTheme();

  return (
    <MonteCarloLayout pageTitle="Results" currentStep={3}>
      <p className="text-fg-subtle mb-6">
        Target: <span className="text-fg-soft font-medium">{result.target_value} {result.target_type}</span>
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {result.rows.map((row) => {
          const color = confidenceColor(row.confidence);
          const textColor = confidenceTextColor(row.confidence, theme);
          return (
            <div key={row.confidence} data-testid={`card-p${row.confidence}`} className="rounded-lg border border-line bg-surface p-4" style={{ borderTop: `3px solid ${color}` }}>
              <p className="text-sm mb-1" style={{ color: textColor }}>P{row.confidence} - {row.label}</p>
              <p className="text-2xl font-semibold" style={{ color: textColor }}>
                {row.exceeds_window ? OVERFLOW_LABEL : row.sprints}{" "}
                <span className="text-sm font-normal text-fg-subtle">sprints</span>
              </p>
              <p className="text-sm text-fg-subtle mt-1">{row.completion_date ?? "Not reached within window"}</p>
            </div>
          );
        })}
      </div>

      {calendarData && <CalendarView data={calendarData} />}

      <h3 className="text-base font-semibold mb-3">Distribution of Simulated Outcomes</h3>
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-4">
        <div className="lg:col-span-1 rounded-lg border border-line bg-surface overflow-y-auto h-[420px]">
          <table className="min-w-full text-sm text-left">
            <thead className="text-fg-subtle border-b border-line sticky top-0 bg-surface">
              <tr>
                <th className="px-4 py-2">Sprint</th>
                <th className="px-4 py-2">Count</th>
              </tr>
            </thead>
            <tbody>
              {histogram.labels.map((label, index) =>
                histogram.counts[index] > 0 ? (
                  <tr key={label} className="border-b border-line/60">
                    <td className="px-4 py-2">{label}</td>
                    <td className="px-4 py-2">{histogram.counts[index]}</td>
                  </tr>
                ) : null,
              )}
            </tbody>
          </table>
        </div>

        <div className="lg:col-span-3 rounded-lg border border-line bg-surface p-4 h-[420px]">
          <Suspense fallback={<p className="text-sm text-fg-faint">Loading chart…</p>}>
            <HistogramChart histogram={histogram} rows={result.rows} />
          </Suspense>
        </div>
      </div>
    </MonteCarloLayout>
  );
}

function CalendarView({ data }: { data: CalendarData }) {
  const dayClass = "h-6 w-full rounded-sm flex items-center justify-center text-[11px]";
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold">Calendar View</h3>
        <div className="flex items-center gap-4">
          {data.legend.map((item) => (
            <span key={item.label} className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.months.map((month) => (
          <div key={month.label} className="rounded-lg border border-line bg-surface p-3">
            <p className="text-sm font-medium text-fg-muted mb-2">{month.label}</p>
            <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-fg-faint mb-1">
              {WEEKDAYS.map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            {month.weeks.map((week, weekIndex) => (
              <div key={weekIndex} className="grid grid-cols-7 gap-1 mb-1">
                {week.map((cell, cellIndex) => {
                  if (!cell) {
                    return <span key={cellIndex} className="h-6 w-full" />;
                  }
                  if (cell.color) {
                    return (
                      <span key={cellIndex} className={`${dayClass} font-medium text-slate-950`} style={{ backgroundColor: cell.color }}>
                        {cell.day}
                      </span>
                    );
                  }
                  if (cell.isWeekend) {
                    return <span key={cellIndex} className={`${dayClass} bg-surface-raised/60 text-fg-dim`}>{cell.day}</span>;
                  }
                  return <span key={cellIndex} className={`${dayClass} text-fg-faint`}>{cell.day}</span>;
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
