import { useState, type ChangeEvent, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { validate } from "../../lib/monteCarlo/api";
import { DataSourceCard } from "../../components/monteCarlo/DataSourceCard";
import { InfoIcon } from "../../components/monteCarlo/InfoIcon";
import { MonteCarloLayout } from "../../components/monteCarlo/MonteCarloLayout";
import { errorMessages, useToast } from "../../components/Toast";
import { MONTE_CARLO_ROUTES } from "../../lib/monteCarlo/routes";
import { runSimulation } from "../../lib/monteCarlo/runSimulation";
import { useForecast } from "../../monteCarloStore";

// Port of input.html.
export const DEFAULT_FORM_VALUES = {
  target_type: "Items Resolved",
  target_value: "",
  num_simulations: "10000",
  skip_validation: false,
  exclude_latest_sprints: "0",
  sprint_start_date: "",
  sprint_length: "10",
  team_capacity_factor: "1.0",
};

type FormValues = typeof DEFAULT_FORM_VALUES;
type TextField = Exclude<keyof FormValues, "skip_validation">;

const inputClass = "w-full rounded bg-surface-raised border border-line-strong px-3 py-2";
const labelClass = "flex items-center gap-1 text-sm font-medium mb-1";

function Required() {
  return <span style={{ color: "var(--cm-red)" }}>*</span>;
}

/**
 * Simulation parameters form (`/monte-carlo/input`) for the data source chosen
 * on the data source page (shown in a `DataSourceCard`; no source in the store
 * redirects there). Validates, then confirms or runs.
 */
export function InputPage() {
  const navigate = useNavigate();
  const { dataSource, setValidation, setExecution } = useForecast();
  const { showError } = useToast();
  const [values, setValues] = useState<FormValues>(DEFAULT_FORM_VALUES);
  const [submitting, setSubmitting] = useState(false);

  if (!dataSource) {
    return <Navigate to={MONTE_CARLO_ROUTES.dataSource} replace />;
  }

  const onText = (field: TextField) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((current) => ({ ...current, [field]: event.target.value }));

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Same fields a native form submit would send: every text field (even
    // blank) and the checkbox only when checked; plus the sprint history: the
    // Excel file chosen on the data source page, or the Azure DevOps work items
    // as the JSON field `sprint_history_items` (no file then).
    const formData = new FormData();
    for (const field of Object.keys(values) as (keyof FormValues)[]) {
      if (field !== "skip_validation") {
        formData.append(field, values[field]);
      }
    }
    if (values.skip_validation) {
      formData.append("skip_validation", "on");
    }
    if (dataSource.kind === "excel") {
      formData.append("sprint_history_file", dataSource.file);
    } else {
      formData.append("sprint_history_items", JSON.stringify(dataSource.workItems));
    }

    setSubmitting(true);
    try {
      const validation = await validate(formData);
      setValidation(validation);
      if (values.skip_validation) {
        setExecution(await runSimulation(validation));
        navigate(MONTE_CARLO_ROUTES.results);
      } else {
        setExecution(null);
        navigate(MONTE_CARLO_ROUTES.confirm);
      }
    } catch (exc) {
      showError(errorMessages(exc), "Please correct the following:");
      setSubmitting(false);
    }
  };

  return (
    <MonteCarloLayout pageTitle="Data Input" currentStep={1}>
      <div className="max-w-xl mx-auto mb-6">
        <DataSourceCard dataSource={dataSource} />
      </div>
      <form onSubmit={onSubmit} encType="multipart/form-data" className="space-y-6 max-w-xl mx-auto">
        <div>
          <label className={labelClass} htmlFor="target_type">
            Target Type <Required />
            <InfoIcon text='A choice between "Items Resolved" or "Story Points" to determine the metric for the simulation.' />
          </label>
          <select className={inputClass} id="target_type" name="target_type" value={values.target_type} onChange={onText("target_type")}>
            <option value="Items Resolved">Items Resolved</option>
            <option value="Story Points">Story Points</option>
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="target_value">
            Target Value <Required />
            <InfoIcon text="The target to be completed." />
          </label>
          <input className={inputClass} type="number" step="any" id="target_value" name="target_value" value={values.target_value} onChange={onText("target_value")} required />
        </div>

        <div>
          <label className={labelClass} htmlFor="num_simulations">
            Number of Simulations <Required />
            <InfoIcon text="Number of Monte Carlo simulations to run. Maximum of 20000 simulations." />
          </label>
          <input className={inputClass} type="number" step="1" id="num_simulations" name="num_simulations" value={values.num_simulations} onChange={onText("num_simulations")} required />
        </div>

        <div>
          <label className={labelClass} htmlFor="sprint_start_date">
            Sprint Start Date <Required />
            <InfoIcon text="The start date of the first sprint of the simulation." />
          </label>
          <input className={inputClass} type="date" id="sprint_start_date" name="sprint_start_date" value={values.sprint_start_date} onChange={onText("sprint_start_date")} required />
        </div>

        <div>
          <label className={labelClass} htmlFor="sprint_length">
            Sprint Length (business days) <Required />
            <InfoIcon text="The length of each sprint in business days." />
          </label>
          <input className={inputClass} type="number" step="1" id="sprint_length" name="sprint_length" value={values.sprint_length} onChange={onText("sprint_length")} required />
        </div>

        <div className="flex items-center gap-2">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              id="skip_validation"
              name="skip_validation"
              className="sr-only peer"
              checked={values.skip_validation}
              onChange={(event) => setValues((current) => ({ ...current, skip_validation: event.target.checked }))}
            />
            <div className="w-11 h-6 rounded-full bg-surface-overlay transition-colors peer-checked:bg-[var(--cm-light-blue)] peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-canvas peer-focus-visible:ring-[var(--cm-light-blue)]" />
            <div className="absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
          </label>
          <label className="flex items-center gap-1" htmlFor="skip_validation">
            Skip Historical Sprint Validation
            <InfoIcon text="Skip the historical sprint validation step and proceed without validation." />
          </label>
        </div>

        <div>
          <label className={labelClass} htmlFor="exclude_latest_sprints">
            Exclude Latest Sprints from Sampling
            <InfoIcon text="The number of latest sprints to exclude from sampling." />
          </label>
          <input className={inputClass} type="number" step="1" min="0" id="exclude_latest_sprints" name="exclude_latest_sprints" value={values.exclude_latest_sprints} onChange={onText("exclude_latest_sprints")} />
        </div>

        <div>
          <label className={labelClass} htmlFor="team_capacity_factor">
            Team Capacity Factor
            <InfoIcon text="The team capacity factor relative to the historical data. 1.0 means same capacity, 1.2 means 20% additional capacity. Multiplies Items Resolved and Story Points when running the simulation." />
          </label>
          <input className={inputClass} type="number" step="0.01" min="0.01" id="team_capacity_factor" name="team_capacity_factor" value={values.team_capacity_factor} onChange={onText("team_capacity_factor")} />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="rounded px-4 py-2 font-medium disabled:opacity-60"
            style={{ backgroundColor: "var(--cm-light-blue)", color: "#04101d" }}
          >
            {submitting ? "Working…" : "Continue"}
          </button>
        </div>
      </form>
    </MonteCarloLayout>
  );
}
