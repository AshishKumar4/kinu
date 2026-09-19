/**
 * Typed client for `/api/shared/*` and the one public read behind the
 * blueprint page. The session rides the HttpOnly cookie, so the fetches are
 * bare; the blueprint read needs none.
 */
import {
  BlueprintForkSchema, BlueprintViewSchema, SharedLibrarySchema, LiveShareCreatedSchema, LiveShareRecordSchema,
  type BlueprintFork, type BlueprintView, type SharedLibrary, type LiveShareCreated, type LiveShareRecord, type LiveShareVisibility,
} from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import { DEFAULT_CALL_TIMEOUT_MS } from 'agents/client';
import * as v from 'valibot';

const ErrorBody = v.object({ error: v.string() });

async function errorDetail(res: Response): Promise<string> {
  const parsed = v.safeParse(ErrorBody, await tolerateAsync(() => res.json(), 'malformed-input'));

  return parsed.success ? parsed.output.error : '';
}

async function api<Schema extends v.GenericSchema, Body>(schema: Schema, method: string, path: string, body?: Body): Promise<v.InferOutput<Schema>> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: method === 'GET' ? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) : undefined,
  });

  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await errorDetail(res)}`);

  return v.parse(schema, await res.json());
}

/** My shared and shared with me. */
export function getSharedLibrary(): Promise<SharedLibrary> {
  return api(SharedLibrarySchema, 'GET', '/api/shared');
}

/** A blueprint's read-only page; refused as 404 when unminted or revoked. */
export function getBlueprint(id: string): Promise<BlueprintView> {
  return api(BlueprintViewSchema, 'GET', `/api/shared/blueprint/${encodeURIComponent(id)}`);
}

const PublishedLink = v.object({ id: v.string(), share: v.string(), users: v.array(v.string()) });

/** What publishing answered: the signed link and who was named. */
export type Published = v.InferOutput<typeof PublishedLink>;

export function publishBlueprint(input: { workspace: string; slate: string; version: string; include?: string[]; emails?: string[]; public?: boolean }): Promise<Published> {
  return api(PublishedLink, 'POST', '/api/shared/publish', input);
}

export function forkBlueprint(input: { blueprint: string; workspace: string }): Promise<BlueprintFork> {
  return api(BlueprintForkSchema, 'POST', '/api/shared/fork', input);
}

/** Fork a LIVE share: the running slate's skeleton, admitted the same as a
 *  blueprint's — `ownerWorkspace` names where it runs, `live` its share row. */
export function forkLiveShare(input: { live: string; ownerWorkspace: string; workspace: string }): Promise<BlueprintFork> {
  return api(BlueprintForkSchema, 'POST', '/api/shared/fork', input);
}

const MeSchema = v.object({ user: v.nullable(v.object({ email: v.string() })) });

/** Whether this browser holds a Kinu session; the one read the public page makes about the viewer. */
export async function signedInEmail(): Promise<string | null> {
  const res = await fetch('/api/auth/me', { signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) });

  if (res.status === 401) return null;

  if (!res.ok) throw new Error(`GET /api/auth/me → ${res.status} ${await errorDetail(res)}`);

  return v.parse(MeSchema, await res.json()).user?.email ?? null;
}

/** Share the running slate under the members the owner approved; answers
 *  the row and the URL it serves at (null where this deployment cannot sign one). */
export function shareLive(input: {
  workspace: string; slate: string; visibility: LiveShareVisibility; emails?: string[];
  approved: { slate: string; binding: string; member: string }[];
  fork?: boolean;
}): Promise<LiveShareCreated> {
  return api(LiveShareCreatedSchema, 'POST', '/api/shared/live', input);
}

/** Revoke one of the owner's live shares; answers the row with `revokedAt` set. */
export function revokeLiveShare(input: { workspace: string; share: string }): Promise<LiveShareRecord> {
  return api(LiveShareRecordSchema, 'POST', '/api/shared/live/revoke', input);
}

/** The URL this signed-in user opens a live share at: the share origin for a
 *  public one, a ticket-bearing entry for a share that names people. */
export function openLiveShare(input: { workspace: string; share: string }): Promise<{ url: string }> {
  return api(v.object({ url: v.string() }), 'POST', '/api/shared/live/open', input);
}
