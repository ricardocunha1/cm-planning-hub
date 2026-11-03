import { useId, useRef, useState } from "react";
import { isDiffEmpty, type EpicField, type FeatureField, type SyncDiff, type SyncItem } from "../../lib/releasePlan/syncDiff";
import { useDialog } from "../useDialog";

const FIELD_LABELS: Record<EpicField | FeatureField, string> = {
  title: "title",
  state: "state",
  description: "description",
  size: "size",
  iterationPath: "iteration",
  epic: "Epic",
};

/** `"1 new Feature"` / `"3 new Features"`. */
function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

interface Row {
  key: string;
  item: SyncItem;
  /** Extra text after the title (changed fields, target Epic, item kind). */
  detail?: string;
}

/** One collapsible section: the count line is the `<summary>`, the items are the list. */
function Section({ label, rows }: { label: string; rows: Row[] }) {
  if (rows.length === 0) {
    return null;
  }
  return (
    <details className="rounded border border-line-strong bg-canvas">
      <summary className="cursor-pointer px-3 py-2 font-medium text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]">
        {label}
      </summary>
      <ul className="max-h-48 space-y-1 overflow-auto border-t border-line px-3 py-2 text-fg-muted">
        {rows.map(({ key, item, detail }) => (
          <li key={key}>
            <span className="text-fg-subtle">#{String(item.id)}</span> {item.title}
            {detail ? <span className="text-fg-subtle"> ({detail})</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Sync preview: what applying the fetched backlog would change on the board,
 * as count lines ("N new Features", "N new Epics", "N updated", "N no longer in
 * scope") that expand to `#id title` lists with the changed fields. Gone items
 * stay unless "Remove items no longer in scope" (shown only when there are some,
 * unticked) is ticked. With no item changes it says the board is up to date
 * (Apply then only refreshes the iterations and the source). Renders nothing
 * while `diff` is `null`; the checkbox resets every time it opens.
 */
export function SyncPreviewDialog({
  diff,
  onApply,
  onCancel,
}: {
  /** The diff to preview; `null` = closed. */
  diff: SyncDiff | null;
  /** Apply, with the state of the "Remove items no longer in scope" checkbox. */
  onApply: (removeGone: boolean) => void;
  /** Cancel, Esc or a backdrop click: nothing changes. */
  onCancel: () => void;
}) {
  return diff ? <SyncPreview diff={diff} onApply={onApply} onCancel={onCancel} /> : null;
}

function SyncPreview({ diff, onApply, onCancel }: { diff: SyncDiff; onApply: (removeGone: boolean) => void; onCancel: () => void }) {
  const titleId = useId();
  const removeId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const [removeGone, setRemoveGone] = useState(false);

  useDialog({ open: true, onClose: onCancel, dialogRef, initialFocusRef: applyRef });

  const empty = isDiffEmpty(diff);
  const updated = diff.updatedEpics.length + diff.updatedFeatures.length;
  const gone = diff.goneEpics.length + diff.goneFeatures.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" data-testid="sync-preview-backdrop" onClick={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-full w-full max-w-xl flex-col rounded-lg border border-line-strong bg-surface shadow-xl"
      >
        <div className="px-6 py-4 border-b border-line">
          <h2 id={titleId} className="text-lg font-semibold">
            Sync from Azure DevOps
          </h2>
        </div>
        <div className="space-y-3 overflow-y-auto px-6 py-5 text-sm">
          {empty ? (
            <>
              <p className="text-fg-soft">The board is up to date with Azure DevOps.</p>
              {diff.iterationsChanged && <p className="text-fg-subtle">The iteration list will be refreshed.</p>}
            </>
          ) : (
            <>
              <Section
                label={count(diff.newFeatures.length, "new Feature", "new Features")}
                rows={diff.newFeatures.map((f) => ({ key: `nf-${String(f.id)}`, item: f, detail: `in ${f.epicTitle}` }))}
              />
              <Section
                label={count(diff.newEpics.length, "new Epic", "new Epics")}
                rows={diff.newEpics.map((e) => ({ key: `ne-${String(e.id)}`, item: e }))}
              />
              <Section
                label={`${updated} updated`}
                rows={[
                  ...diff.updatedEpics.map((e) => ({
                    key: `ue-${String(e.id)}`,
                    item: e,
                    detail: `Epic: ${e.changes.map((c) => FIELD_LABELS[c]).join(", ")}`,
                  })),
                  ...diff.updatedFeatures.map((f) => ({
                    key: `uf-${String(f.id)}`,
                    item: f,
                    detail: f.changes.map((c) => FIELD_LABELS[c]).join(", "),
                  })),
                ]}
              />
              <Section
                label={`${gone} no longer in scope`}
                rows={[
                  ...diff.goneEpics.map((e) => ({ key: `ge-${String(e.id)}`, item: e, detail: "Epic" })),
                  ...diff.goneFeatures.map((f) => ({ key: `gf-${String(f.id)}`, item: f })),
                ]}
              />
              <p className="text-fg-subtle">New Features are added to Unplanned. Existing planning is kept.</p>
              {gone > 0 && (
                <label htmlFor={removeId} className="flex items-center gap-2 text-fg-soft">
                  <input
                    id={removeId}
                    type="checkbox"
                    checked={removeGone}
                    onChange={(event) => setRemoveGone(event.target.checked)}
                    className="accent-[color:var(--cm-light-blue)]"
                  />
                  Remove items no longer in scope
                </label>
              )}
            </>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-line-bold px-4 py-2 text-sm font-medium text-fg-soft hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
          >
            Cancel
          </button>
          <button
            ref={applyRef}
            type="button"
            onClick={() => onApply(gone > 0 && removeGone)}
            className="rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            style={{ backgroundColor: "var(--cm-light-blue)" }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
