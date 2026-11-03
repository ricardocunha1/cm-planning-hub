import type { ReleasePlan } from "../lib/releasePlan/types";
import { ReleasePlanBoardPage } from "../pages/ReleasePlanBoardPage";
import { renderAt } from "./render";

/** Id of the plan opened by {@link renderBoard}. */
export const BOARD_PLAN_ID = 1;

/**
 * Renders the real board page at `/release-plan/1` with `plan` already in the
 * store as plan 1 (so the page doesn't fetch). With `null` the store is empty and the page loads plan 1 from the server.
 */
export function renderBoard(plan: ReleasePlan | null) {
  return renderAt("/release-plan/:id", <ReleasePlanBoardPage />, {
    initialPlan: plan,
    initialPlanId: plan ? BOARD_PLAN_ID : null,
    initialEntry: `/release-plan/${BOARD_PLAN_ID}`,
  });
}

/** Slow-ish full-page component tests: generous per-test timeout under parallel load. */
export const BOARD_TEST_TIMEOUT_MS = 20_000;
