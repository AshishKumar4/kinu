// Kinu-local rule; see upstream.json's `kinuRules`. The red->green proof through the real `oxlint`
// binary and the live denominator are in ../effect.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { effectRunInAdapterRule } from "./effect-run-in-adapter.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const run = { messageId: "runOutsideAdapter" };
const runtime = { messageId: "runtimeOutsideAdapter" };

const product = "packages/core/src/tools/example.ts";
const adapter = "packages/core/src/obs/effect.ts";

tester.run("anti-slop/effect-run-in-adapter", effectRunInAdapterRule, {
  valid: [
    // Composing is everywhere's job; only running is the adapter's.
    { code: "import { Effect } from 'effect'; export const p = Effect.gen(function* () { return yield* Effect.succeed(1); });", filename: product },
    { code: "import { Effect } from 'effect'; export const p = Effect.succeed(1).pipe(Effect.map((n) => n + 1));", filename: product },
    { code: "import { settle } from '../obs/index'; import { Effect } from 'effect'; await settle(Effect.succeed(1));", filename: product },
    // The adapter runs effects and chooses the scheduler.
    { code: "import { Effect, Scheduler } from 'effect'; const s = new Scheduler.MixedScheduler('sync'); await Effect.runPromiseExit(Effect.succeed(1), { scheduler: s });", filename: adapter },
    { code: "import { Effect, Scheduler } from 'effect'; const s = new Scheduler.MixedScheduler('sync'); Effect.runCallback(Effect.void, { scheduler: s, onExit() {} });", filename: "packages/devbox/src/errors.ts" },
    // A suite or a probe runs what it asserts on.
    { code: "import { Effect } from 'effect'; await Effect.runPromise(Effect.succeed(1));", filename: "packages/core/tests/unit-x.test.ts" },
    { code: "import { Effect } from 'effect'; await Effect.runPromise(Effect.succeed(1));", filename: "packages/cf-backend/tests/workerd/probe.ts" },
    // A method named `run…` on something that is not Effect.
    { code: "import { Effect } from 'effect'; declare const job: { runPromise(): void }; job.runPromise(); export const e = Effect.void;", filename: product },
  ],
  invalid: [
    { name: "runPromise", code: "import { Effect } from 'effect'; await Effect.runPromise(Effect.succeed(1));", filename: product, errors: [run] },
    { name: "standalone library code also cannot run effects outside its adapter", code: "import { Effect } from 'effect'; Effect.runSync(Effect.void);", filename: "packages/devbox/src/storage.ts", errors: [run] },
    { name: "runFork", code: "import { Effect } from 'effect'; Effect.runFork(Effect.never);", filename: product, errors: [run] },
    { name: "a run passed by reference", code: "import { Effect } from 'effect'; export const go = Effect.runPromiseExit;", filename: product, errors: [run] },
    { name: "a namespace import of effect/Effect", code: "import * as E from 'effect/Effect'; E.runSync(E.succeed(1));", filename: product, errors: [run] },
    { name: "a named run export", code: "import { runPromise } from 'effect/Effect'; export const go = runPromise;", filename: product, errors: [run] },
    { name: "a detached fork outlives the invocation", code: "import { Effect } from 'effect'; export const p = Effect.forkDetach(Effect.never);", filename: product, errors: [run] },
    { name: "a runtime", code: "import { ManagedRuntime } from 'effect'; export const r = ManagedRuntime;", filename: product, errors: [runtime] },
    { name: "a scheduler", code: "import { Scheduler } from 'effect'; export const s = new Scheduler.MixedScheduler();", filename: product, errors: [runtime] },
    { name: "a scheduler module", code: "import * as S from 'effect/Scheduler'; export const s = S.MaxOpsBeforeYield;", filename: product, errors: [runtime] },
    { name: "a client file of the web app", code: "import { Effect } from 'effect'; Effect.runFork(Effect.void);", filename: "packages/cf-backend/src/components/x.tsx", errors: [run] },
    { name: "a script runs through settle like everything else", code: "import { Effect } from 'effect'; Effect.runSync(Effect.succeed(1));", filename: "scripts/x.ts", errors: [run] },
  ],
});
