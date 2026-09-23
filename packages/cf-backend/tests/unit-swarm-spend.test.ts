/**
 * Defends: a search's model calls missing from the workspace's spend because the swarm was built with no sink.
 * The owner's turn starts a search through the main actor's `agents` tool, its nodes run to completion, and
 * the spend the owner reads bills what the search reports it cost. Every model call is the platform gateway's.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { catalogTurn, gatewayWorkspace } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';

const ASK = 'Find two ways to speed up the parser.';

/** The main actor's requests open with the owner's words; a node's open with its own assignment. */
function fromTheOwner(run: RecordedGatewayRun): boolean {
  const opening = requestOf(run).messages.find((message) => message.role === 'user');

  return JSON.stringify(opening?.content ?? '').includes(ASK);
}

const SettledSearchSchema = v.object({
  report: v.object({ expansions: v.number(), tokens: v.number() }),
});

test("a search's node calls are billed to the workspace's spend", async () => {
  const gateway = stubAiBinding((run) => {
    if (!fromTheOwner(run)) return chatCompletion(run, 'Cache the token table between passes.');
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    return step === 0
      ? toolCallCompletion(run, {
        tool: 'agents', args: { action: 'swarm', task: ASK, preset: 'ideate', branches: 2, depth: 1 },
      }, 'swarm_0')
      : chatCompletion(run, 'Searching.');
  });

  const { agent, db } = gatewayWorkspace(gateway);

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
