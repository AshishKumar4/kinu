/** Typed client for `/api/shared/*` and the public blueprint read; the session rides the HttpOnly cookie. */
import { Effect } from 'effect';
import {
  BlueprintForkSchema, BlueprintViewSchema, SharedLibrarySchema, LiveShareCreatedSchema, LiveShareRecordSchema, LIVE_SHARE_MODE_PATH,
  type BlueprintFork, type BlueprintView, type JsonValue, type SharedLibrary, type LiveShareCreated, type LiveShareBody, type LiveShareModeBody, type LiveShareRecord,
} from '@kinu.run/core';
import { settle } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { refusal, request, respond } from './http';

function api<Schema extends v.GenericSchema>(schema: Schema, method: string, path: string, body?: JsonValue): Effect.Effect<v.InferOutput<Schema>> {
  return request(schema, path, { method, ...(body !== undefined && { json: body }) });
}

export function getSharedLibrary(): Promise<SharedLibrary> {
  return settle(api(SharedLibrarySchema, 'GET', '/api/shared'));
}

/** Shared was opened: the account's unseen shares are seen, on every device. */
export function markSharedSeen(): Promise<void> {
  return settle(Effect.asVoid(api(v.object({ seen: v.literal(true) }), 'POST', '/api/shared/seen')));
}

/** Refused as 404 when unminted or revoked. */
export function getBlueprint(id: string): Promise<BlueprintView> {
  return settle(api(BlueprintViewSchema, 'GET', `/api/shared/blueprint/${encodeURIComponent(id)}`));
}

const Listing = v.optional(v.literal('pending'));

const PublishedLink = v.object({ id: v.string(), share: v.string(), users: v.array(v.string()), listing: Listing });

export type Published = v.InferOutput<typeof PublishedLink>;

export function publishBlueprint(input: { workspace: string; slate: string; version: string; include?: string[]; emails?: string[] }): Promise<Published> {
  return settle(api(PublishedLink, 'POST', '/api/shared/publish', input));
}

export function forkBlueprint(input: { blueprint: string; workspace: string }): Promise<BlueprintFork> {
  return settle(api(BlueprintForkSchema, 'POST', '/api/shared/fork', input));
}

/** Fork a live share: admitted the same as a blueprint; `ownerWorkspace` names where it runs. */
export function forkLiveShare(input: { live: string; ownerWorkspace: string; workspace: string }): Promise<BlueprintFork> {
  return settle(api(BlueprintForkSchema, 'POST', '/api/shared/fork', input));
}

const MeSchema = v.object({ user: v.nullable(v.object({ email: v.string(), signedInWith: v.optional(v.nullable(v.string()), null) })) });

/** The signed-in session as `/api/auth/me` answers it; null when no one is signed in. */
const signedIn = Effect.gen(function* () {
  const res = yield* respond('/api/auth/me');

  if (res.status === 401) return null;

  if (!res.ok) return yield* Effect.die(yield* refusal(res, 'GET', '/api/auth/me'));

  return v.parse(MeSchema, yield* Effect.promise(async () => res.json())).user;
});

/** The provider this session signed in with, by name ("Cloudflare"); null for a sign-in that is no provider's. */
export function signedInWith(): Promise<string | null> {
  return settle(Effect.map(signedIn, (user) => user?.signedInWith ?? null));
}

/** Whether anyone is signed in on this browser: a public page draws its own shell for a visitor. */
export function readSignedIn(): Promise<boolean> {
  return settle(Effect.map(signedIn, (user) => user !== null));
}

export function signedInEmail(): Promise<string | null> {
  return settle(Effect.map(signedIn, (user) => user?.email ?? null));
}

/** Answers the row and its URL (null where this deployment cannot sign one). */
/** `mode`: whose access the shared server acts with (docs/SLATE-SHARING-NIMBUS.md §2); `approved` counts only for 'owner'. */
export function shareLive(input: LiveShareBody): Promise<LiveShareCreated & { listing?: 'pending' }> {
  return settle(api(v.object({ ...LiveShareCreatedSchema.entries, listing: Listing }), 'POST', '/api/shared/live', input));
}

/** Ends a live share or a blueprint link. */
export async function revokeShare(input: { workspace: string; share: string }): Promise<{ listing?: 'pending' }> {
  return settle(api(v.object({ listing: Listing }), 'POST', '/api/shared/revoke', input));
}

/** Share origin for a public share; a ticket-bearing entry for one that names people. */
export function openLiveShare(input: { workspace: string; share: string }): Promise<{ url: string }> {
  return settle(api(v.object({ url: v.string() }), 'POST', '/api/shared/live/open', input));
}

/** Switches a share's mode, or approves the reach again at the slate's new revision: the share as it now is. */
export function setShareMode(body: LiveShareModeBody): Promise<LiveShareRecord> {
  return settle(api(LiveShareRecordSchema, 'POST', LIVE_SHARE_MODE_PATH, body));
}
