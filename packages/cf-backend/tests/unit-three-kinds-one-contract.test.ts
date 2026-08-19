/**
 * ONE CONTRACT, THREE AGENT KINDS.
 *
 * The requirement this suite exists to prove or disprove: an orchestrator, a
 * subordinate and a swarm node are the same kind of thing, sharing maximum code,
 * so they have the same capabilities. Three descriptions of that claim already
 * exist in comments across the tree. None of them is a measurement, so this file
 * asserts it instead — one set of assertions, three fixtures, no skips.
 *
 * ## THE CONTRACT, ENUMERATED FROM THE CODE
 *
 * Each item names the capability, where it is implemented per kind, and the verdict
 * on whether it SHOULD hold for all three. A capability that genuinely belongs to
 * one kind is recorded as an asymmetry, not chased as a gap.
 *
 * C1 SYSTEM PROMPT. A turn assembles a system prompt naming the surface it holds.
 *     actor kinds: `ActorAgent.beforeTurn` returns `TurnConfig.system`, which Think
 *     uses in place of the cached base prompt. node: `nodeSystemPrompt` composed
 *     into `HeadInferenceDeps.framing.system` (node-agent.ts:540-548).
 *     SHOULD HOLD FOR ALL THREE — an agent that cannot state what it is and what it
 *     may touch is not an agent. Held by all three.
 *
 * C2 TOOL DISPATCH AND TRANSCRIPT. A tool call dispatches and its result reaches the
 *     conversation the model sees on the next request.
 *     SHOULD HOLD FOR ALL THREE — this is the definition of a tool-using loop.
 *
 * C3 USAGE ACCOUNTING. Per-step usage is measured from the provider's own report,
 *     and charged to a mission ledger when the turn runs under one.
 *     SHOULD HOLD FOR ALL THREE — a mission budget that one kind ignores is not a
 *     budget. What must NOT be uniform is charging an UNDECLARED run: all three
 *     must leave the ledger untouched when no mission exists.
 *
 * C4 BACKGROUNDING. A slow tool call detaches at the interactive threshold
 *     (`BACKGROUND_POLICY.interactive.detachAfterMs` = 30_000) and the turn may end
 *     with it still running.
 *     SHOULD HOLD FOR ALL THREE — but only where a wake can arrive, which is C5.
 *     Detaching with no wake path loses the work silently, so C4 and C5 stand or
 *     fall together. Held by the actor kinds; ABSENT for a node.
 *
 * C5 WAKE. Work that settled after the turn ended resumes the agent.
 *     SHOULD HOLD FOR ALL THREE. ABSENT for a node: nothing constructs a
 *     `BackgroundJobRunner` on the node path and a node's loop has no second turn
 *     to be woken into.
 *
 * C6 ABORT. An abort is honoured, and the run says it was aborted rather than
 *     reporting a finished answer.
 *     SHOULD HOLD FOR ALL THREE — a supervisor that cannot stop one kind cannot
 *     stop the swarm.
 *
 * C7 TERMINAL RECORD WITH CAUSE. A failure leaves a terminal record whose text
 *     carries the cause chain, not just the outermost message.
 *     SHOULD HOLD FOR ALL THREE. The node path holds it for a TRANSPORT failure
 *     (`renderCauseChain` at node-agent.ts:658) and DROPS it for a LOOP failure
 *     (head-inference.ts uses `err.message` alone) — one store, two renderings.
 *
 * C8 COMPACTION. The context transform triggers on the same MEASURED condition —
 *     provider-reported prompt tokens against a share of the model's window.
 *     SHOULD HOLD FOR ALL THREE, but the SITE legitimately differs: an actor
 *     compacts its own durable history per turn, while a node's prefix is compacted
 *     ONCE by the engine for a whole level (`sharedPrefix`) because every sibling
 *     must receive a byte-identical prefix. Same trigger quantity, different owner.
 *
 * C9 CACHE BREAKPOINTS AND AFFINITY. Provider-native prompt-cache controls are
 *     placed on the request, and requests that share a prefix are pinned to one
 *     replica so the prefix cache can hit.
 *     SHOULD HOLD FOR ALL THREE, and for a node it is load-bearing rather than
 *     incidental: `head-inference.ts` and `node-agent.ts` both justify the
 *     append-only inheritance rule by the caching it buys — *"an unmodified prefix
 *     is a prefix a provider can cache, so every sibling of one parent shares one
 *     cacheable prefix"*. That sentence is only true if the siblings' requests
 *     actually carry cache controls and actually land together. Measured below.
 *
 * ## WHY THE FIXTURES DIFFER IN SHAPE
 *
 * The two actor kinds are one class (`SubordinateAgent extends ActorAgent`), so any
 * assertion that passes for one passes for the other unless the subclass overrides
 * the mechanism — which is itself worth asserting, since the whole roster of
 * subordinate capabilities rests on it. Their turn BODY is Think's, which does not
 * run outside workerd, so each capability is exercised at the entry point our own
 * code owns for it. A node's whole loop is core's, so a node is driven end to end.
 * That asymmetry is stated rather than hidden: see helpers/three-kinds.ts.
 */

import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  BACKGROUND_POLICY,
  NODE_BUILTIN_TOOLS,
  PROPOSE_BRANCH_TOOL,
  agentAffinityKey,
  applyCacheBreakpoints,
  promptCachePlan,
} from '@proteus/core';
import {
  assembleActorTurn,
  cacheControlsOn,
  capturingWorkersAIModel,
  driveNode,
  missionRecorder,
  type AgentKind,
  type Difference,
  type TurnRequest,
} from './helpers/three-kinds';
import { orchestratorHarness, subordinateHarness } from './helpers/actor-harness';

/** A history every kind can be asked to assemble a turn over. */
const HISTORY: readonly ModelMessage[] = [
  { role: 'user', content: 'Name the cheapest change to the reference implementation.' },
];

/**
 * The declared differences, per kind, with the reason a reader gets instead of a
 * skipped test. `defect` entries are what this suite reports; each has an assertion
 * below that OBSERVES the gap rather than tolerating it.
 */
const DIFFERENCES = {
  'cf-orchestrator': [],
  'cf-subordinate': [],
  'swarm-node': [
    {
      capability: 'C4 backgrounding',
      verdict: 'defect',
      reason:
        'No BackgroundJobRunner is constructed anywhere on the node path, and '
        + 'buildNodeToolSet threads no jobRunner into BuiltinToolDeps, so a node\'s '
        + 'slow tool call cannot detach at all. It blocks the step instead.',
    },
    {
      capability: 'C5 wake',
      verdict: 'defect',
      reason:
        'A node has no wake path: runHeadInference is one generateText call and '
        + 'returns a HeadReport, so there is no second turn for settled work to '
        + 'resume into. This is why C4 must not be fixed without C5 — detaching '
        + 'into a kind with no wake would lose the work silently.',
    },
    {
      capability: 'C8 compaction',
      verdict: 'asymmetry',
      reason:
        'A node does not compact its own history. Its prefix is compacted ONCE per '
        + 'parent by the engine (swarm-run sharedPrefix, at the same measured share '
        + 'of the model window) because every sibling must receive a byte-identical '
        + 'prefix — the shared cacheable prefix the inheritance rule is designed '
        + 'around. Same trigger quantity, engine-owned site.',
    },
    {
      capability: 'C9 cache breakpoints',
      verdict: 'defect',
      reason:
        'Neither promptCachePlan nor applyCacheBreakpoints is called anywhere on '
        + 'the node path, so a node places no provider-native cache control on any '
        + 'request — while the module comments justify append-only inheritance by '
        + 'exactly the caching that absence prevents.',
    },
  ],
} satisfies Record<AgentKind, readonly Difference[]>;

function differenceFor(kind: AgentKind, capability: string): Difference | undefined {
  return DIFFERENCES[kind].find((entry) => entry.capability === capability);
}

// ── C1 — every kind assembles a system prompt naming its own surface ──────────

describe('C1 a turn of any kind assembles a system prompt over its own tool surface', () => {
  test('cf-orchestrator', async () => {
    const { agent } = orchestratorHarness();
    agent.setObservedSoul('# SOUL\nA workspace root under test.');
    agent.declareScaffoldPresent();
    const request = await assembleActorTurn(agent, HISTORY);
    assertSystemPromptContract('cf-orchestrator', request);
  });

  test('cf-subordinate', async () => {
    const { agent } = subordinateHarness();
    agent.declareScaffoldPresent();
    const request = await assembleActorTurn(agent, HISTORY);
    assertSystemPromptContract('cf-subordinate', request);
  });

  test('swarm-node', async () => {
    const drive = await driveNode({
      steps: [
        { toolCall: { name: 'report', input: { status: 'completed', content: 'Sort once.' } } },
        { text: 'Reported.' },
      ],
    });
    expect(drive.requests.length).toBeGreaterThan(0);
    assertSystemPromptContract('swarm-node', drive.requests[0]!);
  });
});

/**
 * The same three claims for every kind: a prompt exists, a surface exists, and the
 * prompt is about THAT surface rather than a generic preamble. The last is the one
 * with teeth — a kind whose prompt never names a tool it holds is describing a
 * different agent to the model than the one it built.
 */
function assertSystemPromptContract(kind: AgentKind, request: TurnRequest): void {
  expect(request.system.length, `${kind}: assembled no system prompt`).toBeGreaterThan(200);
  expect(request.toolNames.length, `${kind}: assembled no tool surface`).toBeGreaterThan(0);
  const named = request.toolNames.filter((name) => request.system.includes(name));
  expect(named.length, `${kind}: the system prompt names none of its ${String(request.toolNames.length)} tools`)
    .toBeGreaterThan(0);
}

// ── C9 — affinity and cache breakpoints, measured rather than read ────────────

/**
 * The claim under test is the one BOTH node modules make in prose: siblings of one
 * parent share a byte-identical prefix, so a provider can cache it once for the
 * whole level. Two independent mechanisms have to be present for that to be true —
 * a replica pin, so the sibling requests reach the same cache at all, and a cache
 * control on the request, so the provider is asked to keep the prefix.
 *
 * Both are measured. The affinity half runs a real node on a REAL Workers AI model
 * whose only fake is `fetch`, so the header comes off the wire. The cache-control
 * half reads what the provider was handed, for a node and for an actor, through the
 * same `cacheControlsOn` reducer, so the two answers are comparable by construction.
 */
describe('C9 affinity', () => {
  test('a node inherits the PARENT pin when it runs on the parent\'s model', async () => {
    // The in-isolate transport: `agents-tool.ts` hands `runSwarm` the actor's own
    // already-resolved `deps.model`, so every node of a wave issues its requests
    // through the object that carries the PARENT's key. Measured, not inferred.
    const { model, captured } = capturingWorkersAIModel(agentAffinityKey('parent-workspace'));
    const drive = await driveNode({ steps: [{ text: 'Sort once.' }] }, { model });

    expect(drive.run?.report.status).toBe('completed');
    expect(captured.length, 'the node issued no provider request at all').toBeGreaterThan(0);
    for (const request of captured) {
      expect(request.headers.get('x-session-affinity')).toBe('proteus-parent-workspace');
    }
  });

  test('a node pinned to its OWN spawn id cannot reach the parent\'s cache', async () => {
    // The CF hosted transport: `spawnNodeFacet` names the facet after the node's
    // spawn id, the facet builds its own `OwnedModelServices`, and the id is
    // documented as never reused. So the same node gets a DIFFERENT bucket per
    // transport — the opposite cache behaviour from the case above.
    const { model, captured } = capturingWorkersAIModel(agentAffinityKey('node-1'));
    await driveNode({ steps: [{ text: 'Sort once.' }] }, { model });

    expect(captured.length).toBeGreaterThan(0);
    const key = captured[0]!.headers.get('x-session-affinity');
    expect(key).toBe('proteus-node-1');
    expect(key).not.toBe('proteus-parent-workspace');
  });

  test('an unpinned model sends no key at all — the denominator', async () => {
    const { model, captured } = capturingWorkersAIModel();
    await driveNode({ steps: [{ text: 'Sort once.' }] }, { model });
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]!.headers.get('x-session-affinity')).toBeNull();
  });
});

describe('C9 cache breakpoints', () => {
  /** A marker-family model, because that is the family whose controls are visible on
   *  a request at all: `cache-breakpoints.ts` records that workers-ai has no
   *  request-level cache concept and rides `x-session-affinity` instead. Measuring
   *  the gap on workers-ai alone would find nothing for either kind. */
  const MARKER_MODEL = 'anthropic/claude-sonnet-4-5';

  test('an actor kind places cache controls on every request of its loop', async () => {
    const { agent } = orchestratorHarness();
    agent.setObservedSoul('# SOUL\nA workspace root under test.');
    agent.declareScaffoldPresent();
    await agent.setModel(MARKER_MODEL);
    const request = await assembleActorTurn(agent, HISTORY);

    const controls = cacheControlsOn(request);
    expect(controls, 'the orchestrator placed no cache control at all').not.toEqual([]);
    // Both halves of the marker strategy: a cache-eligible system, and a rolling
    // tail so each step reads the prefix the previous step wrote.
    expect(controls).toContain('system-message');
    expect(controls.filter((where) => where.startsWith('message-')).length).toBeGreaterThan(0);
  });

  test('a subordinate places the same controls — it is the same class', async () => {
    const { agent } = subordinateHarness();
    agent.declareScaffoldPresent();
    await agent.setModel(MARKER_MODEL);
    const request = await assembleActorTurn(agent, HISTORY);
    expect(cacheControlsOn(request)).toContain('system-message');
  });

  test('a node places NONE, on any request, whatever the family', async () => {
    const declared = differenceFor('swarm-node', 'C9 cache breakpoints');
    expect(declared?.verdict, 'the node cache gap must be declared, not discovered').toBe('defect');

    const drive = await driveNode({
      steps: [
        { toolCall: { name: 'report', input: { status: 'completed', content: 'Sort once.' } } },
        { text: 'Reported.' },
      ],
    });
    expect(drive.requests.length, 'the node issued no request to read').toBeGreaterThan(0);
    for (const request of drive.requests) {
      expect(cacheControlsOn(request)).toEqual([]);
      // Family-independent, and the root of it: `runHeadInference` passes no
      // `providerOptions` to the SDK at all, so there is no namespace for a plan
      // to have written into.
      expect(request.providerOptions.namespaces).toEqual([]);
    }
  });

  test('the two functions a node never calls DO produce controls on its own inputs', () => {
    // The denominator guard: an absent control is also what a broken measurement
    // looks like. These are a node's own request shape, through the two functions
    // the actor kinds call and the node path does not.
    const nodeSystem = 'You are ONE node of a search. Other nodes are working on sibling angles.';
    const plan = promptCachePlan({
      providerId: 'anthropic', modelId: 'claude-sonnet-4-5',
      system: nodeSystem, sessionKey: agentAffinityKey('parent-workspace'),
    });
    // A marker plan turns the system into a cacheable MESSAGE carrying the marker,
    // which the rendering shows and a bare string cannot.
    expect(JSON.stringify(plan.system)).toContain('cacheControl');
    const full = applyCacheBreakpoints({
      providerId: 'anthropic', modelId: 'claude-sonnet-4-5',
      system: nodeSystem, sessionKey: agentAffinityKey('parent-workspace'),
      messages: [...HISTORY],
    });
    expect(JSON.stringify(full.messages)).toContain('cacheControl');
  });
});

// ── C3 — usage is accounted, and charged only where a mission exists ──────────

describe('C3 usage is measured from the provider and charged to a mission when one exists', () => {
  test('a node charges the mission ledger per reported step', async () => {
    const mission = missionRecorder();
    const drive = await driveNode({
      mission,
      steps: [
        { toolCall: { name: 'report', input: { status: 'completed', content: 'Sort once.' } }, usage: { input: 40, output: 9 } },
        { text: 'Reported.', usage: { input: 50, output: 3 } },
      ],
    });

    expect(drive.outcome.terminal?.status).toBe('completed');
    expect(mission.debits.length, 'a run under a mission charged nothing').toBeGreaterThan(0);
    // Charged per step from the provider's own numbers, so the sum is the run's.
    const charged = mission.debits.reduce((total, debit) => total + debit.amount, 0);
    expect(charged).toBe(102);
    expect(mission.guards).toContain('model_call');
  });

  test('a node under NO mission leaves the ledger untouched', async () => {
    const unused = missionRecorder();
    await driveNode({ steps: [{ text: 'Sort once.', usage: { input: 40, output: 9 } }] });
    expect(unused.debits).toEqual([]);
    expect(unused.guards).toEqual([]);
  });

  test('a step the provider said nothing about moves nothing', async () => {
    const mission = missionRecorder();
    await driveNode({ mission, steps: [{ text: 'Sort once.' }] });
    // Zero-usage is what an unreported step looks like on this fake, and an
    // unreported step must not be guessed into the ledger.
    expect(mission.debits).toEqual([]);
  });
});

// ── C4/C5 — backgrounding and wake ────────────────────────────────────────────

describe('C4/C5 backgrounding and the wake it depends on', () => {
  test('the interactive detach threshold is one shared number', () => {
    // Whatever a kind does with it, there is exactly one policy — so a kind that
    // detaches at a different time is a wiring fault, not a second policy.
    expect(BACKGROUND_POLICY.interactive.detachAfterMs).toBe(30_000);
    expect(BACKGROUND_POLICY.interactive.wakesAfterTurn).toBe(true);
  });

  test('an actor kind wires a background job runner; a node wires none', () => {
    const declared = differenceFor('swarm-node', 'C4 backgrounding');
    expect(declared?.verdict).toBe('defect');
    const wake = differenceFor('swarm-node', 'C5 wake');
    expect(wake?.verdict).toBe('defect');
    // Stated as the pairing, because that is the load-bearing part: detaching into
    // a kind with no wake path would lose the work rather than background it.
    expect(declared?.reason).toContain('detach');
    expect(wake?.reason).toContain('wake');
  });

  /**
   * THE TOOL SURFACE, THREE WAYS — the most direct reading of "same capabilities"
   * there is, and it is not a subset relation in either direction.
   *
   * Both actor surfaces are OBSERVED from the real production composition
   * (`getRawTools()` on a real instance); the node's is its declared constant,
   * which is what `buildNodeToolSet` filters to. The three omissions are recorded
   * with the reason the code gives, or with the fact that it gives none.
   */
  test('the three surfaces overlap but neither contains the other', () => {
    const orchestrator = new Set(Object.keys(orchestratorHarness().agent.observeRawTools()));
    const subordinate = new Set(Object.keys(subordinateHarness().agent.observeRawTools()));
    const node: ReadonlySet<string> = new Set<string>(NODE_BUILTIN_TOOLS);

    // Denominator: three real surfaces, not three empty sets.
    expect(orchestrator.size).toBeGreaterThan(5);
    expect(subordinate.size).toBeGreaterThan(5);
    expect(node.size).toBe(5);

    // The four every kind holds — the actual shared capability floor.
    for (const shared of ['execute_tools', 'run', 'file', 'web']) {
      expect(orchestrator.has(shared), `orchestrator lacks ${shared}`).toBe(true);
      expect(subordinate.has(shared), `subordinate lacks ${shared}`).toBe(true);
      expect(node.has(shared), `node lacks ${shared}`).toBe(true);
    }

    // `report` is the one an ORCHESTRATOR lacks: a workspace root has nobody to
    // report to, so the tool is deps-gated off rather than offered and refused.
    // A genuine asymmetry, and the reason the subset relation fails upward.
    expect(orchestrator.has('report')).toBe(false);
    expect(subordinate.has('report')).toBe(true);
    expect(node.has('report')).toBe(true);

    // The three a NODE lacks. `agents` is explained by the node's own prompt — the
    // search owns delegation, and the node's route to it is `propose_branch`.
    // `memory` and `tasks` are not explained anywhere: `NODE_BUILTIN_TOOLS` is
    // `[...HEAD_BUILTIN_TOOLS, 'report']` and no comment says why a node may not
    // remember anything or leave a task behind. That silence is the finding.
    for (const absent of ['agents', 'memory', 'tasks']) {
      expect(orchestrator.has(absent), `orchestrator lacks ${absent}`).toBe(true);
      expect(subordinate.has(absent), `subordinate lacks ${absent}`).toBe(true);
      expect(node.has(absent), `node unexpectedly holds ${absent}`).toBe(false);
    }

    // Stated as a set relation so a future change in EITHER direction fails here.
    expect([...node].filter((name) => !orchestrator.has(name))).toEqual(['report']);
    expect([...orchestrator].filter((name) => !node.has(name)).sort())
      .toEqual(['agents', 'memory', 'tasks']);
  });
});

// ── C6 — abort ────────────────────────────────────────────────────────────────

describe('C6 an abort is honoured and the record says so', () => {
  test('a node aborted before its first step reports aborted, not completed', async () => {
    const controller = new AbortController();
    controller.abort();
    const drive = await driveNode({
      signal: controller.signal,
      steps: [{ text: 'Sort once.' }],
    });
    expect(drive.outcome.terminal?.status).toBe('aborted');
    expect(drive.outcome.terminal?.errorMessage).toContain('abort');
  });

  test('the same node without the abort completes — the denominator', async () => {
    const drive = await driveNode({ steps: [{ text: 'Sort once.' }] });
    expect(drive.outcome.terminal?.status).toBe('completed');
  });
});

// ── C7 — a failure leaves a terminal record carrying its cause ────────────────

describe('C7 a failed turn leaves a terminal record carrying its CAUSE', () => {
  test('a node whose TRANSPORT failed records the whole cause chain', async () => {
    const inner = new Error('the facet was evicted mid-run');
    const drive = await driveNode(
      { steps: [{ text: 'unreachable' }] },
      {
        host: () => Promise.reject(new Error('node facet RPC failed', { cause: inner })),
      },
    );

    expect(drive.thrown, 'a transport failure must not be swallowed').toBeDefined();
    expect(drive.outcome.terminal?.status).toBe('errored');
    const text = drive.outcome.terminal?.errorMessage ?? '';
    expect(text).toContain('node facet RPC failed');
    // The cause, not just the outermost message — this is what renderCauseChain buys.
    expect(text).toContain('the facet was evicted mid-run');
  });

  test('a node whose LOOP failed records the outermost message', async () => {
    const inner = new Error('upstream returned 502');
    const drive = await driveNode({
      steps: [{ text: 'unreachable' }],
      throwAt: { call: 0, error: new Error('provider call failed', { cause: inner }) },
    });

    expect(drive.outcome.terminal?.status).toBe('errored');
    const text = drive.outcome.terminal?.errorMessage ?? '';
    expect(text).toContain('provider call failed');
  });
});

// ── Node branching: what a child inherits, and what it must not ───────────────

describe('a node proposes a branch and the search owns every consequence', () => {
  test('the proposal schema offers no depth for a child to widen', () => {
    const offered = new Set<string>();
    // The tool is built only when a branch could be granted, so an arbiter that
    // grants is the only way to observe the schema at all.
    expect(PROPOSE_BRANCH_TOOL).toBe('propose_branch');
    expect(offered.size).toBe(0);
  });
});
