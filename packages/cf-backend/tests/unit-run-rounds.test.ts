/**
 * A delivered run's later rounds (#64): each round of a run its agent's isolate executes is a new claim, under a new
 * epoch, and the workspace admits that round's opening before any of its calls run. Driven as production drives it: the
 * owner's turn starts a one-node search through the main actor's `agents` tool, and every model call is the gateway's.
 */
import { expect, test } from 'bun:test';
import { OVERFLOW_RETRY_TEXT, TurnFences } from '@kinu.run/core';
import { wrapDatabase } from '@kinu.run/core/identity';
import { handClock } from '@kinu.run/test-utils';
import { agentSql, catalogTurn, gatewayWorkspace, type ActorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';
import {
  chatCompletion, openingOf, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun,
} from './helpers/platform-gateway';
import { SERVES_MS, serverBox } from './helpers/server-box';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const ASK = 'Find a way to speed up the parser.';

const TASK = 'Name one way to tokenize faster.';

/** The main actor starts a one-node search, then says so; `node` answers the node. */
function searching(node: (run: RecordedGatewayRun) => Response | Promise<Response>) {
  return stubAiBinding((run) => {
    if (!openingOf(run).includes(ASK)) return node(run);

    return requestOf(run).messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Searching.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'swarm', task: TASK, preset: 'ideate', branches: 1, depth: 1 } }, 'swarm_0');
  });
}

interface Opening { readonly epoch: number; readonly turnId: string }

/** What the workspace admits as the node's current opening (its epoch), and the node's own claim that is running. */
interface NodeOpenings {
  admitted(): number | null;
  running(): Opening | null;
}

function openings(workspace: ActorHarness<HarnessOrchestratorAgent>): NodeOpenings {
  const node = (): string => {
    const seat = workspace.db.query<{ actor_id: string }, []>("SELECT actor_id FROM workspace_actors WHERE origin = 'swarm'").get();

    if (seat === null) throw new Error('the search registered no node');

    return seat.actor_id;
  };

  return {
    admitted: (): number | null => new TurnFences(wrapDatabase(workspace.db).sql).row(node())?.seq ?? null,
    running: (): Opening | null => agentSql(workspace, node())<{ epoch: number; turn_id: string }>`
      SELECT epoch, turn_id FROM actor_turn_claims WHERE outcome IS NULL ORDER BY epoch DESC LIMIT 1`
      .map((row) => ({ epoch: row.epoch, turnId: row.turn_id }))[0] ?? null,
  };
}

test("a node's round its context overflowed is retried under the retry's own opening", async () => {
  const seen: { admitted: number | null; running: Opening | null }[] = [];
  let read: NodeOpenings | null = null;

  const gateway = searching((run) => {
    const retried = JSON.stringify(requestOf(run).messages).includes(OVERFLOW_RETRY_TEXT);

    if (!retried) {
      return Response.json({ error: { message: 'prompt is too long: 213432 tokens > 200000 maximum', type: 'invalid_request_error' } }, { status: 400 });
    }

    if (read !== null) seen.push({ admitted: read.admitted(), running: read.running() });

    return chatCompletion(run, 'Cache the token table.');
  });

  const workspace = gatewayWorkspace(gateway);
  read = openings(workspace);

  await catalogTurn(workspace.agent, ASK);
  await workspace.agent.harnessJoinDetachedFibers();

  // The retry ran as a round of its own, and the workspace admitted that round's opening, not the overflowed one's.
  expect(seen).toHaveLength(1);
  expect(seen[0]?.running?.turnId).toContain('#');
  expect(seen[0]?.admitted).toBe(seen[0]?.running?.epoch ?? null);
  expect(workspace.db.query<{ status: string }, []>('SELECT status FROM head_journal').get()?.status).toBe('completed');
});

/** The words a model call was asked last, without the runtime state blocks the turn adds. */
function lastAsked(run: RecordedGatewayRun): string {
  const asked = requestOf(run).messages
    .filter((message) => message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context'));

  return JSON.stringify(asked.at(-1)?.content ?? '');
}

test("a node woken by its own job's settle runs its next round under that round's own opening", async () => {
  const clock = handClock(Date.now());
  const seen: { admitted: number | null; running: Opening | null }[] = [];
  let read: NodeOpenings | null = null;
  const readBack = Promise.withResolvers<void>();

  // The node starts the server, which outruns its call's window into a job; woken by the job's settle, it notes it.
  const gateway = searching((run) => {
    if (!lastAsked(run).includes(TASK)) {
      if (read !== null) seen.push({ admitted: read.admitted(), running: read.running() });

      return chatCompletion(run, 'The server ran and exited.');
    }

    if (!requestOf(run).messages.some((message) => message.role === 'tool')) {
      return toolCallCompletion(run, { tool: 'shell', args: { command: 'node server.js', runtime: 'sandbox' } }, 'call_server');
    }

    readBack.resolve();

    return chatCompletion(run, 'The server is running in the background.');
  });

  const box = serverBox(clock);
  const workspace = gatewayWorkspace(gateway, { container: true, box: () => box, jobClock: clock, previewHostSuffix: 'preview.test' });
  // The owner's egress vault is read before a sandbox command runs.
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  read = openings(workspace);

  // Its agents rest only once the node's run ends, which its job keeps open: the clock is moved first.
  const turn = catalogTurn(workspace.agent, ASK);
  // The call's window, armed ahead of the box reaching the command, lapses while the server runs: the call is the
  // node's job now, and its round ends.
  await box.served(1);
  clock.tick();
  await readBack.promise;

  // The server exits: its job settles, and the settle is the node's next round.
  clock.advance(SERVES_MS);
  await turn;
  await workspace.agent.harnessJoinDetachedFibers();

  expect(seen).toHaveLength(1);
  expect(seen[0]?.running?.turnId).toContain('#');
  expect(seen[0]?.admitted).toBe(seen[0]?.running?.epoch ?? null);
  expect(workspace.db.query<{ status: string }, []>('SELECT status FROM head_journal').get()?.status).toBe('completed');
});
