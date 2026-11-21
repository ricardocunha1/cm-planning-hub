import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./authStore";
import { useToast, errorMessages } from "./components/Toast";
import { createAdoCredential, deleteAdoCredential, listAdoCredentials, updateAdoCredential } from "./lib/settings/api";
import type { AdoCredential, AdoCredentialCreate, AdoCredentialUpdate } from "./lib/settings/types";

/** `idle` = never loaded (nothing is fetched until {@link SettingsState.ensureLoaded}). */
export type SettingsStatus = "idle" | "loading" | "ready" | "error";

/** Value of {@link useSettings}. */
export interface SettingsState {
  /** The user's stored credentials (no PATs, ever). */
  items: AdoCredential[];
  status: SettingsStatus;
  /** Fetches the list again (also after an error); failures set `status: "error"` and show a toast. */
  load: () => Promise<void>;
  /** Loads once: does nothing unless the status is `idle` or `error`. */
  ensureLoaded: () => Promise<void>;
  /** Creates a credential; rejects with the ApiError so the caller can show it. */
  add: (body: AdoCredentialCreate) => Promise<AdoCredential>;
  /** Updates a credential (omit `pat` to keep the stored one); rejects with the ApiError. */
  update: (id: number, body: AdoCredentialUpdate) => Promise<AdoCredential>;
  /** Deletes a credential; rejects with the ApiError. */
  remove: (id: number) => Promise<void>;
}

const SettingsContext = createContext<SettingsState | null>(null);

/**
 * Holds the signed-in user's stored Azure DevOps credentials. It never fetches on
 * mount or on login: a consumer calls `ensureLoaded` when it needs the list (the
 * Settings modal when opened). The state is cleared when the user signs out or
 * changes. `initialItems` (tests) starts as already loaded.
 */
export function SettingsProvider({ children, initialItems }: { children: ReactNode; initialItems?: AdoCredential[] }) {
  const { user } = useAuth();
  const { showError } = useToast();
  const userId = user?.id ?? null;
  const [items, setItems] = useState<AdoCredential[]>(initialItems ?? []);
  const [status, setStatus] = useState<SettingsStatus>(initialItems ? "ready" : "idle");
  const statusRef = useRef(status);
  statusRef.current = status;
  /** Bumped on reset so a response for a previous user is ignored. */
  const generation = useRef(0);
  const lastUser = useRef(userId);

  useEffect(() => {
    if (lastUser.current === userId) {
      return;
    }
    lastUser.current = userId;
    generation.current += 1;
    setItems([]);
    setStatus("idle");
  }, [userId]);

  const load = useCallback(async () => {
    const mine = generation.current;
    setStatus("loading");
    statusRef.current = "loading";
    try {
      const result = await listAdoCredentials();
      if (mine !== generation.current) {
        return;
      }
      setItems(result.items);
      setStatus("ready");
    } catch (exc) {
      if (mine !== generation.current) {
        return;
      }
      setStatus("error");
      showError(errorMessages(exc), "Could not load settings");
    }
  }, [showError]);

  const ensureLoaded = useCallback(async () => {
    if (statusRef.current === "idle" || statusRef.current === "error") {
      await load();
    }
  }, [load]);

  const add = useCallback(async (body: AdoCredentialCreate) => {
    const created = await createAdoCredential(body);
    setItems((current) => [...current, created]);
    return created;
  }, []);

  const update = useCallback(async (id: number, body: AdoCredentialUpdate) => {
    const updated = await updateAdoCredential(id, body);
    setItems((current) => current.map((item) => (item.id === id ? updated : item)));
    return updated;
  }, []);

  const remove = useCallback(async (id: number) => {
    await deleteAdoCredential(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const value = useMemo<SettingsState>(
    () => ({ items, status, load, ensureLoaded, add, update, remove }),
    [items, status, load, ensureLoaded, add, update, remove],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/** The settings state; must be used inside {@link SettingsProvider}. */
export function useSettings(): SettingsState {
  const value = useContext(SettingsContext);
  if (!value) {
    throw new Error("useSettings must be used inside a SettingsProvider");
  }
  return value;
}
