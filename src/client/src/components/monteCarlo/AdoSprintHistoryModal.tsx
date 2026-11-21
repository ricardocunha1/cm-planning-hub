import { AdoConnectModal, type AdoScopeTypes } from "../ado/AdoConnectModal";
import type { AdoConnection, AdoScopedRequest } from "../../lib/ado/types";
import { adoSprintHistory } from "../../lib/monteCarlo/api";
import { ADO_CONNECTION_KEY } from "../../lib/monteCarlo/constants";
import type { AdoSprintHistory } from "../../lib/monteCarlo/types";

const SCOPE_TYPES: AdoScopeTypes = ["iteration"];

/** Loads the sprint history for the Iteration path picked in the modal. */
const loadSprintHistory = ({ source, projectUrl, scopePath }: AdoScopedRequest, signal: AbortSignal): Promise<AdoSprintHistory> =>
  adoSprintHistory({ source, projectUrl, iterationPath: scopePath }, signal);

/**
 * Monte Carlo's "Load from Azure DevOps" modal: the shared
 * {@link AdoConnectModal} with an Iteration-path-only picker, Monte Carlo's
 * own remembered connection and `POST /api/ado/sprint-history` as the loader
 * ("Load sprint history"). There is no sync: the data is loaded once.
 */
export function AdoSprintHistoryModal({
  open,
  onClose,
  onLoaded,
}: {
  /** Whether the modal is shown; it starts fresh every time it opens. */
  open: boolean;
  /** Cancel, Esc or a backdrop click; an in-flight request is aborted. */
  onClose: () => void;
  /** The loaded sprint history and its connection (no PAT); the caller closes the modal. */
  onLoaded: (history: AdoSprintHistory, connection: AdoConnection) => void;
}) {
  return (
    <AdoConnectModal<AdoSprintHistory>
      open={open}
      title="Load from Azure DevOps"
      submitLabel="Load sprint history"
      scopeTypes={SCOPE_TYPES}
      connectionKey={ADO_CONNECTION_KEY}
      onClose={onClose}
      load={loadSprintHistory}
      onLoaded={onLoaded}
    />
  );
}
