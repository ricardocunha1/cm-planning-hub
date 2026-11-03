import type { BoardOrientation } from "../../lib/releasePlan/layout";
import { sourceInfo } from "../../lib/releasePlan/selectors";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import { zoomLabel } from "../../lib/releasePlan/zoom";
import { useReleasePlan } from "../../releasePlanStore";
import { FlipIcon } from "../icons/FlipIcon";
import { SaveIcon } from "../icons/SaveIcon";
import { SyncIcon } from "../icons/SyncIcon";
import { CommitInput } from "./CommitInput";
import { ModeSwitch } from "./ModeSwitch";
import type { SaveStatus } from "./usePlanPersistence";

/** Text of the save status indicator. */
export const SAVE_STATUS_LABEL: Readonly<Record<SaveStatus, string>> = {
  saved: "Saved",
  dirty: "Unsaved changes",
  saving: "Saving…",
  error: "Save failed",
};

/** Which view the board page shows (UI-only state, not stored). */
export type BoardView = "board" | "table";

/**
 * Board toolbar: editable plan name + source line, Board/Table tabs,
 * Releases/Sprints switch, zoom (− 100% + Fit) and the "Flip board" toggle
 * (`aria-pressed` while flipped; both hidden in Table view), then a
 * spacer and the "Sync from ADO" button (with a decorative sync icon before its
 * label) and the primary "Export PNG" button, both shown in both views.
 *
 * Before them: the "Autosave" toggle (a checkbox with `role="switch"`), the save status text
 * (`data-testid="save-status"`, a polite live region) and, when autosave is
 * off or the last save failed, a "Save" button with a floppy-disk icon (disabled while status is `saved`).
 */
export function BoardToolbar({
  plan,
  view,
  onViewChange,
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  orientation,
  onFlip,
  onSync,
  onExportPng,
  exporting,
  saveStatus,
  autosave,
  onAutosaveChange,
  onSave,
}: {
  plan: ReleasePlan;
  view: BoardView;
  onViewChange: (view: BoardView) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Board orientation shown (UI-only state of the page). */
  orientation: BoardOrientation;
  /** "Flip board": toggles between the standard and the flipped orientation. */
  onFlip: () => void;
  /** "Sync from ADO": opens the Azure DevOps connection form (the page owns the sync flow). */
  onSync: () => void;
  /** "Export PNG": downloads an image of the board. */
  onExportPng: () => void;
  /** An export is running: "Export PNG" is disabled. */
  exporting: boolean;
  /** Save state of the plan on the server. */
  saveStatus: SaveStatus;
  /** Whether changes are saved automatically. */
  autosave: boolean;
  /** Autosave switch toggled. */
  onAutosaveChange: (on: boolean) => void;
  /** "Save": saves now. */
  onSave: () => void;
}) {
  const { dispatch } = useReleasePlan();
  return (
    <div className="toolbar">
      <div className="title">
        <CommitInput
          aria-label="Plan name"
          value={plan.name}
          style={{ width: `${plan.name.length + 3}ch` }}
          onCommit={(name) => dispatch({ type: "rename", name })}
        />
        <small data-testid="source-info">{sourceInfo(plan.source)}</small>
      </div>
      <div className="tabs" role="tablist" aria-label="View">
        {(["board", "table"] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => onViewChange(v)}>
            {v === "board" ? "Board" : "Table"}
          </button>
        ))}
      </div>
      <ModeSwitch plan={plan} />
      {view === "board" && (
        <div className="zoom" role="group" aria-label="Zoom">
          <button type="button" className="btn" aria-label="Zoom out" onClick={onZoomOut}>
            −
          </button>
          <span data-testid="zoom-value">{zoomLabel(zoom)}</span>
          <button type="button" className="btn" aria-label="Zoom in" onClick={onZoomIn}>
            +
          </button>
          <button type="button" className="btn" onClick={onFit}>
            Fit
          </button>
        </div>
      )}
      {view === "board" && (
        <button
          type="button"
          className="btn flipBtn"
          aria-pressed={orientation === "flipped"}
          title={orientation === "flipped" ? "Flip board: show milestones as rows" : "Flip board: show milestones as columns"}
          onClick={onFlip}
        >
          <FlipIcon className="btnIcon" />
          Flip board
        </button>
      )}
      <div className="spacer" />
      <div className="flex items-center gap-2 text-[12.5px]">
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            role="switch"
            id="autosave-toggle"
            className="sr-only peer"
            checked={autosave}
            aria-checked={autosave}
            onChange={(event) => onAutosaveChange(event.target.checked)}
          />
          <div className="w-9 h-5 rounded-full bg-slate-300 transition-colors peer-checked:bg-[var(--cm-light-blue)] peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-[var(--cm-light-blue)]" />
          <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
        </label>
        <label htmlFor="autosave-toggle" className="cursor-pointer">
          Autosave
        </label>
      </div>
      <span data-testid="save-status" aria-live="polite" className="saveStatus">
        {SAVE_STATUS_LABEL[saveStatus]}
      </span>
      {(!autosave || saveStatus === "error") && (
        <button type="button" className="btn withIcon" onClick={onSave} disabled={saveStatus === "saved" || saveStatus === "saving"}>
          <SaveIcon className="btnIcon" />
          Save
        </button>
      )}
      <button type="button" className="btn withIcon" onClick={onSync}>
        <SyncIcon className="btnIcon" />
        Sync from ADO
      </button>
      <button type="button" className="btn primary" onClick={onExportPng} disabled={exporting}>
        Export PNG
      </button>
    </div>
  );
}
