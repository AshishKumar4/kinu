import * as v from 'valibot';

import type { StoredValue } from '../storage';

/**
 * One scanned upper path, as the container-side scan recorded it.
 *
 * NOT durable Durable Object state. It is the runner's scan cache, kept beside
 * the bytes it describes, and it is what keeps a tick proportional to the
 * CHANGED set: a file whose mode, size, mtime and inode still match is never
 * re-read. The pending journal, never this, is authority for what a path holds.
 *
 * A type alias rather than an interface: the runner serializes these rows, and
 * only an alias carries the implicit index signature that says so.
 */
export type UpperSignature = {
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly hash?: string;
  readonly target?: string;
  readonly device?: string;
  readonly inode?: string;
};

/**
 * Everything the Durable Object keeps for this strategy.
 *
 * Two fields, because two fields are read. `lastCheckpointAt` is what the tick
 * interval gate compares against, and `lastFailure` is how a refusal survives
 * the isolate: a scheduled callback reduces a throw to a console line, so
 * durable state is the only place a repeatedly failing checkpoint stays
 * visible. The signature rows this row used to carry moved into the store with
 * the scan that produces them — the Durable Object never reads them, and a
 * copy nothing reads is a copy that drifts.
 */
export interface OverlayCasState {
  readonly lastCheckpointAt: number;
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined;
}

export const UpperSignatureSchema = v.object({
  kind: v.picklist(['file', 'dir', 'symlink']),
  mode: v.number(),
  mtimeMs: v.number(),
  size: v.number(),
  hash: v.optional(v.pipe(v.string(), v.length(64))),
  target: v.optional(v.string()),
  device: v.optional(v.string()),
  inode: v.optional(v.string()),
});

const OverlayCasStateSchema = v.object({
  lastCheckpointAt: v.number(),
  lastFailure: v.optional(v.object({ at: v.number(), reason: v.string() })),
});

export function normalizeOverlayCasState(raw: StoredValue): OverlayCasState | null {
  const parsed = v.safeParse(OverlayCasStateSchema, raw);
  if (!parsed.success) return null;
  return {
    lastCheckpointAt: parsed.output.lastCheckpointAt,
    lastFailure: parsed.output.lastFailure,
  };
}
