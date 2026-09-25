/**
 * Depth-2 swarm of tool-using agents on a real task, real instrument and tools; only the
 * model is scripted. Specified by docs/EXPLORATION.md — "A node is an agent", "Arbitration",
 * "Inherited context", "Isolation" and "The six axes".
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { scriptedTurnModel, unobservedSearchSeams, unobservedSpend } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import type { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { MissionGovernor } from '../src/mission-budget';
import {
  createAgentsCodemodeProvider, type AgentsToolDeps,
} from '../src/index';
import type { AgentRuntime } from '../src/types/agent-runtime';
import { createRecordingLogger } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { runSwarm } from '../src/strategy/swarm-run';
import { MctsSearchStore } from '../src/mcts/search-store';
import {
  readExplorationCanvas, readExplorationRun,
} from '../src/read-models/exploration-canvas';
import { resolveSwarm, swarmValidity } from '../src/strategy/swarm';
import { NODE_BUILTIN_TOOLS, PROPOSE_BRANCH_TOOL } from '../src/strategy/node-agent';
import type { Objective } from '../src/strategy/objective';
import type { ResolvedSwarm, SwarmConfig } from '../src/strategy/swarm';
import type { SearchNode } from '../src/types/mcts';

/** Small: every measurement spawns a real process in the workspace shell. */
const N = 24;

const REFERENCE = `export function solve(input, oracle) {
  const t = input.tokens;
  const n = t.length;
  for (let i = 0; i < n; i += 1) {
    let wins = 0;
    for (let j = 0; j < n; j += 1) {
      if (i !== j && oracle.greater(t[i], t[j])) wins += 1;
    }
    if (wins === n - 1) return t[i];
  }
  return t[0];
}
`;

const BODY = `
const values = shuffle(Array.from({ length: P.n }, (_unused, i) => i + 1));
const tokens = values.map(tok);
const oracle = { greater: meter((a, b) => valueOf(a) > valueOf(b)) };
const decode = (out) => (out === undefined || out === null ? null : valueOf(out));
emitTrials([trial({ tokens }, oracle, decode, P.n)]);
`;

const OPTIMAL = `export function solve(input, oracle) {
  const t = input.tokens;
  let best = t[0];
  for (let i = 1; i < t.length; i += 1) {
    if (oracle.greater(t[i], best)) best = t[i];
  }
  return best;
}
`;

const REFERENCE_PATH = 'candidate/reference.js';

function objective(): Objective {
  return {
    kind: 'scalar',
    metric: 'oracle_calls',
    unit: 'oracle calls',
    direction: 'minimise',
    scale: 'log',
    target: N - 1,
    verify: {
      kind: 'exec-ratio',
      spec: {
        params: { n: N, seed: 11 },
        reference: REFERENCE,
        body: BODY,
        targetOps: N - 1,
        lowerBoundOps: Math.ceil(N / 2),
      },
    },
    floor: {
      value: Math.ceil(N / 2),
      kind: 'certificate',
      bestKnownHonest: N - 1,
      proof: 'Every token must appear in at least one comparison and a comparison '
        + 'touches two, so covering n needs at least ceil(n/2) calls.',
    },
  };
}

function agentConfig(over?: Partial<SwarmConfig>): SwarmConfig {
  return {
    unit: { kind: 'answer' },
    context: 'inherit',
    expand: 'sample',
    score: { kind: 'verify' }, advance: { kind: 'uct' }, carry: { kind: 'none' },
    ...over,
  };
}

/** Shared with the `agents.swarm` ledger suite so the two cannot drift. */
const TASK = `Return the largest of ${String(N)} opaque tokens using the fewest oracle calls. `
  + `The current implementation is at ${REFERENCE_PATH}.`;

function resolved(depth: number, branches: number, over?: Partial<SwarmConfig>): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'custom',
    label: 'agent-nodes',
    task: TASK,
    objective: objective(),
    config: agentConfig(over),
    depth,
    branches,
  });

  if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
  const illegal = swarmValidity(call);

  if (illegal) throw new Error(`the suite's own composition is not legal: ${illegal.error}`);

  return call;
}

interface ScriptedRun {
  readonly calls: string[];
  readonly verdicts: string[];
  readonly offered: Set<string>;
  /** Prior assistant turns at each node's first step: zero means `fresh`, non-zero inherited. */
  readonly inheritedTurns: number[];
  count: () => number;
}

/** Scripted off the node's own turns, not a shared counter: nodes run concurrently. */
interface ScriptedNode {
  readonly model: MockLanguageModelV3;
  readonly script: ScriptedRun;
}

/** Per-call usage; expected ledger totals are this times observed calls. */
const CALL_INPUT_TOKENS = 120;

const CALL_OUTPUT_TOKENS = 45;

/** `usageTotal` is input + output — cache and reasoning are subsets of those two. */
const CALL_TOKENS = CALL_INPUT_TOKENS + CALL_OUTPUT_TOKENS;

function workingNode(input: { readonly proposeAtDepth1: boolean }): ScriptedNode {
  const calls: string[] = [];
  const verdicts: string[] = [];
  const offered = new Set<string>();
  const inheritedTurns: number[] = [];
  let generations = 0;

  const model = scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-agent-node',
    doGenerate: async ({ prompt, tools }) => {
      generations += 1;

      for (const tool of tools ?? []) offered.add(tool.name);

      for (const line of JSON.stringify(prompt).matchAll(/(Granted: [^"]*|Refused \([^"]*)/g)) {
        if (!verdicts.includes(line[0])) verdicts.push(line[0]);
      }

      let lastUser = -1;

      for (const [index, message] of prompt.entries()) {
        if (message.role === 'user') lastUser = index;
      }

      const own = prompt.slice(lastUser + 1).filter((message) => message.role === 'assistant').length;

      if (own === 0) {
        inheritedTurns.push(prompt.slice(0, lastUser).filter((m) => m.role === 'assistant').length);
      }

      const canPropose = (tools ?? []).some((tool) => tool.name === PROPOSE_BRANCH_TOOL);
      const proposes = canPropose && input.proposeAtDepth1;
      const reportAt = proposes ? 2 : 1;

      const content: LanguageModelV3Content[] = [];
      let finish: 'stop' | 'tool-calls' = 'tool-calls';

      if (own === 0) {
        content.push({ type: 'text', text: 'Reading the current implementation first.' });
        content.push({
          type: 'tool-call', toolCallId: `read-${String(generations)}`, toolName: 'file',
          input: JSON.stringify({ action: 'read', path: REFERENCE_PATH }),
        });
        calls.push('file');
      } else if (proposes && own === 1) {
        content.push({ type: 'text', text: 'The tail of this deserves its own thread.' });
        content.push({
          type: 'tool-call', toolCallId: `propose-${String(generations)}`, toolName: PROPOSE_BRANCH_TOOL,
          input: JSON.stringify({
            rationale: 'one thread should try a tournament and one a single scan',
            branches: [
              { task: 'find the largest with a single linear scan', rationale: 'fewest calls', context: 'inherit' },
              { task: 'find the largest with a pairwise tournament', rationale: 'a different shape', context: 'fresh' },
            ],
          }),
        });
        calls.push(PROPOSE_BRANCH_TOOL);
      } else if (own === reportAt) {
        content.push({
          type: 'tool-call', toolCallId: `report-${String(generations)}`, toolName: 'report',
          input: JSON.stringify({
            status: 'completed',
            content: `A single scan is enough.\n\n\`\`\`javascript\n${OPTIMAL}\`\`\``,
          }),
        });
        calls.push('report');
      } else {
        // Ending on a tool call forces another SDK step and a `budget_exceeded` report.
        content.push({ type: 'text', text: 'Reported: a single linear scan.' });
        finish = 'stop';
      }

      return {
        content,
        finishReason: { unified: finish, raw: undefined },
        usage: {
          inputTokens: { total: CALL_INPUT_TOKENS, noCache: CALL_INPUT_TOKENS, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: CALL_OUTPUT_TOKENS, text: CALL_OUTPUT_TOKENS, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  return { model, script: { calls, verdicts, offered, inheritedTurns, count: () => generations } };
}

async function workspace(): Promise<{ rt: AgentRuntime; db: Database }> {
  const { rt, db } = createTestRuntime();
  await rt.storage.vfs.mkdir('candidate', { recursive: true });
  await rt.storage.vfs.writeFile(REFERENCE_PATH, `// a nested loop over every pair\n${REFERENCE}`);

  return { rt, db };
}

async function run(input: {
  readonly depth: number;
  readonly branches: number;
  readonly proposeAtDepth1: boolean;
}) {
  const { rt, db } = await workspace();
  const logger = createRecordingLogger();
  const { model, script } = workingNode({ proposeAtDepth1: input.proposeAtDepth1 });
  const startedAt = Date.now();

  const result = await runSwarm(
    { reportModelCall: unobservedSpend, rt, hostNode: hostedSeatsOver({ rt, db }).hostNode, model, mode: 'build', logger, },
    resolved(input.depth, input.branches),
  );

  const wallClockMs = Date.now() - startedAt;

  // Scoped to the caller's actor: nodes are actors over this database too.
  const nodes = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes WHERE actor_id = ${rt.actor.actorId}
    ORDER BY depth ASC, created_at ASC`;

  return { rt, logger, nodes, result, script, journal: new HeadJournal(rt.storage.sql, rt.actor), wallClockMs };
}

let depthTwoRun: Awaited<ReturnType<typeof run>>;

let depthOneRun: Awaited<ReturnType<typeof run>>;

beforeAll(async () => {
  depthTwoRun = await run({ depth: 2, branches: 2, proposeAtDepth1: true });
  depthOneRun = await run({ depth: 1, branches: 2, proposeAtDepth1: true });
});

describe('a depth-2 swarm of tool-using agents, end to end', () => {
  test('every node runs a tool loop, the tree reaches depth 2, and the objective is met', () => {
    const { nodes, result, script, logger } = depthTwoRun;

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // More than one turn per node: a loop, not one generation.
    expect(script.calls.filter((name) => name === 'file').length).toBeGreaterThanOrEqual(3);
    expect(script.calls.filter((name) => name === 'report').length).toBeGreaterThanOrEqual(3);
    expect(script.calls).toContain(PROPOSE_BRANCH_TOOL);

    // No `agents` tool: never wired, not withheld.
    expect(script.offered.has('file')).toBe(true);
    expect(script.offered.has('report')).toBe(true);
    expect(script.offered.has(PROPOSE_BRANCH_TOOL)).toBe(true);
    expect(script.offered.has('agents')).toBe(false);

    for (const name of script.offered) {
      expect([...NODE_BUILTIN_TOOLS, PROPOSE_BRANCH_TOOL]).toContain(name);
    }

    const depths = nodes.map((node) => node.depth);
    expect(Math.max(...depths)).toBe(2);
    const byId = new Map(nodes.map((node) => [node.id, node]));

    for (const node of nodes) {
      if (node.parent_id === null) continue;
      expect(node.depth).toBe((byId.get(node.parent_id)?.depth ?? -99) + 1);
    }

    expect(script.verdicts.some((verdict) => verdict.startsWith('Granted:'))).toBe(true);
    expect(logger.emitted.map((line) => line.event)).toContain('swarm.branch_accepted');

    expect(result.best).not.toBeNull();
    expect(result.best?.measured?.kind).toBe('measured');
    expect(result.best?.measured?.value).toBe(N - 1);
    expect(result.best?.score).toBe(1);
    expect(result.report.baseline).toBeGreaterThan(N - 1);
    expect(result.publication.state.kind).toBe('open');
  });

  test('every node has a transcript that can be read back, with its tool calls in it', () => {
    const { nodes, result, journal, logger } = depthTwoRun;

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    const rootId = nodes.find((node) => node.parent_id === null)?.root_id;
    expect(rootId).toBeTruthy();
    const view = journal.readRun(rootId ?? '');
    expect(view).not.toBeNull();

    if (!view) return;

    // The root has no model-written transcript.
    const modelWritten = nodes.filter((node) => node.parent_id !== null);
    expect(view.heads).toHaveLength(modelWritten.length);

    for (const head of view.heads) {
      // Read per head: the run view carries lifecycle, the journal carries prose.
      const steps = journal.readSteps(head.id);
      expect(steps.length).toBeGreaterThan(0);
      const toolNames = steps.flatMap((step) => step.toolCalls.map((call) => call.name));
      expect(toolNames).toContain('report');
      expect(head.status).toBe('completed');
      expect(head.summary ?? '').not.toBe('');
      expect(head.usage.input).toBeGreaterThan(0);
      expect(head.wallClockMs).toBeGreaterThanOrEqual(0);
    }

    const firstLevel = modelWritten.filter((node) => node.depth === 1).map((node) => node.id);

    for (const id of firstLevel) {
      const head = view.heads.find((candidate) => candidate.id === id);

      const fileStep = head && journal.readSteps(head.id).find(
        (step) => step.toolCalls.some((call) => call.name === 'file'),
      );

      expect(fileStep).toBeDefined();
      expect(JSON.stringify(fileStep?.toolCalls)).toContain(REFERENCE_PATH);
    }

    const proposals = view.heads.flatMap(
      (head) => journal.readSteps(head.id).flatMap(
        (step) => step.toolCalls.filter((call) => call.name === PROPOSE_BRANCH_TOOL),
      ),
    );

    expect(proposals.length).toBeGreaterThanOrEqual(1);

    // No credentialled filesystem here, so every node reports `shared-origin-plane`.
    const settled = logger.emitted.filter((line) => line.event === 'swarm.node_settled');
    expect(settled.length).toBe(modelWritten.length);

    for (const line of settled) {
      expect(line.fields.isolation).toBe('shared-origin-plane');
      expect(line.fields.reported).toBe('self');
    }
  });

  test('an inheriting child inherits its parents conversation and a fresh child does not', () => {
    const { result, journal, nodes, script } = depthTwoRun;

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    const rootId = nodes.find((node) => node.parent_id === null)?.root_id ?? '';
    const deep = journal.readTree(rootId).filter((row) => row.depth === 2);
    expect(deep.length).toBe(2);
    // Without the proposal's focus a child is a re-run of its parent.
    const rationales = deep.map((row) => row.rationale ?? '');
    expect(rationales.some((rationale) => rationale.includes('fewest calls'))).toBe(true);
    expect(rationales.some((rationale) => rationale.includes('a different shape'))).toBe(true);

    // Depth 1 inherits nothing (none wired); at depth 2 only the inheriting child sees turns.
    expect(script.inheritedTurns).toHaveLength(4);
    expect(script.inheritedTurns.filter((turns) => turns > 0)).toHaveLength(1);
    expect(script.inheritedTurns.filter((turns) => turns === 0)).toHaveLength(3);
  });

  test('the run states what it spent: model calls, per-node steps, and wall clock', () => {
    const { result, script, wallClockMs, logger } = depthTwoRun;

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    expect(script.count()).toBeGreaterThanOrEqual(4);
    const settled = logger.emitted.filter((line) => line.event === 'swarm.node_settled');
    const steps = settled.map((line) => Number(line.fields.steps));
    expect(steps.every((count) => count >= 2)).toBe(true);
    expect(steps.reduce((sum, count) => sum + count, 0)).toBe(script.count());
    expect(result.report.tokens).toBeGreaterThan(0);
    expect(result.report.durationMs).toBeGreaterThan(0);
    expect(result.report.durationMs).toBeLessThanOrEqual(wallClockMs);
  });

  test('a refused proposal reaches the node as its next instruction, and it still finishes', () => {
    // `propose_branch` is absent at build time; the node must still finish.
    const { result, script } = depthOneRun;

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);
    expect(script.offered.has(PROPOSE_BRANCH_TOOL)).toBe(false);
    expect(script.calls).not.toContain(PROPOSE_BRANCH_TOOL);
    expect(result.report.expansions).toBe(2);
    expect(result.best?.score).toBe(1);
  });
});

/** The run above read back through the production read model as one row with tree and transcript. */
describe('the run a reader gets back', () => {
  test('is ONE run carrying its tree, its transcripts, its params and its task', () => {
    const { rt, result, nodes } = depthTwoRun;

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // Non-empty tree and journal first, so the checks cannot pass vacuously.
    expect(nodes.length).toBeGreaterThan(0);

    const journalled = rt.storage.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal WHERE actor_id = ${rt.actor.actorId}`[0]?.n ?? 0;

    expect(journalled).toBeGreaterThan(0);

    const page = readExplorationCanvas(rt.storage.sql, rt.actor);
    expect(page.items).toHaveLength(1);
    const entry = page.items[0];
    expect(entry.run.hasSearchTree).toBe(true);
    expect(entry.run.hasNodeTranscripts).toBe(true);
    expect(entry.tree).toHaveLength(nodes.length);
    expect(entry.head?.heads.length).toBe(journalled);
    // The task, not `label` (which `recordSplit` stamps as the split name).
    expect(entry.run.task).toContain('opaque tokens');
    expect(entry.run.task).not.toBe('agent-nodes');
    expect(entry.head?.rationale).toBe('agent-nodes');
    expect(entry.params?.search).toMatchObject({
      branches: 2, maxDepth: 2, budget: 4, mode: 'build',
    });
    expect(entry.params?.transcripts?.branches).toBe(journalled);
    expect(entry.params?.search?.judgeSamplesRequested).toBeNull();
    expect(entry.params?.search?.judgeSamplesRealised).toBeNull();
    expect(readExplorationRun(rt.storage.sql, rt.actor, entry.run.id)).toEqual(entry);
  });

  test('the ledger row says the run settled, with what it actually spent', () => {
    const { rt, result } = depthOneRun;

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    const ledger = new MctsSearchStore(rt.storage.sql, rt.actor).list(10);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      engine: 'swarm',
      status: 'converged',
      // A swarm's budget unit is one child.
      iteration: result.report.expansions,
      budget: 2 - result.report.expansions,
    });
    // Still-running swarm rows vs `findResumable`: see unit-mcts-resume.test.ts.
  });
});

/**
 * Node steps debit the mission ledger as they run, so the `agents.swarm` spawn record must
 * charge no tokens. Expected totals come from provider-served calls, never the ledger.
 */
describe('the mission ledger a search charges', () => {
  const LABEL = 'nightly';

  /** Snake_case tool form of {@link objective} (`tools/swarm-input.ts` owns the mapping). */
  function wireObjective() {
    const declared = objective();

    if (declared.kind !== 'scalar' || declared.floor === undefined) {
      throw new Error("the suite's own objective must be a scalar one carrying a floor");
    }

    const { floor } = declared;

    return {
      ...declared,
      floor: {
        value: floor.value, kind: floor.kind, proof: floor.proof,
        best_known_honest: floor.bestKnownHonest,
      },
    };
  }

  async function runUnderMission(input: {
    readonly depth: number;
    readonly branches: number;
    readonly tokens?: number;
  }) {
    const { rt, db } = await workspace();
    // A mission cap is this actor's ledger in this workspace.
    const governor = new MissionGovernor({ storage: rt.storage, actor: rt.actor });
    governor.declare(LABEL, input.tokens === undefined ? {} : { tokens: input.tokens });
    governor.activate([LABEL]);
    const { model, script } = workingNode({ proposeAtDepth1: true });

    const deps: AgentsToolDeps = {
      mode: 'build',
      swarm: { rt, hostNode: hostedSeatsOver({ rt, db }).hostNode, model, ...unobservedSearchSeams() },
      budget: governor,
    };

    const provider = createAgentsCodemodeProvider(() => deps);

    const out = await provider.tools.swarm.execute({
      preset: 'custom',
      label: 'agent-nodes',
      task: TASK,
      objective: wireObjective(),
      config: agentConfig(),
      depth: input.depth,
      branches: input.branches,
    });

    // Scoped to the caller's actor, as in `run()`.
    const nodes = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes WHERE actor_id = ${rt.actor.actorId}
      ORDER BY depth ASC, created_at ASC`;

    return { governor, script, nodes, out: v.parse(SwarmOutputSchema, out) };
  }

  const SwarmOutputSchema = v.object({
    report: v.object({
      expansions: v.number(),
      tokens: v.nullable(v.number()),
      stop: v.picklist(['settled', 'budget', 'aborted']),
    }),
  });

  test('charges the provider\'s reported usage exactly once over a two-level search', async () => {
    const { governor, script, nodes, out } = await runUnderMission({ depth: 2, branches: 2 });

    // Non-trivial denominators: an over-charge test with nothing charged proves nothing.
    expect(script.count()).toBeGreaterThan(1);
    expect(nodes.filter((node) => node.depth === 1).length).toBeGreaterThan(1);
    expect(nodes.some((node) => node.depth === 2)).toBe(true);
    expect(out.report.expansions).toBeGreaterThan(2);

    const served = script.count() * CALL_TOKENS;
    expect(served).toBeGreaterThan(0);
    const [mission] = governor.snapshot(LABEL);
    expect(mission?.spent.tokens).toBe(served);
    expect(mission?.calls).toBe(script.count());
    expect(mission?.spawns).toBe(1);

    // Independent accumulators over the same calls; a double bill breaks equality.
    expect(out.report.tokens).toBe(served);
  });

  test('an exhausted label stops the search mid-flight, before the level it cannot pay for', async () => {
    // The cap equals the first level's spend, so only a mid-run ledger check refuses level two.
    const cap = CALL_TOKENS * 2;

    const { governor, script, nodes, out } = await runUnderMission({
      depth: 2, branches: 2, tokens: cap,
    });

    expect(script.count()).toBeGreaterThan(0);
    const [mission] = governor.snapshot(LABEL);
    expect(mission?.spent.tokens).toBeGreaterThan(0);
    expect(mission?.exhausted).toBe(true);

    // The ledger emptied after the first level, so `stop` is `budget`.
    expect(out.report.expansions).toBe(2);
    expect(nodes.some((node) => node.depth === 2)).toBe(false);
    expect(out.report.stop).toBe('budget');

    expect(mission?.spent.tokens).toBe(script.count() * CALL_TOKENS);
    expect(mission?.spent.tokens).toBe(cap);
  });
});
