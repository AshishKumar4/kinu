/**
 * How a turn ends is what a restart of its agent's isolate finds (#71, #72, #73): one commit closes the turn's claim, its
 * run and the input it answered, whether it answered, failed or was retried, and a delivered run's end is kept in the
 * commit that answers it. A later start of the isolate, routine as isolates rest and are evicted, runs none of it again.
 */
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { CHAT_MESSAGE_TYPES } from 'agents/chat';
import { RECOVERY_BACKOFF_CEILING_MS } from '@kinu.run/core';
import {
  agentSql, driveUntil, gatewayWorkspace, hostedMainActor, mainDatabase, relayedReports, storedChat, workspaceMainActor, type StartedHarness,
} from './helpers/actor-harness';
import { delayNextModelReport, delayNextRunEnd, delayNextRunReview, delayNextTurnReport, failNextAnswerWrite } from './helpers/agent-facets';
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

/** A workspace whose main agent starts a one-node search, then says so; `nodeCalls` counts the node's model calls. */
function searching() {
  let calls = 0;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (!openingOf(run).includes(SEARCH)) {
      calls += 1;

      return chatCompletion(run, 'Cache the token table.');
    }

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: TASK, preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  }));

  return { workspace, nodeCalls: () => calls };
}

function searchSettled(workspace: StartedHarness): boolean {
  return workspace.db.query<{ status: string }, []>('SELECT status FROM head_journal').get()?.status === 'completed';
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
  const { workspace, nodeCalls } = searching();
  const told = delayNextRunEnd();
  const id = crypto.randomUUID();

  // Sent as the pane sends it; nothing waits for its agents to rest, which a dead isolate's telling never lets them.
  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message', SEARCH));

  await told.reached;
  const node = workspace.db.query<{ storage_key: string }, []>("SELECT storage_key FROM workspace_actors WHERE origin = 'swarm'").get();

  // It dies there: the run's answer and its end are committed, its telling only on the way.
  workspace.agent.harnessResetAgentIsolate(node?.storage_key ?? '');
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, 'the search never settled', () => searchSettled(workspace));

  expect(nodeCalls()).toBe(1);
});

test("a hire whose isolate dies as its turn's report goes to its hirer is asked once, and its hirer hears it once", async () => {
  const MISSION = 'Catalogue every file under the home directory.';
  const ASKED = 'Have someone check the ledger.';
  const ANSWER = 'The ledger balances.';
  let asked = 0;

  // Main hires a task agent for the mission, then says so; the hire, whose conversation never holds main's ask, answers.
  // A call that offers no tools is the workspace naming itself, no agent's turn.
  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);

    if (tools.length > 0 && !JSON.stringify(messages).includes(ASKED)) {
      asked += 1;

      return chatCompletion(run, ANSWER);
    }

    if (!JSON.stringify(messages).includes(ASKED)) return chatCompletion(run, '{"title":"Ledger Check"}');

    return messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Handed off.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', mission: MISSION } }, 'hire_0');
  }));

  const reporting = delayNextTurnReport();
  const id = crypto.randomUUID();

  // Sent as the pane sends it; nothing waits for its agents to rest, which a held report never lets them.
  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message', ASKED));
  const hire = await reporting.reached;

  // The hire's isolate dies as its report goes: its answer, and the report it owes, are its own, told when next woken.
  workspace.agent.harnessResetAgentIsolate(hire);
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, "the hire's hirer never heard its report", () => relayedReports(workspace.db).some((report) => report.includes(ANSWER)));

  expect({ asked, heard: relayedReports(workspace.db).filter((report) => report.includes(ANSWER)).length }).toEqual({ asked: 1, heard: 1 });
});

test("a node whose isolate dies as its round's review goes to its workspace is not asked again, and its search completes", async () => {
  const { workspace, nodeCalls } = searching();
  // The review of the node's round goes to its workspace on the way: its isolate dies there.
  const reviewing = delayNextRunReview();
  const id = crypto.randomUUID();

  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message', SEARCH));
  workspace.agent.harnessResetAgentIsolate(await reviewing.reached);
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, 'the search never settled', () => searchSettled(workspace));

  expect(nodeCalls()).toBe(1);
});

/** Main's loop, which a node it starts inherits: on the node's task, one model call beside its turn's own. */
const NOTING_LOOP = `async function* run(rt, task) {
  if (String(task).includes('tokenize')) await host.llmStream({ system: 'Note.', messages: [{ role: 'user', content: 'LOOP_NOTE' }] });
  await host.defaultInference();
}`;

test("a node whose isolate dies after its run's end committed, before it was told, has its loop's model call charged once", async () => {
  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages } = requestOf(run);

    if (JSON.stringify(messages).includes('LOOP_NOTE')) return chatCompletion(run, 'Noted.');

    if (!openingOf(run).includes(SEARCH)) return chatCompletion(run, 'Cache the token table.');

    return messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: TASK, preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  }));

  // Main's current loop is the noting one, which the node inherits as it is hired.
  const { actor: main } = await hostedMainActor(workspace);
  const files = main.runtime.agentStateVfs ?? main.runtime.storage.vfs;

  await files.mkdir('scaffold', { recursive: true });
  await writeText(files, `${main.runtime.identity.scaffold.path}.v2`, NOTING_LOOP);
  workspace.db.query("UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND status = 'current'").run(main.handle.actorId);
  workspace.db.query("INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status) VALUES (?, 2, ?, 'noting loop', 'current')")
    .run(main.handle.actorId, Date.now());

  // Whatever the node tells its workspace of the run is held on the way: its end, and any charge it relays on its own.
  const told = delayNextRunEnd();

  delayNextModelReport((key) => key !== mainKey(workspace));
  const id = crypto.randomUUID();

  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message', SEARCH));
  await driveUntil(workspace, "the node's run never ended", () => {
    const node = workspace.db.query<{ actor_id: string }, []>("SELECT actor_id FROM workspace_actors WHERE origin = 'swarm'").get();

    return node !== null && agentSql(workspace, node.actor_id)<{ n: number }>`SELECT COUNT(*) AS n FROM run_events WHERE type = 'run_end'`[0]?.n === 1;
  });
  const node = workspace.db.query<{ storage_key: string }, []>("SELECT storage_key FROM workspace_actors WHERE origin = 'swarm'").get();

  // It dies there: the run's end is committed; what it tells of it only on the way. A telling of its end already sent
  // still arrives, as an unanswered call can, and the next start of the isolate tells it again.
  workspace.agent.harnessResetAgentIsolate(node?.storage_key ?? '');
  told.release();
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, 'the search never settled', () => searchSettled(workspace));

  const charged = workspace.db.query<{ payload: string }, []>("SELECT payload FROM run_events WHERE type = 'model_call'").all()
    .filter((event) => JSON.parse(event.payload).source === 'scaffold');

  expect(charged).toHaveLength(1);
});
