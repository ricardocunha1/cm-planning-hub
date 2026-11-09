import { useId } from "react";
import { Link } from "react-router-dom";
import { MONTE_CARLO_ROUTES } from "../../lib/monteCarlo/routes";
import type { DataSource } from "../../lib/monteCarlo/types";
import { DatabaseIcon } from "../icons/DatabaseIcon";
import { FileSpreadsheetIcon } from "../icons/FileSpreadsheetIcon";

const termClass = "text-xs uppercase tracking-wide text-fg-subtle";
const detailClass = "break-all text-sm font-medium text-fg";

/**
 * Compact summary of the chosen sprint history source shown above the Monte
 * Carlo input form: the Excel file name, or the Azure DevOps project,
 * Iteration path and number of work items loaded. Its "Change" link goes back to the data source page.
 */
export function DataSourceCard({ dataSource }: { dataSource: DataSource }) {
  const headingId = useId();
  const isExcel = dataSource.kind === "excel";
  const Icon = isExcel ? FileSpreadsheetIcon : DatabaseIcon;

  return (
    <section aria-labelledby={headingId} className="flex items-start gap-3 rounded-lg border border-line bg-surface p-4">
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: "var(--cm-dark-blue)", color: "var(--cm-teal)" }}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="text-sm font-semibold text-fg-soft">
          Data source: {isExcel ? "Excel file" : "Azure DevOps"}
        </h3>
        <dl className="mt-2 grid gap-2">
          {dataSource.kind === "excel" ? (
            <div>
              <dt className={termClass}>File</dt>
              <dd className={detailClass}>{dataSource.file.name}</dd>
            </div>
          ) : (
            <>
              <div>
                <dt className={termClass}>Project</dt>
                <dd className={detailClass}>{dataSource.project}</dd>
              </div>
              <div>
                <dt className={termClass}>Iteration Path</dt>
                <dd className={detailClass}>{dataSource.iterationPath}</dd>
              </div>
              <div>
                <dt className={termClass}>Work items</dt>
                <dd className={detailClass}>{dataSource.workItems.length}</dd>
              </div>
            </>
          )}
        </dl>
      </div>
      <Link
        to={MONTE_CARLO_ROUTES.dataSource}
        className="shrink-0 rounded text-sm font-medium text-accent-blue hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
        aria-label="Change data source"
      >
        Change
      </Link>
    </section>
  );
}
