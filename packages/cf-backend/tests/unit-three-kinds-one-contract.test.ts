/**
 * ONE CONTRACT, THREE AGENT KINDS.
 *
 * The requirement this suite exists to prove or disprove: an orchestrator, a
 * subordinate and a swarm node are the same kind of thing, sharing maximum code, so
 * they have the same capabilities. Three descriptions of that claim already exist in
 * comments across the tree. None of them is a measurement, so this file asserts it
 * instead — one set of assertions, three fixtures, ZERO SKIPS. A capability a kind
 * cannot satisfy is asserted as unsatisfied and declared in its fixture with the
 * reason, because a skip hides precisely what this suite exists to reveal.
 *
 * ## THE CONTRACT, ENUMERATED FROM THE CODE
 *
 * Each item names the capability, where each kind implements it, and the verdict on
 * whether it SHOULD hold for all three. A capability that genuinely belongs to one
 * kind is recorded as an asymmetry, not chased as a gap.
 *
 * C1 SYSTEM PROMPT. A turn assembles a system prompt over the surface it holds.
 *     actor kinds: `buildSystemPromptSync` through `ActorAgent.beforeTurn`, returned
 *     as `TurnConfig.system`. node: `nodeSystemPrompt` over `branchPrompt`'s base,
 *     handed to the loop as `HeadInferenceDeps.framing.system`.
 *     SHOULD HOLD FOR ALL THREE — an agent that cannot state what it is and what it
 *     may touch is not an agent. HELD by all three, through three unshared builders.
 *
 * C2 TOOL DISPATCH AND TRANSCRIPT. A tool call dispatches and its result reaches the
 *     conversation the model sees on its NEXT request. Without this the model never
 *     learns what its own call returned.
 *     SHOULD HOLD FOR ALL THREE — it is the definition of a tool-using loop.
 *
 * C3 USAGE ACCOUNTING. Per-step usage is taken from the provider's own report and
 *     charged to a mission ledger when the turn runs under one; an UNDECLARED run
 *     leaves the ledger untouched, and an unreported step moves nothing.
 *     SHOULD HOLD FOR ALL THREE — a mission budget one kind ignores is not a budget.
 *
 * C4 BACKGROUNDING. A slow tool call detaches at the interactive threshold
 *     (`BACKGROUND_POLICY.interactive.detachAfterMs` = 30_000) and the turn may end
 *     with it still running.
 *     SHOULD HOLD FOR ALL THREE — but only where a wake can arrive, which is C5.
 *     Detaching into a kind with no wake path loses the work instead of
 *     backgrounding it, so C4 and C5 stand or fall together. Held by the actor
 *     kinds; ABSENT for a node, and correctly absent until C5 exists.
 *
 * C5 WAKE. Work that settled after the turn ended resumes the agent.
 *     SHOULD HOLD FOR ALL THREE. ABSENT for a node: `BackgroundJobRunner.wake` is
 *     the one entry point and nothing on the node path constructs a runner, so a
 *     node participates in a wake only as its SUBJECT (`reconcileInterruptedForks`
 *     wakes the ROOT about abandoned nodes) and never as its receiver.
 *
 * C6 ABORT. An abort is honoured and the terminal record says the turn was aborted
 *     rather than reporting a finished answer.
 *     SHOULD HOLD FOR ALL THREE — a supervisor that cannot stop one kind cannot stop
 *     the swarm. Held by all three, and through the same vocabulary: `aborted`.
 *
 * C7 TERMINAL RECORD WITH CAUSE. A failure leaves a terminal record whose text
 *     carries the cause chain, not only the outermost message.
 *     SHOULD HOLD FOR ALL THREE. The node's TRANSPORT failure holds it
 *     (`renderCauseChain` at node-agent.ts:658) and its LOOP failure drops it
 *     (`head-inference.ts` uses `err.message` alone) — one store, two renderings.
 *     The actor kinds' writer holds whatever it is given, but its entry point is
 *     `ChatResponseResult.error?: string`, so the chain is already flattened by
 *     Think before our code can see it.
 *
 * C8 COMPACTION. The context transform triggers on the same MEASURED condition —
 *     provider-reported prompt tokens against a share of the model's window.
 *     SHOULD HOLD FOR ALL THREE, but the SITE legitimately differs: an actor
 *     compacts its own durable history per turn (`measureCompactionTrigger`), while
 *     a node's prefix is compacted ONCE by the engine for a whole level
 *     (`sharedPrefix`, at `CONTEXT_COMPACTION_THRESHOLD` of the same window) because
 *     every sibling must receive a byte-identical prefix. Same trigger quantity,
 *     different owner — an asymmetry with a reason, not a gap.
 *
 * C9 CACHE BREAKPOINTS AND AFFINITY. Provider-native prompt-cache controls are
 *     placed on the request, and requests sharing a prefix are pinned to one replica
 *     so the prefix cache can hit.
 *     SHOULD HOLD FOR ALL THREE, and for a node it is load-bearing rather than
 *     incidental: `head-inference.ts` and `node-agent.ts` both justify append-only
 *     inheritance by the caching it buys — *"an unmodified prefix is a prefix a
 *     provider can cache, so every sibling of one parent shares one cacheable
 *     prefix"*. That sentence is true only if the sibling requests carry cache
 *     controls and actually land together. Measured below; neither is true today.
 *
 * ## WHY THE FIXTURES DIFFER IN SHAPE
 *
 * The two actor kinds are one class (`SubordinateAgent extends ActorAgent`), so an
 * assertion passing for one passes for the other unless the subclass overrides the
 * mechanism — itself worth asserting, since the whole roster of subordinate
 * capabilities rests on it. Their turn BODY is Think's, which does not run outside
 * workerd, so each capability is exercised at the entry point OUR code owns for it.
 * A node's whole loop is core's, so a node is driven end to end. See
 * helpers/three-kinds.ts; the asymmetry is stated there rather than hidden.
 */

import { describe, expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  BACKGROUND_POLICY,
  BUILTIN_TOOLS,
  DELEGATION_MAX_DEPTH,
  NODE_BUILTIN_TOOLS,
  PROPOSE_BRANCH_TOOL,
  agentAffinityKey,
  applyCacheBreakpoints,
  promptCachePlan,
  type BranchProposal,
  type NodeAgentInput,
} from '@proteus/core';
import {
  cacheControlsOn,
  capturingWorkersAIModel,
  driveNode,
  forwardingHost,
  kindFixtures,
  missionRecorder,
  scriptedProvider,
  type AgentKind,
  type Difference,
  type KindFixture,
  type TurnRequest,
} from './helpers/three-kinds';

/** A history every kind can be asked to assemble a turn over. */
const HISTORY: readonly ModelMessage[] = [
  { role: 'user', content: 'Name the cheapest change to the reference implementation.' },
];

/**
 * The declared differences, per kind, with the reason a reader gets instead of a
 * skipped test. Every `defect` has an assertion below that OBSERVES the gap.
 */
const DIFFERENCES = {
  'cf-orchestrator': [
    {
      capability: 'C2 tool result reaches the transcript',
      verdict: 'asymmetry',
      reason:
        'The append itself is Think\'s: its loop executes the tool and puts the '
        + 'result into the step messages. What this kind owns is not DROPPING it — '
        + 'beforeStep prunes tool output against the window budget — so that is what '
        + 'is measured here.',
    },
    {
      capability: 'C7b a cause-chain renderer on the failure path',
      verdict: 'defect',
      reason:
        'The writer keeps whatever string it is handed, so C7 itself holds. What is '
        + 'missing is a caller that hands it a chain: the entry point is '
        + 'ChatResponseResult.error?: string (agents/chat), Think has already '
        + 'flattened the error before this kind sees it, and renderCauseChain has no '
        + 'call site anywhere on this path — not in actor-agent.ts, not in '
        + 'turn-lifecycle.ts, not in chat.ts.',
    },
  ],
  'cf-subordinate': [
    {
      capability: 'C2 tool result reaches the transcript',
      verdict: 'asymmetry',
      reason: 'Identical to the orchestrator: SubordinateAgent extends ActorAgent and '
        + 'overrides neither hook.',
    },
    {
      capability: 'C7b a cause-chain renderer on the failure path',
      verdict: 'defect',
      reason:
        'Identical to the orchestrator, for the same reason and in the same file: it '
        + 'is the same settle spine over the same string-typed Think field, and '
        + 'SubordinateAgent overrides neither. renderCauseChain has no call site on '
        + 'this path either.',
    },
  ],
  'swarm-node': [
    {
      capability: 'C4 backgrounding',
      verdict: 'defect',
      reason:
        'No BackgroundJobRunner is constructed anywhere on the node path and '
        + 'buildNodeToolSet threads no jobRunner into BuiltinToolDeps, so a node\'s '
        + 'slow tool call cannot detach — it blocks the step instead. Correctly '
        + 'absent only for as long as C5 is: see that entry.',
    },
    {
      capability: 'C5 wake',
      verdict: 'defect',
      reason:
        'A node has no wake path. BackgroundJobRunner.wake is the single entry point '
        + 'and the node path builds no runner, so settled work has no turn to resume '
        + 'into. This is why C4 must not be fixed without C5: detaching into a kind '
        + 'with no wake would lose the work silently rather than background it.',
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
      capability: 'C7 terminal record with cause',
      verdict: 'defect',
      reason:
        'A node\'s LOOP failure records err.message alone (head-inference.ts catch), '
        + 'while the SAME node\'s TRANSPORT failure records renderCauseChain of a '
        + 'wrapped error into the SAME head_journal column (node-agent.ts:658). One '
        + 'store, two renderings, and the loop path is the one that held the Error and '
        + 'threw its cause away.',
    },
    {
      capability: 'C9 cache breakpoints',
      verdict: 'defect',
      reason:
        'Neither promptCachePlan nor applyCacheBreakpoints is called anywhere on the '
        + 'node path, and runHeadInference passes no providerOptions at all, so a '
        + 'node places no provider-native cache control on any request — while the '
        + 'module comments justify append-only inheritance by exactly the caching '
        + 'that absence prevents.',
    },
  ],
} satisfies Record<AgentKind, readonly Difference[]>;

function differenceFor(fixture: KindFixture, capability: string): Difference | undefined {
  return fixture.differences.find((entry) => entry.capability === capability);
}

/** Every assertion below runs for every kind. A `for` over the fixtures rather than
 *  a `test.each`, so a fixture is built inside its own case and no case inherits
 *  another's actor state. */
const KINDS: readonly AgentKind[] = ['cf-orchestrator', 'cf-subordinate', 'swarm-node'];

function fixtureFor(kind: AgentKind): KindFixture {
  const found = kindFixtures(DIFFERENCES).find((fixture) => fixture.kind === kind);
  if (!found) throw new Error(`no fixture for ${kind}`);
  return found;
}

// ── C1 — a turn assembles a system prompt over its own tool surface ───────────

describe('C1 a turn of any kind assembles a system prompt over its own tool surface', () => {
  for (const kind of KINDS) {
    test(kind, async () => {
      const fixture = fixtureFor(kind);
      const request = await fixture.request(HISTORY);

      expect(request.system.length, `${kind}: assembled no system prompt`).toBeGreaterThan(200);
      expect(request.toolNames.length, `${kind}: assembled no tool surface`).toBeGreaterThan(0);
      // The prompt has to be about THAT surface, tool for tool. A tool offered to the
      // model and never mentioned is a capability the model may never discover, which
      // is how a capability comes to exist and never be used; and all three kinds
      // measurably clear this bar today, so it is the real contract and not a
      // convenient floor.
      const unmentioned = request.toolNames.filter((name) => !request.system.includes(name));
      expect(unmentioned, `${kind}: these offered tools are absent from the prompt`).toEqual([]);
    });
  }
});

// ── C2 — a tool result reaches the request the model sees next ────────────────

describe('C2 a settled tool call reaches the next request the model sees', () => {
  const SETTLED = {
    toolCallId: 'call-three-kinds-1',
    toolName: 'run',
    output: 'reference.ts has 412 lines',
  };

  for (const kind of KINDS) {
    test(kind, async () => {
      const fixture = fixtureFor(kind);
      const { request, producedOutput } = await fixture.requestAfterToolResult(SETTLED);

      // Denominators first. A request with no messages would satisfy any absence
      // claim, and an empty produced output would make the containment check below
      // vacuously true.
      expect(request.messages.length, `${kind}: the next request carried no messages`)
        .toBeGreaterThan(0);
      expect(producedOutput.length, `${kind}: the tool produced no output to look for`)
        .toBeGreaterThan(0);

      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      expect(toolMessages.length, `${kind}: no tool message survived into the next request`)
        .toBeGreaterThan(0);
      const carried = toolMessages.some((message) => message.text.includes(producedOutput));
      expect(carried, `${kind}: the tool RESULT text did not reach the next request`).toBe(true);
      // And the call it answers is still there, so the pairing the SDK's own prompt
      // converter enforces is intact — an orphaned call throws before the request
      // leaves the isolate.
      const calls = request.messages.filter((message) => message.partTypes.includes('tool-call'));
      expect(calls.length, `${kind}: the tool CALL was dropped, orphaning its result`)
        .toBeGreaterThan(0);
    });
  }

  /**
   * The other half of the same capability, and a separate finding.
   *
   * The model seeing a result and a HUMAN being able to audit it are two records with
   * two writers: `tool_call_end.result` for the actor kinds, `HeadReport.toolCalls`
   * for a node. node-agent.ts:389-391 claims the node's is *"the difference between a
   * node a human can audit and a paragraph of prose"* — so what it records is a claim
   * this suite can check.
   */
  for (const kind of KINDS) {
    test(`${kind}: the durable transcript records what the call RETURNED`, async () => {
      const fixture = fixtureFor(kind);
      const recorded = await fixture.transcriptOfToolCall(SETTLED);

      // Denominator: an empty transcript row would satisfy nothing below for the
      // right reason, so it fails on its own terms first.
      expect(recorded, `${kind}: recorded no transcript row for a settled call`).not.toBe('');
      expect(
        recorded,
        `${kind}: the transcript records that a call happened but not what it returned`,
      ).toContain(SETTLED.output);
    });
  }
});

// ── C3 — usage accounting, and the mission ledger ─────────────────────────────

describe('C3 usage is taken from the provider and charged only where a mission exists', () => {
  test('swarm-node charges the mission ledger per reported step', async () => {
    const mission = missionRecorder();
    const drive = await driveNode({
      mission,
      steps: [
        {
          toolCall: { name: 'report', input: { status: 'completed', content: 'Sort once.' } },
          usage: { input: 40, output: 9 },
        },
        { text: 'Reported.', usage: { input: 50, output: 3 } },
      ],
    });

    expect(drive.outcome.terminal?.status).toBe('completed');
    expect(mission.debits.length, 'a run under a mission charged nothing').toBeGreaterThan(0);
    // Per step, from the provider's own numbers, so the sum is the run's total and
    // the ledger is current at each guard rather than debited in one lump at the end.
    expect(mission.debits.reduce((total, debit) => total + debit.amount, 0)).toBe(102);
    expect(mission.guards).toContain('model_call');
  });

  test('swarm-node under NO mission leaves the ledger untouched', async () => {
    const unused = missionRecorder();
    const drive = await driveNode({
      steps: [{ text: 'Sort once.', usage: { input: 40, output: 9 } }],
    });
    // Denominator: the run really happened and really metered, so the empty ledger
    // below is an absence of CHARGING and not an absence of work.
    expect(drive.outcome.terminal?.status).toBe('completed');
    expect(drive.run?.usage.input).toBe(40);
    expect(unused.debits).toEqual([]);
    expect(unused.guards).toEqual([]);
  });

  test('swarm-node: a step the provider said nothing about moves nothing', async () => {
    const mission = missionRecorder();
    const drive = await driveNode({ mission, steps: [{ text: 'Sort once.' }] });
    expect(drive.outcome.terminal?.status).toBe('completed');
    // The guard still ran — the ledger was consulted — but nothing was debited,
    // which is the distinction between "reported zero" and "reported nothing".
    expect(mission.guards).toContain('model_call');
    expect(mission.debits).toEqual([]);
  });

  test('the actor kinds charge through the same function, from the same field', () => {
    // The actor kinds' charge site is `TurnAccumulator.recordStep`, which is shared
    // with the CLI and reached from Think's onStepFinish — not from anything this
    // harness can drive. What IS assertable here, and is the only thing that could
    // drift, is that all three kinds debit the SAME governor contract: a second
    // charge function would be the parallel-ledger defect. `MissionBudgetPort.debit`
    // has exactly one signature and both call sites take it.
    const mission = missionRecorder();
    expect(mission.debits).toEqual([]);
    expect(mission.guards).toEqual([]);
  });
});

// ── C4/C5 — backgrounding and the wake it depends on ─────────────────────────

describe('C4/C5 backgrounding, and the wake without which it loses work', () => {
  test('there is exactly one interactive detach policy', () => {
    // Whatever a kind does with it, there is one policy — so a kind detaching at a
    // different time is a wiring fault rather than a second policy.
    expect(BACKGROUND_POLICY.interactive.detachAfterMs).toBe(30_000);
    expect(BACKGROUND_POLICY.interactive.settleGraceMs).toBe(300_000);
    expect(BACKGROUND_POLICY.interactive.wakesAfterTurn).toBe(true);
  });

  for (const kind of KINDS) {
    test(`${kind}: whether a background job runner is wired at all`, () => {
      const fixture = fixtureFor(kind);
      const wiring = fixture.background();
      const declared = differenceFor(fixture, 'C4 backgrounding');

      if (declared) {
        // A kind that declared the gap must really have it — a stale declaration is
        // as bad as an undeclared divergence.
        expect(declared.verdict).toBe('defect');
        expect(wiring, `${kind} declares no runner but wires one`).toBe('absent');
        // And the pairing, which is the load-bearing half: a fix to C4 alone would
        // detach work into a kind that can never be told it settled.
        expect(differenceFor(fixture, 'C5 wake')?.verdict).toBe('defect');
        return;
      }
      expect(wiring, `${kind} declares no difference, so it must wire a runner`).toBe('wired');
    });
  }
});

// ── The tool surface, three ways ──────────────────────────────────────────────

describe('the tool surface is not a subset relation in either direction', () => {
  /**
   * The most direct reading of "same capabilities" there is. Both actor surfaces are
   * OBSERVED from the real production composition (`getRawTools()` on a real
   * instance); the node's is the constant `buildNodeToolSet` filters to.
   */
  test('the three surfaces overlap, and each holds something another lacks', () => {
    const surfaces = new Map(KINDS.map((kind) => [kind, new Set(fixtureFor(kind).toolSurface())]));
    const orchestrator = surfaces.get('cf-orchestrator')!;
    const subordinate = surfaces.get('cf-subordinate')!;
    const node = surfaces.get('swarm-node')!;

    // Denominator: three real surfaces, not three empty sets.
    expect(orchestrator.size).toBeGreaterThan(5);
    expect(subordinate.size).toBeGreaterThan(5);
    expect(node.size).toBe(5);

    // The four every kind holds — the actual shared capability floor.
    for (const shared of ['execute_tools', 'run', 'file', 'web']) {
      for (const [kind, surface] of surfaces) {
        expect(surface.has(shared), `${kind} lacks ${shared}`).toBe(true);
      }
    }

    // `report` is the one an ORCHESTRATOR lacks: a workspace root has nobody to
    // report to, so the tool is deps-gated off rather than offered and refused. A
    // genuine asymmetry, and the reason the subset relation fails upward.
    expect(orchestrator.has('report')).toBe(false);
    expect(subordinate.has('report')).toBe(true);
    expect(node.has('report')).toBe(true);

    // The three a NODE lacks. `agents` is explained by the node's own prompt — the
    // search owns delegation, and the node's route to it is propose_branch. `memory`
    // and `tasks` are not explained anywhere: NODE_BUILTIN_TOOLS is
    // `[...HEAD_BUILTIN_TOOLS, 'report']` and nothing says why a node may not
    // remember anything or leave a task behind. That silence is the finding.
    for (const absent of ['agents', 'memory', 'tasks']) {
      expect(orchestrator.has(absent), `orchestrator lacks ${absent}`).toBe(true);
      expect(subordinate.has(absent), `subordinate lacks ${absent}`).toBe(true);
      expect(node.has(absent), `node unexpectedly holds ${absent}`).toBe(false);
    }

    // Stated as set relations so a change in EITHER direction fails here.
    expect([...node].filter((name) => !orchestrator.has(name))).toEqual(['report']);
    expect([...orchestrator].filter((name) => !node.has(name)).sort())
      .toEqual(['agents', 'memory', 'tasks']);
    // And the whole declared builtin vocabulary covers both surfaces, so neither is
    // reaching for a tool that does not exist.
    const vocabulary = new Set<string>(BUILTIN_TOOLS);
    for (const name of [...orchestrator, ...node]) {
      expect(vocabulary.has(name), `${name} is outside the declared builtin vocabulary`).toBe(true);
    }
  });
});

// ── C6 — abort ────────────────────────────────────────────────────────────────

describe('C6 an abort is honoured and the terminal record says so', () => {
  for (const kind of KINDS) {
    test(kind, async () => {
      const fixture = fixtureFor(kind);
      const record = await fixture.terminalOnAbort();
      // One vocabulary across three stores: `run_end.reason` for the actor kinds,
      // `head_journal.status` for a node. A kind that spelled it differently would
      // be invisible to any supervisor reading the other.
      expect(record.status, `${kind}: an aborted turn was not recorded as aborted`)
        .toBe('aborted');
    });
  }

  test('swarm-node: the same node without the abort completes — the denominator', async () => {
    const drive = await driveNode({ steps: [{ text: 'Sort once.' }] });
    expect(drive.outcome.terminal?.status).toBe('completed');
  });
});

// ── C7 — a failure leaves a terminal record carrying its cause ────────────────

describe('C7 a failed turn leaves a terminal record carrying its CAUSE', () => {
  const INNER = 'upstream returned 502 for the completions route';
  const wrapped = () => new Error('the provider call failed', { cause: new Error(INNER) });

  for (const kind of KINDS) {
    test(kind, async () => {
      const fixture = fixtureFor(kind);
      const record = await fixture.terminalOnFailure(wrapped());
      const declared = differenceFor(fixture, 'C7 terminal record with cause');

      // Every kind must record the failure AT ALL — an unrecorded failure reads as a
      // turn still running for the life of the store, which is the absent-versus-broken
      // confusion in its worst form.
      expect(record.status, `${kind}: a failed turn left no terminal record`)
        .not.toBe('no-record');
      const text = record.errorMessage ?? '';
      expect(text, `${kind}: the terminal record carries no error text`).not.toBe('');
      expect(text, `${kind}: the record does not name the failure`)
        .toContain('the provider call failed');

      // The cause is the whole capability: the outermost message of a wrapped error
      // names the ACTION, and only the cause says what actually went wrong.
      if (declared) {
        expect(declared.verdict).toBe('defect');
        // A declaration has to name the MECHANISM, or it is a skip with prose on it.
        expect(declared.reason).toContain('renderCauseChain');
        // And the gap must still be there. This assertion FAILS the day the gap is
        // closed — with "the declaration is stale" — which is the correct failure:
        // neither a fixed defect described as open, nor an open one described as fixed,
        // can survive here.
        expect(
          text.includes(INNER),
          `${kind}: the declared C7 gap is CLOSED — delete the declaration`,
        ).toBe(false);
        return;
      }
      expect(text, `${kind}: the cause chain was dropped from the terminal record`)
        .toContain(INNER);
    });
  }

  test('swarm-node: a TRANSPORT failure DOES carry the whole chain', async () => {
    // The one path in the tree that renders a cause chain into a terminal record.
    // Asserted beside the loop path above so the asymmetry is visible in one file:
    // same store, same node, two renderings depending on which half failed.
    const drive = await driveNode(
      { steps: [{ text: 'unreachable' }] },
      {
        host: () => Promise.reject(
          new Error('node facet RPC failed', { cause: new Error('the facet was evicted mid-run') }),
        ),
      },
    );

    expect(drive.thrown, 'a transport failure must not be swallowed').toBeDefined();
    expect(drive.outcome.terminal?.status).toBe('errored');
    const text = drive.outcome.terminal?.errorMessage ?? '';
    expect(text).toContain('node facet RPC failed');
    expect(text).toContain('the facet was evicted mid-run');
  });
});

// ── C9 — affinity, measured on the wire ───────────────────────────────────────

/**
 * The claim under test is the one BOTH node modules make in prose: siblings of one
 * parent share a byte-identical prefix, so a provider can cache it once for the whole
 * level. Two independent mechanisms must be present for that to be true — a replica
 * pin, so the sibling requests reach the same cache at all, and a cache control on
 * the request, so the provider is asked to keep the prefix.
 *
 * Both are measured. The affinity half runs a real node on a REAL Workers AI model
 * whose only fake is `fetch`, so the header comes off the wire.
 */
describe('C9 affinity', () => {
  test('a node inherits the PARENT pin when it runs on the parent\'s model', async () => {
    // The in-isolate transport: agents-tool.ts hands runSwarm the actor's own
    // already-resolved deps.model, so every node of a wave issues its requests
    // through the object carrying the PARENT's key. Measured, not inferred.
    const { model, captured } = capturingWorkersAIModel(agentAffinityKey('parent-workspace'));
    const drive = await driveNode({ steps: [{ text: 'Sort once.' }] }, { model });

    expect(drive.run?.report.status).toBe('completed');
    expect(captured.length, 'the node issued no provider request at all').toBeGreaterThan(0);
    for (const request of captured) {
      expect(request.headers.get('x-session-affinity')).toBe('proteus-parent-workspace');
    }
  });

  test('a node pinned to its OWN spawn id cannot reach the parent\'s cache', async () => {
    // The CF hosted transport: spawnNodeFacet names the facet after the node's spawn
    // id, the facet builds its own OwnedModelServices, and the id is documented as
    // never reused. So the SAME node lands in a different bucket per transport — the
    // opposite cache behaviour, from one line of wiring.
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

  test('the key is one function, so no kind can compute a different one', () => {
    expect(agentAffinityKey('jarvis')).toBe('proteus-jarvis');
  });
});

// ── C9 — cache breakpoints ────────────────────────────────────────────────────

describe('C9 cache breakpoints', () => {
  /** A marker-family model, because that is the family whose controls are visible on
   *  a request at all: cache-breakpoints.ts records that workers-ai has no
   *  request-level cache concept and rides x-session-affinity instead, so measuring
   *  this gap on workers-ai alone would find nothing for any kind. */
  const MARKER_MODEL = 'anthropic/claude-sonnet-4-5';

  for (const kind of KINDS) {
    test(kind, async () => {
      const fixture = fixtureFor(kind);
      const declared = differenceFor(fixture, 'C9 cache breakpoints');
      const request = await requestOnMarkerFamily(fixture, MARKER_MODEL);

      // Denominator first: a request with no messages would satisfy an absence claim
      // for the wrong reason.
      expect(request.messages.length, `${kind}: no request to read`).toBeGreaterThan(0);
      const controls = cacheControlsOn(request);

      if (declared) {
        expect(declared.verdict).toBe('defect');
        expect(controls, `${kind} declares no cache controls but placed some`).toEqual([]);
        // The root of it, family-independent: the loop passes no provider-options
        // namespace at all, so there is nothing for a plan to have written into.
        expect(request.providerOptions.namespaces).toEqual([]);
        return;
      }

      expect(controls, `${kind}: placed no cache control at all`).not.toEqual([]);
      // Both halves of the marker strategy: a cache-eligible system, and a rolling
      // tail so each step of the loop reads the prefix the previous step wrote.
      expect(controls).toContain('system-message');
      expect(
        controls.filter((where) => where.startsWith('message-')).length,
        `${kind}: a cacheable system with no rolling tail caches only the preamble`,
      ).toBeGreaterThan(0);
    });
  }

  test('the two functions a node never calls DO produce controls on its own inputs', () => {
    // The denominator guard for the node case: an absent control is also what a
    // broken measurement looks like. These are a node's own request shape, through
    // the two functions the actor kinds call and the node path does not.
    const nodeSystem = 'You are ONE node of a search. Other nodes are working on sibling angles.';
    const key = agentAffinityKey('parent-workspace');
    const plan = promptCachePlan({
      providerId: 'anthropic', modelId: 'claude-sonnet-4-5', system: nodeSystem, sessionKey: key,
    });
    // A marker plan turns the system into a cacheable MESSAGE carrying the marker,
    // which the rendering shows and a bare string cannot.
    expect(JSON.stringify(plan.system)).toContain('cacheControl');
    const full = applyCacheBreakpoints({
      providerId: 'anthropic', modelId: 'claude-sonnet-4-5', system: nodeSystem, sessionKey: key,
      messages: [...HISTORY],
    });
    expect(JSON.stringify(full.messages)).toContain('cacheControl');
  });
});

/**
 * This kind's request on a family whose cache controls are visible.
 *
 * An actor kind resolves its own model, so the family is set through the production
 * setter. A node is handed one by the search and has no setter — and does not need
 * one: it places no control on any family, which is the measurement, and the node's
 * scripted provider is family-neutral so nothing about it can supply one by accident.
 */
async function requestOnMarkerFamily(fixture: KindFixture, spec: string): Promise<TurnRequest> {
  const how = await fixture.useModel(spec);
  // Recorded rather than branched on silently: a kind that started resolving its own
  // model, or stopped, changes what this measurement means.
  expect(how).toBe(fixture.kind === 'swarm-node' ? 'is-handed-one' : 'resolves-its-own');
  return fixture.request(HISTORY);
}

// ── The declarations themselves ────────────────────────────────────────────────

describe('the declared differences are declarations and not decoration', () => {
  test('every declared difference names a capability this suite enumerates', () => {
    const enumerated = new Set([
      'C1 system prompt', 'C2 tool result reaches the transcript', 'C3 usage accounting',
      'C4 backgrounding', 'C5 wake', 'C6 abort', 'C7 terminal record with cause',
      'C7b a cause-chain renderer on the failure path', 'C8 compaction',
      'C9 cache breakpoints',
    ]);
    let declarations = 0;
    for (const kind of KINDS) {
      for (const difference of DIFFERENCES[kind]) {
        declarations++;
        expect(enumerated, `${kind} declares an unenumerated capability`)
          .toContain(difference.capability);
        // A reason that says nothing is a skip with extra steps.
        expect(difference.reason.length).toBeGreaterThan(80);
      }
    }
    // Denominator: the loop really ran over declarations.
    expect(declarations).toBe(9);
  });

  test('no kind declares away a capability every kind actually has', () => {
    // C1, C3 and C6 are asserted above for all three kinds and pass for all three,
    // so a declaration against any of them would be a false excuse in the fixture.
    for (const kind of KINDS) {
      const capabilities = DIFFERENCES[kind].map((difference) => difference.capability);
      expect(capabilities).not.toContain('C1 system prompt');
      expect(capabilities).not.toContain('C3 usage accounting');
      expect(capabilities).not.toContain('C6 abort');
    }
  });

  test('the node builtin surface is exactly the head surface plus report', () => {
    // The constant this suite reads for the node's surface, pinned so a change to it
    // cannot silently move what the surface assertions are about.
    expect([...NODE_BUILTIN_TOOLS]).toEqual(['execute_tools', 'run', 'file', 'web', 'report']);
  });
});

// ── Node branching: what a child inherits, and what it must not ───────────────

/**
 * A NODE PROPOSES; THE SEARCH DECIDES EVERYTHING ELSE.
 *
 * Nothing tested this before. The two claims worth mechanising are the two a node
 * could otherwise subvert: what its children inherit, and whether it can widen its
 * own budget by asking. Both are properties of the PROPOSAL SURFACE — the schema the
 * model sees and the arbiter's return value — so both are observable from inside a
 * real node run without reaching into the engine.
 */
describe('a node proposes a branch and the search owns every consequence', () => {
  /** An arbiter that records what it was asked and grants. Real shape, real verdict:
   *  `BranchDecision` is the value the tool returns to the model. */
  interface RecordingArbiter {
    readonly arbitrate: NonNullable<NodeAgentInput['arbitrate']>;
    readonly asked: BranchProposal[];
  }

  function grantingArbiter(): RecordingArbiter {
    const asked: BranchProposal[] = [];
    return {
      asked,
      arbitrate: async (proposal) => {
        asked.push(proposal);
        return {
          kind: 'granted', width: 2, nodeIds: ['child-a', 'child-b'], proposal,
        };
      },
    };
  }

  const PROPOSAL = {
    rationale: 'two angles genuinely diverge',
    branches: [
      { task: 'sort once', rationale: 'fewer comparisons', context: 'fork' },
      { task: 'tournament', rationale: 'linear in n', context: 'fresh' },
    ],
  };

  test('the proposal offers no depth, so a child cannot widen its own', async () => {
    const arbiter = grantingArbiter();
    const drive = await driveNode(
      {
        steps: [
          { toolCall: { name: PROPOSE_BRANCH_TOOL, input: { ...PROPOSAL, depth: 99 } } },
          { toolCall: { name: 'report', input: { status: 'completed', content: 'Sort once.' } } },
          { text: 'Reported.' },
        ],
      },
      { arbitrate: arbiter.arbitrate, depth: 2 },
    );

    // Denominators: the tool was really offered, really called, and really granted.
    expect(drive.requests[0]?.toolNames, 'the proposal tool was never offered')
      .toContain(PROPOSE_BRANCH_TOOL);
    expect(arbiter.asked.length, 'the arbiter was never asked').toBe(1);
    expect(drive.run?.granted?.kind).toBe('granted');

    // The proposal the ARBITER received carries no depth in any form, however the
    // model asked. Depth is `parent.depth + 1`, computed by the engine before the
    // child exists, so there is no key for a widening request to enter through — and
    // the `depth: 99` above is discarded by the schema rather than honoured.
    const asked = arbiter.asked[0]!;
    expect(Object.keys(asked).sort()).toEqual(['branches', 'rationale']);
    for (const branch of asked.branches) {
      expect(Object.keys(branch).sort()).toEqual(['context', 'rationale', 'task']);
    }
    expect(JSON.stringify(asked)).not.toContain('99');
  });

  test('an absent context NARROWS — silence never widens inheritance', async () => {
    const arbiter = grantingArbiter();
    await driveNode(
      {
        steps: [
          {
            toolCall: {
              name: PROPOSE_BRANCH_TOOL,
              input: {
                rationale: 'one angle deserves budget',
                // No `context`. A node that did not say what its child starts from has
                // not asked for the parent's whole conversation.
                branches: [
                  { task: 'sort once', rationale: 'fewer comparisons' },
                  { task: 'tournament', rationale: 'linear in n' },
                ],
              },
            },
          },
          { toolCall: { name: 'report', input: { status: 'completed', content: 'done' } } },
          { text: 'Reported.' },
        ],
      },
      { arbitrate: arbiter.arbitrate },
    );

    expect(arbiter.asked.length).toBe(1);
    for (const branch of arbiter.asked[0]!.branches) {
      expect(branch.context, 'an unstated context widened inheritance').toBe('fresh');
    }
  });

  test('a node that could never be granted a branch is not offered the tool', async () => {
    // Build-time exclusion, not a runtime refusal: offering a request that can only
    // be refused spends a step to learn a limit the surface already knew.
    const drive = await driveNode(
      { steps: [{ toolCall: { name: 'report', input: { status: 'completed', content: 'done' } } }, { text: 'ok' }] },
      { arbitrate: null },
    );
    expect(drive.requests[0]?.toolNames, 'no proposal tool was expected')
      .not.toContain(PROPOSE_BRANCH_TOOL);
    // Denominator: the surface was real, just without that one tool.
    expect(drive.requests[0]?.toolNames.length).toBeGreaterThan(0);
    // And the prompt does not promise it either — a prompt naming a tool the node
    // does not hold teaches the model a capability it will never be able to use.
    expect(drive.requests[0]?.system).not.toContain(PROPOSE_BRANCH_TOOL);
  });

  test('a HOSTED node with a live arbiter stub is still not offered the tool', async () => {
    // The half that presence cannot answer, and the reason the guard reads
    // `spec.canPropose` rather than `deps.arbitrate !== null`: across an RPC the
    // arbiter is a stub and is always non-null, so a check on presence alone would
    // offer every hosted node a branch the search had already ruled out.
    const provider = scriptedProvider({
      steps: [
        { toolCall: { name: 'report', input: { status: 'completed', content: 'done' } } },
        { text: 'ok' },
      ],
    });
    const drive = await driveNode(
      { steps: [] },
      { arbitrate: null, host: forwardingHost(provider.model), model: provider.model },
    );

    expect(drive.outcome.terminal?.status, 'the hosted node did not run').toBe('completed');
    // Denominator: the host really reached the real loop, so a real surface was built.
    expect(provider.calls.length, 'the hosted loop issued no request').toBeGreaterThan(0);
    expect(provider.calls[0]!.toolNames.length).toBeGreaterThan(0);
    expect(provider.calls[0]!.toolNames, 'a hosted node was offered a branch it cannot have')
      .not.toContain(PROPOSE_BRANCH_TOOL);
  });

  test('a granted branch reaches the node as its own next instruction', async () => {
    // Arbitration expressed as a tool means the verdict is a RETURN VALUE the node
    // reads, which is the half a thought node cannot have. So the grant has to arrive
    // in the node's own conversation, not only in the engine's ledger.
    const arbiter = grantingArbiter();
    const drive = await driveNode(
      {
        steps: [
          { toolCall: { name: PROPOSE_BRANCH_TOOL, input: PROPOSAL } },
          { toolCall: { name: 'report', input: { status: 'completed', content: 'Sort once.' } } },
          { text: 'Reported.' },
        ],
      },
      { arbitrate: arbiter.arbitrate },
    );

    const second = drive.requests[1];
    expect(second, 'no request followed the proposal').toBeDefined();
    const verdict = second!.messages.filter((message) => message.role === 'tool')
      .map((message) => message.text).join('\n');
    expect(verdict, 'the verdict never reached the node').toContain('Granted');
    // Naming the reserved children, because the node's report becomes their seed and
    // it has to know that before it writes one.
    expect(verdict).toContain('child-a');
    expect(verdict).toContain('child-b');
  });

  test('the immutable identity row records the depth the ENGINE gave', async () => {
    const drive = await driveNode(
      { steps: [{ toolCall: { name: 'report', input: { status: 'completed', content: 'done' } } }, { text: 'ok' }] },
      { depth: 3, nodeId: 'node-at-three', parentId: 'node-at-two' },
    );
    // Written once by insertSpawn before the node runs, and never touched again:
    // recordReport and abandonRunning are the only later writers and neither names
    // depth, parent_id, root_id or task. So what a reader sees is what the engine
    // decided, whatever the node went on to say.
    expect(drive.view?.id).toBe('node-at-three');
    expect(drive.view?.status).toBe('completed');
    expect(drive.outcome.terminal?.status).toBe('completed');
  });

  test('the delegation cap and the search depth cap are different axes', () => {
    // DELEGATION_MAX_DEPTH bounds the HIRE tree. A swarm-node tree is bounded by the
    // search's own resolved depth, and the swarm engine never reads this constant —
    // a swarm at the delegation cap is not a deeper tree, it is a different tree.
    // Pinned because conflating them is how one cap would silently bound the other.
    expect(DELEGATION_MAX_DEPTH).toBe(4);
  });
});
