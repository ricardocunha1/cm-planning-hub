import type { AdoBacklog, AdoConnection, AdoWorkItem } from "./adoTypes";
import { MS_COLORS, SCHEMA, VERSION, uid, type IdFactory } from "./constants";
import { NO_EPIC_ID, NO_EPIC_TITLE, type Epic, type Feature, type ReleasePlan } from "./types";

/** System name written to `plan.source.system` for boards built from Azure DevOps. */
export const ADO_SYSTEM = "Azure DevOps";
/** Name of the single milestone of a new board (template default). */
export const INITIAL_MILESTONE_NAME = "MVP";

/** An Epic from the backlog with its Features. */
export interface BacklogEpicGroup {
  epic: AdoWorkItem;
  features: AdoWorkItem[];
}

/** {@link groupBacklog} result. */
export interface GroupedBacklog {
  /** Epics in ascending id order, each with its Features (ascending id). */
  epics: BacklogEpicGroup[];
  /** Features with no parent, or whose parent is not a returned Epic (ascending id). */
  orphans: AdoWorkItem[];
}

/** Groups the flat backlog: Features under their parent Epic; the others are orphans. */
export function groupBacklog(items: readonly AdoWorkItem[]): GroupedBacklog {
  const sorted = [...items].sort((a, b) => a.id - b.id);
  const groups = new Map<number, BacklogEpicGroup>();
  for (const item of sorted) {
    if (item.type === "Epic") {
      groups.set(item.id, { epic: item, features: [] });
    }
  }
  const orphans: AdoWorkItem[] = [];
  for (const item of sorted) {
    if (item.type !== "Feature") {
      continue;
    }
    const group = item.parentId === null ? undefined : groups.get(item.parentId);
    if (group) {
      group.features.push(item);
    } else {
      orphans.push(item);
    }
  }
  return { epics: [...groups.values()], orphans };
}

function toFeature(item: AdoWorkItem, milestoneId: string): Feature {
  return {
    id: item.id,
    title: item.title,
    state: item.state,
    description: item.description,
    size: item.size.trim().toUpperCase(),
    iterationPath: item.iterationPath,
    milestoneId,
  };
}

/** Default name of a board built from `projectName`'s backlog. */
export function defaultPlanName(projectName: string): string {
  return `${projectName} – Feature Release Plan`;
}

/**
 * A new board from a fetched backlog (the template default): Releases mode, one
 * `MVP` milestone (`MS_COLORS[0]`, no date) holding every Feature, no flags,
 * Epics in id order with the synthetic "Features without an Epic" Epic last
 * when there are orphan Features. `source` records the project, scope, fetch
 * time and the connection (never the PAT). The result is already normalized:
 * `normalizePlan(plan)` deep-equals it.
 */
export function planFromBacklog(backlog: AdoBacklog, connection: AdoConnection, makeId: IdFactory = uid): ReleasePlan {
  const milestoneId = makeId("ms_");
  const { epics: groups, orphans } = groupBacklog(backlog.workItems);
  const epics: Epic[] = groups.map(({ epic, features }) => ({
    id: epic.id,
    title: epic.title,
    state: epic.state,
    description: epic.description,
    features: features.map((f) => toFeature(f, milestoneId)),
  }));
  if (orphans.length > 0) {
    epics.push({
      id: NO_EPIC_ID,
      title: NO_EPIC_TITLE,
      state: "",
      description: "",
      features: orphans.map((f) => toFeature(f, milestoneId)),
    });
  }
  return {
    schema: SCHEMA,
    version: VERSION,
    mode: "releases",
    name: defaultPlanName(backlog.project.name),
    source: {
      system: ADO_SYSTEM,
      project: backlog.project.name,
      scope: backlog.scope,
      fetchedAt: backlog.fetchedAt,
      kind: connection.source,
      projectUrl: connection.projectUrl,
      scopeType: connection.scopeType,
      scopePath: connection.scopePath,
    },
    iterations: backlog.iterations.map(({ path, finishDate }) => ({ path, finishDate })),
    milestones: [{ id: milestoneId, name: INITIAL_MILESTONE_NAME, date: "", color: MS_COLORS[0] }],
    flags: [],
    epics,
  };
}
