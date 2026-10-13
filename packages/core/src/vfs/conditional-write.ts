/**
 * The one way an agent or the owner replaces or creates a file: conditioned on what was read, on the plane's own side.
 * A plane that versions its files (the workspace's SQLite store, a session's files through the SDK, the context tree)
 * checks the revision read; every other plane (the CLI's folder, a machine under /pc, the sandbox) compares the bytes'
 * sha256 and writes in its own process. Either way the check and the write are one call, so nothing written between a
 * read and the write is lost: it is refused, naming what is there now. A plane that checks neither is refused.
 */
import type { Awaitable, VFS, VfsCasResult, VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import { sha256Hex } from '../safety/argument-digest';
import { VfsRevisionSchema, type CheckpointFiles, type VfsWriteReport } from '../types/primitives';
import { FileRefusalError } from '../types/file-edits';
import { ensureDir, vfsDirname } from '../utils/vfs-helpers';

/**
 * What the write is conditioned on: that no file was there; the file as it was read (its bytes, and its revision where
 * the plane versions files); or, from an editor that holds only a token, the revision or digest it was shown.
 */
export type ObservedFile =
  | { readonly kind: 'absent' }
  | { readonly kind: 'read'; readonly bytes: Uint8Array; readonly revision?: VfsRevision }
  | { readonly kind: 'revision'; readonly revision: VfsRevision }
  | { readonly kind: 'digest'; readonly sha256: string };

/**
 * Which check held: the plane's revision (revision 0 for a create), the read bytes' digest compared by the plane, or the
 * same compared across the wire where the plane cannot (`/shared`).
 */
export type WriteGuarantee = 'revision' | 'digest' | 'digest-remote';

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

  if (!('revision' in now)) what = now.sha256 === null ? 'no file' : `content with sha256 ${now.sha256.slice(0, 12)}...`;

  return new FileRefusalError('stale', `${path} changed since it was read: it now holds ${what}. Read it again before you replace it.`, {
    cause: { kind: 'file.changed', now },
  });
}

const UNSUPPORTED = (path: string) => new KinuError('unsupported', `${path}: this file plane keeps no revisions, so a save over the one you opened cannot be checked`);

const UNCHECKED = (path: string) => new KinuError('unsupported', `${path}: this file plane checks neither a revision nor the bytes, so a write over what was read cannot be checked`);

/** A plane's own refusal of a check it does not make (ENOTSUP): the other check may still be its. Null for that. */
function made<A>(attempt: () => Awaitable<A>): Effect.Effect<A | null> {
  return Effect.tryPromise({ try: async () => attempt(), catch: (cause) => ({ cause }) }).pipe(
    Effect.catchIf(({ cause }) => isVfsError(cause) && cause.code === 'ENOTSUP', () => Effect.succeed(null)),
    // Any other failure is the plane's own, carried as it threw it.
    Effect.catch((failed) => Effect.die(failed.cause)),
  );
}

/** A revision-checked write's answer: landed, at its new revision, or refused, naming the one there now. */
function revisionChecked(path: string, result: VfsCasResult | null): Effect.Effect<ConditionalWrite | null, KinuError> {
  if (result === null) return Effect.succeed(null);

  return result.ok
    ? Effect.succeed({ guarantee: 'revision' as const, now: { revision: result.revision }, report: null })
    : Effect.fail(changed(path, { revision: result.revision }));
}

function byRevision(vfs: VFS & CheckpointFiles, path: string, data: Uint8Array, expected: VfsRevision): Effect.Effect<ConditionalWrite | null, KinuError> {
  const check = vfs.writeFileIfRevision?.bind(vfs);

  if (check === undefined) return Effect.succeed(null);

  return Effect.flatMap(made(() => check(path, data, expected)), (result) => revisionChecked(path, result));
}

function byDigest(vfs: VFS & CheckpointFiles, path: string, data: Uint8Array, expected: string | null): Effect.Effect<ConditionalWrite | null, KinuError> {
  const check = vfs.writeFileIfDigest?.bind(vfs);

  if (check === undefined) return Effect.succeed(null);

  return Effect.flatMap(made(() => check(path, data, expected)), (result) => {
    if (result === null) return Effect.succeed(null);

    return result.ok
      ? Effect.succeed({ guarantee: result.remote === true ? 'digest-remote' as const : 'digest' as const, now: { sha256: result.sha256 }, report: result.report ?? null })
      : Effect.fail(changed(path, { sha256: result.sha256 }));
  });
}

/**
 * A create where nothing was read: revision 0, the versioned store's own "no file", made only where none is, so of two
 * creates one lands and the other is refused, naming it. A directory above it that is not there yet (ENOENT) is made
 * first, on this plane as its principal, and the create asked again.
 */
function byAbsence(vfs: VFS & CheckpointFiles, path: string, data: Uint8Array): Effect.Effect<ConditionalWrite | null, KinuError> {
  const check = vfs.writeFileIfRevision?.bind(vfs);

  if (check === undefined) return Effect.succeed(null);
  const parent = vfsDirname(path);
  const create = Effect.tryPromise({ try: async () => check(path, data, ABSENT_REVISION), catch: (cause) => ({ cause }) });

  const created = create.pipe(
    Effect.catchIf(({ cause }) => parent !== '' && isVfsError(cause, 'ENOENT'), () => Effect.andThen(Effect.promise(async () => ensureDir(vfs, parent)), create)),
    Effect.catchIf(({ cause }) => isVfsError(cause, 'ENOTSUP'), () => Effect.succeed(null)),
    Effect.catch((failed) => Effect.die(failed.cause)),
  );

  return Effect.flatMap(created, (result) => revisionChecked(path, result));
}

/**
 * `data` at `path`, only over what `observed` says was there: by the revision read where the plane checks one, else by
 * the read bytes' digest. A plane that makes neither is refused, and so is an editor's revision on a plane with no
 * revision check, as the file manager always refused it.
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

    const absentByRevision = observed.kind === 'absent' ? yield* byAbsence(vfs, path, data) : null;

    return absentByRevision ?? (yield* Effect.fail(UNCHECKED(path)));
  }));
}
