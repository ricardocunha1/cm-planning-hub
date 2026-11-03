import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { AdoSyncModal } from "../components/releasePlan/AdoSyncModal";
import { Board } from "../components/releasePlan/Board";
import { BoardToolbar, type BoardView } from "../components/releasePlan/BoardToolbar";
import "../components/releasePlan/releasePlan.css";
import { ReleasePlanLayout } from "../components/releasePlan/ReleasePlanLayout";
import { SummaryCards } from "../components/releasePlan/SummaryCards";
import { SyncPreviewDialog } from "../components/releasePlan/SyncPreviewDialog";
import { TableView } from "../components/releasePlan/TableView";
import { useExportPng } from "../components/releasePlan/useExportPng";
import { WorkItemModal } from "../components/releasePlan/WorkItemModal";
import { useToast } from "../components/Toast";
import type { AdoBacklog, AdoConnection } from "../lib/releasePlan/adoTypes";
import { computeBoardLayout, type BoardOrientation } from "../lib/releasePlan/layout";
import { diffBacklog, type SyncDiff } from "../lib/releasePlan/syncDiff";
import type { ReleasePlan, WorkItemRef } from "../lib/releasePlan/types";
import { fitZoom, zoomIn, zoomOut } from "../lib/releasePlan/zoom";
import { useReleasePlan } from "../releasePlanStore";

/** A fetched backlog waiting in the sync preview. */
interface PendingSync {
  backlog: AdoBacklog;
  connection: AdoConnection;
  diff: SyncDiff;
}

/**
 * Board/Table workspace for a plan. UI-only state (view, zoom, board
 * orientation, open item) lives here,
 * not in the store; the orientation (default `standard`, toggled by "Flip
 * board") is never persisted. Fit and Export PNG use the orientation shown.
 *
 * Export PNG ({@link useExportPng}) works from both views.
 *
 * Sync from ADO opens {@link AdoSyncModal}: the connection is read-only from
 * `plan.source`, only the PAT is typed
 * in, and a board without a connection can't be synced. The fetched backlog
 * is diffed and shown in {@link SyncPreviewDialog}. Apply dispatches one `applySync` action, then
 * remounts `Board` (new `key`, resetting its selection, gap menu and drag state) and toasts (plus any backlog warnings);
 * Cancel changes nothing. The PAT never leaves the modal's state.
 */
function BoardWorkspace({ plan }: { plan: ReleasePlan }) {
  const { dispatch } = useReleasePlan();
  const { showInfo } = useToast();
  const [view, setView] = useState<BoardView>("board");
  const [zoom, setZoom] = useState(1);
  const [orientation, setOrientation] = useState<BoardOrientation>("standard");
  const [openItem, setOpenItem] = useState<WorkItemRef | null>(null);
  const [boardKey, setBoardKey] = useState(0);
  const [syncOpen, setSyncOpen] = useState(false);
  const [pendingSync, setPendingSync] = useState<PendingSync | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => computeBoardLayout(plan, orientation), [plan, orientation]);
  const closeItem = useCallback(() => setOpenItem(null), []);
  const closeSync = useCallback(() => setSyncOpen(false), []);
  const cancelSync = useCallback(() => setPendingSync(null), []);
  const { exporting, exportPng } = useExportPng(plan, orientation);

  const onBacklog = (backlog: AdoBacklog, connection: AdoConnection) => {
    setSyncOpen(false);
    setPendingSync({ backlog, connection, diff: diffBacklog(plan, backlog) });
  };

  const onApplySync = (removeGone: boolean) => {
    if (!pendingSync) {
      return;
    }
    const { backlog, connection } = pendingSync;
    dispatch({ type: "applySync", backlog, connection, removeGone });
    setPendingSync(null);
    setOpenItem(null);
    setBoardKey((k) => k + 1);
    showInfo("Board synchronized with Azure DevOps");
    backlog.warnings.forEach((warning) => showInfo(warning));
  };

  const onFit = () => {
    const box = scrollRef.current;
    if (box) {
      setZoom(fitZoom(box.clientWidth, layout.width));
    }
  };

  return (
    <div className="rp">
      <BoardToolbar
        plan={plan}
        view={view}
        onViewChange={setView}
        zoom={zoom}
        onZoomIn={() => setZoom(zoomIn)}
        onZoomOut={() => setZoom(zoomOut)}
        onFit={onFit}
        orientation={orientation}
        onFlip={() => setOrientation((o) => (o === "flipped" ? "standard" : "flipped"))}
        onSync={() => setSyncOpen(true)}
        onExportPng={() => void exportPng()}
        exporting={exporting}
      />
      <SummaryCards plan={plan} />
      {view === "board" ? (
        <Board key={boardKey} plan={plan} layout={layout} zoom={zoom} scrollRef={scrollRef} onOpenItem={setOpenItem} />
      ) : (
        <TableView plan={plan} onOpenItem={setOpenItem} />
      )}
      <WorkItemModal plan={plan} item={openItem} onNavigate={setOpenItem} onClose={closeItem} />
      <AdoSyncModal open={syncOpen} source={plan.source} onClose={closeSync} onBacklog={onBacklog} />
      <SyncPreviewDialog diff={pendingSync ? pendingSync.diff : null} onApply={onApplySync} onCancel={cancelSync} />
    </div>
  );
}

/**
 * Release Plan board page (`/release-plan/:id`, and `/release-plan/board` for now). Shows the store's plan. Redirects to `/release-plan`
 * when there is no plan; shows "Restored your last session" once when the plan
 * was hydrated from storage.
 */
export function ReleasePlanBoardPage() {
  const { plan, consumeRestoredNotice } = useReleasePlan();
  const { showInfo } = useToast();
  const hasPlan = plan !== null;

  useEffect(() => {
    if (hasPlan && consumeRestoredNotice()) {
      showInfo("Restored your last session");
    }
  }, [hasPlan, consumeRestoredNotice, showInfo]);

  if (!plan) {
    return <Navigate to="/release-plan" replace />;
  }
  return (
    <ReleasePlanLayout page="Board">
      <BoardWorkspace plan={plan} />
    </ReleasePlanLayout>
  );
}
