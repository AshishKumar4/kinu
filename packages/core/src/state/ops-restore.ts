/**
 * An object's storage restored to a point in time, from its own SQLite history (Cloudflare's point-in-time recovery):
 * the operator's `scripts/restore.ts`, through `/ops/restore`. ARCHITECTURE-DECISIONS W7 records what was measured.
 *
 * - The whole database goes back, SQL and KV, and the alarm with it; every facet of the object goes back too, as its
 *   storage is in the same database. No facet can go back alone: a facet's own `onNextSessionRestoreBookmark` arms a
 *   restore of the whole object at its next start (kinu-probe-pitr, staging 2026-10-23), so only this module may make
 *   the calls (`anti-slop/no-storage-restore-outside-ops`).
 * - The restore takes effect when the object next starts, so it is armed, then the object ended at once: an armed
 *   restore left waiting would land at some later eviction, over whatever was written in between.
 * - The undo bookmark names the moment just before the restore: restoring to it takes the restore back.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { attempt, settle } from '../obs/effect';
import { requireOps, type OpsCaller } from './ops-tables';

/** How far back the history reaches (Cloudflare's documentation, the SQLite storage API's PITR section). */
const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** A moment, as epoch ms, or a bookmark the history gave. */
export const RestoreTargetSchema = v.union([
  v.strictObject({ at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) }),
  v.strictObject({ bookmark: v.pipe(v.string(), v.regex(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/u)) }),
]);

export type RestoreTarget = v.InferOutput<typeof RestoreTargetSchema>;

/** A SQLite Durable Object's history, as `ctx.storage` holds it. */
export interface StorageHistory {
  getCurrentBookmark(): Promise<string>;
  getBookmarkForTime(timestamp: number | Date): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
}

/** A SQLite Durable Object as its restore reaches it: its storage's history, and the end of its activation. */
export interface RestorableState {
  readonly storage: StorageHistory;
  abort(reason?: string): void;
}

/** What a restore armed: the bookmark it goes back to, the one that takes it back, and the one it left. */
export interface ArmedRestore {
  readonly bookmark: string;
  readonly undo: string;
  readonly previous: string;
}

/** Arms `storage`'s restore to `target`, measured against `now`; the object must be ended next for it to land. */
function armRestore(storage: StorageHistory, target: RestoreTarget, now: number): Effect.Effect<ArmedRestore, KinuError> {
  return Effect.gen(function* () {
    if ('at' in target && (target.at > now || target.at < now - RESTORE_WINDOW_MS)) {
      return yield* new KinuError('bad_input', `${new Date(target.at).toISOString()} is not within the last 30 days, the history a restore reaches`);
    }

    const previous = yield* attempt({ doing: 'reading where the history stands', otherwise: 'unavailable' }, () => storage.getCurrentBookmark());

    const bookmark = 'at' in target
      ? yield* attempt({ doing: 'finding the moment in the history', otherwise: 'bad_input' }, () => storage.getBookmarkForTime(target.at))
      : target.bookmark;

    const undo = yield* attempt({ doing: 'arming the restore', otherwise: 'bad_input' }, () => storage.onNextSessionRestoreBookmark(bookmark));

    return { bookmark, undo, previous };
  });
}

/** Whether the object now serves the restore armed with `undo`: a bookmark after the moment just before it. Bookmarks
 *  compare as strings (Cloudflare's documentation). */
export function restoreLanded(current: string, undo: string): boolean {
  return current > undo;
}

// What each restorable class answers `/ops/restore` with: a workspace, an account, its mailbox, its Drive's user object
// and each of its shards. Each call holds the ops capability only `/ops/*` derives.

/** The deployment's root secret, which the ops capability is derived from, as an object's env holds it. */
export interface DeploymentSecret {
  readonly CREDENTIAL_ENCRYPTION_KEY?: string | undefined;
}

/** Arms the object's restore to `target`, to land at its next start. */
export async function restoreArmed(ctx: RestorableState, env: DeploymentSecret, caller: OpsCaller, target: RestoreTarget): Promise<ArmedRestore> {
  await requireOps(env, caller);

  return await settle(armRestore(ctx.storage, target, Date.now()));
}

/** Ends the object's activation, so an armed restore lands; the rejection of the call is its receipt. */
export async function restartedForRestore(ctx: RestorableState, env: DeploymentSecret, caller: OpsCaller): Promise<void> {
  await requireOps(env, caller);
  ctx.abort('ops: restarted for a restore');
}

/** Where the object's history stands now. */
export async function bookmarkNow(ctx: RestorableState, env: DeploymentSecret, caller: OpsCaller): Promise<string> {
  await requireOps(env, caller);

  return await ctx.storage.getCurrentBookmark();
}

/** What a restored object's rows name that R2 no longer holds: a deletion made at once, a workspace's teardown or an
 *  account's, is not undone by a restore (ARCHITECTURE-DECISIONS W7). */
export interface MissingBytes {
  readonly named: number;
  readonly missing: number;
  /** The first {@link MISSING_SHOWN} of them. */
  readonly keys: readonly string[];
}

const MISSING_SHOWN = 50;

/** A bucket as far as a listing reads it. */
interface ListedBucket {
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** Which of `named`, all under `prefix`, `bucket` does not hold. */
export async function missingBytes(bucket: ListedBucket | null | undefined, prefix: string, named: readonly string[]): Promise<MissingBytes> {
  const wanted = new Set(named);
  const held = new Set<string>();

  for (let cursor: string | undefined, more = bucket !== null && bucket !== undefined && wanted.size > 0; more;) {
    const listed = await bucket?.list(cursor === undefined ? { prefix } : { prefix, cursor });

    for (const object of listed?.objects ?? []) held.add(object.key);
    more = listed?.truncated ?? false;
    cursor = listed?.cursor;
  }

  const gone = [...wanted].filter((key) => !held.has(key));

  return { named: wanted.size, missing: gone.length, keys: gone.slice(0, MISSING_SHOWN) };
}
