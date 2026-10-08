/**
 * An agent in its own isolate shares the workspace's one file plane: what it writes in its home through Nimbus's
 * session surface, the workspace reads and `cat`s. Slice 5's check (kinu-logs/design/SUBAGENTS.md).
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import * as v from 'valibot';
import { CHILD_ANSWER } from './hire-shapes';

it('an agent in its own isolate writes a file the workspace reads and cats', async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('agent-facet'));
  const seen = await probe.onePlane('agent-facet-workspace', 'scout');

  expect(seen.sameIsolate).toBe(false);
  expect(seen.agentShell.exitCode).toBe(0);
  expect(seen.agentShell.stdout.split('\n')[0]).toBe(seen.home);
  expect(seen.agentShell.stdout.split('\n')[1]).not.toBe('1000');
  expect(seen.mainRead).toBe('written by the agent');
  expect(seen.mainCat).toMatchObject({ exitCode: 0, stdout: 'written by the agent' });
});

const SwarmFacetSchema = v.object({
  actorId: v.string(), home: v.string(), sameIsolate: v.boolean(), workspaceClaims: v.number(),
  claims: v.array(v.object({ actorId: v.string(), turnId: v.string(), outcome: v.nullable(v.string()), programKind: v.string() })),
  retired: v.boolean(), summary: v.string(), candidate: v.string(), reportedItself: v.boolean(),
});

it('a swarm node runs its inherited loop and keeps its completed claim in its own facet', async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('swarm-facet'));
  const seen = v.parse(SwarmFacetSchema, await new Response(await probe.swarmNode('swarm-facet-workspace')).json());

  expect(seen.summary).toBe(CHILD_ANSWER);
  expect(seen.sameIsolate).toBe(false);
  expect(seen.workspaceClaims).toBe(0);
  expect(seen.claims).toEqual([{ actorId: seen.actorId, turnId: 'facet-node', outcome: 'completed', programKind: 'scaffold' }]);
  expect(seen.candidate).toBe(seen.home);
  expect(seen.reportedItself).toBe(true);
  expect(seen.retired).toBe(true);
});

it("a tool main crafted is callable from a swarm node's eval, and main's score retires it there too", async () => {
  // Crafted tools are the workspace's (`crafted_tools` has no actor): a node's eval reads main's rows and scores.
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('crafted-node'));
  const seen = await probe.craftedFromNode('crafted-node-workspace');

  expect(seen.nodeActorId).not.toBe(seen.mainActorId);
  expect(JSON.parse(seen.called)).toMatchObject({ result: 42 });
  expect(seen.retired).toContain('double');
});

// job.context_silence_ms bounds how long a live job's context may leave its probe unanswered: the probe waits for its
// object's one thread and nothing else, so under load it is late by the CPU queued ahead of it, never more.
it("a running job's probe under queued CPU-bound invocations answers once the work ahead of it has run", async () => {
  const probe = env.AGENT_FACET_PROBE.get(env.AGENT_FACET_PROBE.idFromName('probe-contention'));
  const seen = await probe.probeUnderLoad('probe-contention', QUEUED_BURNS, BURN_ITERATIONS);
  const worstQuiet = Math.max(...seen.quiet);

  const worstLoaded = Math.max(...seen.loaded);

  // The load held the thread for about its CPU, and a probe sent into it waited behind work queued ahead of it.
  expect(seen.loadedMs).toBeGreaterThanOrEqual(QUEUED_BURNS * seen.burnMs / 2);
  expect(worstLoaded).toBeGreaterThan(worstQuiet + seen.burnMs);
  // It waited for that work and nothing else: never past the load's own end.
  expect(worstLoaded).toBeLessThanOrEqual(seen.loadedMs + worstQuiet);
});

/** Forty invocations of a few tens of milliseconds of CPU each, queued on one object at once. */
const QUEUED_BURNS = 40;

const BURN_ITERATIONS = 20_000_000;
