/**
 * Comment budget: the comment characters each package may hold, a number that
 * only goes down.
 *
 * Owner decision, 2026-09-22, after `scripts/bloat-census.ts` measured comments
 * at 41% of the non-whitespace characters in product source at 1dd25b3ad. The
 * unit is `commentCharacters`: non-whitespace characters inside oxc's comment
 * spans, delimiters included, so reflowing a comment does not move the number.
 *
 * `scripts/bloat-budget.lock.json` holds one number per package. A package over
 * its number is red; a package the lock never held has a budget of zero. A
 * package under its number is green and printed as a stale row, so cutting a
 * comment never fails a commit, and `--lock` then writes the lower number.
 * `--lock` never raises a number: it merges through `shrinkOnly`, which admits a
 * package the lock has not held only when a vanished one pays for it (a rename).
 * With no lock on disk, `--lock` records the first budget.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';
import * as v from 'valibot';

import { commentCharacters } from './comment-only';
import { assertMeasured, finding, type LockedNumber, type LockRefusal, refuseLock, shrinkOnly } from './gate-ratchet';
import { readSources } from './sources';

const root = new URL('..', import.meta.url).pathname;

const LOCK = `${root}scripts/bloat-budget.lock.json`;

/** The package a product file belongs to: `packages/<name>/src/…`. */
export const packageOf = (file: string): string => file.split('/')[1] ?? file;

/** Comment characters per package, by package name. */
export function measureComments(sources: ReadonlyMap<string, string>): LockedNumber[] {
  const totals = new Map<string, number>();

  for (const [file, text] of sources) {
    const name = packageOf(file);
    totals.set(name, (totals.get(name) ?? 0) + commentCharacters(text, parseSync(file, text).comments));
  }

  return [...totals].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key));
}

const BudgetSchema = v.object({
  measuredAt: v.pipe(v.string(), v.minLength(1)),
  packages: v.record(v.string(), v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export type CommentBudget = v.InferOutput<typeof BudgetSchema>;

export interface Excess {
  readonly key: string;
  /** Absent when the lock never held the package. */
  readonly was: number | undefined;
  readonly now: number;
}

export interface Slack {
  readonly key: string;
  readonly was: number;
  /** Absent when the package is gone. */
  readonly now: number | undefined;
}

export interface BudgetVerdict {
  readonly over: readonly Excess[];
  readonly stale: readonly Slack[];
}

export function judgeComments(measured: readonly LockedNumber[], budget: CommentBudget): BudgetVerdict {
  const held = new Map(Object.entries(budget.packages));
  const present = new Map(measured.map(({ key, value }) => [key, value]));

  return {
    over: measured.flatMap(({ key, value }) => {
      const was = held.get(key);

      return value > (was ?? 0) ? [{ key, was, now: value }] : [];
    }),
    stale: [...held].flatMap(([key, was]) => {
      const now = present.get(key);

      return now === undefined || now < was ? [{ key, was, now }] : [];
    }),
  };
}

export interface LoweredBudget {
  /** What `--lock` writes, or nothing when a number would rise. */
  readonly budget: CommentBudget | undefined;
  readonly refusals: readonly LockRefusal[];
}

/** The budget `--lock` may write over `previous`: every package at the lower of its two numbers. */
export function lowerBudget(
  previous: CommentBudget | undefined,
  measured: readonly LockedNumber[],
  measuredAt: string,
): LoweredBudget {
  const record = (numbers: readonly LockedNumber[]): CommentBudget =>
    ({ measuredAt, packages: Object.fromEntries(numbers.map(({ key, value }) => [key, value])) });

  if (previous === undefined) return { budget: record(measured), refusals: [] };
  const held = Object.entries(previous.packages).map(([key, value]) => ({ key, value }));
  const known = new Set(Object.keys(previous.packages));
  // A new package with no comments grows nothing, so it needs no departure to pay for it.
  const empty = measured.filter(({ key, value }) => value === 0 && !known.has(key));
  const { merged, refusals } = shrinkOnly(held, measured.filter((entry) => !empty.includes(entry)));

  return { refusals, budget: refusals.length > 0 ? undefined : record([...merged, ...empty]) };
}

/** What this gate cannot see, printed on the green path. */
export const BLIND_SPOTS: readonly string[] = [
  'EXPLANATION MOVED OUT OF COMMENTS — NOT MEASURED. A string literal, a document under docs/ or a '
  + 'commit body carries the same prose at no cost here.',
  'TESTS, SCRIPTS AND TOOLS — OUT OF SCOPE. The corpus is product source (`readSources`); a comment in '
  + 'a suite, in scripts/ or in tools/ has no budget.',
  'GROWTH PAID FOR INSIDE ONE PACKAGE — NOT DETECTED. The unit is the package total, so a comment that '
  + 'grows in one file while another shrinks by as much passes.',
  'WHETHER A KEPT COMMENT EARNS ITS PLACE — NOT JUDGED. The budget counts characters; the rule that a '
  + 'kept comment states a non-obvious constraint is still review\'s.',
  'A DELETED LOCK. `--lock` records a first budget when none exists, so deleting the lock and '
  + 're-locking resets every number to the tree as it stands; only the diff shows it.',
];

if (import.meta.main) {
  const sources = readSources();
  const measured = measureComments(sources);

  const summary = assertMeasured('bloat-budget', [
    ['product source files', sources.size],
    ['packages', measured.length],
    ['comment characters', measured.reduce((total, { value }) => total + value, 0)],
  ]);

  const previous = existsSync(LOCK) ? v.parse(BudgetSchema, JSON.parse(readFileSync(LOCK, 'utf8'))) : undefined;

  if (process.argv.includes('--lock')) {
    const { budget, refusals } = lowerBudget(previous, measured, new Date().toISOString().slice(0, 10));

    if (budget === undefined) process.exit(refuseLock('bloat-budget', refusals, 'cut the comments back under it'));
    writeFileSync(LOCK, `${JSON.stringify(budget, null, 2)}\n`);
    console.log(`bloat-budget: locked ${String(Object.keys(budget.packages).length)} package budget(s) over ${summary}`);
    process.exit(0);
  }

  if (previous === undefined) {
    console.error('bloat-budget: no budget is recorded. `bun scripts/bloat-budget.ts --lock` records the first one.');
    process.exit(1);
  }

  const verdict = judgeComments(measured, previous);

  if (verdict.over.length > 0) {
    console.error(`bloat-budget: ${String(verdict.over.length)} package(s) over their comment budget\n`);

    for (const { key, was, now } of verdict.over) {
      console.error(finding({
        at: `packages/${key}`,
        invariant: 'a package holds no more comment characters than its locked budget',
        found: `${String(now)} comment characters, ${was === undefined ? 'and the lock holds no budget for it' : `locked at ${String(was)}`}`,
        silently: 'comments accrete a sentence at a time until they are 41% of the text, as measured at '
          + '1dd25b3ad, and a reader stops reading any of them',
        fix: 'cut the new comment, or as many characters elsewhere in the package; `--lock` never raises a budget',
      }));
    }

    process.exit(1);
  }

  console.log(`bloat-budget: ok — every package at or under its comment budget (locked ${previous.measuredAt}), over ${summary}`);

  for (const { key, was, now } of verdict.stale) {
    console.log(`  stale: ${key} locked at ${String(was)}, now ${now === undefined ? 'absent' : String(now)}; `
      + '`bun scripts/bloat-budget.ts --lock` lowers it');
  }

  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
}
