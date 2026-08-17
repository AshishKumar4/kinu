/**
 * Shared ratchet for the two inventory gates (dead exports, AST duplication).
 *
 * Both gates find real violations on today's tree that cannot be fixed by the
 * gate's own commit, and both would be useless as warnings — a warning nobody
 * has to clear is how 10+ "correct, wired, dead" symbols accumulated in the
 * first place. So each gate records what exists in a machine-written lock and
 * fails on anything NEW. That is the instrument `KNOWN_TWINS` already proved
 * here: an enumerated list whose only legal direction is smaller, which took
 * cross-backend twins from 54 to 9.
 *
 * Two properties make the lock a ledger rather than an ignore list:
 *   - it is written only by `--lock`, never edited by hand, so it cannot drift
 *     from what the analysis actually finds;
 *   - a lock entry that no longer reproduces is a FAILURE, not a pass. Fixing a
 *     violation therefore forces a re-lock, and the list can never quietly
 *     retain something that has already been cleaned up.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';

export interface Ratchet {
  /** Violations present in the tree and absent from the lock — new debt. */
  readonly added: readonly string[];
  /** Lock entries that no longer reproduce — the lock needs rewriting. */
  readonly stale: readonly string[];
}

const LockSchema = v.array(v.string());

export function reconcile(keys: readonly string[], lockPath: string): Ratchet {
  const locked = new Set(v.parse(LockSchema, JSON.parse(readFileSync(lockPath, 'utf8'))));
  const found = new Set(keys);
  return {
    added: [...found].filter((k) => !locked.has(k)).sort(),
    stale: [...locked].filter((k) => !found.has(k)).sort(),
  };
}

export function writeLock(keys: readonly string[], lockPath: string): number {
  const sorted = [...new Set(keys)].sort();
  writeFileSync(lockPath, `${JSON.stringify(sorted, null, 2)}\n`);
  return sorted.length;
}


/** A gate that scanned nothing reports a clean tree, which is the shape of
 *  `assertEventSequence` — a check that could never fail. The ratchet hides it
 *  particularly well: with a non-empty lock a broken scan shows up as every
 *  entry going stale, but drive the debt to zero and that signal disappears with
 *  it. So every gate states what it measured and dies if any of it is zero. */
export function assertMeasured(
  gate: string,
  counts: readonly (readonly [string, number])[],
): string {
  const empty = counts.filter(([, n]) => n <= 0).map(([label]) => label);
  if (empty.length > 0) {
    throw new Error(
      `${gate}: measured nothing (${empty.join(', ')} is zero) — a gate that scans nothing cannot fail`,
    );
  }
  return counts.map(([label, n]) => `${String(n)} ${label}`).join(', ');
}

/** Every gate failure names the same five things, because a message that only
 *  says a check failed sends the reader to the wrong file. `silently` is the
 *  field that makes it worth reading: what the violation produces while the
 *  suite stays green. All five are required — a gate that cannot state what its
 *  violation silently produces has not understood its own defect class. */
export interface Finding {
  readonly invariant: string;
  readonly at: string;
  readonly found: string;
  readonly silently: string;
  readonly fix: string;
}

export function finding(f: Finding): string {
  return [
    `  ${f.at}`,
    `    must:      ${f.invariant}`,
    `    found:     ${f.found}`,
    `    silently:  ${f.silently}`,
    `    fix:       ${f.fix}`,
  ].join('\n');
}

/** Prints the verdict and returns the process exit code. `detail` supplies the
 *  human-readable body for a key; a stale key has no detail by definition. */
export function report(
  gate: string,
  ratchet: Ratchet,
  detail: ReadonlyMap<string, string>,
  lockCommand: string,
  measured: string,
): number {
  if (ratchet.added.length === 0 && ratchet.stale.length === 0) {
    console.log(`${gate}: ok — ${measured}`);
    return 0;
  }
  if (ratchet.added.length > 0) {
    console.error(`${gate}: ${ratchet.added.length} new violation(s)\n`);
    for (const key of ratchet.added) console.error(detail.get(key) ?? key);
  }
  if (ratchet.stale.length > 0) {
    console.error(
      `\n${gate}: ${ratchet.stale.length} recorded violation(s) no longer reproduce.`,
    );
    for (const key of ratchet.stale) console.error(`  ${key}`);
    console.error(`Run \`${lockCommand}\` to record the cleanup.`);
  }
  return 1;
}
