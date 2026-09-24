/**
 * A search as production runs one: the owner's turn starts it through the main actor's `agents` tool and its
 * nodes run to completion. Every model call is the platform gateway's.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import {
  chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun,
} from './helpers/platform-gateway';

const ASK = 'Find two ways to speed up the parser.';

/** What the search's nodes are assigned: never the owner's words, so a node's request is told apart. */
const TASK = 'Name one way to make tokenizing faster.';

/** The main actor's requests open with the owner's words; a node's open with its own assignment. */
function fromTheOwner(run: RecordedGatewayRun): boolean {
  const opening = requestOf(run).messages.find((message) => message.role === 'user');

  return JSON.stringify(opening?.content ?? '').includes(ASK);
}

/** How many tool results a request already carries: the step the model is on. */
function stepOf(run: RecordedGatewayRun): number {
  return requestOf(run).messages.filter((message) => message.role === 'tool').length;
}

/** The main actor starts one two-node search, then says so; `node` answers every node request. */
function searching(node: (run: RecordedGatewayRun) => Response) {
  return stubAiBinding((run) => {
    if (!fromTheOwner(run)) return node(run);

    return stepOf(run) === 0
      ? toolCallCompletion(run, {
        tool: 'agents', args: { action: 'swarm', task: TASK, preset: 'ideate', branches: 2, depth: 1 },
      }, 'swarm_0')
      : chatCompletion(run, 'Searching.');
  });
}

const SettledSearchSchema = v.object({
  report: v.object({ expansions: v.number(), tokens: v.number() }),
});

/** Defends: a search's calls missing from spend because the swarm was built with no sink. */
test("a search's node calls are billed to the workspace's spend", async () => {
  const { agent, db } = gatewayWorkspace(searching((run) => chatCompletion(run, 'Cache the token table between passes.')));

  await catalogTurn(agent, ASK);
  await agent.harnessJoinDetachedFibers();

  const job = db.query<{ result: string }, []>("SELECT result FROM background_jobs WHERE kind = 'agents'").get();

  if (job === null) throw new Error('the search left no job row');
  const settled = v.parse(SettledSearchSchema, JSON.parse(job.result));
  const swarm = (await agent.getActivitySnapshot()).spend.producers.find((producer) => producer.source === 'swarm');

  expect(settled.report.expansions).toBe(2);
  expect(swarm?.calls).toBe(settled.report.expansions);
  expect((swarm?.usage.input ?? 0) + (swarm?.usage.output ?? 0)).toBe(settled.report.tokens);
});

/** Defends: a node offered `eval` that refuses as unconfigured, and no `web`, because the swarm was built without either. */
test('a search node runs code and is offered the web', async () => {
  const gateway = searching((run) => (stepOf(run) === 0
    ? toolCallCompletion(run, { tool: 'eval', args: { code: 'return 6 * 7;' } }, 'eval_0')
    : chatCompletion(run, 'Computed.')));

  const { agent } = gatewayWorkspace(gateway);

  await catalogTurn(agent, ASK);
  await agent.harnessJoinDetachedFibers();

  const nodes = gateway.runs.filter((run) => !fromTheOwner(run)).map(requestOf);
  const opening = nodes.find((request) => !request.messages.some((message) => message.role === 'tool'));
  const answered = nodes.find((request) => request.messages.some((message) => message.role === 'tool'));

  expect(opening?.tools).toEqual(expect.arrayContaining(['eval', 'web']));
  expect(JSON.stringify(answered?.messages.filter((message) => message.role === 'tool'))).toContain('42');
});
