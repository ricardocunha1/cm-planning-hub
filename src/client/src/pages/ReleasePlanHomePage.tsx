import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DatabaseIcon } from "../components/icons/DatabaseIcon";
import { AdoConnectModal } from "../components/releasePlan/AdoConnectModal";
import { PlanList } from "../components/releasePlan/PlanList";
import { ReleasePlanLayout } from "../components/releasePlan/ReleasePlanLayout";
import { useToast } from "../components/Toast";
import type { ReleasePlan } from "../lib/releasePlan/types";
import { useReleasePlan } from "../releasePlanStore";

const cardBase = "flex h-full w-full flex-col gap-3 rounded-lg border border-line bg-surface p-5 text-left";

/**
 * Release Plan entry page (`/release-plan`): the "Create from Azure DevOps"
 * card and, below it, the {@link PlanList} of saved plans. The card opens
 * {@link AdoConnectModal}, which saves the new plan on the server; this page then
 * puts it in the store, opens `/release-plan/<id>` and toasts "Plan created"
 * followed by the backlog warnings.
 */
export function ReleasePlanHomePage() {
  const { loadPlan } = useReleasePlan();
  const { showInfo } = useToast();
  const navigate = useNavigate();
  const [adoOpen, setAdoOpen] = useState(false);
  const closeAdo = useCallback(() => setAdoOpen(false), []);

  const onCreated = useCallback(
    (id: number, plan: ReleasePlan, warnings: readonly string[]) => {
      loadPlan(id, plan);
      setAdoOpen(false);
      navigate(`/release-plan/${id}`);
      showInfo(`Plan created: ${plan.name}`);
      warnings.forEach((warning) => showInfo(warning));
    },
    [loadPlan, navigate, showInfo],
  );

  return (
    <ReleasePlanLayout>
      <div className="max-w-5xl mx-auto">
        <h3 className="text-2xl font-semibold">Create a release plan board</h3>
        <p className="mt-2 text-slate-400">Build a board from the Epics and Features of an Azure DevOps project.</p>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          <li>
            <button
              type="button"
              onClick={() => setAdoOpen(true)}
              className={`${cardBase} transition-colors hover:border-[color:var(--cm-light-blue)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]`}
            >
              <span className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-md" style={{ backgroundColor: "var(--cm-dark-blue)", color: "var(--cm-teal)" }}>
                  <DatabaseIcon className="h-6 w-6" />
                </span>
                <span className="text-lg font-semibold">Create from Azure DevOps</span>
              </span>
              <span className="text-sm text-fg-muted">Connect to an Azure DevOps project and build a board from its Epics and Features.</span>
            </button>
          </li>
        </ul>
        <PlanList />
      </div>
      <AdoConnectModal open={adoOpen} onClose={closeAdo} onCreated={onCreated} />
    </ReleasePlanLayout>
  );
}
