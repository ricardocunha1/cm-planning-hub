import { vi } from "vitest";
import { AUTOSAVE_KEY } from "../lib/releasePlan/autosavePreference";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A `PlanDetail` as the server returns it. */
export function planDetail(id: number, state: unknown, name = "Plan") {
  return { id, name, projectType: "cloud", projectName: "Proj", createdAt: "2026-11-01T08:00:00Z", updatedAt: "2026-11-03T10:15:00Z", state };
}

/**
 * Stubs `fetch` with a one-plan fake of `/api/plan/{id}`: GET returns `state` (or what the last PUT stored),
 * PUT records `{name, state}` in `puts` and answers 200. Any other request goes
 * to `other` (default: throws). Call `vi.unstubAllGlobals()` afterwards.
 */
export function stubPlanServer(
  state: unknown,
  { id = 1, other }: { id?: number; other?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {},
) {
  let current = state;
  const puts: Array<{ name: string; state: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `/api/plan/${id}`) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { name: string; state: unknown };
        puts.push(body);
        current = body.state;
        return json(planDetail(id, body.state, body.name));
      }
      return json(planDetail(id, current));
    }
    if (other) {
      return other(url, init);
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, puts };
}

/** Turns the per-browser autosave preference off, so tests save with the Save button instead of waiting 3 s. */
export function disableAutosave(): void {
  window.localStorage.setItem(AUTOSAVE_KEY, "off");
}
