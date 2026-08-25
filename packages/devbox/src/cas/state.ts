import * as v from 'valibot';

import type { StoredValue } from '../storage';

/** Half the SQLite Durable Object per-value ceiling, leaving envelope margin. */
export const OVERLAY_CAS_STATE_MAX_BYTES = 1_000_000;

/** Signature rows are a scan cache, not correctness state. Pending journal
 * entries are authoritative for upper-only ownership. Keeping the newest rows
 * bounds one DO value; an evicted row is compared with that journal before any
 * duplicate entry is emitted. */
export const SIGNATURE_ROWS_MAX = 4_096;

export interface UpperSignature {
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly mode: number;
  readonly mtimeMs: number;
  readonly mtimeNs?: string;
  readonly size: number;
  readonly hash?: string;
  readonly target?: string;
  readonly folded?: boolean;
}

export interface OverlayCasState {
  readonly lastCheckpointAt: number;
  readonly signatures: { readonly [path: string]: UpperSignature };
  readonly lastFailure: { readonly at: number; readonly reason: string } | undefined;
}

export function capSignatures(
  rows: ReadonlyMap<string, UpperSignature>,
): ReadonlyMap<string, UpperSignature> {
  return rows.size <= SIGNATURE_ROWS_MAX
    ? rows
    : new Map([...rows].slice(rows.size - SIGNATURE_ROWS_MAX));
}

export function overlayCasStateBytes(
  signatures: ReadonlyMap<string, UpperSignature>,
): number {
  return new TextEncoder().encode(JSON.stringify({
    lastCheckpointAt: 0,
    signatures: Object.fromEntries(signatures),
  })).byteLength;
}

const UpperSignatureSchema = v.object({
  kind: v.picklist(['file', 'dir', 'symlink']),
  mode: v.number(),
  mtimeMs: v.number(),
  mtimeNs: v.optional(v.string()),
  size: v.number(),
  hash: v.optional(v.pipe(v.string(), v.length(64))),
  target: v.optional(v.string()),
  folded: v.optional(v.boolean()),
});

const OverlayCasStateSchema = v.object({
  lastCheckpointAt: v.number(),
  signatures: v.record(v.string(), UpperSignatureSchema),
  lastFailure: v.optional(v.object({ at: v.number(), reason: v.string() })),
});

export function normalizeOverlayCasState(raw: StoredValue): OverlayCasState | null {
  const parsed = v.safeParse(OverlayCasStateSchema, raw);
  if (!parsed.success) return null;
  const row = parsed.output;
  const signatures: Record<string, UpperSignature> = {};
  for (const [path, signature] of Object.entries(row.signatures)) {
    signatures[path] = {
      kind: signature.kind,
      mode: signature.mode,
      mtimeMs: signature.mtimeMs,
      mtimeNs: signature.mtimeNs,
      size: signature.size,
      hash: signature.hash,
      target: signature.target,
      folded: signature.folded,
    };
  }
  return {
    lastCheckpointAt: row.lastCheckpointAt,
    signatures,
    lastFailure: row.lastFailure,
  };
}
