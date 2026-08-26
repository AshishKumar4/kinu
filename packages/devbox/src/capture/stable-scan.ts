/**
 * Mechanism one: scan the tree and try to prove it held still.
 *
 * The protocol is tar-shaped: per file, stat — read — stat again, retrying
 * while the metadata moves; then a full second stat pass over every captured
 * path plus a directory-listing recheck. When that proof succeeds on a quiet
 * tree, the capture equals exactly one prefix and can even name it post-hoc,
 * because the audit finds a unique anchoring cut.
 *
 * What the protocol can NEVER do is see three mutation classes:
 *
 *   an in-place rewrite with equal size and restored mtime — every stat agrees
 *     while the bytes differ;
 *   mmap stores — no metadata changes at all;
 *   anything landing between the last read of pass one and the second stat
 *     pass on paths whose own stats were untouched by it.
 *
 * So the mechanism has two honest outputs: a capture it CANNOT name a cut for
 * (cut -1), publishable only if the audit later finds a unique anchoring cut;
 * or a refusal when its instability checks fire. It is never sound BY
 * CONSTRUCTION, which is why it is at most an optimization inside a frozen
 * window and never the answer to CaptureSound on its own. `naiveLiveScan` is
 * kept beside it deliberately: the tests use it to show the bare recursive
 * scan failing the audit, so "a live scan alone must fail" is demonstrated,
 * not asserted.
 */

import type { CaptureView } from './view';
import { tick, type Capture, type NodeEntry, type StatSnapshot, type UpperPath } from './model';

export interface StableScanOptions {
  /** Retries per file while its stats move under it. */
  readonly maxFileRetries?: number;
}

export type StableScanResult =
  | { readonly verdict: 'captured'; readonly capture: Capture }
  | { readonly verdict: 'refused'; readonly reason: 'unstable-window'; readonly detail: string };

const DEFAULT_FILE_RETRIES = 3;

function sameStat(a: StatSnapshot | null, b: StatSnapshot | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One stabilized read outcome: the entry plus the stat it was proven against. */
interface Stabilized {
  readonly entry: NodeEntry;
  readonly statAfterRead: StatSnapshot;
}

/**
 * Stat — read — stat, retrying while metadata moves. Null when the path was
 * gone before either stat; 'unstable' when it kept moving past the budget.
 */
async function stabilizedRead(
  view: CaptureView,
  path: UpperPath,
  maxRetries: number,
): Promise<Stabilized | null | 'unstable'> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const before = view.stat(path);
    const entry = await view.readEntry(path);
    const after = view.stat(path);
    if (!before && !after) return null; // gone before we touched it
    if (entry && before && after && sameStat(before, after)) return { entry, statAfterRead: after };
    await tick();
  }
  return 'unstable';
}

/**
 * The bare recursive scan: list once, read once, ship whatever came back. No
 * stability protocol, no cut, no proof — the shape that must fail CaptureSound.
 */
export async function naiveLiveScan(view: CaptureView): Promise<Capture> {
  const entries: NodeEntry[] = [];
  for (const path of view.paths()) {
    const entry = await view.readEntry(path);
    if (entry) entries.push(entry);
  }
  return { mechanism: 'stable-scan', cut: -1, generation: -1, entries };
}

/** Scan with the stability proof. See the module comment for what it cannot see. */
export async function stableScan(
  view: CaptureView,
  options: StableScanOptions = {},
): Promise<StableScanResult> {
  const maxRetries = options.maxFileRetries ?? DEFAULT_FILE_RETRIES;
  const firstListing = [...view.paths()];

  // Pass one: stabilized reads, recording the stat each read was proven against.
  const captured: Stabilized[] = [];
  for (const path of firstListing) {
    const outcome = await stabilizedRead(view, path, maxRetries);
    if (outcome === 'unstable') {
      return {
        verdict: 'refused',
        reason: 'unstable-window',
        detail: `${path} kept changing across ${maxRetries + 1} attempts`,
      };
    }
    if (outcome) captured.push(outcome);
  }

  // Pass two: every recorded stat must still agree, and the path set must not
  // have gained or lost anything.
  const secondListing = view.paths();
  if (secondListing.length !== firstListing.length ||
      secondListing.some((path, i) => path !== firstListing[i])) {
    return {
      verdict: 'refused',
      reason: 'unstable-window',
      detail: 'the path set changed during the scan',
    };
  }
  for (const record of captured) {
    const now = view.stat(record.entry.path);
    if (!now || !sameStat(now, record.statAfterRead)) {
      return {
        verdict: 'refused',
        reason: 'unstable-window',
        detail: `${record.entry.path} changed between passes`,
      };
    }
  }

  return {
    verdict: 'captured',
    capture: {
      mechanism: 'stable-scan',
      cut: -1, // the scan cannot name its cut; only the audit may anchor it
      generation: -1, // not observable through an ordinary walk either
      entries: captured.map((record) => record.entry),
    },
  };
}
