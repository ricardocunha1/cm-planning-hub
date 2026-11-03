import { deleteRequest, getJson, postJson, putJson } from "../ado/api";
import type { PlanCreateRequest, PlanDetail, PlanListResponse, PlanUpdateRequest } from "./planTypes";

const PLAN_URL = "/api/plan";

const planUrl = (id: number): string => `${PLAN_URL}/${encodeURIComponent(String(id))}`;

/**
 * Release Plan persistence client (`/api/plan`). Every function rejects with an
 * `ApiError` carrying the server's `errors` (404 unknown id, 422 validation,
 * 503 database unavailable) and with the fetch's `AbortError` when `signal` aborts.
 */

/** GET /api/plan?page=N: one page of saved plans, most recently updated first. */
export function listPlans(page: number, signal?: AbortSignal): Promise<PlanListResponse> {
  return getJson<PlanListResponse>(`${PLAN_URL}?page=${encodeURIComponent(String(page))}`, signal);
}

/** GET /api/plan/{id}: a saved plan with its (un-normalized) state. */
export function getPlan(id: number, signal?: AbortSignal): Promise<PlanDetail> {
  return getJson<PlanDetail>(planUrl(id), signal);
}

/** POST /api/plan: saves a new plan (201). */
export function createPlan(req: PlanCreateRequest, signal?: AbortSignal): Promise<PlanDetail> {
  return postJson<PlanDetail>(PLAN_URL, req, signal);
}

/** PUT /api/plan/{id}: replaces the plan's name and state. */
export function updatePlan(id: number, req: PlanUpdateRequest, signal?: AbortSignal): Promise<PlanDetail> {
  return putJson<PlanDetail>(planUrl(id), req, signal);
}

/** DELETE /api/plan/{id}: resolves on 204. */
export function deletePlan(id: number, signal?: AbortSignal): Promise<void> {
  return deleteRequest(planUrl(id), signal);
}
