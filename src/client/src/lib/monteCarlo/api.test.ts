import { afterEach, describe, expect, it, vi } from "vitest";
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
