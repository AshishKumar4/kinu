// Kinu-local rule; see upstream.json's `kinuRules`. The red->green proof through the real `oxlint`
// binary and the live denominator are in ../effect.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { effectEntryAwaitsRule } from "./effect-entry-awaits.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const late = { messageId: "lateAdoption" };

const head = "import { Effect } from 'effect'; declare const call: () => Promise<string>; declare function attempt<A>(input: object, run: () => PromiseLike<A>): Effect.Effect<A>;";

tester.run("anti-slop/effect-entry-awaits", effectEntryAwaitsRule, {
  valid: [
    // The promise itself, or a function that awaits before it returns.
    `${head} export const p = Effect.promise(() => Promise.resolve(call()));`,
    `${head} export const p = Effect.promise(call);`,
    `${head} export const p = Effect.promise(async () => (await call()).trim());`,
    `${head} export const p = Effect.tryPromise({ try: async () => { const text = await call(); return text; }, catch: (cause) => ({ cause }) });`,
    `${head} export const p = attempt({}, async () => { await call(); return 1; });`,
    // Not an Effect entry.
    `${head} export const f = async () => call();`,
  ],
  invalid: [
    { name: "Effect.promise over a call", code: `${head} export const p = Effect.promise(async () => call());`, errors: [late] },
    { name: "Effect.tryPromise with a function", code: `${head} export const p = Effect.tryPromise(async () => call());`, errors: [late] },
    { name: "Effect.tryPromise's try", code: `${head} export const p = Effect.tryPromise({ try: async () => call(), catch: (cause) => ({ cause }) });`, errors: [late] },
    { name: "a block body that returns the call", code: `${head} export const p = Effect.promise(async function () { return call(); });`, errors: [late] },
    { name: "attempt's run", code: `${head} export const p = attempt({}, async () => call());`, errors: [late] },
  ],
});
