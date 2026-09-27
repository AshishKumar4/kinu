// gate:effect-diagnostics' red half. The pinned @effect/tsgo must report the statement after the
// marker as a floating effect: it builds an effect, drops it, and compiles. If the report stops
// (a bump, a lost plugin entry in tsconfig.base.json), the gate is red.
import { Effect } from 'effect';

export const program = Effect.gen(function* () {
  // [floating]
  Effect.succeed('dropped');

  return yield* Effect.succeed(1);
});
