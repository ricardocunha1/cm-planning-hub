import type { AdoConnection } from "./adoTypes";
import { DONE_STATES, SIZES } from "./constants";
import { NO_EPIC_ID, type Band, type Epic, type Feature, type Flag, type Milestone, type PlanSource, type ReleasePlan } from "./types";
import type { PlanProjectType } from "./planTypes";

/** Milestones in order, then the synthetic Unplanned band. */
export function bands(plan: ReleasePlan): Band[] {
  return [
    ...plan.milestones.map((m): Band => ({ unplanned: false, id: m.id, name: m.name, milestone: m })),
    { unplanned: true, id: null, name: "Unplanned", milestone: null },
  ];
}

/** Milestone with `id`, or `null` (unknown id or Unplanned). */
export function msById(plan: ReleasePlan, id: string | null | undefined): Milestone | null {
  return plan.milestones.find((m) => m.id === id) ?? null;
}

/** Index of a milestone, `-1` when unknown or `null`. */
export function msIndex(plan: ReleasePlan, id: string | null | undefined): number {
  return plan.milestones.findIndex((m) => m.id === id);
}

/** A Feature paired with its parent Epic. */
export interface FeatureWithEpic {
  feature: Feature;
  epic: Epic;
}

/** Every Feature with its Epic, in epic/column order. */
export function allFeatures(plan: ReleasePlan): FeatureWithEpic[] {
  return plan.epics.flatMap((epic) => epic.features.map((feature) => ({ feature, epic })));
}

/** Features assigned to a band (`null` = Unplanned), in epic/column order. */
export function featuresInBand(plan: ReleasePlan, bandId: string | null): Feature[] {
  return allFeatures(plan)
    .map((x) => x.feature)
    .filter((f) => (f.milestoneId ?? null) === bandId);
}

/** Whether the state is one of `DONE_STATES` (case-sensitive). */
export function isDone(item: { state: string }): boolean {
  return DONE_STATES.includes(item.state);
}

/** `[size, count]` pairs: `SIZES` order, then other sizes (sorted), then `"?"`; zero counts left out. */
export function sizeCounts(features: readonly Feature[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const f of features) {
    const key = f.size || "?";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sizes: readonly string[] = SIZES;
  const others = [...counts.keys()].filter((k) => !sizes.includes(k) && k !== "?").sort();
  return [...sizes, ...others, "?"].flatMap((k) => {
    const n = counts.get(k);
    return n ? [[k, n] as [string, number]] : [];
  });
}

/** `"S×2 · M×3"`, or `"–"` when there are no features. */
export function sizeSummary(features: readonly Feature[]): string {
  const parts = sizeCounts(features).map(([k, n]) => `${k}×${n}`);
  return parts.length ? parts.join(" · ") : "–";
}

/** Result of `epicMilestone`. */
export interface EpicMilestone {
  /** Latest milestone among the planned features, `null` when none is planned. */
  ms: Milestone | null;
  unplanned: number;
  total: number;
}

/** Latest milestone among an epic's features; unplanned features flag it as incomplete. */
export function epicMilestone(plan: ReleasePlan, epic: Epic): EpicMilestone {
  let max = -1;
  let unplanned = 0;
  for (const f of epic.features) {
    const i = msIndex(plan, f.milestoneId);
    if (i < 0) {
      unplanned++;
    } else {
      max = Math.max(max, i);
    }
  }
  return { ms: max >= 0 ? plan.milestones[max] : null, unplanned, total: epic.features.length };
}

/** Epic meta line: "No features", "Unplanned", "<ms> · N unplanned" or "Done in <ms>". */
export function epicMsLabel(plan: ReleasePlan, epic: Epic): string {
  const r = epicMilestone(plan, epic);
  if (!r.total) {
    return "No features";
  }
  if (r.unplanned === r.total || !r.ms) {
    return "Unplanned";
  }
  if (r.unplanned) {
    return `${r.ms.name} · ${r.unplanned} unplanned`;
  }
  return `Done in ${r.ms.name}`;
}

/**
 * Full Epic header meta text (board and PNG): `Epic #<id> · <label>`, or just
 * `<label>` for the synthetic {@link NO_EPIC_ID} Epic, which has no ADO id.
 */
export function epicMetaText(epic: Epic, label: string): string {
  return String(epic.id) === NO_EPIC_ID ? label : `Epic #${epic.id} · ${label}`;
}

/** Whether `epic` is completed in milestone `msId` (no unplanned features, latest milestone is `msId`). */
export function epicCompletedIn(plan: ReleasePlan, epic: Epic, msId: string): boolean {
  const r = epicMilestone(plan, epic);
  return !r.unplanned && r.ms !== null && r.ms.id === msId;
}

/** Last `\`-separated term of the iteration path, only when the path has more than one term. */
export function iterationLeaf(item: { iterationPath: string }): string | null {
  const parts = (item.iterationPath || "")
    .split("\\")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

/** Unique iteration leaves of all features, natural sort. */
export function sprintLeaves(plan: ReleasePlan): string[] {
  const leaves = new Set<string>();
  for (const { feature } of allFeatures(plan)) {
    const leaf = iterationLeaf(feature);
    if (leaf) {
      leaves.add(leaf);
    }
  }
  return [...leaves].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/** Flags placed right after milestone `msId`, in plan order. */
export function flagsAfter(plan: ReleasePlan, msId: string): Flag[] {
  return plan.flags.filter((f) => f.afterMsId === msId);
}

/** Flags in milestone order. */
export function orderedFlags(plan: ReleasePlan): Flag[] {
  return plan.milestones.flatMap((m) => flagsAfter(plan, m.id));
}

/** First ordered flag whose milestone index is ≥ `i`; none when `i < 0`. */
export function flagForMsIndex(plan: ReleasePlan, i: number): Flag | null {
  if (i < 0) {
    return null;
  }
  return orderedFlags(plan).find((f) => msIndex(plan, f.afterMsId) >= i) ?? null;
}

/** `"YYYY-MM-DD"` → localized "20 Oct 2026"; `""` → `""`; an invalid date is returned unchanged. */
export function fmtDate(d: string): string {
  if (!d) {
    return "";
  }
  const x = new Date(`${d}T00:00:00`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

/** Toolbar source line: `"<system|Manual>[ · <scope>][ · fetched <date>]"`. */
export function sourceInfo(source: PlanSource): string {
  return (
    (source.system || "Manual") +
    (source.scope ? ` · ${source.scope}` : "") +
    (source.fetchedAt ? ` · fetched ${new Date(source.fetchedAt).toLocaleString()}` : "")
  );
}

/** Data of one milestone (or Unplanned) summary box. */
export interface BandSummary {
  band: Band;
  features: Feature[];
  /** Epics completed in this milestone, or (Unplanned) epics with any unplanned feature. */
  epicCount: number;
  /** Flags placed right after this milestone (empty for Unplanned). */
  flags: Flag[];
}

/** One summary box per band, in order. */
export function milestoneSummaryData(plan: ReleasePlan): BandSummary[] {
  return bands(plan).map((band) => {
    const features = featuresInBand(plan, band.id);
    const epicCount = band.unplanned
      ? plan.epics.filter((e) => epicMilestone(plan, e).unplanned > 0).length
      : plan.epics.filter((e) => epicCompletedIn(plan, e, band.id)).length;
    return { band, features, epicCount, flags: band.unplanned ? [] : flagsAfter(plan, band.id) };
  });
}

/** Data of one flag summary box. */
export interface FlagSummary {
  flag: Flag;
  /** Name of the milestone the flag sits after. */
  afterName: string;
  /** Cumulative: features whose milestone index ≤ the flag's milestone index. */
  features: Feature[];
  /** Completed epics whose milestone index ≤ the flag's milestone index. */
  epicCount: number;
}

/** Cumulative summary of everything delivered up to and including the flag's milestone. */
export function flagSummaryData(plan: ReleasePlan, flag: Flag): FlagSummary {
  const upto = msIndex(plan, flag.afterMsId);
  const features = allFeatures(plan)
    .map((x) => x.feature)
    .filter((f) => {
      const i = msIndex(plan, f.milestoneId);
      return i >= 0 && i <= upto;
    });
  const epicCount = plan.epics.filter((e) => {
    const r = epicMilestone(plan, e);
    return !r.unplanned && r.ms !== null && msIndex(plan, r.ms.id) <= upto;
  }).length;
  return { flag, afterName: msById(plan, flag.afterMsId)?.name ?? "", features, epicCount };
}

/** Finds a feature and its epic by id. */
export function findFeature(plan: ReleasePlan, id: Feature["id"]): FeatureWithEpic | null {
  return allFeatures(plan).find((x) => x.feature.id === id) ?? null;
}

/** Finds an Epic by id. */
export function findEpic(plan: ReleasePlan, id: Epic["id"]): Epic | null {
  return plan.epics.find((e) => e.id === id) ?? null;
}

/** Feature card tooltip (Phase 1 text; Phase 2 appends the Ctrl+click hint). */
export function featureTooltip(f: Feature): string {
  return `${f.title}\nState: ${f.state || "-"}\nEstimated size: ${f.size || "not estimated"}\nIteration: ${f.iterationPath || "-"}\nClick to see the description`;
}

/**
 * The Azure DevOps connection a plan is linked to (written when the board is
 * created from, or synced with, ADO and kept by Save/Load Plan JSON), or `null`
 * when `source` lacks any of `kind`, `projectUrl`, `scopeType`, `scopePath`.
 */
export function planConnection(source: PlanSource): AdoConnection | null {
  const { kind, projectUrl, scopeType, scopePath } = source;
  return kind && projectUrl && scopeType && scopePath ? { source: kind, projectUrl, scopeType, scopePath } : null;
}

/** Human label of a saved plan's project: `"On Prem · X"` or `"Collaboration Hub · X"`. */
export function projectLabel(projectType: PlanProjectType, projectName: string): string {
  return `${projectType === "onprem" ? "On Prem" : "Collaboration Hub"} · ${projectName}`;
}
