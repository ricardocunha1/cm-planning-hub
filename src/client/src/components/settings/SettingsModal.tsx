import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { PAT_REQUIRED, URL_REQUIRED, validateProjectUrl } from "../../lib/ado/url";
import type { AdoCredential } from "../../lib/settings/types";
import { useSettings } from "../../settingsStore";
import { ConfirmDialog } from "../ConfirmDialog";
import { errorMessages, useToast } from "../Toast";
import { useDialog } from "../useDialog";

/** Error shown for an empty project name. */
export const NAME_REQUIRED = "Enter a project name.";
/** Masked stand-in shown for a stored PAT; the real PAT is never rendered. */
export const MASKED_PAT = "••••••••";

const inputClass =
  "block w-full rounded border border-line-bold bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";
const primaryButton =
  "rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const secondaryButton =
  "rounded border border-line-bold px-4 py-2 text-sm font-medium text-fg-soft hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";
const smallButton =
  "rounded border border-line-bold px-2.5 py-1 text-xs font-medium text-fg-soft hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";

type Field = "name" | "url" | "pat";

interface FormErrors {
  messages: string[];
  fields: ReadonlySet<Field>;
}

const NO_ERRORS: FormErrors = { messages: [], fields: new Set() };

/** The form being shown: a new entry, or an existing one being edited. */
type FormTarget = { mode: "add" } | { mode: "edit"; credential: AdoCredential };

/**
 * Shape error of a project URL when it is valid for neither Azure DevOps source
 * (Collaboration Hub or On-Prem), else `null`. The source is not stored, so the URL
 * only has to satisfy one of the two sets of rules; the shape message follows the host.
 */
function urlError(url: string): string | null {
  if (!url.trim()) {
    return URL_REQUIRED;
  }
  const cloud = validateProjectUrl("cloud", url);
  const onprem = validateProjectUrl("onprem", url);
  if (cloud === null || onprem === null) {
    return null;
  }
  return /^https:\/\/([^/]+\.)?(dev\.azure\.com|visualstudio\.com)(\/|$)/i.test(url.trim()) ? cloud : onprem;
}

function formErrors(target: FormTarget, name: string, url: string, pat: string): FormErrors {
  const messages: string[] = [];
  const fields = new Set<Field>();
  if (!name.trim()) {
    messages.push(NAME_REQUIRED);
    fields.add("name");
  }
  const shape = urlError(url);
  if (shape) {
    messages.push(shape);
    fields.add("url");
  }
  if (target.mode === "add" && !pat.trim()) {
    messages.push(PAT_REQUIRED);
    fields.add("pat");
  }
  return { messages, fields };
}

export interface SettingsModalProps {
  /** Whether the modal is shown; it starts fresh (no form, no typed PAT) every time it opens. */
  open: boolean;
  onClose: () => void;
}

/**
 * User settings: manage the Azure DevOps credentials (project name, project URL, PAT)
 * stored on the server. Loads the list when it opens. Stored PATs are never shown, only
 * a masked "PAT saved" indicator; the PAT field is a password input that opts out of
 * password managers, is required when adding, and on edit an empty value keeps the saved
 * PAT (it is then omitted from the request). The typed PAT lives only in the form's
 * state and is cleared after a save and when the modal closes. Failed requests show a toast.
 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  return open ? <SettingsDialog onClose={onClose} /> : null;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { items, status, ensureLoaded, load, add, update, remove } = useSettings();
  const { showError, showInfo } = useToast();
  const titleId = useId();
  const nameId = useId();
  const urlId = useId();
  const patId = useId();
  const patHelpId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  const [target, setTarget] = useState<FormTarget | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [pat, setPat] = useState("");
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const [pending, setPending] = useState(false);
  const [toDelete, setToDelete] = useState<AdoCredential | null>(null);

  useDialog({ open: true, onClose, dialogRef });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  const openForm = (next: FormTarget) => {
    setTarget(next);
    setName(next.mode === "edit" ? next.credential.projectName : "");
    setUrl(next.mode === "edit" ? next.credential.projectUrl : "");
    setPat("");
    setErrors(NO_ERRORS);
  };

  const closeForm = () => {
    setTarget(null);
    setPat("");
    setErrors(NO_ERRORS);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || pending) {
      return;
    }
    const fieldErrors = formErrors(target, name, url, pat);
    if (fieldErrors.messages.length > 0) {
      setErrors(fieldErrors);
      return;
    }
    setErrors(NO_ERRORS);
    setPending(true);
    const projectName = name.trim();
    const projectUrl = url.trim();
    const typedPat = pat.trim();
    try {
      if (target.mode === "add") {
        await add({ projectName, projectUrl, pat: typedPat });
      } else {
        await update(target.credential.id, typedPat ? { projectName, projectUrl, pat: typedPat } : { projectName, projectUrl });
      }
      if (mounted.current) {
        closeForm();
      }
      showInfo(target.mode === "add" ? "Project saved." : "Project updated.");
    } catch (exc) {
      showError(errorMessages(exc), "Could not save the project");
    } finally {
      if (mounted.current) {
        setPending(false);
      }
    }
  };

  const confirmDelete = async () => {
    const credential = toDelete;
    if (!credential) {
      return;
    }
    setToDelete(null);
    try {
      await remove(credential.id);
      if (mounted.current && target?.mode === "edit" && target.credential.id === credential.id) {
        closeForm();
      }
      showInfo("Project deleted.");
    } catch (exc) {
      showError(errorMessages(exc), "Could not delete the project");
    }
  };

  const invalidProps = (field: Field, describedBy?: string) => {
    const invalid = errors.fields.has(field);
    const ids = [describedBy, invalid ? errorId : undefined].filter(Boolean).join(" ");
    return { "aria-invalid": invalid ? true : undefined, "aria-describedby": ids || undefined };
  };

  const editing = target?.mode === "edit";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" data-testid="settings-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-full w-full max-w-2xl flex-col rounded-lg border border-line-strong bg-surface shadow-xl"
      >
        <div className="border-b border-line px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold">
            Settings
          </h2>
        </div>
        <div className="space-y-5 overflow-y-auto px-6 py-5 text-sm">
          <section aria-label="Azure DevOps projects" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-medium text-fg-soft">Azure DevOps projects</h3>
              {!target && status === "ready" && (
                <button type="button" onClick={() => openForm({ mode: "add" })} className={smallButton}>
                  Add project
                </button>
              )}
            </div>
            <p className="text-xs text-fg-subtle">
              Saved Personal Access Tokens are stored encrypted on the server and are never shown again.
            </p>
            {status === "loading" || status === "idle" ? (
              <p role="status" className="text-fg-muted">
                Loading…
              </p>
            ) : status === "error" ? (
              <div className="flex items-center gap-3 text-danger">
                <p>Could not load your saved projects.</p>
                <button type="button" onClick={() => void load()} className={smallButton}>
                  Retry
                </button>
              </div>
            ) : items.length === 0 ? (
              <p className="text-fg-muted">No saved projects yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded border border-line">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-fg">{item.projectName}</p>
                      <p className="truncate text-xs text-fg-subtle">{item.projectUrl}</p>
                      {item.hasPat && (
                        <p className="text-xs text-fg-muted">
                          <span aria-hidden="true">{MASKED_PAT}</span> <span>PAT saved</span>
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => openForm({ mode: "edit", credential: item })}
                        aria-label={`Edit ${item.projectName}`}
                        className={smallButton}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setToDelete(item)}
                        aria-label={`Delete ${item.projectName}`}
                        className={smallButton}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {target && (
            <form
              onSubmit={(event) => void onSubmit(event)}
              noValidate
              aria-label={editing ? "Edit project" : "Add project"}
              className="space-y-4 border-t border-line pt-4"
            >
              <div className="space-y-1">
                <label htmlFor={nameId} className="block font-medium text-fg-soft">
                  Project name
                </label>
                <input
                  id={nameId}
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  {...invalidProps("name")}
                  className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <label htmlFor={urlId} className="block font-medium text-fg-soft">
                  Project URL
                </label>
                <input
                  id={urlId}
                  type="url"
                  value={url}
                  placeholder="https://dev.azure.com/<ORGANIZATION>/<PROJECT_NAME>"
                  onChange={(event) => setUrl(event.target.value)}
                  spellCheck={false}
                  {...invalidProps("url")}
                  className={inputClass}
                />
              </div>
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
                  onChange={(event) => setPat(event.target.value)}
                  {...invalidProps("pat", patHelpId)}
                  className={inputClass}
                />
                <p id={patHelpId} className="text-xs text-fg-subtle">
                  {editing ? "Leave blank to keep the saved PAT. " : ""}Needs the Work Items (Read) scope.
                </p>
              </div>
              {errors.messages.length > 0 && (
                <div id={errorId} role="alert" className="space-y-1 text-danger">
                  {errors.messages.map((message) => (
                    <p key={message}>{message}</p>
                  ))}
                </div>
              )}
              <div className="flex gap-3">
                <button type="submit" disabled={pending} className={primaryButton} style={{ backgroundColor: "var(--cm-light-blue)" }}>
                  {pending ? "Saving…" : "Save"}
                </button>
                <button type="button" onClick={closeForm} disabled={pending} className={secondaryButton}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
        <div className="flex justify-end border-t border-line px-6 py-4">
          <button type="button" onClick={onClose} className={secondaryButton}>
            Close
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        title="Delete project?"
        message={toDelete ? `Delete "${toDelete.projectName}" and its saved PAT?` : ""}
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setToDelete(null)}
      />
    </div>,
    document.body,
  );
}
