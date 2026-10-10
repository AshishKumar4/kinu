/**
 * The one way an agent or the owner replaces or creates a file: conditioned on what was read, on the plane's own side.
 * A plane that versions its files (the workspace's SQLite store, the context tree) checks the revision read; every other
 * plane (the CLI's folder, a machine under /pc, the sandbox) compares the bytes' sha256 and replaces through a temp file
 * and a rename in its own process. Either way the check and the write are one call, so nothing written between a read
 * and the write is lost: it is refused, naming what is there now.
 */
import type { Awaitable, VFS, VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import { sha256Hex } from '../safety/argument-digest';
import { VfsRevisionSchema, type CheckpointFiles, type VfsWriteReport } from '../types/primitives';
import { FileRefusalError } from '../types/file-edits';

/**
 * What the write is conditioned on: that no file was there; the file as it was read (its bytes, and its revision where
 * the plane versions files); or, from an editor that holds only a token, the revision or digest it was shown.
 */
export type ObservedFile =
  | { readonly kind: 'absent' }
  | { readonly kind: 'read'; readonly bytes: Uint8Array; readonly revision?: VfsRevision }
  | { readonly kind: 'revision'; readonly revision: VfsRevision }
  | { readonly kind: 'digest'; readonly sha256: string };

/** Which guarantee held: the plane's revision, or the read bytes' digest. */
export type WriteGuarantee = 'revision' | 'digest';

/** What the file holds now, in the plane's own terms: its revision, or its bytes' digest (null: no file). */
export type FileNow = { readonly revision: VfsRevision } | { readonly sha256: string | null };

export interface ConditionalWrite {
  readonly guarantee: WriteGuarantee;
  readonly now: FileNow;
  readonly report: VfsWriteReport | null;
}

/** Revision 0 is Nimbus's absent file. */
const ABSENT_REVISION = 0;

/** A `stale` refusal's cause: what the file holds now. */
export const FileChangedSchema = v.object({
  kind: v.literal('file.changed'),
  now: v.union([v.object({ revision: VfsRevisionSchema }), v.object({ sha256: v.nullable(v.string()) })]),
});

/** It changed since it was read: refused, naming what it holds now, and nothing on the plane moved. */
function changed(path: string, now: FileNow): FileRefusalError {
  let what = `revision ${String('revision' in now ? now.revision : '')}`;

  if (!('revision' in now)) what = now.sha256 === null ? 'no file' : `content with sha256 ${now.sha256.slice(0, 12)}…`;

  return new FileRefusalError('stale', `${path} changed since it was read: it now holds ${what}. Read it again before you replace it.`, {
    cause: { kind: 'file.changed', now },
  });
}

const UNSUPPORTED = (path: string) => new KinuError('unsupported', `${path}: this file plane can check neither a revision nor a digest, so a write there could lose a newer one`);

/** A plane's own refusal of a check it does not make (ENOTSUP): the other check may still be its. Null for that. */
function made<A>(attempt: () => Awaitable<A>): Effect.Effect<A | null> {
  return Effect.tryPromise({ try: async () => attempt(), catch: (cause) => ({ cause }) }).pipe(
    Effect.catchIf(({ cause }) => isVfsError(cause) && cause.code === 'ENOTSUP', () => Effect.succeed(null)),
    // Any other failure is the plane's own, carried as it threw it.
    Effect.catch((failed) => Effect.die(failed.cause)),
  );
}

function byRevision(vfs: VFS & CheckpointFiles, path: string, data: Uint8Array, expected: VfsRevision): Effect.Effect<ConditionalWrite | null, KinuError> {
  const check = vfs.writeFileIfRevision?.bind(vfs);

  if (check === undefined) return Effect.succeed(null);

  return Effect.flatMap(made(() => check(path, data, expected)), (result) => {
    if (result === null) return Effect.succeed(null);

    return result.ok
      ? Effect.succeed({ guarantee: 'revision' as const, now: { revision: result.revision }, report: null })
      : Effect.fail(changed(path, { revision: result.revision }));
  });
}

function byDigest(vfs: VFS & CheckpointFiles, path: string, data: Uint8Array, expected: string | null): Effect.Effect<ConditionalWrite | null, KinuError> {
  const check = vfs.writeFileIfDigest?.bind(vfs);

  if (check === undefined) return Effect.succeed(null);

  return Effect.flatMap(made(() => check(path, data, expected)), (result) => {
    if (result === null) return Effect.succeed(null);

    return result.ok
      ? Effect.succeed({ guarantee: 'digest' as const, now: { sha256: result.sha256 }, report: result.report ?? null })
      : Effect.fail(changed(path, { sha256: result.sha256 }));
  });
}

/**
 * `data` at `path`, only over what `observed` says was there: by the revision read where the plane checks one, else by
 * the read bytes' digest. A plane that makes neither check refuses; nothing ever writes unconditionally.
 */
export function writeConditionally(
  vfs: VFS & CheckpointFiles, path: string, data: Uint8Array, observed: ObservedFile,
): Promise<ConditionalWrite> {
  return settle(Effect.gen(function* () {
    let revision: VfsRevision | undefined = ABSENT_REVISION;
    let digest: string | null = null;

    if (observed.kind === 'read') [revision, digest] = [observed.revision, sha256Hex(observed.bytes)];
    else if (observed.kind === 'revision') revision = observed.revision;
    else if (observed.kind === 'digest') [revision, digest] = [undefined, observed.sha256];

    // A file read with its revision is checked by it; a file read without one, or none at all, by its bytes first,
    // which every plane but the versioned store checks, and an absence by revision 0 where only that store does.
    if (revision !== undefined && observed.kind !== 'absent') {
      const byRevisionRead = yield* byRevision(vfs, path, data, revision);

      if (byRevisionRead !== null) return byRevisionRead;

      // A revision alone names no bytes to compare.
      if (observed.kind === 'revision') return yield* Effect.fail(UNSUPPORTED(path));
    }

    const byDigestRead = yield* byDigest(vfs, path, data, digest);

    if (byDigestRead !== null) return byDigestRead;

    const absentByRevision = observed.kind === 'absent' ? yield* byRevision(vfs, path, data, ABSENT_REVISION) : null;

    return absentByRevision ?? (yield* Effect.fail(UNSUPPORTED(path)));
  }));
}
