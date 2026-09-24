import { RuleTester } from "oxlint/plugins-dev";

import { requireSuperAlarmRule } from "./require-super-alarm.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const product = "/repo/packages/cf-backend/src/orchestrator.ts";

tester.run("anti-slop/require-super-alarm", requireSuperAlarmRule, {
  valid: [
    {
      filename: product,
      code: "class Root extends ActorAgent { async alarm(): Promise<void> { await super.alarm(); this.tick(); } }",
    },
    {
      filename: product,
      code: "class Root extends Agent<Env> { alarm = async (): Promise<void> => { await super.alarm(); }; }",
    },
    // A plain Durable Object owns its slot.
    {
      filename: "/repo/packages/cf-backend/src/deploy/deploy-do.ts",
      code: "class DeployRunDO extends DurableObject { async alarm() { await this.ctx.storage.setAlarm(Date.now()); } }",
    },
    // No alarm declared, and a wake scheduled through the SDK.
    { filename: product, code: "class Root extends ActorAgent { arm(at: Date) { return this.schedule(at, 'tick'); } }" },
    { filename: "/repo/packages/cf-backend/tests/helpers/harness.ts", code: "class Probe extends Agent<Env> { async alarm() {} }" },
  ],
  invalid: [
    {
      name: "a shadowed alarm stops every scheduled wake",
      filename: product,
      code: "class Root extends ActorAgent { async alarm(): Promise<void> { this.tick(); } }",
      errors: [{ messageId: "shadowedAlarm", data: { base: "ActorAgent" } }],
    },
    {
      name: "a class-field alarm is the same shadow",
      filename: product,
      code: "class Root extends Agent<Env> { alarm = async (): Promise<void> => { this.tick(); }; }",
      errors: [{ messageId: "shadowedAlarm", data: { base: "Agent" } }],
    },
    {
      name: "a comment or string naming super.alarm() is not a call",
      filename: product,
      code: "class Root extends Agent<Env> { async alarm() { log('call super.alarm() next time'); /* super.alarm() */ } }",
      errors: [{ messageId: "shadowedAlarm", data: { base: "Agent" } }],
    },
    {
      name: "a file hosting an SDK class writes the slot",
      filename: product,
      code: "class Root extends Agent<Env> { arm(at: number) { void this.ctx.storage.setAlarm(at); } }\nfunction clear(ctx: DurableObjectState) { void ctx.storage.deleteAlarm(); }",
      errors: [
        { messageId: "directAlarm", data: { method: "setAlarm" } },
        { messageId: "directAlarm", data: { method: "deleteAlarm" } },
      ],
    },
  ],
});
