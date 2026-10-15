/**
 * Typed client for the Drive's shared library (`/api/shared`) and the signed-in read; the session rides the HttpOnly
 * cookie. A slate's own sharing goes through its room (use-room, room-client).
 */
import { Effect } from 'effect';
import { DriveRoomCardSchema, GalleryListingSchema, RoomAudienceSchema } from '@kinu.run/core';
import { settle } from '@kinu.run/core/obs';
import * as v from 'valibot';
import { refusal, request, respond } from './http';

/** One of the owner's slates, and who can open it. */
export const OwnedSlateSchema = v.object({
  id: v.string(),
  title: v.string(),
  workspace: v.string(),
  audience: RoomAudienceSchema,
  picture: v.optional(v.string()),
});

export type OwnedSlate = v.InferOutput<typeof OwnedSlateSchema>;

export type DriveCard = DriveLibrary['shared'][number];

/**
 * What the Drive shows of sharing: the owner's slates; slates shared with them; slates they used through a link; and
 * Gallery slates they starred. `unseen` marks a slate shared with them since they last opened Shared.
 */
export const DriveLibrarySchema = v.object({
  slates: v.array(OwnedSlateSchema),
  shared: v.array(v.object({ ...DriveRoomCardSchema.entries, unseen: v.optional(v.literal(true)) })),
  used: v.array(DriveRoomCardSchema),
  starred: v.array(GalleryListingSchema),
});

export type DriveLibrary = v.InferOutput<typeof DriveLibrarySchema>;

export function getDriveLibrary(): Promise<DriveLibrary> {
  return settle(request(DriveLibrarySchema, '/api/shared'));
}

/** Opening Shared sees what is new in it, on every device. */
export function markSharedSeen(): Promise<void> {
  return settle(Effect.asVoid(request(v.unknown(), '/api/shared/seen', { method: 'POST' })));
}

/** Leaves a slate shared with this person, or forgets one they used through its link: off their Drive, and its room. */
export function leaveSlate(input: { workspace: string; slate: string }): Promise<void> {
  return settle(Effect.asVoid(request(v.unknown(), '/api/shared/leave', { method: 'POST', json: input })));
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
