import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../monteCarlo/api";
import { createAdoCredential, deleteAdoCredential, listAdoCredentials, updateAdoCredential } from "./api";

const item = { id: 4, projectName: "Alpha", projectUrl: "https://dev.azure.com/org/Alpha", hasPat: true };

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("settings api", () => {
  it("lists credentials with GET", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ items: [item] }), { status: 200 }));
    await expect(listAdoCredentials()).resolves.toEqual({ items: [item] });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/settings/ado-credentials");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET" });
  });

  it("creates with POST and the PAT in the JSON body only", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify(item), { status: 201 }));
    const body = { projectName: "Alpha", projectUrl: item.projectUrl, pat: "secret" };
    await expect(createAdoCredential(body)).resolves.toEqual(item);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/settings/ado-credentials");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { "X-Requested-With": "planning-hub" } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(body);
  });

  it("updates with PUT on the item URL and omits the PAT when not given", async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify(item), { status: 200 }));
    await updateAdoCredential(4, { projectName: "Beta", projectUrl: item.projectUrl });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/settings/ado-credentials/4");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ projectName: "Beta", projectUrl: item.projectUrl });
  });

  it("deletes with DELETE and resolves on 204", async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await expect(deleteAdoCredential(4)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/settings/ado-credentials/4");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });

  it("rejects with an ApiError carrying the server errors", async () => {
    stubFetch(new Response(JSON.stringify({ errors: ["Duplicate URL."] }), { status: 422 }));
    const error = await createAdoCredential({ projectName: "a", projectUrl: "b", pat: "c" }).catch((exc: unknown) => exc);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).errors).toEqual(["Duplicate URL."]);
  });
});
