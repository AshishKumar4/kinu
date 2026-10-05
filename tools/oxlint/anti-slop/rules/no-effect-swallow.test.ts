// Kinu-local rule; see upstream.json's `kinuRules`. The red->green proof through the real `oxlint`
// binary and the live denominator are in ../effect.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noEffectSwallowRule } from "./no-effect-swallow.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const drops = { messageId: "dropsEveryFailure" };
const handler = { messageId: "handlerDropsFailure" };

const head = "import { Effect } from 'effect'; declare const load: Effect.Effect<string, KinuError>; declare const log: { failure(e: unknown): void };";
// A detached root a holder keeps alive must answer every failure itself; the holder is no excuse to drop one.
const held = `${head} declare const ctx: { waitUntil(p: Promise<unknown>): void }; declare function settle<A>(e: Effect.Effect<A>): Promise<A>;`;

tester.run("anti-slop/no-effect-swallow", noEffectSwallowRule, {
  valid: [
    // A named failure is a declared tolerance, the channel's `tolerate(op, 'enoent')`.
    `${head} export const p = load.pipe(Effect.catchTag('KinuError', () => Effect.succeed('')));`,
    `${head} export const p = load.pipe(Effect.catchIf((e) => e.code === 'missing', () => Effect.succeed('')));`,
    // A handler that reads what it caught has said what happened to it.
    `${head} export const p = load.pipe(Effect.catch((error) => Effect.sync(() => log.failure(error)).pipe(Effect.as(''))));`,
    `${head} export const p = Effect.catch(load, (error) => Effect.fail(error));`,
    `${head} export const p = load.pipe(Effect.catchCause((cause) => Effect.die(cause)));`,
    // A handler passed by name is not inspected (the gate prints this blind spot).
    `${head} declare const recover: (e: KinuError) => Effect.Effect<string>; export const p = load.pipe(Effect.catch(recover));`,
    // Keeping the failure as data is not dropping it.
    `${head} export const p = Effect.exit(load); export const q = Effect.result(load);`,
    `${held} ctx.waitUntil(settle(load.pipe(Effect.catch((error) => Effect.sync(() => log.failure(error))))));`,
  ],
  invalid: [
    { name: "ignore", code: `${head} export const p = Effect.ignore(load);`, errors: [drops] },
    { name: "ignore in a pipe", code: `${head} export const p = load.pipe(Effect.ignore);`, errors: [drops] },
    { name: "ignoreCause", code: `${head} export const p = load.pipe(Effect.ignoreCause);`, errors: [drops] },
    { name: "orElseSucceed", code: `${head} export const p = load.pipe(Effect.orElseSucceed(() => ''));`, errors: [drops] },
    { name: "option", code: `${head} export const p = Effect.option(load);`, errors: [drops] },
    { name: "a catch-all with no parameter", code: `${head} export const p = load.pipe(Effect.catch(() => Effect.succeed('')));`, errors: [handler] },
    { name: "a catch-all that binds and drops", code: `${head} export const p = Effect.catch(load, (error) => Effect.succeed(''));`, errors: [handler] },
    { name: "a defect handler that drops the defect", code: `${head} export const p = load.pipe(Effect.catchDefect(() => Effect.succeed('')));`, errors: [handler] },
    { name: "a held root whose never-failing body drops the failure", code: `${held} ctx.waitUntil(settle(load.pipe(Effect.catch(() => Effect.void))));`, errors: [handler] },
    { name: "a held root that ignores its failure", code: `${held} ctx.waitUntil(settle(Effect.ignore(load)));`, errors: [drops] },
  ],
});
