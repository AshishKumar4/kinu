// Kinu-local rule; see upstream.json's `kinuRules`. The red->green proof through the real `oxlint`
// binary and the live denominator are in ../effect.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { effectRestrictedApiRule } from "./effect-restricted-api.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const imported = { messageId: "restrictedImport" };
const member = { messageId: "restrictedMember" };

tester.run("anti-slop/effect-restricted-api", effectRestrictedApiRule, {
  valid: [
    "import { Cause, Data, Effect, Exit, Option } from 'effect'; export const p = Effect.gen(function* () { return yield* Effect.succeed(1); });",
    "import { Effect } from 'effect'; export const f = Effect.fnUntraced(function* (n: number) { return n; });",
    // A bounded retry with no schedule arms no timer.
    "import { Effect } from 'effect'; declare const load: Effect.Effect<string>; export const p = Effect.retry(load, { times: 2 });",
    // A `log` member on something that is not Effect.
    "import { Effect } from 'effect'; declare const logger: { log(m: string): void }; logger.log('x'); export const e = Effect.void;",
  ],
  invalid: [
    { name: "Effect Schema", code: "import { Schema } from 'effect'; export const S = Schema.String;", errors: [imported] },
    { name: "Effect Schema by module", code: "import * as Schema from 'effect/Schema'; export const S = Schema.String;", errors: [imported] },
    { name: "Layer", code: "import { Layer } from 'effect'; export const L = Layer.empty;", errors: [imported] },
    { name: "Context services", code: "import { Context } from 'effect'; export const C = Context.empty;", errors: [imported] },
    { name: "Schedule", code: "import { Schedule } from 'effect'; export const s = Schedule.spaced('1 second');", errors: [imported] },
    { name: "Logger", code: "import { Logger } from 'effect'; export const l = Logger.defaultLogger;", errors: [imported] },
    { name: "an unstable module", code: "import * as Rpc from 'effect/unstable/rpc/Rpc'; export const r = Rpc;", errors: [imported] },
    { name: "sleep", code: "import { Effect } from 'effect'; export const p = Effect.sleep('1 second');", errors: [member] },
    { name: "timeout", code: "import { Effect } from 'effect'; declare const load: Effect.Effect<string>; export const p = load.pipe(Effect.timeout('30 seconds'));", errors: [member] },
    { name: "log", code: "import { Effect } from 'effect'; export const p = Effect.logInfo('turn started');", errors: [member] },
    { name: "a span", code: "import { Effect } from 'effect'; declare const load: Effect.Effect<string>; export const p = load.pipe(Effect.withSpan('load'));", errors: [member] },
    { name: "a traced function", code: "import { Effect } from 'effect'; export const f = Effect.fn('load')(function* () { return 1; });", errors: [member] },
    { name: "through a namespace import", code: "import * as E from 'effect/Effect'; export const p = E.delay(E.void, '1 second');", errors: [member] },
  ],
});
