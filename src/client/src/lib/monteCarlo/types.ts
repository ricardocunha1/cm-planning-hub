// Mirrors src/server/app/schemas.py. Summary record keys keep the server's
// DataFrame column names (Pydantic aliases), so they're quoted here.

import type { AdoConnectionRequest, AdoProjectInfo, AdoSource } from "../ado/types";

export type TargetType = "Items Resolved" | "Story Points";

export interface SprintSummaryRecord {
  Sprint: string;
  "Items Resolved": number;
  "Story Points": number;
  /** ISO date, `YYYY-MM-DD`. */
  "Last Resolved Date": string;
  "Recency Rank": number;
  "In Sampling Pool": boolean;
}

/** The Data Input form fields as raw strings, exactly as submitted. Only
 * fields that were submitted are present. */
export interface SimulationParams {
  target_type?: string | null;
  target_value?: string | null;
  num_simulations?: string | null;
  skip_validation: boolean;
  exclude_latest_sprints?: string | null;
  sprint_start_date?: string | null;
  sprint_length?: string | null;
  team_capacity_factor?: string | null;
}

export interface ValidateResponse {
  summary: SprintSummaryRecord[];
  params: SimulationParams;
}

export interface ResultRow {
  confidence: number;
  label: string;
  /** Sentinel 51 (MAX_SPRINT_WINDOW + 1) when the target isn't reached. */
  sprints: number;
  exceeds_window: boolean;
  /** ISO date, `YYYY-MM-DD`; null when `exceeds_window`. */
  completion_date: string | null;
}

export interface Histogram {
  /** "1".."50" followed by ">50". */
  labels: string[];
  counts: number[];
}

export interface SimulateResponse {
  target_type: string;
  target_value: number;
  rows: ResultRow[];
  histogram: Histogram;
}

export interface ErrorResponse {
  errors: string[];
}

/** `POST /api/ado/sprint-history` request. The SPA does not send the PAT: the server uses the signed-in user's stored one (Settings). */
export interface AdoSprintHistoryRequest extends AdoConnectionRequest {
  /** Normalized Iteration path (`Proj\Phase 1`); matched case-insensitively, children included. */
  iterationPath: string;
}

/** A resolved User Story or Bug as returned by the sprint-history route (ascending id). */
export interface AdoSprintWorkItem {
  id: number;
  type: "User Story" | "Bug";
  title: string;
  /** `Resolved`, `Done` or `Closed`. */
  state: string;
  /** The item's own iteration, e.g. `Proj\Phase 1\Sprint 01`. */
  iterationPath: string;
  /** ResolvedDate, else ClosedDate, else ChangedDate; UTC ISO `YYYY-MM-DDTHH:MM:SSZ`. */
  resolvedDate: string;
  /** 0 when missing. */
  storyPoints: number;
}

/** `POST /api/ado/sprint-history` 200 response. */
export interface AdoSprintHistory {
  project: AdoProjectInfo;
  /** Canonical project URL. */
  projectUrl: string;
  iterationPath: string;
  /** Server UTC time, ISO with `Z`. */
  fetchedAt: string;
  workItems: AdoSprintWorkItem[];
  /** E.g. the story points field missing or the 20000 cap; shown as info toasts. */
  warnings: string[];
}

/**
 * Where the sprint history for a simulation comes from, chosen on the data
 * source page and held in memory by the store. Client-only (not part of the
 * server schemas): an Excel `file` is posted to `/api/validate` as
 * `sprint_history_file`; the Azure DevOps `workItems` (loaded once from
 * `/api/ado/sprint-history`, never re-synced) are posted as the JSON field
 * `sprint_history_items`.
 */
export type DataSource =
  | { kind: "excel"; file: File }
  | {
      kind: "azureDevOps";
      source: AdoSource;
      /** Canonical project URL. */
      projectUrl: string;
      /** Canonical project name. */
      project: string;
      iterationPath: string;
      fetchedAt: string;
      workItems: AdoSprintWorkItem[];
    };
