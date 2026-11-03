import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode } from "react";
import { planReducer, type PlanAction } from "./lib/releasePlan/reducer";
import { localPlanStorage, type PlanStorage } from "./lib/releasePlan/storage";
import type { ReleasePlan } from "./lib/releasePlan/types";

interface ReleasePlanState {
  /** The current plan, `null` when no board was created or restored. */
  plan: ReleasePlan | null;
  /** Applies a `PlanAction`; every change is autosaved. */
  dispatch: Dispatch<PlanAction>;
  /** Server id of the saved plan being edited, `null` when the plan is not (yet) tied to a saved plan. */
  planId: number | null;
  /** Makes `plan` the current board, saved on the server as `id`. */
  loadPlan: (id: number, plan: ReleasePlan) => void;
  /** Replaces the whole plan (not tied to a saved plan: `planId` becomes `null`); clears the pending "restored" notice. */
  replacePlan: (plan: ReleasePlan) => void;
  /** Whether the plan was hydrated from storage on mount. */
  restoredFromStorage: boolean;
  /** Returns `true` exactly once if the restored-session notice is still pending (safe under StrictMode). */
  consumeRestoredNotice: () => boolean;
}

const ReleasePlanContext = createContext<ReleasePlanState | null>(null);

/**
 * Holds the Release Plan board state (`useReducer` over `planReducer`), lazily
 * hydrated from `storage` and saved after every change. `storage={null}` keeps it
 * in memory only; `initialPlan` (tests) skips hydration. Mounted in `App.tsx`
 * around the routes (not in `main.tsx`).
 */
export function ReleasePlanProvider({
  children,
  initialPlan,
  storage = localPlanStorage,
}: {
  children: ReactNode;
  initialPlan?: ReleasePlan | null;
  storage?: PlanStorage | null;
}) {
  const [init] = useState(() => {
    if (initialPlan !== undefined) {
      return { plan: initialPlan, restored: false };
    }
    const saved = storage ? storage.load() : null;
    return { plan: saved, restored: saved !== null };
  });
  const [plan, dispatch] = useReducer(planReducer, init.plan);
  const [planId, setPlanId] = useState<number | null>(null);
  const restoredNotice = useRef(init.restored);

  useEffect(() => {
    if (plan && storage) {
      storage.save(plan);
    }
  }, [plan, storage]);

  const replacePlan = useCallback((next: ReleasePlan) => {
    restoredNotice.current = false;
    setPlanId(null);
    dispatch({ type: "replace", plan: next });
  }, []);

  const loadPlan = useCallback((id: number, next: ReleasePlan) => {
    restoredNotice.current = false;
    setPlanId(id);
    dispatch({ type: "replace", plan: next });
  }, []);

  const consumeRestoredNotice = useCallback(() => {
    const pending = restoredNotice.current;
    restoredNotice.current = false;
    return pending;
  }, []);

  const value = useMemo(
    () => ({ plan, dispatch, planId, loadPlan, replacePlan, restoredFromStorage: init.restored, consumeRestoredNotice }),
    [plan, planId, loadPlan, replacePlan, init.restored, consumeRestoredNotice],
  );
  return <ReleasePlanContext.Provider value={value}>{children}</ReleasePlanContext.Provider>;
}

/** The Release Plan store; throws outside a `ReleasePlanProvider`. */
export function useReleasePlan(): ReleasePlanState {
  const state = useContext(ReleasePlanContext);
  if (!state) {
    throw new Error("useReleasePlan must be used within a ReleasePlanProvider");
  }
  return state;
}
