import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DatabaseIcon } from "../../components/icons/DatabaseIcon";
import { FileSpreadsheetIcon } from "../../components/icons/FileSpreadsheetIcon";
import { AdoSprintHistoryModal } from "../../components/monteCarlo/AdoSprintHistoryModal";
import { ImportExcelModal } from "../../components/monteCarlo/ImportExcelModal";
import { MonteCarloLayout } from "../../components/monteCarlo/MonteCarloLayout";
import { useToast } from "../../components/Toast";
import type { AdoConnection } from "../../lib/ado/types";
import { MONTE_CARLO_ROUTES } from "../../lib/monteCarlo/routes";
import type { AdoSprintHistory, DataSource } from "../../lib/monteCarlo/types";
import { useForecast } from "../../monteCarloStore";

const cardBase =
  "flex h-full w-full flex-col gap-3 rounded-lg border border-line bg-surface p-5 text-left transition-colors hover:border-[color:var(--cm-light-blue)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";
const iconBox = "flex h-10 w-10 items-center justify-center rounded-md";
const iconBoxStyle = { backgroundColor: "var(--cm-dark-blue)", color: "var(--cm-teal)" };

/**
 * Monte Carlo entry page (`/monte-carlo`, breadcrumb step 1): choose where the
 * sprint history comes from. The "Load from Azure DevOps" card opens
 * `AdoSprintHistoryModal` (its warnings become info toasts); the "Import an
 * Excel file" card opens `ImportExcelModal`. Either way the loaded source
 * becomes the store's data source (clearing any previous
 * validation/execution) before going to the input form.
 */
export function DataSourcePage() {
  const navigate = useNavigate();
  const { setDataSource, setValidation, setExecution } = useForecast();
  const { showInfo } = useToast();
  const [openModal, setOpenModal] = useState<"ado" | "excel" | null>(null);
  const closeModal = useCallback(() => setOpenModal(null), []);

  const chooseSource = (dataSource: DataSource) => {
    setDataSource(dataSource);
    setValidation(null);
    setExecution(null);
    setOpenModal(null);
    navigate(MONTE_CARLO_ROUTES.input);
  };

  const onFileSelected = (file: File) => chooseSource({ kind: "excel", file });

  const onSprintHistory = (history: AdoSprintHistory, connection: AdoConnection) => {
    chooseSource({
      kind: "azureDevOps",
      source: connection.source,
      projectUrl: history.projectUrl,
      project: history.project.name,
      iterationPath: history.iterationPath,
      fetchedAt: history.fetchedAt,
      workItems: history.workItems,
    });
    history.warnings.forEach((warning) => showInfo(warning));
  };

  return (
    <MonteCarloLayout pageTitle="Data Source" currentStep={1}>
      <h3 className="text-2xl font-semibold">Load sprint history</h3>
      <p className="mt-2 text-fg-subtle">Choose where the historical sprint data for the simulation comes from.</p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        <li>
          <button type="button" onClick={() => setOpenModal("ado")} aria-haspopup="dialog" className={cardBase}>
            <span className="flex items-center gap-3">
              <span className={iconBox} style={iconBoxStyle}>
                <DatabaseIcon className="h-6 w-6" />
              </span>
              <span className="text-lg font-semibold">Load from Azure DevOps</span>
            </span>
            <span className="text-sm text-fg-muted">
              Connect to an Azure DevOps project and load the resolved User Stories and Bugs under an Iteration path.
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            onClick={() => setOpenModal("excel")}
            aria-haspopup="dialog"
            className={cardBase}
          >
            <span className="flex items-center gap-3">
              <span className={iconBox} style={iconBoxStyle}>
                <FileSpreadsheetIcon className="h-6 w-6" />
              </span>
              <span className="text-lg font-semibold">Import an Excel file</span>
            </span>
            <span className="text-sm text-fg-muted">Select a sprint history extract (.xlsx), then set the simulation parameters.</span>
          </button>
        </li>
      </ul>
      <AdoSprintHistoryModal open={openModal === "ado"} onClose={closeModal} onLoaded={onSprintHistory} />
      <ImportExcelModal open={openModal === "excel"} onClose={closeModal} onFileSelected={onFileSelected} />
    </MonteCarloLayout>
  );
}
