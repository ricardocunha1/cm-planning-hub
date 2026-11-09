import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { deletePlan, listPlans } from "../../lib/releasePlan/planApi";
import type { PlanListResponse, PlanSummary } from "../../lib/releasePlan/planTypes";
import { projectLabel } from "../../lib/releasePlan/selectors";
import { errorMessages, useToast } from "../Toast";
import { TrashIcon } from "../icons/TrashIcon";
import { DeletePlanDialog } from "./DeletePlanDialog";

type ListState = { kind: "loading" } | { kind: "error"; messages: string[] } | { kind: "ready"; data: PlanListResponse };

const buttonClass =
  "rounded border border-line-bold px-3 py-1.5 text-sm font-medium text-fg-soft hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";

const formatDate = (iso: string): string => new Date(iso).toLocaleString();

/**
 * "Saved release plans" on the Release Plan home page: one page of the server's
 * plans (most recently updated first) as a table (name linking to the board,
 * project, created, last modified, Delete), with Previous/Next and "Page X of Y"
 * when there is more than one page. Shows loading, empty and error (with Retry)
 * states. Delete asks {@link DeletePlanDialog}, then calls `deletePlan`, toasts
 * and refetches the page (one page back when it was the last item of a page
 * after the first); a failure shows an error toast and refetches the page. A page past the end
 * (with `total > 0`) moves to the last page. A list request is aborted
 * on unmount and when the page changes, and aborted responses are ignored.
 */
export function PlanList() {
  const { showInfo, showError } = useToast();
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [pendingDelete, setPendingDelete] = useState<PlanSummary | null>(null);
  const deleting = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    listPlans(page, controller.signal).then(
      (data) => {
        if (controller.signal.aborted) {
          return;
        }
        if (data.items.length === 0 && data.total > 0 && page > 1) {
          // The page is past the end (rows were deleted elsewhere): go to the last page.
          setPage(Math.max(1, Math.min(page - 1, Math.ceil(data.total / data.pageSize))));
          return;
        }
        setState({ kind: "ready", data });
      },
      (exc: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: "error", messages: errorMessages(exc) });
        }
      },
    );
    return () => controller.abort();
  }, [page, reloadKey]);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);
  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const confirmDelete = async () => {
    if (!pendingDelete || deleting.current) {
      return;
    }
    const target = pendingDelete;
    deleting.current = true;
    try {
      await deletePlan(target.id);
      showInfo(`Plan deleted: ${target.name}`);
      const emptiesPage = state.kind === "ready" && state.data.items.length === 1 && page > 1;
      if (emptiesPage) {
        setPage(page - 1);
      } else {
        retry();
      }
    } catch (exc) {
      showError(errorMessages(exc), "Could not delete the plan");
      retry(); // the row may be gone already (e.g. deleted elsewhere): show the real list
    } finally {
      deleting.current = false;
      setPendingDelete(null);
    }
  };

  return (
    <section aria-labelledby="saved-plans-heading" className="mt-12">
      <h3 id="saved-plans-heading" className="text-2xl font-semibold">
        Saved release plans
      </h3>
      {state.kind === "loading" && (
        <p role="status" className="mt-4 text-fg-subtle">
          Loading saved release plans…
        </p>
      )}
      {state.kind === "error" && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <div role="alert" className="text-danger">
            {state.messages.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
          <button type="button" onClick={retry} className={buttonClass}>
            Retry
          </button>
        </div>
      )}
      {state.kind === "ready" && state.data.items.length === 0 && (
        <p className="mt-4 text-fg-subtle">No saved release plans yet. Create one from Azure DevOps.</p>
      )}
      {state.kind === "ready" && state.data.items.length > 0 && (
        <>
          <div className="mt-4 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface text-fg-subtle">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Project
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Created On
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Last modified
                  </th>
                  <th scope="col" className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.data.items.map((item) => (
                  <tr key={item.id} className="border-t border-line">
                    <td className="px-4 py-2">
                      <Link
                        to={`/release-plan/${item.id}`}
                        className="font-medium text-[color:var(--cm-light-blue)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
                      >
                        {item.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-fg-muted">{projectLabel(item.projectType, item.projectName)}</td>
                    <td className="px-4 py-2 text-fg-muted">{formatDate(item.createdAt)}</td>
                    <td className="px-4 py-2 text-fg-muted">{formatDate(item.updatedAt)}</td>
                    <td className="px-4 py-2 text-right">
                      <button type="button" aria-label={`Delete ${item.name}`} onClick={() => setPendingDelete(item)}
                        title="Delete"
                        className="rounded border border-danger/60 p-1.5 text-danger hover:bg-danger hover:text-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-danger"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.data.total > state.data.pageSize && (
            <nav aria-label="Pagination" className="mt-3 flex items-center justify-end gap-3 text-sm text-fg-muted">
              <button type="button" onClick={() => setPage(page - 1)} disabled={page <= 1} className={buttonClass}>
                Previous
              </button>
              <span>
                Page {page} of {Math.ceil(state.data.total / state.data.pageSize)}
              </span>
              <button
                type="button"
                onClick={() => setPage(page + 1)}
                disabled={page >= Math.ceil(state.data.total / state.data.pageSize)}
                className={buttonClass}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
      <DeletePlanDialog name={pendingDelete ? pendingDelete.name : null} onConfirm={() => void confirmDelete()} onCancel={cancelDelete} />
    </section>
  );
}
