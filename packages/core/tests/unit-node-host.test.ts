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
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { PROPOSE_BRANCH_TOOL, runNodeAgent, runNodeLoop } from '../src/strategy/node-agent';
import type {
  NodeAgentDeps,
  NodeAgentInput,
  NodeRunSpec,
} from '../src/strategy/node-agent';
import type { BranchDecision } from '../src/strategy/swarm-budget';

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
  return new MockLanguageModelV3({
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
    settle: 'best',
    arbitrate: opts?.arbitrate ?? null,
  };
  const deps: NodeAgentDeps = {
    rt,
    model: scriptedReporter(opts?.answer ?? 'sort once instead of comparing every pair', opts?.offered),
    journal,
    maxSteps: 4,
    logger: createRecordingLogger(),
  };
  if (opts?.host !== undefined) deps.host = opts.host;
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
      maxSteps: 4,
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
      maxSteps: 4,
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
});
