import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type Dispatch, type ReactNode } from "react";
import { planReducer, type PlanAction } from "./lib/releasePlan/reducer";
import type { ReleasePlan } from "./lib/releasePlan/types";

/** localStorage key of the board autosave of earlier versions; removed once on start (plans now live on the server). */
const LEGACY_STORAGE_KEY = "cmPlanningHub.releasePlan.v1";

interface ReleasePlanState {
  /** The current plan, `null` when no board is open. */
  plan: ReleasePlan | null;
  /** Applies a `PlanAction`. */
  dispatch: Dispatch<PlanAction>;
  /** Server id of the saved plan being edited, `null` when no plan is open. */
  planId: number | null;
  /** Makes `plan` the current board, saved on the server as `id`. */
  loadPlan: (id: number, plan: ReleasePlan) => void;
  /** Closes the board: no plan, no id. */
  clearPlan: () => void;
}

const ReleasePlanContext = createContext<ReleasePlanState | null>(null);

/**
 * Holds the Release Plan board being edited (`useReducer` over `planReducer`)
 * and the server id it is saved under. In memory only: persistence is the
 * board page's job (`usePlanPersistence`). `initialPlan` / `initialPlanId`
 * (tests) start with a board open. On mount it removes the legacy localStorage
 * autosave key. Mounted in `App.tsx` around the routes (not in `main.tsx`).
 */
export function ReleasePlanProvider({
  children,
  initialPlan = null,
  initialPlanId = null,
}: {
  children: ReactNode;
  initialPlan?: ReleasePlan | null;
  initialPlanId?: number | null;
}) {
  const [plan, dispatch] = useReducer(planReducer, initialPlan);
  const [planId, setPlanId] = useState<number | null>(initialPlanId);

  useEffect(() => {
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Storage unavailable: nothing to clean up.
    }
  }, []);

  const loadPlan = useCallback((id: number, next: ReleasePlan) => {
    setPlanId(id);
    dispatch({ type: "replace", plan: next });
  }, []);

  const clearPlan = useCallback(() => {
    setPlanId(null);
    dispatch({ type: "replace", plan: null });
  }, []);

  const value = useMemo(() => ({ plan, dispatch, planId, loadPlan, clearPlan }), [plan, planId, loadPlan, clearPlan]);
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
