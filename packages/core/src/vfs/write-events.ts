/** Write attribution happens where a write lands: sibling heads run concurrently over the same files. */

import { Effect } from 'effect';
import type { CompositeVFS, Principal } from '@nimbus-sh/core/vfs/composite.js';
import type { VfsContentRef, VfsWriteEvent } from '@nimbus-sh/core/vfs/vfs.js';
import { attempt, diagnostics, settle, toKinuError, type KinuError } from '../obs/index';

export interface WriteEvent {
  readonly path: string;
  /** null when the path did not exist; absent when not asked for or `unread` is set. */
  readonly before?: string | Uint8Array | null;
  /** Why a side's bytes are unknown: a directory stood there, or they could not be read. The change still landed. */
  readonly unread?: 'directory' | 'unreadable';
  readonly after: string | Uint8Array | null;
}

export type TextPayload =
  | { readonly kind: 'absent' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary' };

export function textPayload(value: string | Uint8Array | null | undefined): TextPayload {
  if (value === null || value === undefined) return { kind: 'absent' };

  if (!(value instanceof Uint8Array)) return { kind: 'text', text: value };
  const text = decodedText(value);

  return text === null ? { kind: 'binary' } : { kind: 'text', text };
}

const utf8 = new TextDecoder();

const encoder = new TextEncoder();

/** git's rule: a NUL byte means binary; bytes must also round-trip UTF-8 unchanged. */
function decodedText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const text = utf8.decode(bytes);
  const again = encoder.encode(text);

  if (again.byteLength !== bytes.byteLength) return null;

  for (let i = 0; i < bytes.byteLength; i += 1) if (again[i] !== bytes[i]) return null;

  return text;
}

/** `before` is read only when `needsBaseline` says so, to avoid a second read per write. */
export interface WriteObserver {
  needsBaseline(path: string): boolean;
  record(event: WriteEvent): void;
}

/** One side of a landed mutation: its bytes, nothing there, why its bytes are unknown, or not asked for. */
type Side = Uint8Array | null | NonNullable<WriteEvent['unread']> | 'unasked';

function unreadable(failure: KinuError, path: string): 'unreadable' {
  diagnostics.failure('vfs.write_side_unread', failure, { path });

  return 'unreadable';
}

/**
 * Read while the callback holds the event, which Nimbus releases once it settles. A file's bytes are read only when
 * `asked`: an observer that already holds a path's baseline needs no second copy of it.
 */
function side(ref: VfsContentRef | null | undefined, path: string, asked: boolean): Effect.Effect<Side> {
  if (ref === null) return Effect.succeed(null);

  // Not captured: the backend would not say what stood there.
  if (ref === undefined) return Effect.succeed('unreadable');

  if (ref.type === 'directory') return Effect.succeed('directory');

  if (!asked) return Effect.succeed('unasked');
  const doing = `reading what a write left at ${path}`;

  return Effect.try({ try: () => ref.read(), catch: (cause) => toKinuError({ doing, cause, otherwise: 'io' }) }).pipe(
    Effect.flatMap((read): Effect.Effect<Uint8Array, KinuError> => (read instanceof Uint8Array ? Effect.succeed(read) : attempt({ doing, otherwise: 'io' }, async () => read))),
    Effect.catch((failure) => Effect.sync((): Side => unreadable(failure, path))),
  );
}

const isBytes = (value: Side): value is Uint8Array | null => value === null || value instanceof Uint8Array;

/** `path`'s change as the observer keeps it. A directory made, or kept, is no file's change; one removed is reported. */
function recorded(observer: WriteObserver, path: string, before: Side, after: Side): void {
  if ((before === null || before === 'directory') && after === 'directory') return;

  if (before === null && after === null) return;
  const baseline = observer.needsBaseline(path);
  let unread: WriteEvent['unread'];

  if (after === 'unreadable') unread = after;
  else if (baseline && (before === 'directory' || before === 'unreadable')) unread = before;

  // A directory where the file was is the file gone; a file whose bytes could not be read is still there.
  let now: Uint8Array | null = null;

  if (after === 'unreadable') now = new Uint8Array();
  else if (isBytes(after)) now = after;

  observer.record({ path, ...(baseline && isBytes(before) && { before }), ...(unread !== undefined && { unread }), after: now });
}

/**
 * `observer` hears each mutation a view `mine` names, as Nimbus reports it once landed (`observeWrites`), its content
 * read for those views alone; answers the unsubscribe. A rename is the source's removal and the destination's change.
 */
export function observeNamespace(namespace: CompositeVFS, observer: WriteObserver, mine: (writer: Principal) => boolean = () => true): () => void {
  // Records keep commit order: Nimbus calls once per commit without waiting for the last call to settle, so each event
  // takes its place behind the one before as it arrives, and records once that one has.
  let tail: Promise<void> = Promise.resolve();
  let unsettled = 0;

  return namespace.observeWrites((event: VfsWriteEvent) => {
    if (!mine(event.principal)) return undefined;
    const before = tail;
    // Nothing ahead of it: held content records before the write answers, as the write's own turn.
    const waits = unsettled > 0;
    const turn = Promise.withResolvers<void>();

    tail = turn.promise;
    unsettled += 1;

    return settle(Effect.gen(function* () {
      if (waits) yield* Effect.promise(() => before);

      const asked = observer.needsBaseline(event.path);
      // A side not asked for is not captured, which is not a backend that would not say; a create replaced nothing.
      let replaced: VfsContentRef | null | undefined | 'unasked' = event.before;

      if (event.type === 'create') replaced = null;
      else if (replaced === undefined && !asked) replaced = 'unasked';

      const [was, now] = yield* Effect.all([
        replaced === 'unasked' ? Effect.succeed<Side>('unasked') : side(replaced, event.path, asked), side(event.after, event.path, true),
      ]);

      if (event.oldPath !== undefined) recorded(observer, event.oldPath, now, null);
      recorded(observer, event.path, was, now);
    }).pipe(Effect.ensuring(Effect.sync(() => {
      unsettled -= 1;
      turn.resolve();
    }))));
    // Each side read only for what records it: what a path replaced once, until the observer holds its baseline.
  }, { wants: (path, writer) => (mine(writer) ? { before: observer.needsBaseline(path), after: true } : false) });
}
