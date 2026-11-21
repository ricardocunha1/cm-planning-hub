import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { SOURCE_LABELS, sameProjectUrl } from "../../lib/ado/url";
import { adoBacklog } from "../../lib/releasePlan/adoApi";
import type { AdoBacklog, AdoConnection, AdoScopeType } from "../../lib/releasePlan/adoTypes";
import { planConnection } from "../../lib/releasePlan/selectors";
import type { PlanSource } from "../../lib/releasePlan/types";
import { useSettings } from "../../settingsStore";
import { errorMessages } from "../Toast";
import { useDialog } from "../useDialog";

interface AdoSyncModalProps {
  /** Whether the modal is shown; it starts fresh (no error) every time it opens. */
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

const primaryButton =
  "rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const secondaryButton =
  "rounded border border-line-bold px-4 py-2 text-sm font-medium text-fg-soft hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";

/**
 * Sync dialog of the Release Plan board ("Sync from Azure DevOps"). The
 * connection (source, project URL, Area/Iteration path) comes from
 * `plan.source` and is shown read-only. There is no PAT field: the request to
 * `/api/ado/backlog` omits it and the server uses the signed-in user's PAT
 * stored for the plan's project URL. The Settings projects are loaded with the
 * settings store (loading and retry states); the one whose URL matches the
 * plan's (case-insensitive, trailing slash ignored) is shown (redacted, read-only) as the
 * credential in use and enables "Preview changes". Without a match the dialog says so and
 * offers "Open settings" while Preview stays disabled. "Preview changes" hands
 * the backlog to `onBacklog`; a server error (e.g. a missing or expired PAT)
 * shows inline with a hint to edit the project in Settings and the modal stays
 * open. A board that isn't linked to an Azure DevOps project gets an
 * explanation and a Close button only.
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

/** Dots plus the last 4 characters of the saved PAT (only the dots when unknown); never the PAT itself. */
function redactedPat(last4: string | null): string {
  return last4 ? `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 ${last4}` : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
}

/** The read-only connection, the saved-credential status and the Cancel / Preview changes buttons. */
function SyncForm({ connection, onClose, onBacklog }: { connection: AdoConnection } & Pick<AdoSyncModalProps, "onClose" | "onBacklog">) {
  const errorId = useId();
  const patId = useId();
  const abortRef = useRef<AbortController | null>(null);
  const { items, status, ensureLoaded, load: reloadProjects, openSettings } = useSettings();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  // Abort whatever is in flight when the modal closes (unmounts).
  useEffect(() => () => abortRef.current?.abort(), []);

  const credential = items.find((item) => sameProjectUrl(item.projectUrl, connection.projectUrl)) ?? null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !credential) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setErrors([]);
    setBusy(true);
    try {
      const backlog = await adoBacklog(connection, controller.signal);
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
        {status === "idle" || status === "loading" ? (
          <p role="status" className="text-fg-muted">
            Loading your projects…
          </p>
        ) : status === "error" ? (
          <div className="flex items-center gap-3 text-danger">
            <p>Could not load your projects.</p>
            <button type="button" onClick={() => void reloadProjects()} className={secondaryButton}>
              Retry
            </button>
          </div>
        ) : credential ? (
          <div className="space-y-1">
            <label htmlFor={patId} className="block font-medium text-fg-soft">
              Personal Access Token
            </label>
            <input
              id={patId}
              type="text"
              readOnly
              autoComplete="off"
              value={redactedPat(credential.patLast4)}
              className="w-full rounded border border-line-bold bg-surface-raised px-3 py-2 text-fg-muted focus:outline-none"
            />
            <p className="text-xs text-fg-subtle">
              Saved in Settings as <span className="font-medium text-fg-soft">{credential.projectName}</span>
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-fg-muted">No saved Personal Access Token for this project.</p>
            <button type="button" onClick={openSettings} className={secondaryButton}>
              Open settings
            </button>
          </div>
        )}
        {errors.length > 0 && (
          <div id={errorId} role="alert" className="space-y-1 text-danger">
            {errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        )}
        {errors.length > 0 && (
          <p className="text-xs text-fg-subtle">
            If the Personal Access Token is missing or expired, edit the project in{" "}
            <button type="button" onClick={openSettings} className="underline hover:text-fg-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]">
              Settings
            </button>
            .
          </p>
        )}
      </div>
      <div className="flex justify-end gap-3 px-6 py-4 border-t border-line">
        <button type="button" onClick={onClose} className={secondaryButton}>
          Cancel
        </button>
        <button type="submit" disabled={busy || status !== "ready" || !credential} className={primaryButton} style={{ backgroundColor: "var(--cm-light-blue)" }}>
          {busy ? "Loading work items…" : "Preview changes"}
        </button>
      </div>
    </form>
  );
}
