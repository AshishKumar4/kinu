import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';
import { mockAgentsSdk } from './helpers/agents-sdk';

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
 *
 * The first two tests read the installed SDK's dist because the mechanism
 * being pinned is THEIRS and is not reachable under bun (`ctx.facets` is
 * workerd-only). Everything below them is our own substrate, so it is
 * observed on real instances instead.
 */

const agentsDist = readFileSync(
  createRequire(join(import.meta.dir, '..', 'package.json')).resolve('agents'),
  'utf8',
);

mockAgentsSdk();
// Dynamic on purpose, exactly as tests/helpers/actor-harness.ts:26-29 does: the
// real `agents` dist reaches `cloudflare:*`, so the SDK mock must be registered
// before these modules evaluate, and a static import would hoist above it.
const { ActorAgent } = await import('../src/actor-agent');
const { OrchestratorAgent } = await import('../src/orchestrator');
const { SubordinateAgent } = await import('../src/subordinate-agent');
const { ExplorationAgent } = await import('../src/exploration');
const { Think } = await import('@cloudflare/think');
const { EXPLORATION_RPC_SURFACE } = await import('../src/rpc-surface');
const entry = await import('../src/server');

/** The three classes `ctx.exports` must resolve for a facet to spawn: the
 *  name the lookup uses, the class itself, and the worker entry's binding
 *  under that exact name. */
const FACET_CLASSES = [
  ['OrchestratorAgent', OrchestratorAgent, entry.OrchestratorAgent],
  ['ExplorationAgent', ExplorationAgent, entry.ExplorationAgent],
  ['SubordinateAgent', SubordinateAgent, entry.SubordinateAgent],
] as const;

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
    // `SubAgentClass<T> = { new (ctx, env): T }` — every class the facets API
    // may be handed takes exactly the two arguments it passes. Read off the
    // constructors themselves and off instances the harness builds by CALLING
    // them with those two arguments; a signature in the source could say
    // anything, this is the invocation workerd would make.
    for (const [, Cls] of FACET_CLASSES) {
      expect(Cls.length).toBe(2);
    }
    // ExplorationAgent is a plain Agent; the two subordinate-tree roots are the
    // ones that inherit the substrate, and ActorAgent is a Think directly —
    // which is what makes a Think-based chat agent runnable as a facet at all.
    expect(Object.getPrototypeOf(ActorAgent)).toBe(Think);
    for (const Cls of [OrchestratorAgent, SubordinateAgent]) {
      expect(Cls.prototype).toBeInstanceOf(ActorAgent);
    }
    expect(orchestratorHarness().agent).toBeInstanceOf(OrchestratorAgent);
    expect(subordinateHarness().agent).toBeInstanceOf(SubordinateAgent);
  });

  test('ExplorationAgent stays a bare facet with the parent-bootstrap RPC', () => {
    expect(Object.getPrototypeOf(ExplorationAgent).name).toBe('Agent');
    expect(ExplorationAgent.prototype.setSharedParent).toBeDefined();
    expect(EXPLORATION_RPC_SURFACE).toContain('setSharedParent');
  });

  test('facet classes are exported by exact name from the worker entry', () => {
    // ctx.exports resolves classes by their EXPORT name; a facet class that
    // is not exported (or re-exported under another name) cannot spawn. So
    // the binding must be present AND be the very class whose `.name` the
    // lookup key is built from — identity, not merely "something is exported".
    for (const [name, Cls, exported] of FACET_CLASSES) {
      expect(exported).toBe(Cls);
      expect(Cls.name).toBe(name);
    }
  });

  test('the parent facet gate admits only active, registered subordinate facets', async () => {
    // The gate is ActorAgent's, because a subordinate is now on both sides of
    // the relationship: it hires facets of its own, so it needs the same gate its
    // parent has. The class it admits comes from `subordinateFacet()` rather than
    // a named import, which is how the base class avoids importing its subclass.
    for (const Cls of [OrchestratorAgent, SubordinateAgent]) {
      expect(Object.getOwnPropertyDescriptor(Cls.prototype, 'onBeforeSubAgent')).toBeUndefined();
      expect(Cls.prototype.onBeforeSubAgent).toBe(ActorAgent.prototype.onBeforeSubAgent);
    }

    const { agent } = orchestratorHarness();
    const request = new Request('https://workspace.invalid/agents/orchestrator-agent/w/sub-agent');
    const reach = (className: string, name: string) =>
      agent.onBeforeSubAgent(request, { className, name });
    const roster = agent.harnessRoster();
    const hire = (name: string) => roster.create({
      name,
      createdBy: 'orchestrator',
      status: 'idle',
      currentTask: null,
      createdAt: 1,
      dismissedAt: null,
      lifetime: 'durable',
      taskEventId: null,
    });

    // Rostered, hired as a facet: the one combination that passes through.
    hire('aria');
    await agent.subAgent(SubordinateAgent, 'aria');
    expect(await reach('SubordinateAgent', 'aria')).toBe(request);

    // A class that is not this actor's subordinate facet. Registered under
    // that class name AND rostered under that facet name, so nothing but the
    // class check itself stands between it and the pass-through — the
    // orchestrator's own class included, because "is an actor" is not the
    // question the gate asks.
    await agent.subAgent(OrchestratorAgent, 'aria');
    expect(agent.hasSubAgent(OrchestratorAgent.name, 'aria')).toBe(true);
    for (const className of ['OrchestratorAgent', 'ExplorationAgent', 'Agent']) {
      expect(await reach(className, 'aria')).toMatchObject({ status: 404 });
    }

    // Registered as a facet but never rostered, and rostered but never
    // registered: each half alone must be refused.
    await agent.subAgent(SubordinateAgent, 'ghost');
    expect(await reach('SubordinateAgent', 'ghost')).toMatchObject({ status: 404 });
    hire('paper');
    expect(await reach('SubordinateAgent', 'paper')).toMatchObject({ status: 404 });

    // Dismissal revokes reachability while both the roster row and the facet
    // registration survive — the case a "does it exist?" gate would admit.
    await agent.subAgent(SubordinateAgent, 'dismissed-one');
    hire('dismissed-one');
    expect(await reach('SubordinateAgent', 'dismissed-one')).toBe(request);
    roster.dismiss('dismissed-one', 2);
    expect(roster.get('dismissed-one')?.status).toBe('dismissed');
    expect(agent.hasSubAgent(SubordinateAgent.name, 'dismissed-one')).toBe(true);
    expect(await reach('SubordinateAgent', 'dismissed-one')).toMatchObject({ status: 404 });

    // Still reachable is still reachable: dismissing one facet revokes one.
    expect(await reach('SubordinateAgent', 'aria')).toBe(request);
  });
});
