import { afterEach, describe, expect, it, vi } from "vitest";
import { onUnauthorized } from "../auth/session";
import { makeSprintHistory } from "../../test/monteCarloFixtures";
import { ApiError, adoSprintHistory, request, simulate } from "./api";

function respondWith(body: string, status: number, contentType = "application/json") {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status, headers: { "Content-Type": contentType } })));
}

async function errorsFrom(): Promise<string[]> {
  const error = await simulate([], {} as never).catch((exc: unknown) => exc);
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).errors;
}

describe("api error messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the app's own errors list", async () => {
    respondWith(JSON.stringify({ errors: ["Target Value must be positive.", "Bad date."] }), 422);
    expect(await errorsFrom()).toEqual(["Target Value must be positive.", "Bad date."]);
  });

  it("uses a FastAPI string detail", async () => {
    respondWith(JSON.stringify({ detail: "Not Found" }), 404);
    expect(await errorsFrom()).toEqual(["Not Found"]);
  });

  it("uses the msg of each FastAPI detail item", async () => {
    respondWith(JSON.stringify({ detail: [{ msg: "field required" }, { msg: "bad type" }] }), 422);
    expect(await errorsFrom()).toEqual(["field required", "bad type"]);
  });

  it("uses a message field", async () => {
    respondWith(JSON.stringify({ message: "Upload too large" }), 413);
    expect(await errorsFrom()).toEqual(["Upload too large"]);
  });

  it("uses a short plain-text body", async () => {
    respondWith("Internal Server Error", 500, "text/plain");
    expect(await errorsFrom()).toEqual(["Internal Server Error"]);
  });

  it("falls back to a generic message for an HTML error page", async () => {
    respondWith("<html><body>502 Bad Gateway</body></html>", 502, "text/html");
    expect(await errorsFrom()).toEqual(["Unexpected server error (HTTP 502)."]);
  });

  it("reports an unreachable server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await errorsFrom()).toEqual(["Could not reach the server: Failed to fetch"]);
  });
});

describe("adoSprintHistory", () => {
  afterEach(() => vi.unstubAllGlobals());

  const REQ = { source: "onprem", projectUrl: "https://tfs.example.com/C/P", pat: "pat-1", iterationPath: "P\\Phase 1" } as const;

  it("POSTs the JSON body (PAT in the body only) with the signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(makeSprintHistory()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(adoSprintHistory(REQ, controller.signal)).resolves.toEqual(makeSprintHistory());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ado/sprint-history");
    expect(url).not.toContain("pat-1");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal });
    expect(JSON.parse(String(init.body))).toEqual(REQ);
  });

  it("turns a 422 {errors} into an ApiError", async () => {
    respondWith(JSON.stringify({ errors: ["Choose an Iteration path."] }), 422);
    const error = await adoSprintHistory(REQ).catch((exc: unknown) => exc);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).errors).toEqual(["Choose an Iteration path."]);
    expect((error as ApiError).status).toBe(422);
  });
});

describe("request 204", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves to undefined for a 204 without parsing a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(request<void>("/x", { method: "DELETE" })).resolves.toBeUndefined();
  });
});

describe("request CSRF header and 401 handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  function headersOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
    return (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  }

  it.each(["POST", "PUT", "DELETE", "PATCH"])("sends X-Requested-With: planning-hub on %s, keeping other headers", async (method) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await request("/x", { method, headers: { "Content-Type": "application/json" } });
    expect(headersOf(fetchMock)).toEqual({ "Content-Type": "application/json", "X-Requested-With": "planning-hub" });
  });

  it("adds the header even when the call has no headers of its own", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await request("/x", { method: "DELETE" });
    expect(headersOf(fetchMock)).toEqual({ "X-Requested-With": "planning-hub" });
  });

  it("does not add the header to GET (explicit or default method)", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await request("/x", { method: "GET" });
    await request("/x", {});
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).headers).toBeUndefined();
    }
  });

  it("notifies the unauthorized listeners on a 401 and still throws the ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: ["Not authenticated."] }), { status: 401 })));
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    await expect(request("/x", { method: "GET" })).rejects.toMatchObject({ status: 401, errors: ["Not authenticated."] });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await request("/x", { method: "GET" }).catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify on other errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: ["bad"] }), { status: 422 })));
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    await request("/x", { method: "POST" }).catch(() => undefined);
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });
});
