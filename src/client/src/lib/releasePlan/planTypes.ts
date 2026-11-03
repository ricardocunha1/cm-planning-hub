import type { ReleasePlan } from "./types";

/** Source of a saved plan's project; same codes as `PlanSource.kind` (`onprem` = On Prem, `cloud` = Collaboration Hub). */
export type PlanProjectType = "onprem" | "cloud";

/** A saved plan as listed by `GET /api/plan` (no state). Timestamps are UTC ISO-8601. */
export interface PlanSummary {
  id: number;
  name: string;
  projectType: PlanProjectType;
  projectName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A saved plan with its board. `state` is the stored JSON as the server
 * returns it: not yet normalized, so callers must run `normalizePlan` on it
 * before use (hence `unknown`, not `ReleasePlan`).
 */
export interface PlanDetail extends PlanSummary {
  state: unknown;
}

/** `GET /api/plan?page=N`: one page of summaries, newest update first. */
export interface PlanListResponse {
  items: PlanSummary[];
  total: number;
  page: number;
  pageSize: number;
}

/** `POST /api/plan` body; `state` is the board being saved. */
export interface PlanCreateRequest {
  name: string;
  projectType: PlanProjectType;
  projectName: string;
  state: ReleasePlan;
}

/** `PUT /api/plan/{id}` body (the project is fixed at creation). */
export interface PlanUpdateRequest {
  name: string;
  state: ReleasePlan;
}
