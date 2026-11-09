import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { adoConnect } from "../../lib/ado/api";
import { loadAdoConnection, saveAdoConnection } from "../../lib/ado/connectionStorage";
import type { AdoConnectResponse, AdoConnection, AdoScopeType, AdoScopedRequest, AdoSource } from "../../lib/ado/types";
import { PAT_REQUIRED, PLACEHOLDER, SOURCE_LABELS, SOURCE_REQUIRED, URL_REQUIRED, validateProjectUrl } from "../../lib/ado/url";
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

const SOURCES: readonly AdoSource[] = ["onprem", "cloud"];
/** Source selected when there is no remembered connection. */
const DEFAULT_SOURCE: AdoSource = "cloud";
const SCOPE_LABELS: Readonly<Record<AdoScopeType, string>> = {
  area: "Area path",
  iteration: "Iteration path",
};

const inputClass =
  "block w-full rounded border border-line-bold bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]";
const primaryButton =
  "rounded px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

/** A connection field that can be invalid before any request. */
type ConnectionField = "source" | "url" | "pat" | "name";

/** Inline errors plus the fields they are about (linked with `aria-invalid` / `aria-describedby`). */
interface FormErrors {
  messages: string[];
  fields: ReadonlySet<ConnectionField>;
}

const NO_ERRORS: FormErrors = { messages: [], fields: new Set() };

/** Errors not tied to a field (server responses, network failures). */
const generalErrors = (messages: string[]): FormErrors => ({ messages, fields: new Set() });

/** Field-level errors before any request, in the server's order (source, URL, PAT; then the URL shape). */
function connectionErrors(source: AdoSource | null, projectUrl: string, pat: string): FormErrors {
  const messages: string[] = [];
  const fields = new Set<ConnectionField>();
  if (source === null) {
    messages.push(SOURCE_REQUIRED);
    fields.add("source");
  }
  if (!projectUrl.trim()) {
    messages.push(URL_REQUIRED);
    fields.add("url");
  }
  if (!pat.trim()) {
    messages.push(PAT_REQUIRED);
    fields.add("pat");
  }
  if (messages.length > 0 || source === null) {
    return { messages, fields };
  }
  const shapeError = validateProjectUrl(source, projectUrl);
  return shapeError ? { messages: [shapeError], fields: new Set(["url"]) } : NO_ERRORS;
}

/**
 * Connects to an Azure DevOps project and loads data for one of its paths;
 * shared by the ADO-backed tools (Release Plan board creation, Monte Carlo
 * sprint history). Step 1: source (On-Prem / Collaboration Hub; defaults to
 * Collaboration Hub unless a remembered connection says otherwise), project URL and PAT, then **Connect** (URL shape checked client-side first; on
 * success the connection — never the PAT — is remembered under
 * `connectionKey`). Step 2: a {@link PathTree} of the `scopeTypes` tree (with an
 * "Area path" / "Iteration path" toggle when there are two); the submit button
 * calls `load` and hands its result to `onLoaded`. Editing the source, URL or
 * PAT after Connect clears the trees (Connect again); the path picker is
 * disabled while a request runs. With a `nameField`, a required name input
 * (pre-filled from the project name after Connect) is validated before `load`. Errors show inline (invalid fields point at
 * them with `aria-invalid` / `aria-describedby`) and the modal stays open. The
 * PAT lives only in this component's state; its input opts out of password
 * managers.
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
  const urlId = useId();
  const patId = useId();
  const patHelpId = useId();
  const errorId = useId();
  const nameId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [prefill] = useState(() => loadAdoConnection(connectionKey));
  // `null` (SOURCE_REQUIRED) is kept as a defensive state; the UI always starts with a source.
  const [source, setSource] = useState<AdoSource | null>(prefill?.source ?? DEFAULT_SOURCE);
  const [projectUrl, setProjectUrl] = useState(prefill?.projectUrl ?? "");
  const [pat, setPat] = useState("");
  const [connected, setConnected] = useState<{ source: AdoSource; response: AdoConnectResponse } | null>(null);
  const [scopeType, setScopeType] = useState<AdoScopeType>(scopeTypes[0]);
  const [scopePath, setScopePath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"connect" | "load" | null>(null);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);

  useDialog({ open: true, onClose, dialogRef });

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
    setConnected(null);
    setScopePath(null);
    setErrors(NO_ERRORS);
  };

  const onConnect = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) {
      return;
    }
    const fieldErrors = connectionErrors(source, projectUrl, pat);
    if (fieldErrors.messages.length > 0 || source === null) {
      setErrors(fieldErrors);
      return;
    }
    const controller = startRequest();
    setErrors(NO_ERRORS);
    setBusy("connect");
    try {
      const response = await adoConnect({ source, projectUrl: projectUrl.trim(), pat }, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      saveAdoConnection(connectionKey, { source, projectUrl: response.projectUrl });
      setConnected({ source, response });
      setName(nameField ? nameField.defaultName(response.project.name) : "");
      setScopePath(null);
      setBusy(null);
    } catch (exc) {
      if (!controller.signal.aborted) {
        setErrors(generalErrors(errorMessages(exc)));
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
      const result = await load({ ...connection, pat }, controller.signal, trimmedName);
      if (controller.signal.aborted) {
        return;
      }
      setBusy(null);
      onLoaded(result, connection);
    } catch (exc) {
      if (!controller.signal.aborted) {
        setErrors(generalErrors(errorMessages(exc)));
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
        className="relative flex max-h-full w-full max-w-2xl flex-col rounded-lg border border-line-strong bg-surface shadow-xl"
      >
        <div className="px-6 py-4 border-b border-line">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
        </div>
        <div className="space-y-4 overflow-y-auto px-6 py-5 text-sm">
          <form onSubmit={(event) => void onConnect(event)} noValidate className="space-y-4">
            <fieldset aria-describedby={errors.fields.has("source") ? errorId : undefined}>
              <legend className="mb-1 font-medium text-fg-soft">Azure DevOps source</legend>
              <div className="flex flex-wrap gap-4">
                {SOURCES.map((value) => (
                  <label key={value} className="flex items-center gap-2 text-fg-soft">
                    <input
                      type="radio"
                      name="ado-source"
                      value={value}
                      checked={source === value}
                      onChange={() => {
                        setSource(value);
                        setProjectUrl("");
                        editConnection();
                      }}
                      className="accent-[color:var(--cm-light-blue)]"
                    />
                    {SOURCE_LABELS[value]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-1">
              <label htmlFor={urlId} className="block font-medium text-fg-soft">
                Project URL
              </label>
              <input
                id={urlId}
                type="url"
                value={projectUrl}
                placeholder={PLACEHOLDER[source ?? DEFAULT_SOURCE]}
                onChange={(event) => {
                  setProjectUrl(event.target.value);
                  editConnection();
                }}
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
                onChange={(event) => {
                  setPat(event.target.value);
                  editConnection();
                }}
                {...invalidProps("pat", patHelpId)}
                className={inputClass}
              />
              <p id={patHelpId} className="text-xs text-fg-subtle">
                Needs the Work Items (Read) scope. It is sent only to connect and is never stored.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" disabled={busy !== null} className={primaryButton} style={{ backgroundColor: "var(--cm-light-blue)" }}>
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
