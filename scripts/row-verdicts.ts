/**
 * Rows measured one after another in a suite's `beforeAll`, each leaving its
 * verdict or the account of why it has none, so one broken row cannot hide the
 * others: a row that throws is recorded and the next row runs. Each row's start,
 * break and end go to the run's log under the suite's name, so a run a tier's
 * deadline ends still names the row it was in.
 */
import { watch } from 'node:fs';
import { renderThrownChain } from '@kinu.run/core/obs';
import { SILENCE_NOTICE_ENV } from './deadline';

export interface RowVerdicts {
  /** Run `measure` as `row`: its verdict, or null once its failure is recorded. */
  readonly attempt: <Value>(row: string, measure: () => Promise<Value>) => Promise<Value | null>;
  /** A row's verdict, or the failure that it never produced one. */
  readonly verdictOf: <Value>(value: Value | null, row: string) => Value;
  /** Every row that broke, with why. */
  readonly broken: () => Readonly<Record<string, string>>;
}

/**
 * `work`'s value, unless the row's runner says first that its silence nears the bound (`SILENCE_NOTICE_ENV`, appended
 * by `runUnderDeadline` at three quarters of it): then `end` stops what the work waits on, a row's browser, so its
 * waits reject, and the row fails naming `waiting()`, what it was waiting for. A row that hangs then fails alone and
 * the next row runs, where before the runner's kill took every row after it. No runner, no notice: `work` alone.
 */
export async function endedNearSilence<Value>(work: Promise<Value>, end: () => Promise<void>, waiting: () => string): Promise<Value> {
  const path = process.env[SILENCE_NOTICE_ENV];

  if (path === undefined || path === '') return await work;
  const near = Promise.withResolvers<string>();
  const watcher = watch(path, () => { near.resolve(waiting()); });

  const silenced = near.promise.then(async (named) => {
    await end();

    throw new Error(`the row went silent near its runner's bound${named === '' ? '' : ` while waiting for ${named}`}`);
  });

  // The race holds both: when the notice wins, what the work rejects with once its browser is gone is handled by it.
  try {
    return await Promise.race([work, silenced]);
  } finally {
    watcher.close();
  }
}

/** `unrun` says why no row ran at all (the suite's own setup failed), or null. `evidence`, when given, names where
 *  more of a broken row's account is kept (the live-app rows' dev-server log), and is asked once per break. */
export function rowVerdicts(suite: string, unrun: () => string | null, evidence?: () => string | null): RowVerdicts {
  const broke = new Map<string, string>();

  return {
    attempt: async (row, measure) => {
      const started = performance.now();

      process.stderr.write(`${suite}: ${row} started\n`);

      try {
        return await measure();
      } catch (cause) {
        const kept = evidence?.() ?? null;

        broke.set(row, kept === null ? renderThrownChain({ cause }) : `${renderThrownChain({ cause })} (${kept})`);
        process.stderr.write(`${suite}: ${row} broke: ${broke.get(row) ?? ''}\n`);

        return null;
      } finally {
        process.stderr.write(`${suite}: ${row} ended after ${((performance.now() - started) / 1000).toFixed(0)} s\n`);
      }
    },
    verdictOf: (value, row) => {
      // An `?? 0` fallback inside an assertion would turn a row that never ran into a green one.
      if (value === null) throw new Error(`the ${row} row produced no verdict: ${broke.get(row) ?? unrun() ?? 'it never ran'}`);

      return value;
    },
    broken: () => Object.fromEntries(broke),
  };
}
