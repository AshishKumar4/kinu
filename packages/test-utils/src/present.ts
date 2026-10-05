import { Effect } from 'effect';
import { settleSync } from '@kinu.run/core/obs';
/** The value a test expects to exist, narrowed, or a failure naming what was absent. */

export function present<T>(value: T | null | undefined, what: string): T {
  return settleSync(Effect.gen(function* () {
    if (value === undefined || value === null) return yield* Effect.die(new Error(`${what} is absent`));

    return value;
  }));
}
