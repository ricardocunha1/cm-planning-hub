import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { adoConnect } from "../../lib/ado/api";
import { loadAdoConnection, saveAdoConnection } from "../../lib/ado/connectionStorage";
import type { AdoConnectResponse, AdoConnection, AdoScopeType, AdoScopedRequest, AdoSource } from "../../lib/ado/types";
import { PROJECT_REQUIRED, sourceOf } from "../../lib/ado/url";
import { useSettings } from "../../settingsStore";
import { errorMessages } from "../Toast";
import { useDialog } from "../useDialog";
import { PathTree } from "./PathTree";

/** The path trees a modal offers: one (no toggle) or both (an "Area path" / "Iteration path" toggle). */
export type AdoScopeTypes = readonly [AdoScopeType, ...AdoScopeType[]];

/** An optional required text field (e.g. the name of the plan to create) shown after Connect, above the submit button. */
export interface AdoNameField {
  /** Field label, e.g. "Plan name". */
  label: string;
  /** Initial value, derived from the connected project's name; the user can edit it. */
  defaultName: (projectName: string) => string;
  /** Returns the inline error for `name` (already trimmed), or `null` when it is valid. */
  validate: (name: string) => string | null;
}

export interface AdoConnectModalProps<T> {
  /** Whether the modal is shown; it starts fresh every time it opens. */
  open: boolean;
  /** Dialog title, e.g. "Create from Azure DevOps". */
  title: string;
  /** Label of the submit button (it reads "Loading work items…" while `load` runs). */
  submitLabel: string;
  /** Selectable trees, in toggle order; the first is selected initially. */
  scopeTypes: AdoScopeTypes;
  /** localStorage key under which the connection (never the PAT) is remembered after a successful Connect. */
  connectionKey: string;
  /** Cancel, Esc or a backdrop click; an in-flight request is aborted. */
  onClose: () => void;
  /** Extra required name field (see {@link AdoNameField}); `load` then receives its trimmed value. */
  nameField?: AdoNameField;
  /** Fetches the tool's data for the picked path (`name` is `""` without a `nameField`); a rejection is shown inline and the modal stays open. */
  load: (request: AdoScopedRequest, signal: AbortSignal, name: string) => Promise<T>;
  /** The loaded data and the connection it came from (canonical URL, no PAT); the caller closes the modal. */
  onLoaded: (result: T, connection: AdoConnection) => void;
}

const SCOPE_LABELS: Readonly<Record<AdoScopeType, string>> = {
  area: "Area path",
  iteration: "Iteration path",
};

const inputClass =
  "block w-full rounded border border-line-bold bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";
const secondaryButton =
  "rounded border border-line-bold px-3 py-1.5 text-sm font-medium text-fg-soft hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";
const primaryButton =
  "rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/** A field that can be invalid before any request. */
type ConnectionField = "project" | "name";

/** Inline errors plus the fields they are about (linked with `aria-invalid` / `aria-describedby`). */
interface FormErrors {
  messages: string[];
  fields: ReadonlySet<ConnectionField>;
  /** The errors came from a request: also hint at editing the project (its PAT) in Settings. */
  fromRequest?: boolean;
}

const NO_ERRORS: FormErrors = { messages: [], fields: new Set() };

/** Errors not tied to a field (server responses, network failures). */
const requestErrors = (messages: string[]): FormErrors => ({ messages, fields: new Set(), fromRequest: true });

/**
 * Connects to one of the user's Azure DevOps projects (the ones stored in
 * Settings) and loads data for one of its paths; shared by the ADO-backed
 * tools (Release Plan board creation, Monte Carlo sprint history). Step 1: pick
 * a project from a "Project" list (name; its URL shown below) and press
 * **Connect**. The request carries the stored credential's project URL and the
 * source inferred from its host, never a PAT: the server uses the PAT stored
 * for the signed-in user. The list loads with the settings store (loading and
 * retry states); with no project a message and an "Open settings" button are
 * shown and Connect stays disabled. The last connected project is remembered
 * under `connectionKey` (by URL; ignored when it no longer exists). Step 2: a
 * {@link PathTree} of the `scopeTypes` tree (with an "Area path" / "Iteration
 * path" toggle when there are two); the submit button calls `load` and hands its
 * result to `onLoaded`. Changing the project after Connect clears the trees
 * (Connect again); the path picker is disabled while a request runs. With a
 * `nameField`, a required name input (pre-filled from the project name after
 * Connect) is validated before `load`. Errors show inline (invalid fields point
 * at them with `aria-invalid` / `aria-describedby`; request errors add a hint
 * to edit the project in Settings) and the modal stays open.
 */
export function AdoConnectModal<T>({ open, ...props }: AdoConnectModalProps<T>) {
  return open ? <AdoConnectDialog {...props} /> : null;
}

function AdoConnectDialog<T>({
  title,
  submitLabel,
  scopeTypes,
  connectionKey,
  nameField,
  onClose,
  load,
  onLoaded,
}: Omit<AdoConnectModalProps<T>, "open">) {
  const titleId = useId();
  const projectId = useId();
  const projectUrlId = useId();
  const errorId = useId();
  const nameId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { items, status, ensureLoaded, load: reloadProjects, openSettings, settingsOpen } = useSettings();
  const selectRef = useRef<HTMLSelectElement>(null);
  const [prefill] = useState(() => loadAdoConnection(connectionKey));
  // The user's pick (`null` = the empty option); until they pick, the remembered project (by URL) is selected.
  const [pick, setPick] = useState<{ id: number | null } | null>(null);
  const [connectedState, setConnectedState] = useState<{
    source: AdoSource;
    response: AdoConnectResponse;
    /** The Settings entry (id and URL) the Connect was made for. */
    projectId: number;
    requestUrl: string;
  } | null>(null);
  const [scopeType, setScopeType] = useState<AdoScopeType>(scopeTypes[0]);
  const [scopePath, setScopePath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"connect" | "load" | null>(null);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);

  useDialog({ open: true, onClose, dialogRef });

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  const selected =
    (pick ? items.find((item) => item.id === pick.id) : prefill ? items.find((item) => item.projectUrl === prefill.projectUrl) : undefined) ?? null;

  // The connection only counts while its project is still selected with the same URL (Settings may delete or edit it meanwhile).
  const connected =
    connectedState && selected && selected.id === connectedState.projectId && selected.projectUrl.trim() === connectedState.requestUrl
      ? connectedState
      : null;
  const stale = connectedState !== null && connected === null;
  useEffect(() => {
    if (stale) {
      abortRef.current?.abort();
      abortRef.current = null;
      setBusy(null);
      setConnectedState(null);
      setScopePath(null);
    }
  }, [stale]);

  // When Settings closes, focus may have been lost with the unmounted "Open settings" button: move it into this dialog.
  const wasSettingsOpen = useRef(settingsOpen);
  useEffect(() => {
    const closed = wasSettingsOpen.current && !settingsOpen;
    wasSettingsOpen.current = settingsOpen;
    if (closed && !dialogRef.current?.contains(document.activeElement)) {
      (selectRef.current ?? dialogRef.current)?.focus();
    }
  }, [settingsOpen]);

  // Abort whatever is in flight when the modal closes (unmounts).
  useEffect(() => () => abortRef.current?.abort(), []);

  const startRequest = (): AbortController => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  };

  /** Any edit to the connection fields invalidates a previous Connect. */
  const editConnection = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
    setConnectedState(null);
    setScopePath(null);
    setErrors(NO_ERRORS);
  };

  const onConnect = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) {
      return;
    }
    if (!selected) {
      setErrors({ messages: [PROJECT_REQUIRED], fields: new Set(["project"]) });
      return;
    }
    const projectUrl = selected.projectUrl.trim();
    const source = sourceOf(projectUrl);
    const controller = startRequest();
    setErrors(NO_ERRORS);
    setBusy("connect");
    try {
      const response = await adoConnect({ source, projectUrl }, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      saveAdoConnection(connectionKey, { source, projectUrl: selected.projectUrl });
      setConnectedState({ source, response, projectId: selected.id, requestUrl: projectUrl });
      setName(nameField ? nameField.defaultName(response.project.name) : "");
      setScopePath(null);
      setBusy(null);
    } catch (exc) {
      if (!controller.signal.aborted) {
        setErrors(requestErrors(errorMessages(exc)));
        setBusy(null);
      }
    }
  };

  const onSubmit = async () => {
    if (!connected || scopePath === null || busy) {
      return;
    }
    const trimmedName = name.trim();
    const nameError = nameField ? nameField.validate(trimmedName) : null;
    if (nameError) {
      setErrors({ messages: [nameError], fields: new Set(["name"]) });
      return;
    }
    const connection: AdoConnection = {
      source: connected.source,
      projectUrl: connected.response.projectUrl,
      scopeType,
      scopePath,
    };
    const controller = startRequest();
    setErrors(NO_ERRORS);
    setBusy("load");
    try {
      const result = await load(connection, controller.signal, trimmedName);
      if (controller.signal.aborted) {
        return;
      }
      setBusy(null);
      onLoaded(result, connection);
    } catch (exc) {
      if (!controller.signal.aborted) {
        setErrors(requestErrors(errorMessages(exc)));
        setBusy(null);
      }
    }
  };

  const hasErrors = errors.messages.length > 0;
  /** `aria-invalid` + `aria-describedby` linking an invalid field to the inline error. */
  const invalidProps = (field: ConnectionField, describedBy?: string) => {
    const invalid = errors.fields.has(field);
    const ids = [describedBy, invalid ? errorId : undefined].filter(Boolean).join(" ");
    return { "aria-invalid": invalid ? true : undefined, "aria-describedby": ids || undefined };
  };

  const tree = connected ? (scopeType === "area" ? connected.response.areas : connected.response.iterations) : null;
  const scopeLabel = SCOPE_LABELS[scopeType];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" data-testid="ado-connect-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-full focus:outline-none w-full max-w-2xl flex-col rounded-lg border border-line-strong bg-surface shadow-xl"
      >
        <div className="px-6 py-4 border-b border-line">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
        </div>
        <div className="space-y-4 overflow-y-auto px-6 py-5 text-sm">
          <form onSubmit={(event) => void onConnect(event)} noValidate className="space-y-4">
            <div className="space-y-1">
              <label htmlFor={projectId} className="block font-medium text-fg-soft">
                Project
              </label>
              {status === "idle" || status === "loading" ? (
                <p role="status" className="text-fg-muted">
                  Loading projects…
                </p>
              ) : status === "error" ? (
                <div className="flex items-center gap-3 text-danger">
                  <p>Could not load your projects.</p>
                  <button type="button" onClick={() => void reloadProjects()} className={secondaryButton}>
                    Retry
                  </button>
                </div>
              ) : items.length === 0 ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-fg-muted">No Azure DevOps projects configured yet.</p>
                  <button type="button" onClick={openSettings} className={secondaryButton}>
                    Open settings
                  </button>
                </div>
              ) : (
                <>
                  <select
                    id={projectId}
                    ref={selectRef}
                    value={selected?.id ?? ""}
                    onChange={(event) => {
                      setPick({ id: event.target.value === "" ? null : Number(event.target.value) });
                      editConnection();
                    }}
                    {...invalidProps("project", selected ? projectUrlId : undefined)}
                    className={inputClass}
                  >
                    <option value="">Select a project…</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.projectName}
                      </option>
                    ))}
                  </select>
                  {selected && (
                    <p id={projectUrlId} className="break-all text-xs text-fg-subtle">
                      {selected.projectUrl}
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" disabled={busy !== null || status !== "ready" || items.length === 0} className={primaryButton} style={{ backgroundColor: "var(--cm-light-blue)" }}>
                {busy === "connect" ? "Connecting…" : "Connect"}
              </button>
              {connected && (
                <p className="text-fg-muted">
                  Connected to <span className="font-medium text-fg">{connected.response.project.name}</span>.
                </p>
              )}
            </div>
          </form>
          {connected && tree && (
            <section aria-label="Choose a path" aria-busy={busy !== null} className="space-y-3 border-t border-line pt-4">
              {scopeTypes.length > 1 && (
                <div role="radiogroup" aria-label="Path type" aria-disabled={busy !== null ? true : undefined} className="flex flex-wrap gap-4">
                  {scopeTypes.map((value) => (
                    <label key={value} className="flex items-center gap-2 text-fg-soft">
                      <input
                        type="radio"
                        name="ado-scope-type"
                        value={value}
                        checked={scopeType === value}
                        disabled={busy !== null}
                        onChange={() => {
                          setScopeType(value);
                          setScopePath(null);
                          setErrors(NO_ERRORS);
                        }}
                        className="accent-[color:var(--cm-light-blue)]"
                      />
                      {SCOPE_LABELS[value]}
                    </label>
                  ))}
                </div>
              )}
              <PathTree
                key={scopeType}
                root={tree}
                label={scopeLabel}
                selectedPath={scopePath}
                onSelect={setScopePath}
                disabled={busy !== null}
              />
              <p className="text-fg-subtle" data-testid="ado-selected-path">
                {scopePath !== null ? (
                  <>
                    Selected: <span className="font-medium text-fg-soft">{scopePath}</span>
                  </>
                ) : (
                  `Select an ${scopeType === "area" ? "Area" : "Iteration"} path (child paths are included).`
                )}
              </p>
              {nameField && (
                <div className="space-y-1">
                  <label htmlFor={nameId} className="block font-medium text-slate-200">
                    {nameField.label}
                  </label>
                  <input
                    id={nameId}
                    type="text"
                    required
                    value={name}
                    disabled={busy !== null}
                    onChange={(event) => setName(event.target.value)}
                    {...invalidProps("name")}
                    className={inputClass}
                  />
                </div>
              )}
            </section>
          )}
          {hasErrors && (
            <div id={errorId} role="alert" className="space-y-1 text-danger">
              {errors.messages.map((message) => (
                <p key={message}>{message}</p>
              ))}
            </div>
          )}
          {errors.fromRequest && (
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
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line-bold px-4 py-2 text-sm font-medium text-fg-soft hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!connected || scopePath === null || busy !== null}
            className={primaryButton}
            style={{ backgroundColor: "var(--cm-light-blue)" }}
          >
            {busy === "load" ? "Loading work items…" : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
