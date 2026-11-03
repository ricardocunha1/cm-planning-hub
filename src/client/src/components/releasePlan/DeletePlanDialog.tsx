import { ConfirmDialog } from "../ConfirmDialog";

/** Title (and accessible name) of the delete confirmation. */
export const DELETE_PLAN_TITLE = "Delete release plan";

/**
 * "Delete <name>? This cannot be undone." confirmation for a saved plan. Open
 * while `name` is not `null`; the caller closes it from `onConfirm`/`onCancel`.
 */
export function DeletePlanDialog({
  name,
  onConfirm,
  onCancel,
}: {
  /** Name of the plan about to be deleted; `null` keeps the dialog closed. */
  name: string | null;
  /** "Delete": the caller deletes the plan and clears `name`. */
  onConfirm: () => void;
  /** Cancel, Esc or a backdrop click. */
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={name !== null}
      title={DELETE_PLAN_TITLE}
      message={name !== null ? `Delete ${name}? This cannot be undone.` : ""}
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
