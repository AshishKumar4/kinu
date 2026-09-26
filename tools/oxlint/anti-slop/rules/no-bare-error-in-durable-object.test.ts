// Kinu-local rule; see upstream.json's `kinuRules`. The red->green run through the real `oxlint`
// binary lives in ../no-design-smells.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noBareErrorInDurableObjectRule } from "./no-bare-error-in-durable-object.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const product = "/repo/packages/cf-backend/src/orchestrator.ts";
const userModule = "/repo/packages/cf-backend/src/user/workspace-fork.ts";

tester.run("anti-slop/no-bare-error-in-durable-object", noBareErrorInDurableObjectRule, {
  valid: [
    { filename: product, code: "class Root extends ActorAgent { run() { throw new KinuError('unavailable', 'try again'); } }" },
    { filename: product, code: "class Root extends DurableObject { run() { throw new StoragePredatesResetError(); } }" },
    // A module with no Durable Object: its throws reach no RPC caller directly.
    { filename: "/repo/packages/cf-backend/src/lib/parse.ts", code: "export function parse(s: string) { throw new Error(s); }" },
    // Tests and harnesses stand outside product source.
    { filename: "/repo/packages/cf-backend/tests/helpers/harness.ts", code: "class Probe extends Agent<Env> { run() { throw new Error('x'); } }" },
    // A rethrow of a caught value is not a new unclassified error.
    { filename: product, code: "class Root extends Agent<Env> { run(e: Error) { throw e; } }" },
  ],
  invalid: [
    {
      name: "the refusal that answered 500: a pending teardown",
      filename: "/repo/packages/cf-backend/src/user/user-do.ts",
      code: "class UserDO extends Agent<Env> { requireNotDeleting(name: string) { throw new Error(`${name} is still being deleted.`); } }",
      errors: [{ messageId: "bareError" }],
    },
    {
      name: "a module-level helper beside the class",
      filename: product,
      code: "function refuse(): never { throw new TypeError('bad'); }\nexport class Root extends ActorAgent {}",
      errors: [{ messageId: "bareError" }],
    },
    {
      name: "a user/ module the UserDO runs, with no class of its own",
      filename: userModule,
      code: "export function fork(name: string) { throw new AggregateError([], name); }",
      errors: [{ messageId: "bareError" }],
    },
  ],
});
