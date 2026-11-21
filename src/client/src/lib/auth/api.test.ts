import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../monteCarlo/api";
import { getMe, logout } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("auth api", () => {
  it("getMe GETs /api/auth/me and returns the user", async () => {
    const user = { id: 3, name: "Ada", email: "ada@example.com", pictureUrl: null };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(user), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getMe()).resolves.toEqual(user);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/me");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET" });
  });

  it("getMe rejects with a 401 ApiError without a session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: ["Not authenticated."] }), { status: 401 })));
    const error = await getMe().catch((exc: unknown) => exc);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it("logout POSTs /api/auth/logout with the CSRF header and resolves on 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(logout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/logout");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { "X-Requested-With": "planning-hub" } });
  });
});
