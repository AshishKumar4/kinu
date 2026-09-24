import { RuleTester } from "oxlint/plugins-dev";

import { requireRpcSealRule } from "./require-rpc-seal.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const product = "/repo/packages/cf-backend/src/user/user-do.ts";

tester.run("anti-slop/require-rpc-seal", requireRpcSealRule, {
  valid: [
    {
      filename: product,
      code: "export class UserDO extends Agent<Env> { constructor(ctx, env) { super(ctx, env); sealRpcSurface(this, USER_DO_RPC_SURFACE); } }",
    },
    { filename: product, code: "export abstract class ActorAgent extends Agent<Env> { run() {} }" },
    { filename: product, code: "export class KinuSandbox extends Devbox<Env> { constructor(ctx, env) { super(ctx, env); } }" },
    { filename: "/repo/packages/cf-backend/tests/helpers/actor-harness.ts", code: "class Harness extends Agent<Env> {}" },
  ],
  invalid: [
    {
      name: "no constructor at all",
      filename: product,
      code: "export class MonitorAgent extends Agent<Env> { run() {} }",
      errors: [{ messageId: "unsealed", data: { name: "MonitorAgent", base: "Agent" } }],
    },
    {
      name: "a constructor that seals something else",
      filename: product,
      code: "export class Root extends ActorAgent { constructor(ctx, env) { super(ctx, env); sealRpcSurface(other, SURFACE); } }",
      errors: [{ messageId: "unsealed", data: { name: "Root", base: "ActorAgent" } }],
    },
    {
      name: "a seal only mentioned, never called",
      filename: product,
      code: "export class Root extends ActorAgent { constructor(ctx, env) { super(ctx, env); void sealRpcSurface; } }",
      errors: [{ messageId: "unsealed", data: { name: "Root", base: "ActorAgent" } }],
    },
  ],
});
