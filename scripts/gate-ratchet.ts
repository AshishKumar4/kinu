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
 * Three properties make the lock a ledger rather than an ignore list:
 *   - it is written only by `--lock`, never edited by hand, so it cannot drift
 *     from what the analysis actually finds;
 *   - a lock entry that no longer reproduces is a FAILURE, not a pass. Fixing a
 *     violation therefore forces a re-lock, and the list can never quietly
 *     retain something that has already been cleaned up;
 *   - `--lock` may only SHRINK or RE-KEY what is already there (`shrinkOnly`
 *     below). A lock a red run can re-record upward is an ignore list with an
 *     extra step: it clears today's finding, reads as a routine chore in the
 *     diff, and the only evidence that the envelope moved is a number nobody
 *     compares. Measured over the 57 revisions of
 *     `scripts/complexity.lock.json`: 18 entries were re-recorded HIGHER across
 *     14 functions between 2026-09-01 and 2026-09-14, `WorkspacePage` 64 to 72
 *     in one commit (fb62d4c3b) and `measureArm` 92 to 100 over two.
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

export function readLock(lockPath: string): string[] {
  return v.parse(LockSchema, JSON.parse(readFileSync(lockPath, 'utf8')));
}

export function reconcile(keys: readonly string[], lockPath: string): Ratchet {
  const locked = new Set(readLock(lockPath));
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

/* ── The shrink-only merge ────────────────────────────────────────────── */

/** One number a lock holds, under the key the lock records it by: a function's
 *  complexity, a duplicate group's copy count. */
export interface LockedNumber {
  readonly key: string;
  readonly value: number;
}

/** A key `--lock` will not record. `was` is the number the lock holds for that
 *  key, or for the vanished key this one replaces; absent when nothing in the
 *  lock can stand for it. */
export interface LockRefusal {
  readonly key: string;
  readonly was: number | undefined;
  readonly now: number;
}

export interface ShrinkVerdict {
  /** The lock to write: every accepted key at the lower of the two numbers.
   *  Read only when `refusals` is empty — a refused `--lock` writes nothing. */
  readonly merged: readonly LockedNumber[];
  readonly refusals: readonly LockRefusal[];
}

/** Worst first, and by key on a tie so an equal pair matches the same way on
 *  every run. */
const worstFirst = (a: LockedNumber, b: LockedNumber): number =>
  b.value - a.value || a.key.localeCompare(b.key);

/**
 * The only merge `--lock` may perform: every number falls to `min(old, new)`, a
 * key the lock already holds may keep or lower it, and a key the lock has never
 * seen is refused unless a vanished key pays for it.
 *
 * The exception exists because a rename or a file move changes the key of a
 * violation nobody made worse, and a lock that cannot be re-keyed is a lock
 * people route around. Pairing worst with worst, one departure per arrival, is
 * what keeps that exception from carrying growth: an arrival is admitted only at
 * or below the number of the departure paying for it, so two keys leaving at 50
 * and 40 cannot cover two arriving at 45 — the second one lands above the 40 it
 * would have to be paid for by.
 */
export function shrinkOnly(
  previous: readonly LockedNumber[],
  candidate: readonly LockedNumber[],
): ShrinkVerdict {
  const held = new Map(previous.map(({ key, value }) => [key, value]));
  const present = new Set(candidate.map(({ key }) => key));
  const refusals: LockRefusal[] = [];
  const entrants: LockedNumber[] = [];

  for (const entry of candidate) {
    const was = held.get(entry.key);

    if (was === undefined) entrants.push(entry);
    else if (entry.value > was) refusals.push({ key: entry.key, was, now: entry.value });
  }

  const vanished = previous.filter(({ key }) => !present.has(key)).sort(worstFirst);

  for (const [index, entrant] of [...entrants].sort(worstFirst).entries()) {
    const paidFor = vanished[index];

    if (paidFor === undefined || entrant.value > paidFor.value) {
      refusals.push({ key: entrant.key, was: paidFor?.value, now: entrant.value });
    }
  }

  const refused = new Set(refusals.map(({ key }) => key));

  return {
    merged: candidate
      .filter(({ key }) => !refused.has(key))
      .map(({ key, value }) => ({ key, value: Math.min(held.get(key) ?? value, value) })),
    refusals,
  };
}

/** Prints why `--lock` wrote nothing and returns the process exit code. Each
 *  line carries both numbers, because the reader's next question after "refused"
 *  is how far over the entry is. */
export function refuseLock(
  gate: string,
  refusals: readonly LockRefusal[],
  remedy: string,
): number {
  console.error(`${gate}: --lock refused ${String(refusals.length)} entr(ies) and wrote nothing\n`);

  for (const { key, was, now } of refusals) {
    console.error(`  ${key}\n    ${was === undefined ? 'absent from the lock' : `locked at ${String(was)}`}`
      + `, measured ${String(now)} — the lock only shrinks; ${remedy}`);
  }

  return 1;
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

/** One gate's verdict: what it is called, what its ratchet reconciled, the body
 *  for each key, the command that records a cleanup, and what it measured. */
export interface GateVerdict {
  readonly gate: string;
  readonly ratchet: Ratchet;
  readonly detail: ReadonlyMap<string, string>;
  readonly lockCommand: string;
  readonly measured: string;
}

/** Prints the verdict and returns the process exit code. `detail` supplies the
 *  human-readable body for a key; a stale key has no detail by definition. */
export function report(verdict: GateVerdict): number {
  const { gate, ratchet, detail, lockCommand, measured } = verdict;

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

/**
 * The THIRD verdict, for a gate whose evidence is unreachable — a deployed
 * assertion needing a credential nobody has yet, a browser that is not
 * installed. It exists because the alternative is worse than useless: a gate
 * that prints "skipped" and exits 0 is indistinguishable from a gate that
 * passed, and it WILL be read as a pass. That is not a hypothetical. Measured
 * 2026-08-17 on a deployed Cloudflare worker: a `tailStream`-only trace
 * consumer threw `Handler does not export a tail() function.` five times, once
 * per traced invocation, while the observed worker returned HTTP 200 with
 * `isTraced` true throughout and every trace event was dropped — the exception
 * landing in a DIFFERENT worker's log stream. Every signal available to the
 * person who would look was green. A GREEN SIGNAL FROM THE OBSERVED SYSTEM SAYS
 * NOTHING ABOUT WHETHER THE OBSERVER RECEIVED ANYTHING.
 *
 * So: NON-ZERO BY DEFAULT. A blocked gate fails the build until someone states,
 * in the invocation, that they know it is blocked and why — which puts the
 * acknowledgement in the command that ran rather than in a comment nobody
 * reads. `acknowledgedBy` is the environment variable that carries it; naming
 * the variable in the failure output is the whole affordance. The CALLER reads
 * the variable and passes its value: a read by computed key here would put
 * this module's every importer beyond what the ladder's closure walker can
 * bound, and every corpus gate imports this module.
 */
export function blocked(
  gate: string,
  reason: string,
  acknowledgedBy: string,
  acknowledged: string | undefined,
): number {
  const acknowledgement = (acknowledged ?? '').trim();

  if (acknowledgement.length > 0) {
    console.log(`${gate}: BLOCKED and acknowledged — ${reason} (${acknowledgedBy}=${acknowledgement})`);

    return 0;
  }

  console.error(
    `${gate}: BLOCKED — ${reason}\n`
    + '  This is NOT a pass. The gate could not observe the thing it asserts, so it\n'
    + '  reports non-zero: a skip that exits 0 is read as a pass by every human and\n'
    + '  every CI badge that sees it.\n'
    + `  fix:       remove the blocker.\n`
    + `  or:        acknowledge it for this run with ${acknowledgedBy}=<who/why>, which\n`
    + '             records the acknowledgement in the invocation instead of in a comment.',
  );

  return 1;
}
