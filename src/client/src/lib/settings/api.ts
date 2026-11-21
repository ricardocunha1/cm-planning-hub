import { deleteRequest, getJson, postJson, putJson } from "../ado/api";
import type { AdoCredential, AdoCredentialCreate, AdoCredentialList, AdoCredentialUpdate } from "./types";

const BASE = "/api/settings/ado-credentials";

/** GET: the signed-in user's stored credentials (never their PATs). */
export function listAdoCredentials(signal?: AbortSignal): Promise<AdoCredentialList> {
  return getJson<AdoCredentialList>(BASE, signal);
}

/**
 * POST: stores a credential (201). The PAT only travels in this request body.
 * @throws ApiError (422 `{errors}` for invalid or duplicate input).
 */
export function createAdoCredential(body: AdoCredentialCreate, signal?: AbortSignal): Promise<AdoCredential> {
  return postJson<AdoCredential>(BASE, body, signal);
}

/** PUT: updates a credential; leave `pat` out to keep the stored one. */
export function updateAdoCredential(id: number, body: AdoCredentialUpdate, signal?: AbortSignal): Promise<AdoCredential> {
  return putJson<AdoCredential>(`${BASE}/${id}`, body, signal);
}

/** DELETE: removes a credential (204). */
export function deleteAdoCredential(id: number, signal?: AbortSignal): Promise<void> {
  return deleteRequest(`${BASE}/${id}`, signal);
}
