import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { PAT_REQUIRED, SOURCE_LABELS } from "../../lib/ado/url";
import { adoBacklog } from "../../lib/releasePlan/adoApi";
import type { AdoBacklog, AdoConnection, AdoScopeType } from "../../lib/releasePlan/adoTypes";
import { planConnection } from "../../lib/releasePlan/selectors";
import type { PlanSource } from "../../lib/releasePlan/types";
import { errorMessages } from "../Toast";
import { useDialog } from "../useDialog";

interface AdoSyncModalProps {
  /** Whether the modal is shown; it starts fresh (no PAT, no error) every time it opens. */
  open: boolean;
  /** The board's `plan.source`; its connection is read when the modal opens. */
  source: PlanSource;
  /** Cancel, Esc or a backdrop click; an in-flight request is aborted. */
  onClose: () => void;
  /** The fetched backlog and the connection it came from (no PAT); the caller closes the modal. */
  onBacklog: (backlog: AdoBacklog, connection: AdoConnection) => void;
}

const SCOPE_LABELS: Readonly<Record<AdoScopeType, string>> = {
  area: "Area path",
  iteration: "Iteration path",
};

const inputClass =
  "block w-full rounded border border-line-bold bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";
const primaryButton =
  "rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const secondaryButton =
  "rounded border border-line-bold px-4 py-2 text-sm font-medium text-fg-soft hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";

/**
 * Sync dialog of the Release Plan board ("Sync from Azure DevOps"). The
 * connection (source, project URL, Area/Iteration path) comes from
 * `plan.source` and is shown read-only; only the Personal Access Token is typed
 * in, and it lives only in this component's state. "Preview changes" posts
 * `/api/ado/backlog` and hands the result to `onBacklog`; a blank PAT or a
 * server error shows inline and the modal stays open. A board that isn't
 * linked to an Azure DevOps project gets an explanation and a Close button only.
 */
export function AdoSyncModal({ open, ...props }: AdoSyncModalProps) {
  return open ? <AdoSyncDialog {...props} /> : null;
}

function AdoSyncDialog({ source, onClose, onBacklog }: Omit<AdoSyncModalProps, "open">) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Snapshot on open, so the request and the displayed values can't disagree.
  const [connection] = useState(() => planConnection(source));

  useDialog({ open: true, onClose, dialogRef });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" data-testid="ado-sync-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-full w-full max-w-2xl flex-col rounded-lg border border-line-strong bg-surface shadow-xl"
      >
        <div className="px-6 py-4 border-b border-line">
          <h2 id={titleId} className="text-lg font-semibold">
            Sync from Azure DevOps
          </h2>
        </div>
        {connection ? (
          <SyncForm connection={connection} onClose={onClose} onBacklog={onBacklog} />
        ) : (
          <>
            <div className="space-y-2 px-6 py-5 text-sm text-fg-muted">
              <p>This board isn&apos;t linked to an Azure DevOps project, so it can&apos;t be synced.</p>
              <p>To sync with Azure DevOps, create the board from Azure DevOps on the Release Plan page.</p>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
              <button type="button" onClick={onClose} className={secondaryButton}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The read-only connection, the PAT input and the Cancel / Preview changes buttons. */
function SyncForm({ connection, onClose, onBacklog }: { connection: AdoConnection } & Pick<AdoSyncModalProps, "onClose" | "onBacklog">) {
  const patId = useId();
  const patHelpId = useId();
  const errorId = useId();
  const abortRef = useRef<AbortController | null>(null);
  const [pat, setPat] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [patInvalid, setPatInvalid] = useState(false);

  // Abort whatever is in flight when the modal closes (unmounts).
  useEffect(() => () => abortRef.current?.abort(), []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (!pat.trim()) {
      setErrors([PAT_REQUIRED]);
      setPatInvalid(true);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setErrors([]);
    setPatInvalid(false);
    setBusy(true);
    try {
      const backlog = await adoBacklog({ ...connection, pat }, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      setBusy(false);
      onBacklog(backlog, connection);
    } catch (exc) {
      if (!controller.signal.aborted) {
        setErrors(errorMessages(exc));
        setBusy(false);
      }
    }
  };

  const describedBy = [patHelpId, patInvalid ? errorId : undefined].filter(Boolean).join(" ");

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex min-h-0 flex-col">
      <div className="space-y-4 overflow-y-auto px-6 py-5 text-sm">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
          <dt className="font-medium text-fg-soft">Azure DevOps source</dt>
          <dd className="text-fg-muted">{SOURCE_LABELS[connection.source]}</dd>
          <dt className="font-medium text-fg-soft">Project URL</dt>
          <dd className="break-all text-fg-muted">{connection.projectUrl}</dd>
          <dt className="font-medium text-fg-soft">{SCOPE_LABELS[connection.scopeType]}</dt>
          <dd className="break-all text-fg-muted">{connection.scopePath}</dd>
        </dl>
        <div className="space-y-1">
          <label htmlFor={patId} className="block font-medium text-fg-soft">
            Personal Access Token
          </label>
          <input
            id={patId}
            type="password"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            value={pat}
            onChange={(event) => {
              setPat(event.target.value);
              setErrors([]);
              setPatInvalid(false);
            }}
            aria-invalid={patInvalid ? true : undefined}
            aria-describedby={describedBy}
            className={inputClass}
          />
          <p id={patHelpId} className="text-xs text-fg-subtle">
            Needs the Work Items (Read) scope. It is sent only to connect and is never stored.
          </p>
        </div>
        {errors.length > 0 && (
          <div id={errorId} role="alert" className="space-y-1 text-danger">
            {errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
        <button type="button" onClick={onClose} className={secondaryButton}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className={primaryButton} style={{ backgroundColor: "var(--cm-light-blue)" }}>
          {busy ? "Loading work items…" : "Preview changes"}
        </button>
      </div>
    </form>
  );
}
