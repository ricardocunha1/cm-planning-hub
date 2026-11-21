/** A stored Azure DevOps credential as the server returns it. The PAT itself is never returned. */
export interface AdoCredential {
  id: number;
  /** Free-text name chosen by the user. */
  projectName: string;
  projectUrl: string;
  /** Whether a PAT is stored (always true for items the server returns today). */
  hasPat: boolean;
}

/** GET /api/settings/ado-credentials response. */
export interface AdoCredentialList {
  items: AdoCredential[];
}

/** Body of POST /api/settings/ado-credentials. */
export interface AdoCredentialCreate {
  projectName: string;
  projectUrl: string;
  pat: string;
}

/** Body of PUT /api/settings/ado-credentials/{id}; an omitted `pat` keeps the stored one. */
export interface AdoCredentialUpdate {
  projectName: string;
  projectUrl: string;
  pat?: string;
}
