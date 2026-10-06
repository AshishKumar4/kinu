/** Write attribution happens where a write lands: sibling heads run concurrently over the same files. */

import type { CompositeVFS, Principal } from '@nimbus-sh/core/vfs/composite.js';

export interface WriteEvent {
  readonly path: string;
  /** null when the path did not exist; absent when not asked for or `unread` is set. */
  readonly before?: string | Uint8Array | null;
  /** Why an asked-for `before` is unknown. The change still landed. */
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

/** `observer` hears each write of a view `mine` names; answers the unsubscribe. */
export function observeNamespace(namespace: CompositeVFS, observer: WriteObserver, mine: (writer: Principal) => boolean = () => true): () => void {
  return namespace.observeWrites({
    needsBaseline: (path, writer) => mine(writer) && observer.needsBaseline(path),
    record: ({ principal: writer, ...event }) => { if (mine(writer)) observer.record(event); },
  });
}
