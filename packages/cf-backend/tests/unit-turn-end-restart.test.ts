/**
 * How a turn ends is what a restart of its agent's isolate finds (#71, #72, #73): one commit closes the turn's claim, its
 * run and the input it answered, whether it answered, failed or was retried, and a delivered run's end is kept in the
 * commit that answers it. A later start of the isolate, routine as isolates rest and are evicted, runs none of it again.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import { driveUntil, gatewayWorkspace, mainDatabase, storedChat, workspaceMainActor, type StartedHarness } from './helpers/actor-harness';
import { delayNextRunEnd, failNextAnswerWrite } from './helpers/agent-facets';
import { socketConnection } from './helpers/bindings';
import { chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const ASK = 'Summarize the release.';

const SEARCH = 'Find a way to speed up the parser.';

const TASK = 'Name one way to tokenize faster.';

const owner = socketConnection({ id: 'owner', send: () => {} });

afterEach(() => { setSystemTime(); });

/** A workspace whose model answers the owner's ask; `asked` counts the calls on it. */
function answering() {
  let asked = 0;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (openingOf(run).includes(ASK)) asked += 1;

    return chatCompletion(run, 'The release fixes the parser.');
  }));

  return { workspace, asked: () => asked };
}

function mainKey(workspace: StartedHarness): string {
  return workspace.agent.agentOf(workspaceMainActor(workspace.db).actorId).storageKey;
}

/** The owner's words main still owes a turn: what its next start runs as a turn of their own. */
function owedWords(workspace: StartedHarness): number {
  return mainDatabase(workspace).query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pending_steers').get()?.n ?? 0;
}

/** Main's isolate is evicted at rest; the next read of its chat starts it again, and whatever it finds owed runs. */
async function restartMain(workspace: StartedHarness): Promise<void> {
  workspace.agent.harnessResetAgentIsolate(mainKey(workspace));
  await storedChat(workspace);
  await workspace.agent.harnessAgentsIdle();
}

/** The owner's message, or their Retry of `id` (its messages up to the turn it retries), as the pane sends each. */
function chatRequest(requestId: string, id: string, trigger: 'submit-message' | 'regenerate-message', text = ASK): string {
  return JSON.stringify({
    type: CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST, id: requestId,
    init: { method: 'POST', body: JSON.stringify({ messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }], trigger }) },
  });
}

test('a turn whose answer could not commit ends failed, and a restart does not run it again', async () => {
  const { workspace, asked } = answering();
  const id = crypto.randomUUID();

  // Its answer's commit fails: the turn ends failed, its failure recorded.
  failNextAnswerWrite(mainKey(workspace));
  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message'));
  await workspace.agent.harnessAgentsIdle();
  const before = asked();

  // The words it took are answered by its end: a restart finds nothing of them owed.
  expect(owedWords(workspace)).toBe(0);
  await restartMain(workspace);

  expect({ before, after: asked() }).toEqual({ before: 1, after: 1 });
});

test("a failed turn the owner retried is answered once by the Retry, and a restart runs neither again", async () => {
  const { workspace, asked } = answering();
  const id = crypto.randomUUID();

  failNextAnswerWrite(mainKey(workspace));
  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message'));
  await workspace.agent.harnessAgentsIdle();

  // The owner retries it: the Retry runs it again and answers.
  await workspace.agent.onMessage(owner, chatRequest(crypto.randomUUID(), id, 'regenerate-message'));
  await driveUntil(workspace, 'the Retry never ran', () => asked() === 2);
  await workspace.agent.harnessAgentsIdle();

  expect(owedWords(workspace)).toBe(0);
  await restartMain(workspace);

  expect(asked()).toBe(2);
});

test("a node whose isolate dies after its run ended, with its end untold, is not run again, and its search completes", async () => {
  let nodeCalls = 0;

  const gateway = stubAiBinding((run) => {
    if (!openingOf(run).includes(SEARCH)) {
      nodeCalls += 1;

      return chatCompletion(run, 'Cache the token table.');
    }

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: TASK, preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  });

  const workspace = gatewayWorkspace(gateway);
  const told = delayNextRunEnd();
  const id = crypto.randomUUID();

  // Sent as the pane sends it; nothing waits for its agents to rest, which a dead isolate's telling never lets them.
  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message', SEARCH));

  await told.reached;
  const node = workspace.db.query<{ storage_key: string }, []>("SELECT storage_key FROM workspace_actors WHERE origin = 'swarm'").get();

  // It dies there: the run's answer and its end are committed, its telling only on the way.
  workspace.agent.harnessResetAgentIsolate(node?.storage_key ?? '');
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, 'the search never settled', () => workspace.db.query<{ status: string }, []>('SELECT status FROM head_journal').get()?.status === 'completed');

  expect(nodeCalls).toBe(1);
});
