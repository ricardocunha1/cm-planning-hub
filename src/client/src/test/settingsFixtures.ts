import type { AdoCredential } from "../lib/settings/types";

/** Two stored credentials for settings tests. */
export const CREDENTIALS: AdoCredential[] = [
  { id: 1, projectName: "Alpha", projectUrl: "https://dev.azure.com/org/Alpha", hasPat: true, patLast4: "1a2b" },
  { id: 2, projectName: "Beta", projectUrl: "https://tfs.example.com/Collection/Beta", hasPat: true, patLast4: null },
];
