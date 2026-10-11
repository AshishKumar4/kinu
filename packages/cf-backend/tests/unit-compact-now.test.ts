/**
 * `agent.compactNow` arms the compaction ladder's forced rebuild for the agent's next turn assembly. Main's turns are
 * assembled in its own isolate (D9), so the arm lands in the compaction state that isolate's assembly reads and clears.
 */
import { expect, test } from 'bun:test';
import { catalogTurn, gatewayWorkspace, mainRows, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

test("main's compactNow arms the compaction its own isolate's next assembly reads", async () => {
  const gateway = stubAiBinding((run) => (requestOf(run).messages.some((message) => message.role === 'tool')
    ? chatCompletion(run, 'Armed.')
    : toolCallCompletion(run, { tool: 'eval', args: { code: 'return await agent.compactNow();' } }, 'compact_0')));

  const workspace = gatewayWorkspace(gateway);

  await catalogTurn(workspace.agent, 'Compact your context before the next task.');
  const { db } = await mainRows(workspace);

  const armed = db.query<{ force_compaction: number | null }, [string]>('SELECT force_compaction FROM compaction_state WHERE session_key = ?')
    .all(workspaceMainActor(workspace.db).actorId);

  expect(armed).toEqual([{ force_compaction: 1 }]);
});
