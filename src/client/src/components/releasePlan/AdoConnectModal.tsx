import { AdoConnectModal as SharedAdoConnectModal, type AdoNameField, type AdoScopeTypes } from "../ado/AdoConnectModal";
import { adoBacklog } from "../../lib/releasePlan/adoApi";
import { ADO_CONNECTION_KEY } from "../../lib/releasePlan/constants";
import { defaultPlanName, planFromBacklog } from "../../lib/releasePlan/fromBacklog";
import { createPlan } from "../../lib/releasePlan/planApi";
import { validatePlanName } from "../../lib/releasePlan/planName";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import type { AdoConnection, AdoScopedRequest } from "../../lib/ado/types";

/** What a successful create hands to the caller. */
interface CreatedPlan {
  id: number;
  plan: ReleasePlan;
  warnings: string[];
}

interface AdoConnectModalProps {
  /** Whether the modal is shown; it starts fresh every time it opens. */
  open: boolean;
  /** Cancel, Esc or a backdrop click; an in-flight request is aborted. */
  onClose: () => void;
  /** The plan was saved on the server (`id`); `plan` is the board that was sent (named as typed) and `warnings` come from the backlog. The caller closes the modal. */
  onCreated: (id: number, plan: ReleasePlan, warnings: string[]) => void;
}

const SCOPE_TYPES: AdoScopeTypes = ["area", "iteration"];

const NAME_FIELD: AdoNameField = {
  label: "Plan name",
  defaultName: defaultPlanName,
  validate: validatePlanName,
};

/** Backlog -> board named `name` -> `POST /api/plan`. Rejections (backlog or save) are shown inline by the shared modal. */
async function createFromBacklog(request: AdoScopedRequest, signal: AbortSignal, name: string): Promise<CreatedPlan> {
  const backlog = await adoBacklog(request, signal);
  const connection: AdoConnection = {
    source: request.source,
    projectUrl: request.projectUrl,
    scopeType: request.scopeType,
    scopePath: request.scopePath,
  };
  const plan: ReleasePlan = { ...planFromBacklog(backlog, connection), name };
  const saved = await createPlan({ name, projectType: connection.source, projectName: backlog.project.name, state: plan }, signal);
  return { id: saved.id, plan, warnings: backlog.warnings };
}

/**
 * Release Plan's "Create from Azure DevOps" modal: the shared
 * {@link SharedAdoConnectModal} with the Area/Iteration toggle, Release Plan's
 * remembered connection and a required "Plan name" field (pre-filled with the
 * default name after Connect). "Create board" fetches the backlog, builds the
 * board and saves it with `POST /api/plan`; errors from either request show
 * inline and the modal stays open. Syncing an existing board uses
 * `AdoSyncModal` instead.
 */
export function AdoConnectModal({ open, onClose, onCreated }: AdoConnectModalProps) {
  return (
    <SharedAdoConnectModal<CreatedPlan>
      open={open}
      title="Create from Azure DevOps"
      submitLabel="Create board"
      scopeTypes={SCOPE_TYPES}
      connectionKey={ADO_CONNECTION_KEY}
      nameField={NAME_FIELD}
      onClose={onClose}
      load={createFromBacklog}
      onLoaded={({ id, plan, warnings }) => onCreated(id, plan, warnings)}
    />
  );
}
