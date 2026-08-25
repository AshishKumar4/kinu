/**
 * ONE RUNTIME, TWO TRANSPORTS — the proof that hosting a node somewhere else does
 * not fork the loop.
 *
 * The consolidation's whole claim is that `runNodeLoop` is the body wherever a
 * node runs: in the search's own isolate today, and inside an `ExplorationAgent`
 * facet when a backend supplies a host. A claim like that decays the moment the
 * two paths can drift, so it is asserted rather than described — the SAME node is
 * run both ways here and the two reports are compared field by field.
 *
 * What this suite deliberately does NOT do is stub the loop. A host that returned
 * a hand-made report would pass every assertion below while proving nothing, so
 * the host used here is a transport and nothing else: it forwards the spec to the
 * real `runNodeLoop` and returns what it got, which is exactly what the facet
 * does across an RPC. The only difference under test is WHERE the body ran.
 *
 * The model is scripted, for the reason the sibling suites record: the loop and
 * the seams are the parts under test and the provider is the part under control.
 */
import { describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import {
  PROPOSE_BRANCH_TOOL, readNodeReport, runNodeAgent, runNodeLoop,
} from '../src/strategy/node-agent';
import type {
  NodeAgentDeps,
  NodeAgentInput,
  NodeLoopDeps,
  NodeRunSpec,
} from '../src/strategy/node-agent';
import type { BranchDecision } from '../src/strategy/swarm-budget';
import type { SwarmSettle } from '../src/strategy/swarm';
import type { HeadReport, MergeStrategy } from '../src/heads/types';
import type { MissionScope } from '../src/mission-budget';

/**
 * A real grant, proposal and all.
 *
 * Built rather than cast: a grant CARRIES the proposal it paid for, because the
 * engine expands from what it granted and never from what it remembers. A cast
 * that omitted the proposal would type-check and then describe a grant the engine
 * cannot expand.
 */
function grant(): BranchDecision {
  return {
    kind: 'granted',
    width: 2,
    nodeIds: ['c1', 'c2'],
    proposal: {
      rationale: 'two angles genuinely diverge',
      branches: [
        { task: 'sort once', rationale: 'fewer comparisons', context: 'fresh' },
        { task: 'tournament', rationale: 'linear in n', context: 'fresh' },
      ],
    },
  };
}

/**
 * The node answers by reporting, which is the only artefact a search grades.
 *
 * `offered` records the tool names the loop actually put in front of the model,
 * which is the only place the build-time half of the arbitration rule is visible:
 * whether a tool EXISTS cannot be read off a refusal.
 */
function scriptedReporter(answer: string, offered?: Set<string>): MockLanguageModelV3 {
  let call = 0;
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-node-host',
    doGenerate: async ({ tools }) => {
      for (const tool of tools ?? []) offered?.add(tool.name);
      call += 1;
      const content: LanguageModelV3Content[] = [];
      let finish: 'stop' | 'tool-calls' = 'tool-calls';
      if (call === 1) {
        content.push({
          type: 'tool-call',
          toolCallId: 'report-1',
          toolName: 'report',
          input: JSON.stringify({ status: 'completed', content: answer }),
        });
      } else {
        // A tool call makes the SDK take another step whatever the finish reason
        // says, so the node's last word has to be text or it runs to its envelope.
        content.push({ type: 'text', text: 'Reported.' });
        finish = 'stop';
      }
      return {
        content,
        finishReason: { unified: finish, raw: undefined },
        usage: {
          inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 7, text: 7, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

function doubleProposer(): MockLanguageModelV3 {
  let call = 0;
  const proposal = (suffix: string) => ({
    rationale: `split ${suffix}`,
    branches: [
      { task: `left ${suffix}`, rationale: 'left', context: 'fresh' },
      { task: `right ${suffix}`, rationale: 'right', context: 'fresh' },
    ],
  });
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-double-proposer',
    doGenerate: async () => {
      call += 1;
      const content: LanguageModelV3Content[] = call === 1
        ? [
            {
              type: 'tool-call', toolCallId: 'propose-1', toolName: PROPOSE_BRANCH_TOOL,
              input: JSON.stringify(proposal('one')),
            },
            {
              type: 'tool-call', toolCallId: 'propose-2', toolName: PROPOSE_BRANCH_TOOL,
              input: JSON.stringify(proposal('two')),
            },
          ]
        : call === 2
          ? [{
              type: 'tool-call', toolCallId: 'report-1', toolName: 'report',
              input: JSON.stringify({ status: 'completed', content: 'done' }),
            }]
          : [{ type: 'text', text: 'Reported.' }];
      return {
        content,
        finishReason: { unified: call < 3 ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 2, text: 2, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}


interface Fixture {
  readonly input: NodeAgentInput;
  readonly deps: NodeAgentDeps;
  readonly journal: HeadJournal;
}

/** One node, and the seams a search hands it. `arbitrate` is null unless a test
 *  asks for one, because a tool that could only be refused must not be offered. */
function fixture(opts?: {
  readonly answer?: string;
  readonly arbitrate?: NodeAgentInput['arbitrate'];
  readonly host?: NodeAgentDeps['host'];
  readonly nodeId?: string;
  readonly offered?: Set<string>;
  readonly mission?: MissionScope;
  /** How the search this node belongs to settles. Defaults to `best`, which is what
   *  every other test here wants; varied by the label derivation's own test. */
  readonly settle?: SwarmSettle;
  readonly model?: MockLanguageModelV3;
}): Fixture {
  const { rt } = createTestRuntime();
  const journal = new HeadJournal(rt.storage.sql);
  const input: NodeAgentInput = {
    nodeId: opts?.nodeId ?? 'n1',
    rootId: 'r1',
    parentId: null,
    depth: 1,
    task: 'Name the smallest change that makes the reference implementation cheaper.',
    rationale: 'the direct angle',
    base: 'You are a node under test.',
    messages: [{ role: 'user', content: 'Answer the task.' }],
    inherited: [],
    context: 'fresh',
    mode: 'build',
    settle: opts?.settle ?? 'best',
    arbitrate: opts?.arbitrate ?? null,
  };
  const deps: NodeAgentDeps = {
    rt,
    model: opts?.model
      ?? scriptedReporter(opts?.answer ?? 'sort once instead of comparing every pair', opts?.offered),
    journal,

    // Required, and derived rather than picked, for the reason the type now enforces:
    // a node with no deadline of its own leaves the search's abort signal as its only
    // clock, and that signal cuts a whole wave at once.
    maxWallClockMs: 60_000,
    logger: createRecordingLogger(),
  };
  if (opts?.host !== undefined) deps.host = opts.host;
  if (opts?.mission !== undefined) deps.mission = opts.mission;
  return { input, deps, journal };
}

describe('one runtime, two transports', () => {
  test('an absent host runs the loop in this isolate and reports the node', async () => {
    const { input, deps } = fixture();
    const run = await runNodeAgent(input, deps);

    expect(run.report.status).toBe('completed');
    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toContain('sort once');
  });

  test('a host receives the spec and its result becomes the node run', async () => {
    let seen: NodeRunSpec | null = null;
    // A TRANSPORT, not a stub: it forwards to the real loop, which is what the
    // facet does across an RPC. A host that fabricated a report would pass the
    // assertions below while proving nothing.
    const { input, deps } = fixture({
      host: async (spec) => {
        seen = spec;
        const inner = fixture({ nodeId: spec.headInput.id });
        return await runNodeLoop(spec, {
          rt: inner.deps.rt,
          model: inner.deps.model,
          logger: inner.deps.logger,
          arbitrate: null,
        });
      },
    });

    const run = await runNodeAgent(input, deps);

    expect(seen).not.toBeNull();
    expect(run.report.status).toBe('completed');
    expect(run.reportedItself).toBe(true);
    expect(run.candidate).toContain('sort once');
  });

  test('the spec a host receives is data only, so it can cross an RPC', async () => {
    let seen: NodeRunSpec | null = null;
    const { input, deps } = fixture({
      host: async (spec) => {
        seen = spec;
        const inner = fixture({ nodeId: spec.headInput.id });
        return await runNodeLoop(spec, {
          rt: inner.deps.rt,
          model: inner.deps.model,
          logger: inner.deps.logger,
          arbitrate: null,
        });
      },
    });

    const run = await runNodeAgent(input, deps);

    // Structured-clone is the real boundary a facet crosses: anything the spec
    // carried that a closure cannot survive would throw here rather than failing
    // later inside a Durable Object.
    expect(() => structuredClone(seen)).not.toThrow();
    expect(structuredClone(seen)).toEqual(seen);
    // And the result came back through the same boundary intact.
    expect(() => structuredClone(run.report)).not.toThrow();
  });

  test('both transports produce the same report for the same node', async () => {
    const direct = fixture({ nodeId: 'same' });
    const viaHost = fixture({
      nodeId: 'same',
      host: async (spec) => {
        const inner = fixture({ nodeId: 'same' });
        return await runNodeLoop(spec, {
          rt: inner.deps.rt,
          model: inner.deps.model,
          logger: inner.deps.logger,
          arbitrate: null,
        });
      },
    });

    const a = await runNodeAgent(direct.input, direct.deps);
    const b = await runNodeAgent(viaHost.input, viaHost.deps);

    expect(b.report.status).toBe(a.report.status);
    expect(b.candidate).toBe(a.candidate);
    expect(b.reportedItself).toBe(a.reportedItself);
    expect(b.isolation).toBe(a.isolation);
    expect(b.report.stepCount).toBe(a.report.stepCount);
  });

  test('a hosted node is journalled by the search, never by the loop', async () => {
    // The ledger belongs to the search, which is on the far side of the boundary
    // when a host is in play. A loop that wrote its own copy would be the second
    // store the journal rule forbids, so the spawn and the report rows must be
    // here even though the body ran elsewhere.
    const { input, deps, journal } = fixture({
      host: async (spec) => {
        const inner = fixture({ nodeId: spec.headInput.id });
        return await runNodeLoop(spec, {
          rt: inner.deps.rt,
          model: inner.deps.model,
          logger: inner.deps.logger,
          arbitrate: null,
        });
      },
    });

    await runNodeAgent(input, deps);

    const recorded = journal.readHead(input.nodeId);
    expect(recorded).not.toBeNull();
    expect(recorded?.status).toBe('completed');
  });

  test('a hosted node carries its mission labels, so the far side can find the ledger', async () => {
    // THE UNDER-CHARGE THIS CLOSES. `NodeLoopDeps.mission` is a live port and a spec is
    // data, so the port cannot cross. The far side rebuilds one from the LABELS —
    // `exploration.ts` reads `HeadInput.missionLabels` and opens an RPC back to the
    // actor holding the ledger — and a spec that carried no labels would make the same
    // search free on the backend that hosts its nodes and charged on the one that does
    // not.
    const specs: NodeRunSpec[] = [];
    const charged: number[] = [];
    const mission: MissionScope = {
      labels: ['nightly', 'sweep'],
      port: {
        guard: async () => null,
        debit: async (tokens) => { charged.push(tokens); },
      },
    };
    const { input, deps } = fixture({
      mission,
      host: async (spec) => {
        specs.push(spec);
        // The far side rebuilds the port from what the spec carried, which is exactly
        // what a facet does. Nothing here is handed the parent's port.
        const rebuilt: MissionScope | null = spec.headInput.missionLabels?.length
          ? { labels: spec.headInput.missionLabels, port: mission.port }
          : null;
        const inner = fixture({ nodeId: spec.headInput.id });
        const loop: NodeLoopDeps = {
          rt: inner.deps.rt,
          model: inner.deps.model,
          logger: inner.deps.logger,
          arbitrate: null,
        };
        if (rebuilt) loop.mission = rebuilt;
        return await runNodeLoop(spec, loop);
      },
    });

    const run = await runNodeAgent(input, deps);

    // The denominators: the node really ran, really reported steps, and the labels
    // really crossed as data a facet could receive.
    expect(run.report.status).toBe('completed');
    expect(run.report.stepCount).toBeGreaterThan(0);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.headInput.missionLabels).toEqual(['nightly', 'sweep']);
    expect(() => structuredClone(specs[0])).not.toThrow();

    // AND THE REBUILT PORT WAS CHARGED, per step, for what the provider reported —
    // 11 in plus 7 out on every call this model serves.
    expect(charged.length).toBe(run.report.stepCount);
    expect(charged.every((tokens) => tokens === 18)).toBe(true);
  });

  test('an unbudgeted node carries no labels at all, so nothing opens a ledger', async () => {
    // The absent-key rule where it is load-bearing: an empty array would make the far
    // side ask a ledger that was never declared.
    const specs: NodeRunSpec[] = [];
    const { input, deps } = fixture({
      host: async (spec) => {
        specs.push(spec);
        const inner = fixture({ nodeId: spec.headInput.id });
        return await runNodeLoop(spec, {
          rt: inner.deps.rt,
          model: inner.deps.model,
          logger: inner.deps.logger,
          arbitrate: null,
        });
      },
    });

    const run = await runNodeAgent(input, deps);

    expect(run.report.status).toBe('completed');
    expect(specs).toHaveLength(1);
    expect(specs[0]?.headInput).not.toHaveProperty('missionLabels');
  });
});

describe('the arbiter is offered only when a branch could be granted', () => {
  test('no arbiter means the proposal tool is absent, not present-and-refusing', async () => {
    const offered = new Set<string>();
    const { input, deps } = fixture({ offered });
    const run = await runNodeAgent(input, deps);

    expect(run.report.status).toBe('completed');
    // ABSENT, not present-and-refusing: offering a request that could only ever
    // be refused spends a step to learn a limit the surface already knew.
    expect(offered.has(PROPOSE_BRANCH_TOOL)).toBe(false);
    expect(offered.has('report')).toBe(true);
  });

  test('an arbiter that could grant means the tool IS offered', async () => {
    const offered = new Set<string>();
    const { input, deps } = fixture({ offered, arbitrate: () => grant() });
    await runNodeAgent(input, deps);

    expect(offered.has(PROPOSE_BRANCH_TOOL)).toBe(true);
  });

  test('canPropose:false withholds the tool even when the arbiter is non-null', async () => {
    // THE CASE THE FIELD EXISTS FOR, and the only one that can distinguish it.
    // In-isolate, `canPropose` is redundant: the arbiter is null exactly when a
    // branch could not be granted, so either check answers. A HOST's arbiter is
    // an RPC stub and therefore never null, so without this field a hosted node
    // would be offered a proposal the search had already ruled out — and would
    // spend a step discovering that. Only the spec can carry the answer.
    const offered = new Set<string>();
    const inner = fixture({ offered });
    const spec: NodeRunSpec = {
      headInput: {
        id: 'n-withheld',
        rootId: 'r1',
        parentId: null,
        depth: 1,
        task: 'answer',
        mode: 'build',
        rationale: 'test',
        inheritedContext: [],
        budget: { maxDepth: 1, spawnedAt: Date.now() },
        mergeStrategy: 'best_of',
      },
      base: 'You are a node under test.',
      messages: [{ role: 'user', content: 'Answer.' }],
      isolation: 'shared-origin-plane',
      home: '.',

      canPropose: false,
    };

    await runNodeLoop(spec, {
      rt: inner.deps.rt,
      model: inner.deps.model,
      logger: inner.deps.logger,
      // Non-null, exactly as a parent stub is.
      arbitrate: async () => grant(),
    });

    expect(offered.has(PROPOSE_BRANCH_TOOL)).toBe(false);
  });

  test('canPropose travels in the spec, because a host arbiter is always non-null', async () => {
    const granted = grant();
    const sawCanPropose: boolean[] = [];
    const { input, deps } = fixture({
      arbitrate: () => granted,
      host: async (spec) => {
        sawCanPropose.push(spec.canPropose);
        const inner = fixture({ nodeId: spec.headInput.id });
        return await runNodeLoop(spec, {
          rt: inner.deps.rt,
          model: inner.deps.model,
          logger: inner.deps.logger,
          // An RPC stub is never null, which is exactly why the spec has to say
          // whether the tool may be offered at all.
          arbitrate: async () => granted,
        });
      },
    });

    await runNodeAgent(input, deps);

    expect(sawCanPropose).toEqual([true]);
  });

  test('an async arbiter is awaited, which is what lets a node be hosted', async () => {
    const granted = grant();
    let asked = false;
    const spec: NodeRunSpec = {
      headInput: {
        id: 'n-async',
        rootId: 'r1',
        parentId: null,
        depth: 1,
        task: 'propose',
        mode: 'build',
        rationale: 'test',
        inheritedContext: [],
        budget: { maxDepth: 1, spawnedAt: Date.now() },
        mergeStrategy: 'best_of',
      },
      base: 'You are a node under test.',
      messages: [{ role: 'user', content: 'Propose then report.' }],
      isolation: 'shared-origin-plane',
      home: '.',

      canPropose: true,
    };
    const inner = fixture();
    const result = await runNodeLoop(spec, {
      rt: inner.deps.rt,
      model: inner.deps.model,
      logger: inner.deps.logger,
      // Returns a promise, as a parent-stub RPC does.
      arbitrate: async () => {
        asked = true;
        return granted;
      },
    });

    expect(result.report.status).toBe('completed');
    // The scripted model reports rather than proposing, so the arbiter is offered
    // and simply not called — which is the point: offering it must not require
    // resolving it, or a node would pay for a branch it never asked for.
    expect(asked).toBe(false);
  });

  test('same-step proposals share one arbitration and one budget debit', async () => {
    let calls = 0;
    const { input, deps } = fixture({
      model: doubleProposer(),
      arbitrate: async () => {
        calls += 1;
        return {
          ...grant(),
          nodeIds: [`first-${String(calls)}-a`, `first-${String(calls)}-b`],
        };
      },
    });

    const run = await runNodeAgent(input, deps);

    expect(calls).toBe(1);
    expect(run.granted).toMatchObject({
      kind: 'granted',
      nodeIds: ['first-1-a', 'first-1-b'],
    });
  });
});

/** The four values of the settle axis, so the label table below is walked rather than
 *  spot-checked. Held beside a `Record` over the same axis, which is what makes a fifth
 *  value a compile error instead of a silent else-branch. */
const SETTLES: readonly SwarmSettle[] = ['best', 'archive', 'front', 'merge'];

/** A finished report carrying `summary` and nothing else of interest, so whatever
 *  `readNodeReport` returns can only have come from the field under test. */
function reportWithSummary(summary: string): HeadReport {
  return {
    id: 'n1', status: 'completed', summary,
    evidence: [], decisions: [], artifactRefs: [], fileChanges: [], childHeadIds: [],
    toolCalls: [], stepCount: 2, usage: {}, wallClockMs: 12,
  };
}

/**
 * THE TWO THINGS `runNodeAgent` DERIVES FROM ITS INPUT, each asserted where it lands.
 *
 * Both are one-line ternaries, both are read by something outside this module — a journal
 * column and the engine's own grading signal — and neither had a test. A ternary read the
 * other way changes no type and throws nothing, so a green suite says nothing at all
 * about which way round it is.
 */
describe("what a node's run derives, and where each derivation lands", () => {
  test("the journal's label column says best_of exactly when the search settles by best", async () => {
    // ONE MAPPING OVER THE WHOLE AXIS. `SwarmSettle` has four values and the journal's
    // column three, so the derivation is a fan-in: one settle spells `best_of` and the
    // other three take the synthesis word, because the column is a LABEL in the head
    // vocabulary while `ResolvedSwarm.settle` is the fact. Held as a `Record` over the
    // axis so a fifth settle value fails to COMPILE here rather than quietly taking the
    // else-branch and reporting a search as a synthesis it never performed.
    const EXPECTED = {
      best: 'best_of',
      archive: 'synthesize',
      front: 'synthesize',
      merge: 'synthesize',
    } satisfies Record<SwarmSettle, MergeStrategy>;
    // The two labels really do differ, so the table is not satisfied by a column holding
    // one constant — and the walk really does cover the table.
    expect(new Set(Object.values(EXPECTED)).size).toBe(2);
    expect(SETTLES).toHaveLength(Object.keys(EXPECTED).length);

    for (const settle of SETTLES) {
      const { input, deps, journal } = fixture({ settle });
      const run = await runNodeAgent(input, deps);
      // The node really ran, so the row under test is one a live search would have
      // written rather than an insert with nothing behind it.
      expect(run.report.status).toBe('completed');
      expect(journal.readHead(input.nodeId)?.merge_strategy).toBe(EXPECTED[settle]);
    }
  });

  test('a report made only of whitespace has reported nothing, so the loop summary stands', () => {
    // `readNodeReport` is the whole boundary between what a node's loop produced and what
    // the engine grades, and the fallback is `||` rather than `??` for a reason with
    // consequences. A node that called `report` with a blank string produced no answer;
    // read the other way the engine hands the instrument an empty candidate, and an empty
    // candidate is not measured badly — `evaluateWithMultiModelJudging` returns 0 for an
    // empty trajectory without spending a judge call, and `exec-ratio` reports it
    // unmeasurable. Everything the node's loop did learn would be discarded for nothing.
    const summary = 'the loop settled on a single scan';
    for (const blank of ['', ' ', '\n', '\t  \n ']) {
      const read = readNodeReport({
        report: reportWithSummary(summary),
        reported: { status: 'completed', content: blank },
        languages: ['javascript'],
      });
      expect(read.conclusion).toBe(summary);
      expect(read.candidate).toBe(summary);
    }

    // AND A REPORT WITH CONTENT WINS, which is what makes the arm above a FALLBACK rather
    // than the only path — trimmed, because the boundary decides emptiness by trimming and
    // must therefore hand on what it trimmed.
    const reported = readNodeReport({
      report: reportWithSummary(summary),
      reported: { status: 'completed', content: '  use the running maximum  ' },
      languages: ['javascript'],
    });
    expect(reported.conclusion).toBe('use the running maximum');

    // A node that called no report at all falls back the same way. The absent case both
    // readings agree about, kept because it is what the whitespace case is being told
    // apart FROM.
    const unreported = readNodeReport({
      report: reportWithSummary(summary), reported: null, languages: ['javascript'],
    });
    expect(unreported.conclusion).toBe(summary);
  });
});

describe('a proposal is answered at most once', () => {
  test('a second propose_branch is refused before the arbiter, and the first grant stands', async () => {
    // The engine reads only the LAST grant, so a second arbitrate would debit
    // the shared budget again and strand the first grant's width — children paid
    // for and never created. The refusal must happen BEFORE arbitration runs.
    let asked = 0;
    let firstDecision: BranchDecision | null = null;
    const { input, deps } = fixture({
      arbitrate: (proposal) => {
        asked += 1;
        const decision: BranchDecision = {
          kind: 'granted', width: 2, nodeIds: ['c1', 'c2'], proposal,
        };
        if (asked === 1) firstDecision = decision;
        return decision;
      },
    });
    let call = 0;
    const usage = {
      inputTokens: { total: 11, noCache: 11, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 7, text: 7, reasoning: undefined },
    };
    const propose = (id: string) => ({
      type: 'tool-call' as const,
      toolCallId: id,
      toolName: PROPOSE_BRANCH_TOOL,
      input: JSON.stringify({
        rationale: 'two angles genuinely diverge',
        branches: [
          { task: 'sort once', rationale: 'fewer comparisons', context: 'fresh' },
          { task: 'tournament', rationale: 'linear in n', context: 'fresh' },
        ],
      }),
    });
    deps.model = scriptedTurnModel({
      provider: 'fake',
      modelId: 'fake-double-propose',
      doGenerate: async () => {
        call += 1;
        if (call <= 2) {
          return {
            content: [propose(`propose-${String(call)}`)],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage, warnings: [],
          };
        }
        if (call === 3) {
          return {
            content: [{
              type: 'tool-call' as const,
              toolCallId: 'report-1',
              toolName: 'report',
              input: JSON.stringify({ status: 'completed', content: 'sort once instead of comparing every pair' }),
            }],
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage, warnings: [],
          };
        }
        return {
          content: [{ type: 'text' as const, text: 'Reported.' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage, warnings: [],
        };
      },
    });

    const run = await runNodeAgent(input, deps);

    expect(run.report.status).toBe('completed');
    expect(asked).toBe(1);
    expect(run.granted).toEqual(firstDecision);
  });
});
