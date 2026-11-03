import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../monteCarlo/api";
import { makePlan } from "../../test/releasePlanFixtures";
import { createPlan, deletePlan, getPlan, listPlans, updatePlan } from "./planApi";
import type { PlanDetail } from "./planTypes";

/** A fake server emulating the `/api/plan` contract at the fetch boundary. */
function installFakeServer(opts: { unavailable?: boolean } = {}) {
  const rows = new Map<number, PlanDetail>();
  let nextId = 1;
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 3, 10, 0, tick++)).toISOString();
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const notFound = (id: number) => json(404, { errors: [`Release plan not found: ${id}.`] });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (opts.unavailable) return json(503, { errors: ["The release plan database is unavailable."] });
    const url = new URL(String(input), "http://x");
    const method = init?.method ?? "GET";
    const m = url.pathname.match(/^\/api\/plan(?:\/(\d+))?$/);
    if (!m) return json(404, { errors: ["no route"] });
    const id = m[1] ? Number(m[1]) : undefined;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (id === undefined && method === "GET") {
      const page = Number(url.searchParams.get("page"));
      const all = [...rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
      const items = all.slice((page - 1) * 10, page * 10).map(({ state: _s, ...s }) => s);
      return json(200, { items, total: all.length, page, pageSize: 10 });
    }
    if (id === undefined && method === "POST") {
      if (!body.name.trim()) return json(422, { errors: ["Plan name is required."] });
      const row: PlanDetail = { id: nextId++, name: body.name.trim(), projectType: body.projectType, projectName: body.projectName, createdAt: stamp(), updatedAt: "", state: body.state };
      row.updatedAt = row.createdAt;
      rows.set(row.id, row);
      return json(201, row);
    }
    if (id === undefined) return json(405, { errors: ["method"] });
    const row = rows.get(id);
    if (!row) return notFound(id);
    if (method === "GET") return json(200, row);
    if (method === "PUT") {
      Object.assign(row, { name: body.name.trim(), state: body.state, updatedAt: stamp() });
      return json(200, row);
    }
    if (method === "DELETE") {
      rows.delete(id);
      return new Response(null, { status: 204 });
    }
    return json(405, { errors: ["method"] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("planApi against a contract-faithful fake server", () => {
  beforeEach(() => installFakeServer());
  afterEach(() => vi.unstubAllGlobals());

  it("runs the full create -> list -> get -> update -> delete lifecycle", async () => {
    const state = makePlan();
    const created = await createPlan({ name: " Mine ", projectType: "cloud", projectName: "Proj", state });
    expect(created).toMatchObject({ id: 1, name: "Mine", projectType: "cloud", state });

    const other = await createPlan({ name: "Other", projectType: "onprem", projectName: "P2", state });
    let list = await listPlans(1);
    expect(list).toMatchObject({ total: 2, page: 1, pageSize: 10 });
    expect(list.items.map((i) => i.id)).toEqual([other.id, created.id]);
    expect(list.items[0]).not.toHaveProperty("state");

    const updated = await updatePlan(created.id, { name: "Renamed", state: { ...state, name: "Renamed" } });
    expect(updated.name).toBe("Renamed");
    expect((await getPlan(created.id)).state).toEqual({ ...state, name: "Renamed" });
    list = await listPlans(1);
    expect(list.items.map((i) => i.id)).toEqual([created.id, other.id]);
    expect((await listPlans(2)).items).toEqual([]);

    await expect(deletePlan(created.id)).resolves.toBeUndefined();
    const err = await getPlan(created.id).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(`Release plan not found: ${created.id}.`);
    await expect(updatePlan(created.id, { name: "x", state })).rejects.toBeInstanceOf(ApiError);
    await expect(deletePlan(created.id)).rejects.toThrow("Release plan not found: 1.");
  });

  it("surfaces 422 messages verbatim", async () => {
    await expect(
      createPlan({ name: "  ", projectType: "cloud", projectName: "P", state: makePlan() }),
    ).rejects.toMatchObject({ name: "ApiError", message: "Plan name is required." });
  });
});

describe("planApi when the database is unavailable", () => {
  beforeEach(() => installFakeServer({ unavailable: true }));
  afterEach(() => vi.unstubAllGlobals());

  it("rejects every call with the 503 message", async () => {
    const msg = "The release plan database is unavailable.";
    const state = makePlan();
    await expect(listPlans(1)).rejects.toThrow(msg);
    await expect(getPlan(1)).rejects.toThrow(msg);
    await expect(createPlan({ name: "n", projectType: "cloud", projectName: "p", state })).rejects.toThrow(msg);
    await expect(updatePlan(1, { name: "n", state })).rejects.toThrow(msg);
    await expect(deletePlan(1)).rejects.toThrow(msg);
  });
});
