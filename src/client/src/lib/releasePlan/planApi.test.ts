import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../monteCarlo/api";
import { makePlan } from "../../test/releasePlanFixtures";
import { createPlan, deletePlan, getPlan, listPlans, updatePlan } from "./planApi";
import type { PlanDetail, PlanSummary } from "./planTypes";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const SUMMARY: PlanSummary = {
  id: 12,
  name: "Proj – Feature Release Plan",
  projectType: "onprem",
  projectName: "Proj",
  createdAt: "2026-11-03T10:15:00.123456Z",
  updatedAt: "2026-11-03T11:02:41.000001Z",
};

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit];
}

describe("planApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("listPlans GETs the page and returns the parsed list", async () => {
    const body = { items: [SUMMARY], total: 37, page: 2, pageSize: 10 };
    const fetchMock = stubFetch(json(body));
    const controller = new AbortController();
    await expect(listPlans(2, controller.signal)).resolves.toEqual(body);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/plan?page=2");
    expect(init).toMatchObject({ method: "GET", signal: controller.signal });
  });

  it("getPlan GETs /api/plan/{id}", async () => {
    const detail: PlanDetail = { ...SUMMARY, state: { schema: "release-planner-features" } };
    const fetchMock = stubFetch(json(detail));
    await expect(getPlan(12)).resolves.toEqual(detail);
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/plan/12");
    expect(init.method).toBe("GET");
  });

  it("createPlan POSTs the JSON body", async () => {
    const state = makePlan();
    const req = { name: "N", projectType: "cloud", projectName: "P", state } as const;
    const fetchMock = stubFetch(json({ ...SUMMARY, state }, 201));
    const controller = new AbortController();
    await expect(createPlan(req, controller.signal)).resolves.toMatchObject({ id: 12 });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/plan");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal });
    expect(JSON.parse(String(init.body))).toEqual(JSON.parse(JSON.stringify(req)));
  });

  it("updatePlan PUTs name and state to /api/plan/{id}", async () => {
    const state = makePlan();
    const fetchMock = stubFetch(json({ ...SUMMARY, state }));
    await expect(updatePlan(12, { name: "N", state })).resolves.toMatchObject({ id: 12 });
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/plan/12");
    expect(init).toMatchObject({ method: "PUT", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init.body))).toEqual(JSON.parse(JSON.stringify({ name: "N", state })));
  });

  it("deletePlan DELETEs and resolves on a 204 without parsing a body", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    const controller = new AbortController();
    await expect(deletePlan(12, controller.signal)).resolves.toBeUndefined();
    const [url, init] = lastCall(fetchMock);
    expect(url).toBe("/api/plan/12");
    expect(init).toMatchObject({ method: "DELETE", signal: controller.signal });
    expect(init.body).toBeUndefined();
  });

  it.each([
    [404, "Release plan not found: 12."],
    [422, "Plan name is required."],
    [503, "Database unavailable."],
  ])("turns a %i {errors} body into an ApiError with the server messages", async (status, message) => {
    stubFetch(json({ errors: [message] }, status));
    for (const call of [
      () => listPlans(1),
      () => getPlan(12),
      () => createPlan({ name: "", projectType: "onprem", projectName: "P", state: makePlan() }),
      () => updatePlan(12, { name: "", state: makePlan() }),
      () => deletePlan(12),
    ]) {
      stubFetch(json({ errors: [message] }, status));
      const error = await call().catch((exc: unknown) => exc);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).errors).toEqual([message]);
      expect((error as ApiError).status).toBe(status);
    }
  });

  it("rethrows an abort unchanged", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    const controller = new AbortController();
    for (const call of [
      () => listPlans(1, controller.signal),
      () => getPlan(1, controller.signal),
      () => deletePlan(1, controller.signal),
    ]) {
      const error = await call().catch((exc: unknown) => exc);
      expect(error).toBe(abort);
    }
  });
});
