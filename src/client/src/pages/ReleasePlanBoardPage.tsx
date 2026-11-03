import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate, useParams } from "react-router-dom";
import { AdoSyncModal } from "../components/releasePlan/AdoSyncModal";
import { Board } from "../components/releasePlan/Board";
import { BoardToolbar, type BoardView } from "../components/releasePlan/BoardToolbar";
import "../components/releasePlan/releasePlan.css";
import { ReleasePlanLayout } from "../components/releasePlan/ReleasePlanLayout";
import { UnsavedChangesDialog } from "../components/releasePlan/UnsavedChangesDialog";
import { usePlanPersistence, type PlanPersistence } from "../components/releasePlan/usePlanPersistence";
import { SummaryCards } from "../components/releasePlan/SummaryCards";
import { SyncPreviewDialog } from "../components/releasePlan/SyncPreviewDialog";
import { TableView } from "../components/releasePlan/TableView";
import { useExportPng } from "../components/releasePlan/useExportPng";
import { WorkItemModal } from "../components/releasePlan/WorkItemModal";
import { errorMessages, useToast } from "../components/Toast";
import { ApiError } from "../lib/monteCarlo/api";
import type { AdoBacklog, AdoConnection } from "../lib/releasePlan/adoTypes";
import { computeBoardLayout, type BoardOrientation } from "../lib/releasePlan/layout";
import { getPlan } from "../lib/releasePlan/planApi";
import { diffBacklog, type SyncDiff } from "../lib/releasePlan/syncDiff";
import type { ReleasePlan, WorkItemRef } from "../lib/releasePlan/types";
import { normalizePlan } from "../lib/releasePlan/validate";
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
 * Cancel changes nothing. The PAT never leaves the modal's state. A sync is
 * an ordinary change, so it is saved like any other.
 */
function BoardWorkspace({ plan, persistence }: { plan: ReleasePlan; persistence: PlanPersistence }) {
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
        saveStatus={persistence.status}
        autosave={persistence.autosave}
        onAutosaveChange={persistence.setAutosave}
        onSave={() => void persistence.saveNow()}
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

/** A loaded plan: persistence (autosave/save), the unsaved-changes guard and the workspace. Remount per plan id. */
function LoadedBoard({ planId, plan }: { planId: number; plan: ReleasePlan }) {
  const persistence = usePlanPersistence(planId, plan);
  const { status, saveNow, hasUnsaved } = persistence;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => hasUnsaved() && currentLocation.pathname !== nextLocation.pathname);
  const [guardSaving, setGuardSaving] = useState(false);
  const [guardFailed, setGuardFailed] = useState(false);
  const unsaved = status !== "saved";

  // Closing or reloading the tab: the browser's own confirmation, only while there is something to lose.
  useEffect(() => {
    if (!unsaved) {
      return;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsaved]);

  const onGuardSave = async () => {
    setGuardSaving(true);
    setGuardFailed(false);
    const ok = await saveNow();
    setGuardSaving(false);
    if (ok) {
      if (blocker.state === "blocked") {
        blocker.proceed();
      }
    } else {
      setGuardFailed(true);
    }
  };

  return (
    <>
      <BoardWorkspace plan={plan} persistence={persistence} />
      <UnsavedChangesDialog
        open={blocker.state === "blocked"}
        saving={guardSaving}
        failed={guardFailed}
        onSave={() => void onGuardSave()}
        onDiscard={() => (blocker.state === "blocked" ? blocker.proceed() : undefined)}
        onCancel={() => {
          setGuardFailed(false);
          if (blocker.state === "blocked") {
            blocker.reset();
          }
        }}
      />
    </>
  );
}

/** Heading of the toasts shown when a plan cannot be opened. */
const OPEN_ERROR_TITLE = "Could not open the release plan";

type LoadState = { kind: "loading" } | { kind: "error"; messages: string[] };

/** Parses the `:id` route parameter; `null` unless it is a positive integer. */
function parsePlanId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Release Plan board page (`/release-plan/:id`). Shows the store's plan when it
 * already holds that id (right after creating it); otherwise shows a loading
 * state, fetches the plan (`GET /api/plan/{id}`), normalizes its state and puts
 * it in the store. A non-numeric id, a 404 or an unreadable state toasts and
 * redirects to `/release-plan`; other errors show the message with a Retry
 * button. The request is aborted and the store's plan cleared when the page
 * unmounts or the id changes, so reopening a plan always reloads it from the
 * server.
 */
export function ReleasePlanBoardPage() {
  const { id: rawId } = useParams();
  const planKey = parsePlanId(rawId);
  const { plan, planId, loadPlan, clearPlan } = useReleasePlan();
  const { showError } = useToast();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const held = useRef({ plan, planId });
  held.current = { plan, planId };
  // Set when the plan was just cleared, so a remount (StrictMode) doesn't trust the store's stale snapshot.
  const cleared = useRef(false);

  useEffect(() => {
    if (planKey === null) {
      showError(["Release plan not found"], OPEN_ERROR_TITLE);
      navigate("/release-plan", { replace: true });
      return;
    }
    const inStore = !cleared.current && held.current.plan !== null && held.current.planId === planKey;
    cleared.current = false;
    if (inStore) {
      return;
    }
    const controller = new AbortController();
    setState({ kind: "loading" });
    const leave = (message: string) => {
      showError([message], OPEN_ERROR_TITLE);
      navigate("/release-plan", { replace: true });
    };
    getPlan(planKey, controller.signal).then(
      (detail) => {
        if (controller.signal.aborted) {
          return;
        }
        let loaded: ReleasePlan;
        try {
          loaded = normalizePlan(detail.state);
        } catch {
          leave("This release plan could not be read");
          return;
        }
        loadPlan(planKey, loaded);
      },
      (exc: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        if (exc instanceof ApiError && exc.status === 404) {
          leave("Release plan not found");
        } else {
          setState({ kind: "error", messages: errorMessages(exc) });
        }
      },
    );
    return () => controller.abort();
  }, [planKey, attempt, loadPlan, navigate, showError]);

  useEffect(
    () => () => {
      cleared.current = true;
      clearPlan();
    },
    [planKey, clearPlan],
  );

  if (planKey !== null && plan !== null && planId === planKey) {
    return (
      <ReleasePlanLayout page="Board">
        <LoadedBoard key={planKey} planId={planKey} plan={plan} />
      </ReleasePlanLayout>
    );
  }
  return (
    <ReleasePlanLayout page="Board">
      {state.kind === "error" ? (
        <div className="flex flex-wrap items-center gap-3">
          <div role="alert" className="text-red-400">
            {state.messages.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded border border-slate-600 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
          >
            Retry
          </button>
        </div>
      ) : (
        <p role="status" className="text-slate-400">
          Loading release plan…
        </p>
      )}
    </ReleasePlanLayout>
  );
}
