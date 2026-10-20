/**
 * Main's chat runs in its own isolate while its tools, its crafted tools among them, run in the workspace: the turn it
 * hands back records which crafted tools it was offered and which it chose, counted where they live as it is recorded.
 */
import { expect, test } from 'bun:test';
import { catalogTurn, driveUntil, gatewayWorkspace } from './helpers/actor-harness';
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

test("a crafted tool main's turn chose is counted in the Tools pane as the turn is recorded", async () => {
  const workspace = crafting();
  const { agent, db } = workspace;
  const counted = () => db.query<{ offered: number; chosen: number }, []>("SELECT offered, chosen FROM crafted_tools WHERE name = 'double'").all();

  await catalogTurn(agent, ASK);
  await driveUntil(workspace, 'the crafting turn was never recorded', () => counted()[0]?.offered === 1);

  const { crafted } = await agent.getToolDescriptions();
  const double = crafted.find((tool) => tool.name === 'double');

  // Offered from the step after it was made, and called there: chosen in its one offer.
  expect(double?.usageCount).toBe(1);
  expect(counted()).toEqual([{ offered: 1, chosen: 1 }]);
});
