import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "../useDialog";

/** Title (and accessible name) of the unsaved-changes guard. */
export const UNSAVED_TITLE = "Unsaved changes";

const secondary =
  "rounded border border-slate-600 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";

/**
 * "Save / Discard / Cancel" prompt shown when the user leaves a board with
 * unsaved changes. Controlled: the caller keeps it `open` while navigation is
 * blocked. Save is focused on open; Esc and a backdrop click act as Cancel.
 * While `saving` the three buttons are disabled; after a failed save
 * (`failed`) the dialog stays open and says so.
 */
export function UnsavedChangesDialog({
  open,
  saving,
  failed,
  onSave,
  onDiscard,
  onCancel,
}: {
  open: boolean;
  /** A save started from the dialog is running. */
  saving: boolean;
  /** The last save started from the dialog failed. */
  failed: boolean;
  /** "Save": the caller saves, then leaves the board if that worked. */
  onSave: () => void;
  /** "Discard": the caller leaves the board without saving. */
  onDiscard: () => void;
  /** Cancel, Esc or a backdrop click: stay on the board. */
  onCancel: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog({ open, onClose: onCancel, dialogRef, initialFocusRef: saveRef });

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" data-testid="unsaved-dialog-backdrop" onClick={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="relative w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
      >
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 id={titleId} className="text-lg font-semibold">
            {UNSAVED_TITLE}
          </h2>
        </div>
        <div id={messageId} className="px-6 py-5 text-sm text-slate-300">
          <p>This release plan has changes that are not saved yet. Save them before leaving?</p>
          {failed && (
            <p role="alert" className="mt-3 text-red-400">
              Save failed. Try again, discard the changes or stay on the board.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-800">
          <button type="button" onClick={onCancel} disabled={saving} className={secondary}>
            Cancel
          </button>
          <button type="button" onClick={onDiscard} disabled={saving} className={secondary}>
            Discard
          </button>
          <button
            ref={saveRef}
            type="button"
            onClick={onSave}
            disabled={saving}
            className="rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
            style={{ backgroundColor: "var(--cm-light-blue)" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
