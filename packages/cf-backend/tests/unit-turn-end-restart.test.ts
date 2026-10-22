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
import {
  delayNextModelReport, delayNextOpenWork, delayNextRunEnd, delayNextTurnReport, failNextAnswerWrite, failNextOpening,
  holdNextObserve, holdNextResume, loseNextParentReport,
} from './helpers/agent-facets';
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

test("main's isolate dying after its model answered, as its turn was being closed, does not ask the model again", async () => {
  const { workspace, asked } = answering();
  // Whatever main's turn asks its workspace between its model's answer and its commit is held on the way: it dies there.
  const reading = delayNextOpenWork();
  const id = crypto.randomUUID();
  const sending = Promise.resolve(workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message')));
  const first = await Promise.race([reading.reached.then(() => 'held' as const), sending.then(() => 'answered' as const)]);

  // Its held call is never answered: the isolate died in it. A turn that asked nothing leaves the hold unused.
  if (first === 'held') {
    workspace.agent.harnessResetAgentIsolate(mainKey(workspace));
    await workspace.agent.recoverStrandedTurn();
  } else {
    reading.release();
  }

  await workspace.agent.harnessAgentsIdle();

  expect({ asked: asked(), owed: owedWords(workspace) }).toEqual({ asked: 1, owed: 0 });
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
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', message: MISSION } }, 'hire_0');
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
  const files = main.runtime.agentStateVfs;

  await files.mkdir('scaffold', { recursive: true });
  await writeText(files, `${main.runtime.identity.scaffold.path}.v2`, NOTING_LOOP);
  workspace.db.query("UPDATE scaffold_versions SET status = 'historical' WHERE actor_id = ? AND status = 'current'").run(main.handle.actorId);
  workspace.db.query("INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status) VALUES (?, 2, ?, 'noting loop', 'current')")
    .run(main.handle.actorId, Date.now());

  // Whatever the node tells its workspace of the run is held on the way: its end, and any charge it relays on its own.
  const told = delayNextRunEnd();
  const charging = delayNextModelReport((key) => key !== mainKey(workspace));

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
  charging.release();
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, 'the search never settled', () => searchSettled(workspace));

  const charged = workspace.db.query<{ payload: string }, []>("SELECT payload FROM run_events WHERE type = 'model_call'").all()
    .filter((event) => JSON.parse(event.payload).source === 'scaffold');

  expect(charged).toHaveLength(1);
});

test("a node whose end outgrows a stored row keeps it spilled, and its search hears it whole after a restart", async () => {
  // Its answer alone is past half a stored row; its end carries it again in its round's review.
  const ANSWER = `Cache the token table. ${'x'.repeat(1_200_000)}`;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (!openingOf(run).includes(SEARCH)) return chatCompletion(run, ANSWER);

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: TASK, preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  }));

  const told = delayNextRunEnd();
  const id = crypto.randomUUID();

  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message', SEARCH));
  await told.reached;
  const node = workspace.db.query<{ storage_key: string }, []>("SELECT storage_key FROM workspace_actors WHERE origin = 'swarm'").get();

  // It dies with its end kept and untold: the next start reads it back from where it was kept.
  workspace.agent.harnessResetAgentIsolate(node?.storage_key ?? '');
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, 'the search never settled', () => searchSettled(workspace));

  const [search] = await workspace.agent.getHeadRuns();

  expect(search?.heads.map((head) => head.summary)).toEqual([ANSWER]);
});

test("a hire whose assigned turn fails as it opens tells its hirer once, though its first telling is lost", async () => {
  const MISSION = 'Catalogue every file under the home directory.';
  const ASKED = 'Have someone check the ledger.';

  // Main hires a task agent for the mission, then says so; the hire's turn never runs.
  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);

    if (tools.length === 0 || !JSON.stringify(messages).includes(ASKED)) return chatCompletion(run, '{"title":"Ledger Check"}');

    return messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Handed off.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', message: MISSION } }, 'hire_0');
  }));

  // The hire's opening fails, as a workspace resetting fails it, and the report of that is lost on its first way.
  failNextOpening((key) => key !== mainKey(workspace));
  loseNextParentReport((key) => key !== mainKey(workspace));
  const id = crypto.randomUUID();
  const told = () => relayedReports(workspace.db).filter((report) => report.includes('failed to run its assigned turn'));

  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message', ASKED));
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, "the hire's hirer was never told its task failed", () => told().length > 0);
  await workspace.agent.harnessAgentsIdle();

  expect(told()).toHaveLength(1);
});

test("main's isolate dying as its workspace finishes reading the answer's stream does not ask the model again", async () => {
  const { workspace, asked } = answering();
  // The workspace reads main's answer stream whole and never says so: main's isolate dies waiting.
  const reading = holdNextObserve((key) => key === mainKey(workspace));
  const id = crypto.randomUUID();

  // The owner's request is answered as the turn's stream ends, which the held read never lets it.
  const sending = Promise.resolve(workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message')));
  const first = await Promise.race([reading.then((key) => ({ held: key })), sending.then(() => ({ held: null }))]);

  expect(first.held).not.toBeNull();
  workspace.agent.harnessResetAgentIsolate(first.held ?? '');
  // Recovered, the turn is closed over its recorded answer; a restart after finds nothing of it owed.
  await workspace.agent.recoverStrandedTurn();
  await driveUntil(workspace, 'the recovered turn never closed', () => owedWords(workspace) === 0);
  await restartMain(workspace);

  expect({ asked: asked(), answers: (await storedChat(workspace)).filter((message) => message.role === 'assistant').length, owed: owedWords(workspace) })
    .toEqual({ asked: 1, answers: 1, owed: 0 });
});

test("a node whose isolate dies as it asks whether its run goes on, after its last answer, is not asked again", async () => {
  const { workspace, nodeCalls } = searching();
  const asking = holdNextResume();
  const id = crypto.randomUUID();

  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message', SEARCH));
  workspace.agent.harnessResetAgentIsolate(await asking);
  setSystemTime(new Date(Date.now() + RECOVERY_BACKOFF_CEILING_MS + 1));
  await driveUntil(workspace, 'the search never settled', () => searchSettled(workspace));

  expect(nodeCalls()).toBe(1);
});

test("a hire whose answer cannot commit tells its hirer its turn failed, once", async () => {
  const MISSION = 'Catalogue every file under the home directory.';
  const ASKED = 'Have someone check the ledger.';
  let workspace: StartedHarness | null = null;

  // Main hires a task agent for the mission, then says so; the hire's answer is refused as it commits.
  workspace = gatewayWorkspace(stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);

    if (tools.length === 0) return chatCompletion(run, '{"title":"Ledger Check"}');

    if (!JSON.stringify(messages).includes(ASKED)) {
      // The newest agent: the hire, which this call is.
      const hire = workspace?.db.query<{ storage_key: string }, []>('SELECT storage_key FROM workspace_actors ORDER BY rowid DESC LIMIT 1').get();

      if (hire !== null && hire !== undefined) failNextAnswerWrite(hire.storage_key);

      return chatCompletion(run, 'The ledger balances.');
    }

    return messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Handed off.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'task', lifetime: 'task', message: MISSION } }, 'hire_0');
  }));

  const id = crypto.randomUUID();
  const started = workspace;
  const told = () => relayedReports(started.db).filter((report) => report.includes('failed to run its assigned turn'));

  await started.agent.onMessage(owner, chatRequest(id, id, 'submit-message', ASKED));
  await driveUntil(started, "the hire's hirer was never told its turn failed", () => told().length > 0);
  await started.agent.harnessAgentsIdle();

  expect(told()).toHaveLength(1);
});

test("the owner's inspector reads main's step output where main's turns now run, its own isolate", async () => {
  const { workspace } = answering();
  const id = crypto.randomUUID();

  await workspace.agent.onMessage(owner, chatRequest(id, id, 'submit-message'));
  await workspace.agent.harnessAgentsIdle();

  const [run] = (await workspace.agent.getRunSummaries()).items;
  const step = (await workspace.agent.getRunEvents(run?.runId ?? '')).find((event) => event.type === 'step_finish');
  const read = await workspace.agent.inspectSubagent({ path: [], view: 'step', runId: run?.runId ?? '', eventIndex: step?.eventIndex ?? -1 });

  expect(read).toMatchObject({ view: 'step', runId: run?.runId, eventIndex: step?.eventIndex });
});
