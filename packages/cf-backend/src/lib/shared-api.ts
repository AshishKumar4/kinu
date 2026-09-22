/** Typed client for `/api/shared/*` and the public blueprint read; the session rides the HttpOnly cookie. */
import {
  BlueprintForkSchema, BlueprintViewSchema, SharedLibrarySchema, LiveShareCreatedSchema, LiveShareRecordSchema,
  type BlueprintFork, type BlueprintView, type JsonValue, type SharedLibrary, type LiveShareCreated, type LiveShareRecord, type LiveShareVisibility,
} from '@kinu.run/core';
import { tolerateAsync } from '@kinu.run/core/obs';
import { DEFAULT_CALL_TIMEOUT_MS } from 'agents/client';
import * as v from 'valibot';

const ErrorBody = v.object({ error: v.string() });

async function errorDetail(res: Response): Promise<string> {
  const parsed = v.safeParse(ErrorBody, await tolerateAsync(() => res.json(), 'malformed-input'));

  return parsed.success ? parsed.output.error : '';
}

async function api<Schema extends v.GenericSchema>(schema: Schema, method: string, path: string, body?: JsonValue): Promise<v.InferOutput<Schema>> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: method === 'GET' ? AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) : undefined,
  });

  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await errorDetail(res)}`);

  return v.parse(schema, await res.json());
}

export function getSharedLibrary(): Promise<SharedLibrary> {
  return api(SharedLibrarySchema, 'GET', '/api/shared');
}

/** Refused as 404 when unminted or revoked. */
export function getBlueprint(id: string): Promise<BlueprintView> {
  return api(BlueprintViewSchema, 'GET', `/api/shared/blueprint/${encodeURIComponent(id)}`);
}

const PublishedLink = v.object({ id: v.string(), share: v.string(), users: v.array(v.string()) });

export type Published = v.InferOutput<typeof PublishedLink>;

export function publishBlueprint(input: { workspace: string; slate: string; version: string; include?: string[]; emails?: string[]; public?: boolean }): Promise<Published> {
  return api(PublishedLink, 'POST', '/api/shared/publish', input);
}

export function forkBlueprint(input: { blueprint: string; workspace: string }): Promise<BlueprintFork> {
  return api(BlueprintForkSchema, 'POST', '/api/shared/fork', input);
}

/** Fork a live share: admitted the same as a blueprint; `ownerWorkspace` names where it runs. */
export function forkLiveShare(input: { live: string; ownerWorkspace: string; workspace: string }): Promise<BlueprintFork> {
  return api(BlueprintForkSchema, 'POST', '/api/shared/fork', input);
}

const MeSchema = v.object({ user: v.nullable(v.object({ email: v.string() })) });

export async function signedInEmail(): Promise<string | null> {
  const res = await fetch('/api/auth/me', { signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) });

  if (res.status === 401) return null;

  if (!res.ok) throw new Error(`GET /api/auth/me → ${res.status} ${await errorDetail(res)}`);

  return v.parse(MeSchema, await res.json()).user?.email ?? null;
}

/** Answers the row and its URL (null where this deployment cannot sign one). */
export function shareLive(input: {
  workspace: string; slate: string; visibility: LiveShareVisibility; emails?: string[];
  approved: { slate: string; binding: string; member: string }[];
  fork?: boolean;
}): Promise<LiveShareCreated> {
  return api(LiveShareCreatedSchema, 'POST', '/api/shared/live', input);
}

export function revokeLiveShare(input: { workspace: string; share: string }): Promise<LiveShareRecord> {
  return api(LiveShareRecordSchema, 'POST', '/api/shared/live/revoke', input);
}

/** Share origin for a public share; a ticket-bearing entry for one that names people. */
export function openLiveShare(input: { workspace: string; share: string }): Promise<{ url: string }> {
  return api(v.object({ url: v.string() }), 'POST', '/api/shared/live/open', input);
}
