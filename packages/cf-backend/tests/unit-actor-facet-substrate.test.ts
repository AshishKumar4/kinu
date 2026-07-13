import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * The actor substrate's facet-feasibility contract (Wave A2 gate).
 *
 * A future SubordinateAgent runs as a FACET of the workspace DO via
 * `subAgent(SubordinateAgent, name)`. That requires, on the installed agents
 * SDK (verified against 0.14.1 dist):
 *   1. the class passed DIRECTLY to the Cloudflare facets API
 *      (`ctx.facets.get(..., () => ({ class: Cls, id }))`) after an
 *      exact-name lookup in the worker entry's `ctx.exports` — no wrangler
 *      DO binding needed for the child, only the export;
 *   2. schedule()/keepAlive()/runFiber() delegating to the root DO's single
 *      physical alarm slot (facets cannot arm their own);
 *   3. a `(ctx, env)` constructor — the SubAgentClass shape.
 * If an agents upgrade drops any of these, A2's subordinate design breaks —
 * fail here, not in production.
 */

const src = (p: string) => readFileSync(join(import.meta.dir, '..', 'src', p), 'utf8');
const agentsDist = readFileSync(
  createRequire(join(import.meta.dir, '..', 'package.json')).resolve('agents'),
  'utf8',
);

describe('actor substrate — facet feasibility contract', () => {
  test('the installed agents SDK delegates facet schedule/keepAlive/fibers to the root DO', () => {
    // Root-delegation seams (the stale "throw in facets" era is gone).
    expect(agentsDist).toContain('_cf_scheduleForFacet');
    expect(agentsDist).toContain('_cf_acquireFacetKeepAlive');
    expect(agentsDist).toContain('_cf_registerFacetRun');
  });

  test('subAgent constructs facets from the exported class via the facets API', () => {
    expect(agentsDist).toContain('async subAgent(');
    // Exact-name export lookup + direct class handoff — the mechanism that
    // lets ANY Agent subclass (Think included) run as a facet without a
    // wrangler binding.
    expect(agentsDist).toContain('ctx.exports');
    expect(agentsDist).toMatch(/facets\.get\(/);
  });

  test('the actor substrate satisfies the SubAgentClass shape', () => {
    const actor = src('actor-agent.ts');
    expect(actor).toContain('export abstract class ActorAgent extends Think<Env>');
    expect(actor).toContain('constructor(ctx: AgentContext, env: Env)');
    expect(src('orchestrator.ts')).toContain('export class OrchestratorAgent extends ActorAgent');
  });

  test('facet classes are exported by exact name from the worker entry', () => {
    const server = src('server.ts');
    // ctx.exports resolves classes by their EXPORT name; a facet class that
    // is not exported (or re-exported under another name) cannot spawn.
    expect(server).toMatch(/export \{ OrchestratorAgent \}/);
    expect(server).toMatch(/export \{ ExplorationAgent \}/);
  });
});
