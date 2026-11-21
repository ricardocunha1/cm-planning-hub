// Synthetic Azure DevOps fixtures (builders). Never derived from real ADO data.
import type { AdoBacklog, AdoConnectResponse, AdoConnection, AdoTreeNode, AdoWorkItem } from "../lib/releasePlan/adoTypes";
import type { AdoCredential } from "../lib/settings/types";

export function makeWorkItem(overrides: Partial<AdoWorkItem> & Pick<AdoWorkItem, "id">): AdoWorkItem {
  return {
    type: "Feature",
    title: `Item ${overrides.id}`,
    state: "New",
    description: "",
    size: "",
    iterationPath: "Proj",
    parentId: null,
    ...overrides,
  };
}

export const makeEpicItem = (overrides: Partial<AdoWorkItem> & Pick<AdoWorkItem, "id">): AdoWorkItem =>
  makeWorkItem({ type: "Epic", title: `Epic ${overrides.id}`, ...overrides });

export const makeFeatureItem = (overrides: Partial<AdoWorkItem> & Pick<AdoWorkItem, "id">): AdoWorkItem =>
  makeWorkItem({ type: "Feature", title: `Feature ${overrides.id}`, ...overrides });

/**
 * Area tree: Proj → Team A (→ Squad 1), Team B.
 * Paths are already normalized (`Proj\Team A\Squad 1`).
 */
export function areaTree(): AdoTreeNode {
  return {
    name: "Proj",
    path: "Proj",
    children: [
      {
        name: "Team A",
        path: "Proj\\Team A",
        children: [{ name: "Squad 1", path: "Proj\\Team A\\Squad 1", children: [] }],
      },
      { name: "Team B", path: "Proj\\Team B", children: [] },
    ],
  };
}

/** Iteration tree: Proj → Phase 1 → Sprint 01 / Sprint 02. */
export function iterationTree(): AdoTreeNode {
  return {
    name: "Proj",
    path: "Proj",
    finishDate: "",
    children: [
      {
        name: "Phase 1",
        path: "Proj\\Phase 1",
        finishDate: "",
        children: [
          { name: "Sprint 01", path: "Proj\\Phase 1\\Sprint 01", finishDate: "2026-10-30", children: [] },
          { name: "Sprint 02", path: "Proj\\Phase 1\\Sprint 02", finishDate: "2026-11-13", children: [] },
        ],
      },
    ],
  };
}

export function makeConnectResponse(overrides: Partial<AdoConnectResponse> = {}): AdoConnectResponse {
  return {
    project: { id: "00000000-0000-0000-0000-000000000001", name: "Proj" },
    projectUrl: "https://dev.azure.com/org/Proj",
    areas: areaTree(),
    iterations: iterationTree(),
    ...overrides,
  };
}

/**
 * Backlog: Epic 101 (Features 102, 104), Epic 103 (Feature 105), orphan
 * Feature 106 (no parent) and orphan 107 (parent 999 not returned).
 */
export function makeBacklog(overrides: Partial<AdoBacklog> = {}): AdoBacklog {
  return {
    project: { id: "00000000-0000-0000-0000-000000000001", name: "Proj" },
    projectUrl: "https://dev.azure.com/org/Proj",
    scope: "Area Path: Proj\\Team A",
    fetchedAt: "2026-10-23T10:00:00Z",
    workItems: [
      makeEpicItem({ id: 101, title: "Wave 1", state: "Active", description: "<p>Wave</p>" }),
      makeFeatureItem({ id: 102, title: "Login", size: "m", iterationPath: "Proj\\Phase 1\\Sprint 01", parentId: 101 }),
      makeEpicItem({ id: 103, title: "Wave 2" }),
      makeFeatureItem({ id: 104, title: "Dashboard", state: "Active", size: "XL", parentId: 101 }),
      makeFeatureItem({ id: 105, title: "Reports", parentId: 103 }),
      makeFeatureItem({ id: 106, title: "Loose", parentId: null }),
      makeFeatureItem({ id: 107, title: "Story child", parentId: 999 }),
    ],
    iterations: [
      { path: "Proj\\Phase 1", finishDate: "" },
      { path: "Proj\\Phase 1\\Sprint 01", finishDate: "2026-10-30" },
      { path: "Proj\\Phase 1\\Sprint 02", finishDate: "2026-11-13" },
    ],
    warnings: [],
    ...overrides,
  };
}

export function makeConnection(overrides: Partial<AdoConnection> = {}): AdoConnection {
  return {
    source: "cloud",
    projectUrl: "https://dev.azure.com/org/Proj",
    scopeType: "area",
    scopePath: "Proj\\Team A",
    ...overrides,
  };
}

/** Stored Settings projects the connect modals can select: "Proj" (Collaboration Hub, matches `makeConnectResponse`) and "Legacy" (On-Prem). */
export const ADO_CREDENTIALS: AdoCredential[] = [
  { id: 11, projectName: "Proj", projectUrl: "https://dev.azure.com/org/Proj", hasPat: true, patLast4: "wxyz" },
  { id: 12, projectName: "Legacy", projectUrl: "https://tfs.example.com/C/P", hasPat: true, patLast4: null },
];

/** An On-Prem Settings project ("My Proj") whose stored URL is the canonical one the Release Plan integration tests use. */
export const MY_PROJ_CREDENTIAL: AdoCredential = {
  id: 21,
  projectName: "My Proj",
  projectUrl: "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/My%20Proj",
  hasPat: true,
  patLast4: "6789",
};
