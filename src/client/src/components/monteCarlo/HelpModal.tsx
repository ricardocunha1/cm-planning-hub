import { useEffect } from "react";

// Port of _help_modal.html.
const code = "px-1 rounded bg-surface-raised border border-line-strong";

export function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="flex fixed inset-0 z-50 items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="help-modal-title">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg border border-line-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-line sticky top-0 bg-surface">
          <h2 id="help-modal-title" className="text-lg font-semibold">How to Use This Application</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="text-fg-subtle hover:text-fg text-xl leading-none">
            &times;
          </button>
        </div>
        <div className="px-6 py-5 space-y-6 text-sm text-fg-muted">
          <section>
            <h3 className="text-base font-semibold text-fg mb-2">Overview</h3>
            <p>
              This tool forecasts how many sprints are needed to hit a target (Items
              Resolved or Story Points) by running a Monte Carlo simulation against
              your team's historical sprint data. The flow has three steps:
            </p>
            <ol className="list-decimal list-inside mt-2 space-y-1">
              <li><strong>Data Input</strong> &ndash; load your sprint history (Azure DevOps or an Excel file) and set simulation parameters.</li>
              <li><strong>Data Validation</strong> &ndash; review the sprint summary built from your sprint history (can be skipped).</li>
              <li><strong>Simulation Execution</strong> &ndash; view the forecast results and confidence levels.</li>
            </ol>
            <p className="mt-2">
              The first screen lets you choose the data source: <strong>Import an Excel
              file</strong> opens a dialog where you select the <code className={code}>.xlsx</code> file,
              then the input form shows the selected source and its &ldquo;Change&rdquo; link
              takes you back to pick another one.
            </p>
            <p className="mt-2">
              <strong>Load from Azure DevOps</strong> connects to your project (On-Prem or
              Collaboration Hub, its project URL and a Personal Access Token with the{" "}
              <strong>Work Items (Read)</strong> scope; the token is only used for the request
              and is never stored). Pick an Iteration Path: the User Stories and Bugs under it
              (child paths included) in state <code className={code}>Resolved</code>,{" "}
              <code className={code}>Done</code> or <code className={code}>Closed</code> are loaded
              once as the sprint history, grouped by their own iteration.
            </p>
          </section>

          <section>
            <h3 className="text-base font-semibold text-fg mb-2">Excel File Structure</h3>
            <p className="mb-2">
              The uploaded <code className={code}>.xlsx</code> file must contain a sheet (the
              first sheet is used) with one row per work item, including at least these
              columns:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left border border-line-strong rounded overflow-hidden">
                <thead className="bg-surface-raised text-fg-soft">
                  <tr>
                    <th className="px-3 py-2 border-b border-line-strong">Column</th>
                    <th className="px-3 py-2 border-b border-line-strong">Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="px-3 py-2 border-b border-line align-top whitespace-nowrap font-mono text-xs">State</td>
                    <td className="px-3 py-2 border-b border-line">
                      Work item status. Only rows with state <code className={code}>Resolved</code>,{" "}
                      <code className={code}>Done</code>, or <code className={code}>Closed</code>{" "}
                      (case-sensitive) count toward a sprint.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 border-b border-line align-top whitespace-nowrap font-mono text-xs">Iteration Path</td>
                    <td className="px-3 py-2 border-b border-line">
                      The item's sprint/iteration, e.g. <code className={code}>Project\Sprint 7</code>.
                      Only the last segment after the final <code className={code}>\</code> is used
                      as the sprint name.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 border-b border-line align-top whitespace-nowrap font-mono text-xs">Resolved Date</td>
                    <td className="px-3 py-2 border-b border-line">
                      The date the item was resolved. Used to determine each sprint's most
                      recent activity and its recency rank. Must use the format{" "}
                      <code className={code}>MM/dd/yyyy [hh:mm]</code> (month first, time
                      optional), e.g. <code className={code}>03/27/2025 14:30</code>.
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 align-top whitespace-nowrap font-mono text-xs">Story Points</td>
                    <td className="px-3 py-2">
                      Numeric story point estimate for the item. Blank values are treated as 0;
                      non-numeric values will cause an error.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-3">
              Any additional columns in the file are ignored. Rows are grouped by sprint to
              compute, per sprint, the total Items Resolved and Story Points &mdash; these
              historical sprint totals are what the simulation samples from.
            </p>
          </section>

          <section>
            <h3 className="text-base font-semibold text-fg mb-2">Tips</h3>
            <ul className="list-disc list-inside space-y-1">
              <li>Use "Exclude Latest Sprints from Sampling" to leave out in-progress or partial sprints from the random sampling pool.</li>
              <li>"Team Capacity Factor" scales historical Items Resolved and Story Points to model capacity changes (e.g. 1.2 for 20% more capacity).</li>
              <li>Hover the <span className="inline-block align-middle">&#9432;</span> icons next to each field for a quick description.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
