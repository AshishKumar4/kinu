/**
 * Main's chat runs in its own isolate while its tools, its crafted tools among them, run in the workspace: a crafted
 * tool its turn calls is scored where it ran, and the turn it hands back records the use.
 */
import { expect, test } from 'bun:test';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const ASK = 'Make a tool that doubles a number, then double 21 with it.';

const CREATE = 'await workspace.createTool("double", "Doubles a number.", "async (args) => args.n * 2"); return "made";';

const CALL = 'return await tools.double({ n: 21 });';

function stepOf(run: RecordedGatewayRun): number {
  return requestOf(run).messages.filter((message) => message.role === 'tool').length;
}

/** Main crafts `double` in one program, calls it in the next, then answers. */
function crafting() {
  return gatewayWorkspace(stubAiBinding((run) => {
    if (!openingOf(run).includes(ASK)) return chatCompletion(run, 'Ready.');

    if (stepOf(run) === 0) return toolCallCompletion(run, { tool: 'eval', args: { code: CREATE } }, 'create_0');

    if (stepOf(run) === 1) return toolCallCompletion(run, { tool: 'eval', args: { code: CALL } }, 'call_1');

    return chatCompletion(run, 'Double 21 is 42.');
  }));
}

test("a crafted tool main's turn calls is counted in the Tools pane, and the turn it hands back records the use", async () => {
  const { agent, db } = crafting();

  await catalogTurn(agent, ASK);

  const { crafted } = await agent.getToolDescriptions();
  const double = crafted.find((tool) => tool.name === 'double');

  // One clean call of a tool that existed before it ran: one use, scored up from the neutral prior.
  expect(double?.usageCount).toBe(1);
  expect(double?.qualityScore).toBeGreaterThan(0.5);
  expect(db.query<{ tool_names: string }, []>('SELECT tool_names FROM turn_craft_usage').all()).toEqual([{ tool_names: '["double"]' }]);
});
