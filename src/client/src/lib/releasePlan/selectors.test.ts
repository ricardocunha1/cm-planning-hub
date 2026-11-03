import { describe, expect, it } from "vitest";
import { makeEpic, makeFeature, makeFlag, makeMilestone, makePlan, samplePlan, sprintsPlan } from "../../test/releasePlanFixtures";
import {
  bands,
  epicMetaText,
  epicMilestone,
  epicMsLabel,
  featureTooltip,
  flagForMsIndex,
  flagSummaryData,
  fmtDate,
  iterationLeaf,
  milestoneSummaryData,
  orderedFlags,
  planConnection,
  projectLabel,
  sizeCounts,
  sizeSummary,
  sourceInfo,
  sprintLeaves,
} from "./selectors";
import { NO_EPIC_ID } from "./types";

const sized = (...sizes: string[]) => sizes.map((size, i) => makeFeature({ id: i, size }));

describe("sizeCounts / sizeSummary", () => {
  it("orders SIZES, then other sizes sorted, then '?', leaving zero counts out", () => {
    expect(sizeCounts(sized("", "ZZ", "M", "XS", "M", "AA", "XXL", ""))).toEqual([
      ["XS", 1], ["M", 2], ["XXL", 1], ["AA", 1], ["ZZ", 1], ["?", 2],
    ]);
  });

  it("summarizes as 'S×2 · M×3' or '–' when empty", () => {
    expect(sizeSummary(sized("M", "S", "M", "S", "M"))).toBe("S×2 · M×3");
    expect(sizeSummary([])).toBe("–");
  });
});

describe("epicMilestone / epicMsLabel", () => {
  const plan = makePlan({ milestones: [makeMilestone({ id: "a", name: "MVP" }), makeMilestone({ id: "b", name: "R2" })] });

  it("'No features' for an empty epic", () => {
    expect(epicMsLabel(plan, makeEpic({ id: 1 }))).toBe("No features");
  });

  it("'Unplanned' when every feature is unplanned", () => {
    expect(epicMsLabel(plan, makeEpic({ id: 1, features: [makeFeature({ id: 2 }), makeFeature({ id: 3 })] }))).toBe("Unplanned");
  });

  it("'<latest> · N unplanned' when some are unplanned", () => {
    const epic = makeEpic({ id: 1, features: [makeFeature({ id: 2, milestoneId: "a" }), makeFeature({ id: 3 })] });
    expect(epicMsLabel(plan, epic)).toBe("MVP · 1 unplanned");
  });

  it("'Done in <latest>' when all are planned", () => {
    const epic = makeEpic({ id: 1, features: [makeFeature({ id: 2, milestoneId: "b" }), makeFeature({ id: 3, milestoneId: "a" })] });
    expect(epicMsLabel(plan, epic)).toBe("Done in R2");
    expect(epicMilestone(plan, epic)).toEqual({ ms: plan.milestones[1], unplanned: 0, total: 2 });
  });
});

describe("epicMetaText", () => {
  it("prefixes 'Epic #<id>' for ADO Epics (number or string ids)", () => {
    expect(epicMetaText(makeEpic({ id: 7 }), "Done in MVP")).toBe("Epic #7 · Done in MVP");
    expect(epicMetaText(makeEpic({ id: "7" }), "Unplanned")).toBe("Epic #7 · Unplanned");
  });

  it("shows only the label for the synthetic Epic", () => {
    expect(epicMetaText(makeEpic({ id: NO_EPIC_ID }), "MVP · 1 unplanned")).toBe("MVP · 1 unplanned");
  });
});

describe("flags", () => {
  const plan = makePlan({
    milestones: ["a", "b", "c", "d"].map((id) => makeMilestone({ id })),
    flags: [makeFlag({ id: "f3", afterMsId: "c" }), makeFlag({ id: "f1", afterMsId: "a" })],
  });

  it("orders flags by milestone", () => {
    expect(orderedFlags(plan).map((f) => f.id)).toEqual(["f1", "f3"]);
  });

  it("flagForMsIndex is the first flag at or after the index, none for i < 0 or past the last flag", () => {
    expect(flagForMsIndex(plan, -1)).toBeNull();
    expect(flagForMsIndex(plan, 0)?.id).toBe("f1");
    expect(flagForMsIndex(plan, 1)?.id).toBe("f3");
    expect(flagForMsIndex(plan, 2)?.id).toBe("f3");
    expect(flagForMsIndex(plan, 3)).toBeNull();
  });
});

describe("iterationLeaf / sprintLeaves", () => {
  it("returns the last term only when the path has more than one term", () => {
    expect(iterationLeaf({ iterationPath: "Proj\\Release\\Sprint 3" })).toBe("Sprint 3");
    expect(iterationLeaf({ iterationPath: " Proj \\ Sprint 1 " })).toBe("Sprint 1");
    expect(iterationLeaf({ iterationPath: "Proj" })).toBeNull();
    expect(iterationLeaf({ iterationPath: "Proj\\" })).toBeNull();
    expect(iterationLeaf({ iterationPath: "" })).toBeNull();
  });

  it("collects unique leaves in natural order", () => {
    expect(sprintLeaves(samplePlan())).toEqual(["Sprint 1", "Sprint 2", "Sprint 10"]);
  });
});

describe("fmtDate / sourceInfo / featureTooltip", () => {
  it("formats dates, keeps invalid input and returns '' for empty", () => {
    expect(fmtDate("")).toBe("");
    expect(fmtDate("not-a-date")).toBe("not-a-date");
    expect(fmtDate("2026-10-20")).toBe(new Date("2026-10-20T00:00:00").toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }));
  });

  it("builds the source info line", () => {
    expect(sourceInfo({})).toBe("Manual");
    expect(sourceInfo({ system: "Azure DevOps", scope: "Area Path: X" })).toBe("Azure DevOps · Area Path: X");
    const fetchedAt = "2026-10-16T12:27:00Z";
    expect(sourceInfo({ fetchedAt })).toBe(`Manual · fetched ${new Date(fetchedAt).toLocaleString()}`);
  });

  it("builds the card tooltip", () => {
    expect(featureTooltip(makeFeature({ id: 1, title: "T" }))).toBe("T\nState: New\nEstimated size: not estimated\nIteration: -\nClick to see the description");
  });
});

describe("summaries", () => {
  it("counts features and completed epics per band", () => {
    const data = milestoneSummaryData(samplePlan());
    expect(data.map((d) => [d.band.name, d.features.length, d.epicCount])).toEqual([
      ["MVP", 2, 1],
      ["Release 2", 2, 0],
      ["Unplanned", 1, 1],
    ]);
    expect(bands(samplePlan()).at(-1)).toEqual({ unplanned: true, id: null, name: "Unplanned", milestone: null });
  });

  it("computes cumulative flag summaries", () => {
    const plan = sprintsPlan();
    const s = flagSummaryData(plan, plan.flags[0]);
    expect(s.afterName).toBe("Sprint 1");
    expect(s.features.map((f) => f.id)).toEqual([51]);
    expect(s.epicCount).toBe(0);
    const all = sprintsPlan({ flags: [makeFlag({ id: "end", afterMsId: "sp_2" })] });
    const planned = { ...all, epics: [{ ...all.epics[0], features: all.epics[0].features.slice(0, 2) }] };
    expect(flagSummaryData(planned, planned.flags[0])).toMatchObject({ epicCount: 1 });
  });
});

describe("planConnection", () => {
  const full = { system: "Azure DevOps", kind: "onprem", projectUrl: "https://tfs.example.com/C/P", scopeType: "iteration", scopePath: "P\\Phase 1" } as const;

  it("maps a complete plan source to its connection", () => {
    expect(planConnection(full)).toEqual({ source: "onprem", projectUrl: "https://tfs.example.com/C/P", scopeType: "iteration", scopePath: "P\\Phase 1" });
  });

  it.each(["kind", "projectUrl", "scopeType", "scopePath"] as const)("is null without %s", (key) => {
    const partial = { ...full, [key]: undefined };
    expect(planConnection(partial)).toBeNull();
  });

  it("is null for an empty source or an empty string field", () => {
    expect(planConnection({})).toBeNull();
    expect(planConnection({ ...full, projectUrl: "" })).toBeNull();
  });
});

describe("projectLabel", () => {
  it("labels both project types with a middle dot", () => {
    expect(projectLabel("onprem", "Proj")).toBe("On Prem · Proj");
    expect(projectLabel("cloud", "Proj")).toBe("Collaboration Hub · Proj");
  });
});
