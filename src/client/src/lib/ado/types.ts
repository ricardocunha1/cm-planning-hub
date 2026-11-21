/**
 * Azure DevOps types shared by every tool that connects to ADO (`/api/ado/*`),
 * mirroring the server schemas. Tool-specific responses live with their tool
 * (`lib/releasePlan/adoTypes.ts`, `lib/monteCarlo/types.ts`).
 */

/** Azure DevOps source: `"onprem"` (On-Prem server) or `"cloud"` (Collaboration Hub). */
export type AdoSource = "onprem" | "cloud";

/** Which classification tree a scope is picked from. */
export type AdoScopeType = "area" | "iteration";

/** The part of every `/api/ado/*` request that identifies the project. The SPA never holds the PAT: the server uses the one the signed-in user stored (encrypted) in Settings. */
export interface AdoConnectionRequest {
  source: AdoSource;
  projectUrl: string;
  /** Omitted by the connect modals: the server then uses the signed-in user's PAT stored for `projectUrl`. */
  pat?: string;
}

/** A classification node with its path normalized to the `System.AreaPath`/`System.IterationPath` format. */
export interface AdoTreeNode {
  name: string;
  path: string;
  /** Iteration nodes only: `YYYY-MM-DD` or `""`. Area nodes have no such key. */
  finishDate?: string;
  children: AdoTreeNode[];
}

export interface AdoProjectInfo {
  id: string;
  /** Canonical project name. */
  name: string;
}

/** `POST /api/ado/connect` 200 response. */
export interface AdoConnectResponse {
  project: AdoProjectInfo;
  /** Canonical project URL (encoded, no trailing slash). */
  projectUrl: string;
  areas: AdoTreeNode;
  iterations: AdoTreeNode;
}

/**
 * A connection plus the path picked after Connect (everything but the PAT).
 * Release Plan stores it in `plan.source` so Sync can pre-fill its form.
 */
export interface AdoConnection {
  source: AdoSource;
  /** Canonical project URL returned by Connect. */
  projectUrl: string;
  scopeType: AdoScopeType;
  /** Normalized path (`Proj\Team A`); matched case-insensitively by the server. */
  scopePath: string;
}

/** An {@link AdoConnection} with an optional PAT (the connect modals send none): what the connect modal hands to its loader. */
export type AdoScopedRequest = AdoConnection & Pick<AdoConnectionRequest, "pat">;
