import type { BoardOrientation } from "../../lib/releasePlan/layout";
import { sourceInfo } from "../../lib/releasePlan/selectors";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import { zoomLabel } from "../../lib/releasePlan/zoom";
import { useReleasePlan } from "../../releasePlanStore";
import { FlipIcon } from "../icons/FlipIcon";
import { SyncIcon } from "../icons/SyncIcon";
import { CommitInput } from "./CommitInput";
import { ModeSwitch } from "./ModeSwitch";

/** Which view the board page shows (UI-only state, not stored). */
export type BoardView = "board" | "table";

/**
 * Board toolbar: editable plan name + source line, Board/Table tabs,
 * Releases/Sprints switch, zoom (− 100% + Fit) and the "Flip board" toggle
 * (`aria-pressed` while flipped; both hidden in Table view), then a
 * spacer and the "Sync from ADO" button (with a decorative sync icon before its
 * label) and the primary "Export PNG" button, both shown in both views.
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
