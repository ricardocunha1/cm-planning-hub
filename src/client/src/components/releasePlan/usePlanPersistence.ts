import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { loadAutosave, saveAutosave } from "../../lib/releasePlan/autosavePreference";
import { updatePlan } from "../../lib/releasePlan/planApi";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import { ApiError } from "../../lib/monteCarlo/api";
import { errorMessages, useToast } from "../Toast";

/** How long after the last change an autosave is sent. */
export const AUTOSAVE_DELAY_MS = 3000;

const SAVE_ERROR_TITLE = "Could not save the release plan";

/** Save state of the open plan: nothing to save, changed, request in flight, or the last save failed. */
export type SaveStatus = "saved" | "dirty" | "saving" | "error";

export interface PlanPersistence {
  status: SaveStatus;
  /** Whether changes are saved automatically (per-browser preference). */
  autosave: boolean;
  /** Turns autosave on/off and remembers the choice; turning it on with unsaved changes schedules a save. */
  setAutosave: (on: boolean) => void;
  /** Saves now (cancelling a pending autosave). Resolves `true` when nothing is left unsaved, `false` on failure. */
  saveNow: () => Promise<boolean>;
  /** Whether leaving the board would lose changes; reads live refs, so it is safe inside a router blocker callback. */
  hasUnsaved: () => boolean;
}

/**
 * Saves the open plan to the server (`PUT /api/plan/{id}` with `{name, state}`).
 *
 * `plan` is the loaded board: the first value counts as saved, and every later
 * new value is a change. With autosave on, a save is sent
 * {@link AUTOSAVE_DELAY_MS} after the last change (changes in between coalesce
 * into one request). A change counter makes the status `saved` only when no
 * newer change arrived while the request was in flight. A failed save sets
 * `error` and toasts the server message; there is no automatic retry (the next
 * change or {@link PlanPersistence.saveNow} retries). A 404 means the plan was
 * deleted elsewhere: it toasts and goes to the list. The request is aborted and
 * the timer cleared on unmount. Mount it with a `key` per plan id.
 */
export function usePlanPersistence(planId: number, plan: ReleasePlan): PlanPersistence {
  const { showError } = useToast();
  const navigate = useNavigate();
  const [autosave, setAutosaveState] = useState(loadAutosave);
  const [status, setStatusState] = useState<SaveStatus>("saved");

  const statusRef = useRef<SaveStatus>("saved");
  const autosaveRef = useRef(autosave);
  const planRef = useRef(plan);
  const changeCount = useRef(0);
  const savedCount = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const inflight = useRef<Promise<unknown> | null>(null);
  const gone = useRef(false);
  const mounted = useRef(true);

  const setStatus = useCallback((next: SaveStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // `drain`: keep saving until nothing is left unsaved (manual save); the autosave timer sends one request only,
  // so changes made meanwhile get their own debounced save.
  const send = useCallback(async (drain: boolean): Promise<boolean> => {
    clearTimer();
    // Serialize requests: a slow earlier PUT must not land after a newer one.
    while (inflight.current) {
      await inflight.current;
    }
    if (!mounted.current || gone.current) {
      return false;
    }
    if (savedCount.current === changeCount.current) {
      if (statusRef.current !== "saved") {
        setStatus("saved");
      }
      return true;
    }
    const sent = changeCount.current;
    const snapshot = planRef.current;
    const abort = new AbortController();
    controller.current = abort;
    setStatus("saving");
    const request = updatePlan(planId, { name: snapshot.name, state: snapshot }, abort.signal);
    inflight.current = request.catch(() => undefined);
    try {
      await request;
    } catch (exc) {
      if (abort.signal.aborted) {
        return false;
      }
      if (exc instanceof ApiError && exc.status === 404) {
        gone.current = true;
        showError(["This release plan no longer exists."], SAVE_ERROR_TITLE);
        navigate("/release-plan", { replace: true });
        return false;
      }
      showError(errorMessages(exc), SAVE_ERROR_TITLE);
      // A newer change keeps the status `dirty` (its own save is pending or the user will save).
      setStatus(changeCount.current === sent ? "error" : "dirty");
      return false;
    } finally {
      inflight.current = null;
    }
    savedCount.current = sent;
    if (changeCount.current !== sent) {
      setStatus("dirty");
      return drain ? send(true) : false;
    }
    setStatus("saved");
    return true;
  }, [planId, navigate, showError, clearTimer, setStatus]);

  const saveNow = useCallback(() => send(true), [send]);

  const schedule = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      void send(false);
    }, AUTOSAVE_DELAY_MS);
  }, [clearTimer, send]);

  // A new `plan` value is a change.
  useEffect(() => {
    if (plan === planRef.current) {
      return;
    }
    planRef.current = plan;
    changeCount.current += 1;
    setStatus("dirty");
    if (autosaveRef.current) {
      schedule();
    }
  }, [plan, schedule, setStatus]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      controller.current?.abort();
    };
  }, [clearTimer]);

  const setAutosave = useCallback(
    (on: boolean) => {
      autosaveRef.current = on;
      setAutosaveState(on);
      saveAutosave(on);
      if (!on) {
        clearTimer();
      } else if (statusRef.current !== "saved" && statusRef.current !== "saving") {
        schedule();
      }
    },
    [clearTimer, schedule],
  );

  const hasUnsaved = useCallback(() => !gone.current && statusRef.current !== "saved", []);

  return { status, autosave, setAutosave, saveNow, hasUnsaved };
}
