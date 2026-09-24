/**
 * Rows measured one after another in a suite's `beforeAll`, each leaving its
 * verdict or the account of why it has none, so one broken row cannot hide the
 * others: a row that throws is recorded and the next row runs. Each row's start,
 * break and end go to the run's log under the suite's name, so a run a tier's
 * deadline ends still names the row it was in.
 */
import { renderThrownChain } from '@kinu.run/core/obs';

export interface RowVerdicts {
  /** Run `measure` as `row`: its verdict, or null once its failure is recorded. */
  readonly attempt: <Value>(row: string, measure: () => Promise<Value>) => Promise<Value | null>;
  /** A row's verdict, or the failure that it never produced one. */
  readonly verdictOf: <Value>(value: Value | null, row: string) => Value;
  /** Every row that broke, with why. */
  readonly broken: () => Readonly<Record<string, string>>;
}

/** `unrun` says why no row ran at all (the suite's own setup failed), or null. */
export function rowVerdicts(suite: string, unrun: () => string | null): RowVerdicts {
  const broke = new Map<string, string>();

  return {
    attempt: async (row, measure) => {
      const started = performance.now();

      process.stderr.write(`${suite}: ${row} started\n`);

      try {
        return await measure();
      } catch (cause) {
        broke.set(row, renderThrownChain({ cause }));
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
