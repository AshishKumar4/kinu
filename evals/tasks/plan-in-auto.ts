import { slateUiSegments } from '@kinu.run/core';
import type { EvalPart } from '../src/task';

// Asked in Auto for a plan, the agent submits it for the owner's review: not a plan written in chat, a file or a slate,
// and nothing built before the owner approves it. It leaves a review pending, so it runs last.

/** A write to the workspace's files, a file slate's included, natively or from an eval program. */
const WRITES = /"op":"(write|edit)"|\.(writeFile|editFile)\(/;

export const planInAuto: EvalPart = {
  id: 'plan',
  objectives: ['Asked in Auto for a plan, submit it for review with submit_plan and build nothing before it is approved.'],
  turns: [{
    prompt: 'Make a plan for taking preorders online for the two bakery shops: what we would build, where it would live, and how we would check it works.',
    verify: async (verifier) => {
      const calls = await verifier.turnToolCalls();

      await verifier.check('submitted-the-plan-for-review', async () => {
        const { plans } = await verifier.workspaceWork();
        const pending = plans.filter((entry) => entry.plan.status === 'pending');

        return {
          pass: calls.some((call) => call.name === 'submit_plan') && pending.length > 0,
          evidence: { submissions: calls.filter((call) => call.name === 'submit_plan').length, plans: plans.map((entry) => ({ owner: entry.owner.name, status: entry.plan.status, opening: entry.plan.content.slice(0, 120) })) },
        };
      });

      await verifier.check('built-nothing-before-approval', async () => {
        const writes = calls.filter((call) => (call.name === 'file' || call.name === 'eval') && WRITES.test(call.args));
        const inline = verifier.replies.flatMap(slateUiSegments).filter((segment) => segment.kind === 'slate').length;

        return { pass: writes.length === 0 && inline === 0, evidence: { writes: writes.map((call) => call.args.slice(0, 200)), inline } };
      });
    },
  }],
};
