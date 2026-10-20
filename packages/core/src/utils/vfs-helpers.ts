import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
import { Effect } from 'effect';
import { settle, tolerated } from '../obs/effect';
import { KinuError, toKinuError } from '../obs/error';


/** POSIX dirname: '' for a bare name, '/' for a top-level one (a naive `lastIndexOf` slice gets both wrong). */
export function vfsDirname(path: string): string {
  const i = path.lastIndexOf('/');

  if (i < 0) return '';

  return i === 0 ? '/' : path.slice(0, i);
}

export function vfsBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Idempotent mkdir: an "already exists" failure is tolerated; any other fails with its cause. Classified, not read
 *  from the message: "parent directory does not exist" names `exist` too. */
export async function ensureDir(vfs: Pick<VFS, 'mkdir'>, dir: string): Promise<void> {
  // A remote environment may surface EEXIST even with `recursive: true`.
  return settle(tolerated(Effect.tryPromise({ try: async () => { await vfs.mkdir(dir, { recursive: true }); }, catch: (cause) => cause }), 'eexist').pipe(
    Effect.mapError((cause) => toKinuError({ doing: `creating ${dir}`, cause, otherwise: 'io' })),
    Effect.asVoid,
  ));
}

/** Whether `path` holds exactly `bytes`; absent holds nothing. */
export async function fileHolds(vfs: Pick<VFS, 'stat' | 'readFile'>, path: string, bytes: Uint8Array): Promise<boolean> {
  if (!(await exists(vfs, path))) return false;
  const stored = await vfs.readFile(path);
  // Narrowed by class, as prompting/agents-md.ts does for the same VFS return.
  const existing = stored instanceof Uint8Array ? stored : new TextEncoder().encode(stored);

  if (existing.length !== bytes.length) return false;

  for (let i = 0; i < bytes.length; i++) {
    if (existing[i] !== bytes[i]) return false;
  }

  return true;
}

/** What a content-addressed path holding other bytes is to its owner: rewritten with its content, or a fault. */
export type OtherBytes = 'rewrite' | 'refuse';

/**
 * `bytes` at the content-addressed `path` under `directory`, durable once this returns: the one publication of a file
 * named by its content. A path is no proof of content (an interrupted write, an agent's edit): a file already holding
 * `bytes` is kept, and one holding anything else is rewritten or refused, as its owner says.
 */
export function publishContent(
  vfs: Pick<VFS, 'stat' | 'readFile' | 'writeFile' | 'mkdir'>,
  { directory, path, bytes, otherBytes }: { readonly directory: string; readonly path: string; readonly bytes: Uint8Array; readonly otherBytes: OtherBytes },
): Promise<void> {
  return settle(Effect.gen(function* () {
    if (yield* Effect.promise(() => fileHolds(vfs, path, bytes))) return;

    // Absent is the ordinary first publication; present, it holds other bytes.
    if (otherBytes === 'refuse' && (yield* Effect.promise(() => exists(vfs, path)))) {
      return yield* new KinuError('io', `${path} holds other bytes than the content it is named for.`);
    }

    yield* Effect.promise(() => ensureDir(vfs, directory));
    yield* Effect.tryPromise({ try: async () => { await vfs.writeFile(path, bytes); }, catch: (cause) => toKinuError({ doing: `writing ${path}`, cause, otherwise: 'io' }) });
  }));
}

