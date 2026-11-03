import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConnectResponse } from "../../test/adoFixtures";
import { ApiError } from "../monteCarlo/api";
import { adoConnect, deleteRequest, getJson, postJson, putJson } from "./api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const REQ = { source: "cloud", projectUrl: "https://dev.azure.com/o/P", pat: "pat-1" } as const;

describe("ado api", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adoConnect POSTs the JSON body (PAT in the body only) with the signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(makeConnectResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(adoConnect(REQ, controller.signal)).resolves.toEqual(makeConnectResponse());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ado/connect");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal });
    expect(JSON.parse(String(init.body))).toEqual(REQ);
  });

  it("turns a 422 {errors} into an ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ errors: ["Project not found: P. Check the URL."] }, 422)));
    const error = await adoConnect(REQ).catch((exc: unknown) => exc);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).errors).toEqual(["Project not found: P. Check the URL."]);
    expect((error as ApiError).status).toBe(422);
  });

  it("postJson uses a generic message for a non-JSON error page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 })));
    const error = await postJson("/api/ado/anything", {}).catch((exc: unknown) => exc);
    expect((error as ApiError).errors).toEqual(["Unexpected server error (HTTP 502)."]);
  });

  it("rethrows an abort unchanged (not as an ApiError)", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    const error = await adoConnect(REQ, new AbortController().signal).catch((exc: unknown) => exc);
    expect(error).toBe(abort);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});

describe("getJson / putJson / deleteRequest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("use the right method, headers and body", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    await getJson("/g");
    await putJson("/p", { a: 1 });
    expect(fetchMock.mock.calls[0]).toEqual(["/g", { method: "GET", signal: undefined }]);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init).toMatchObject({ method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteRequest("/d")).resolves.toBeUndefined();
    expect((fetchMock.mock.calls[2] as [string, RequestInit])[1].method).toBe("DELETE");
  });
});
