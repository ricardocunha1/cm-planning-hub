import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { MonteCarloLayout } from "../../components/monteCarlo/MonteCarloLayout";
import { errorMessages, useToast } from "../../components/Toast";
import { MONTE_CARLO_ROUTES } from "../../lib/monteCarlo/routes";
import { runSimulation } from "../../lib/monteCarlo/runSimulation";
import { useForecast } from "../../monteCarloStore";

// Port of confirm.html.
export function ConfirmPage() {
  const navigate = useNavigate();
  const { validation, setExecution } = useForecast();
  const { showError } = useToast();
  const [submitting, setSubmitting] = useState(false);

  if (!validation) {
    return <Navigate to={MONTE_CARLO_ROUTES.dataSource} replace />;
  }

  async function onRun() {
    setSubmitting(true);
    try {
      setExecution(await runSimulation(validation!));
      navigate(MONTE_CARLO_ROUTES.results);
    } catch (exc) {
      showError(errorMessages(exc), "Simulation error");
      setSubmitting(false);
    }
  }

  return (
    <MonteCarloLayout pageTitle="Confirm Sprint Data" currentStep={2}>
      <div className="rounded-lg border border-line bg-surface overflow-x-auto mb-6">
        <table className="min-w-full text-sm text-left">
          <thead className="text-fg-subtle border-b border-line">
            <tr>
              <th className="px-4 py-2">Sprint</th>
              <th className="px-4 py-2">Items Resolved</th>
              <th className="px-4 py-2">Story Points</th>
              <th className="px-4 py-2">Last Resolved Date</th>
              <th className="px-4 py-2">Recency Rank</th>
              <th className="px-4 py-2">In Sampling Pool?</th>
            </tr>
          </thead>
          <tbody>
            {validation.summary.map((row) => (
              <tr key={row.Sprint} className="border-b border-line/60">
                <td className="px-4 py-2">{row.Sprint}</td>
                <td className="px-4 py-2">{row["Items Resolved"]}</td>
                <td className="px-4 py-2">{row["Story Points"]}</td>
                <td className="px-4 py-2">{row["Last Resolved Date"]}</td>
                <td className="px-4 py-2">{row["Recency Rank"]}</td>
                <td className="px-4 py-2">{row["In Sampling Pool"] ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onRun}
          disabled={submitting}
          className="rounded px-4 py-2 font-medium disabled:opacity-60"
          style={{ backgroundColor: "var(--cm-light-blue)", color: "#04101d" }}
        >
          {submitting ? "Running…" : "Confirm and Run Simulation"}
        </button>
      </div>
    </MonteCarloLayout>
  );
}
