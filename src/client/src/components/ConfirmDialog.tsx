import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "./useDialog";

export interface ConfirmDialogProps {
  /** Whether the dialog is shown. */
  open: boolean;
  /** Dialog heading; also its accessible name. */
  title: string;
  /** Body text; newlines are preserved (`white-space: pre-line`). */
  message: string;
  /** Label of the confirm button, which receives focus on open. */
  confirmLabel: string;
  /** Label of the cancel button (default "Cancel"). */
  cancelLabel?: string;
  /** Called when the confirm button is clicked. The dialog does not close itself. */
  onConfirm: () => void;
  /** Called on Cancel, Esc and a backdrop click. */
  onCancel: () => void;
}

/**
 * Controlled confirmation modal, used instead of native browser confirm dialogs.
 *
 * Follows the `HelpModal` pattern (no provider): the call site keeps the
 * "pending" state and renders one `<ConfirmDialog>`, closing it from
 * `onConfirm`/`onCancel`. Focuses the confirm button on open and restores the
 * previous focus on close; Esc and the Tab focus trap only apply while it is the
 * topmost dialog (see `useDialog`), so it can be stacked on another modal.
 * Rendered in a portal on `document.body`, so it works inside transformed
 * (zoomed) containers.
 */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel = "Cancel", onConfirm, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog({ open, onClose: onCancel, dialogRef, initialFocusRef: confirmRef });

  if (!open) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" data-testid="confirm-dialog-backdrop" onClick={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="relative w-full max-w-md rounded-lg border border-line-strong bg-surface shadow-xl"
      >
        <div className="px-6 py-4 border-b border-line">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
        </div>
        <p id={messageId} className="px-6 py-5 text-sm text-fg-muted" style={{ whiteSpace: "pre-line" }}>
          {message}
        </p>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line-bold px-4 py-2 text-sm font-medium text-fg-soft hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            style={{ backgroundColor: "var(--cm-light-blue)" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
