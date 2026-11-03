import { request } from "../monteCarlo/api";
import type { AdoConnectResponse, AdoConnectionRequest } from "./types";

/**
 * POSTs `body` as JSON through the shared `request` helper (ApiError on a
 * non-2xx, the fetch's `AbortError` unchanged when `signal` aborts). Used by
 * every `/api/ado/*` client.
 */
export function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** GETs `url` through the shared `request` helper (same error/abort behavior as {@link postJson}). */
export function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return request<T>(url, { method: "GET", signal });
}

/** PUTs `body` as JSON through the shared `request` helper. */
export function putJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** DELETEs `url` through the shared `request` helper; resolves once the server answers 204. */
export function deleteRequest(url: string, signal?: AbortSignal): Promise<void> {
  return request<void>(url, { method: "DELETE", signal });
}

/**
 * POST /api/ado/connect: validates the URL + PAT and returns the project with
 * its Area and Iteration trees. The PAT travels in the JSON body only.
 * @throws ApiError with the server's messages (422 `{errors}`); an `AbortError` when `signal` aborts.
 */
export function adoConnect(req: AdoConnectionRequest, signal?: AbortSignal): Promise<AdoConnectResponse> {
  return postJson<AdoConnectResponse>("/api/ado/connect", req, signal);
}
