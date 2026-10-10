/** Write attribution happens where a write lands: sibling heads run concurrently over the same files. */

import { Effect, Result } from 'effect';
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

/** One side of a landed mutation: its bytes, nothing there, or why its bytes are unknown. */
type Side = Uint8Array | null | NonNullable<WriteEvent['unread']>;

function unreadable(failure: KinuError, path: string): 'unreadable' {
  diagnostics.failure('vfs.write_side_unread', failure, { path });

  return 'unreadable';
}

/** Read while the callback holds the event, which Nimbus releases once the callback settles; held content reads at once. */
function side(ref: VfsContentRef | null | undefined, path: string): Side | Promise<Side> {
  if (ref === null) return null;

  // Not captured: the backend would not say what stood there.
  if (ref === undefined) return 'unreadable';

  if (ref.type === 'directory') return 'directory';
  const doing = `reading what a write left at ${path}`;

  try {
    const read = ref.read();

    if (read instanceof Uint8Array) return read;

    return settle(Effect.result(attempt({ doing, otherwise: 'io' }, async () => read))).then((settled) => (
      Result.isSuccess(settled) ? settled.success : unreadable(settled.failure, path)));
  } catch (cause) {
    return unreadable(toKinuError({ doing, cause, otherwise: 'io' }), path);
  }
}

const isBytes = (value: Side): value is Uint8Array | null => value === null || value instanceof Uint8Array;

/** `path`'s change as the observer keeps it; a change between a directory and nothing is not a file's. */
function recorded(observer: WriteObserver, path: string, before: Side, after: Side): void {
  if ((before === null || before === 'directory') && (after === null || after === 'directory')) return;
  const baseline = observer.needsBaseline(path);
  let unread: WriteEvent['unread'];

  if (after === 'unreadable') unread = after;
  else if (baseline && !isBytes(before)) unread = before;

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
  // Records keep commit order: Nimbus calls once per commit without waiting for the last call to settle.
  let queue: Promise<void> | null = null;

  return namespace.observeWrites((event: VfsWriteEvent) => {
    if (!mine(event.principal)) return undefined;
    const before = side(event.before, event.path);
    const after = side(event.after, event.path);

    const land = (was: Side, now: Side): void => {
      if (event.oldPath !== undefined) recorded(observer, event.oldPath, now, null);
      recorded(observer, event.path, was, now);
    };

    if (queue === null && !(before instanceof Promise) && !(after instanceof Promise)) {
      land(before, after);

      return undefined;
    }

    const queued: Promise<void> = (queue ?? Promise.resolve()).then(async () => { land(await before, await after); }).then(() => {
      if (queue === queued) queue = null;
    });

    queue = queued;

    return queued;
  }, { wants: (_path, writer) => mine(writer) });
}
