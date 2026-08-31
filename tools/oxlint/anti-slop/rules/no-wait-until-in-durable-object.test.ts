// Kinu-local rule; see upstream.json's `kinuRules`. There is no upstream suite beside this
// one. The repo-level Durable Object corpus count and the seeded red->green run through the real
// `oxlint` binary live in ../no-wait-until.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noWaitUntilInDurableObjectRule } from "./no-wait-until-in-durable-object.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "waitUntilInDurableObject" };

tester.run("anti-slop/no-wait-until-in-durable-object", noWaitUntilInDurableObjectRule, {
  valid: [
    // The Worker entrypoint. `ctx` is an ExecutionContext, waitUntil is the documented way to
    // outlive the response, and it is not `this.ctx`.
    "export default { async fetch(request: Request, env: Env, ctx: ExecutionContext) { ctx.waitUntil(sweep(env)); return new Response('ok'); } };",
    // A module-level route helper handed the Worker's context.
    "export function handle(env: Env, ctx?: ExecutionContext): void { ctx?.waitUntil(cleanup(env)); }",
    // An injected seam. The caller decides what retention means; this file makes no claim.
    "export function create(options: { waitUntil?: (p: Promise<unknown>) => void }): void { const task = run(); if (options.waitUntil) options.waitUntil(task); }",
    // The corrected form of the real defect: awaited inside the invocation.
    "class Orchestrator extends Agent<Env> { private async scheduleTimerAt(ts: number): Promise<void> { await this.armTimer(ts); } }",
    // An object literal with a ctx field is a handler bag, not an instance.
    "const routes = { ctx: executionContext, run() { this.ctx.waitUntil(task()); } };",
    // A different method on the state handle.
    "class Store extends DurableObject<Env> { async put(k: string) { await this.ctx.storage.put(k, 1); } }",
    // waitUntil on something that is not the state handle.
    "class Bridge extends DurableObject<Env> { run(outer: ExecutionContext) { outer.waitUntil(task()); } }",
  ],
  invalid: [
    {
      name: "the real defect — orchestrator.ts scheduleTimerAt as it shipped at 5183d69d",
      code: `class Orchestrator extends Agent<Env> {
  private scheduleTimerAt(ts: number): void {
    this.ctx.waitUntil(this.armTimer(ts).catch((err) => {
      console.error('[kinu] timer arm failed:', err instanceof Error ? err.message : String(err));
    }));
  }
}`,
      errors: [error],
    },
    {
      name: "the UserDO instances feat/observability introduced",
      code: `class UserDO extends Agent<Env> {
  async connect(id: string) { this.ctx.waitUntil(mgr.discoverIfConnected(id)); }
  async ensure(id: string) { this.ctx.waitUntil(mgr.establishConnection(id)); }
}`,
      errors: [error, error],
    },
    {
      name: "the pre-2023 spelling of the state handle",
      code: "class Legacy extends DurableObject { run() { this.state.waitUntil(task()); } }",
      errors: [error],
    },
    {
      name: "a base class the rule was never told about is still caught",
      code: "class Odd extends SomeFutureActorBase { run() { this.ctx.waitUntil(task()); } }",
      errors: [error],
    },
    {
      name: "a class expression is a class",
      code: "const Anon = class extends DurableObject<Env> { run() { this.ctx.waitUntil(task()); } };",
      errors: [error],
    },
    {
      name: "nested in a callback inside a method — still this, still the object",
      code: `class Nested extends DurableObject<Env> {
  run(rows: string[]) { rows.forEach((row) => { this.ctx.waitUntil(save(row)); }); }
}`,
      errors: [error],
    },
    {
      name: "swallowing both settlements does not make it retained",
      code: "class Backfill extends Agent<Env> { go() { this.ctx.waitUntil(repair().then(() => {}, () => {})); } }",
      errors: [error],
    },
  ],
});
