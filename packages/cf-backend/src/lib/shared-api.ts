/** Typed client for `/api/shared/*` and the public blueprint read; the session rides the HttpOnly cookie. */
import { Effect } from 'effect';
import {
  BlueprintForkSchema, BlueprintViewSchema, SharedLibrarySchema, LiveShareCreatedSchema,
  type BlueprintFork, type BlueprintView, type JsonValue, type SharedLibrary, type LiveShareCreated, type LiveShareVisibility,
} from '@kinu.run/core';
import { tolerateAsync, settle } from '@kinu.run/core/obs';
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

const Listing = v.optional(v.literal('pending'));

const PublishedLink = v.object({ id: v.string(), share: v.string(), users: v.array(v.string()), listing: Listing });

export type Published = v.InferOutput<typeof PublishedLink>;

export function publishBlueprint(input: { workspace: string; slate: string; version: string; include?: string[]; emails?: string[] }): Promise<Published> {
  return api(PublishedLink, 'POST', '/api/shared/publish', input);
}

export function forkBlueprint(input: { blueprint: string; workspace: string }): Promise<BlueprintFork> {
  return api(BlueprintForkSchema, 'POST', '/api/shared/fork', input);
}

/** Fork a live share: admitted the same as a blueprint; `ownerWorkspace` names where it runs. */
export function forkLiveShare(input: { live: string; ownerWorkspace: string; workspace: string }): Promise<BlueprintFork> {
  return api(BlueprintForkSchema, 'POST', '/api/shared/fork', input);
}

const MeSchema = v.object({ user: v.nullable(v.object({ email: v.string(), signedInWith: v.optional(v.nullable(v.string()), null) })) });

/** The signed-in session as `/api/auth/me` answers it; null when no one is signed in. */
function signedIn(): Promise<v.InferOutput<typeof MeSchema>['user']> {
  return settle(Effect.gen(function* () {
    const res = yield* Effect.promise(async () => fetch('/api/auth/me', { signal: AbortSignal.timeout(DEFAULT_CALL_TIMEOUT_MS) }));

    if (res.status === 401) return null;

    if (!res.ok) return yield* Effect.die(new Error(`GET /api/auth/me → ${res.status} ${yield* Effect.promise(async () => errorDetail(res))}`));

    return v.parse(MeSchema, yield* Effect.promise(async () => res.json())).user;
  }));
}

/** The provider this session signed in with, by name ("Cloudflare"); null for a sign-in that is no provider's. */
export async function signedInWith(): Promise<string | null> {
  return (await signedIn())?.signedInWith ?? null;
}

export async function signedInEmail(): Promise<string | null> {
  return (await signedIn())?.email ?? null;
}

/** Answers the row and its URL (null where this deployment cannot sign one). */
export function shareLive(input: {
  workspace: string; slate: string; visibility: LiveShareVisibility; emails?: string[];
  approved: { slate: string; namespace: string; member: string }[];
  fork?: boolean;
}): Promise<LiveShareCreated & { listing?: 'pending' }> {
  return api(v.object({ ...LiveShareCreatedSchema.entries, listing: Listing }), 'POST', '/api/shared/live', input);
}

/** Ends a live share or a blueprint link. */
export async function revokeShare(input: { workspace: string; share: string }): Promise<{ listing?: 'pending' }> {
  return await api(v.object({ listing: Listing }), 'POST', '/api/shared/revoke', input);
}

/** Share origin for a public share; a ticket-bearing entry for one that names people. */
export function openLiveShare(input: { workspace: string; share: string }): Promise<{ url: string }> {
  return api(v.object({ url: v.string() }), 'POST', '/api/shared/live/open', input);
}
