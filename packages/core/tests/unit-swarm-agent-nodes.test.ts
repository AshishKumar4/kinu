/**
 * THE BEHAVIOURAL PROOF OF R0: a depth-2 swarm of TOOL-USING agents finishes a real
 * task, and every node has a transcript a human can read.
 *
 * *"Every node is a real tool-calling agent with its own turns and transcript"* is the
 * requirement, and it is not a claim a unit test can make. So this suite runs the whole
 * engine, with:
 *
 *   - a REAL MEASUREMENT. The metered-oracle instrument from the depth suite, which
 *     spawns a real node process inside the workspace shell and counts the comparisons a
 *     candidate actually makes. Nothing here stubs the verifier: the point of the work is
 *     that the tree climbs the caller's own objective, and a stubbed instrument would
 *     assert the plumbing while leaving that claim untested.
 *   - REAL TOOL CALLS against the real runtime. Each node reads a real file out of the
 *     workspace VFS through the `file` tool before it answers, so the loop is a loop
 *     rather than one generation dressed as one. The read is load-bearing: the file holds
 *     the wasteful reference implementation, which is what a node is improving on.
 *   - THE PROPOSAL AS A TOOL. A depth-1 node calls `propose_branch` and reads the
 *     verdict out of the return value, which is the half a toolless node cannot have.
 *     That is also the only way depth 2 is reached here, so a broken verdict is a
 *     one-level tree rather than a passing test.
 *   - THE REPORT AS THE GRADED ARTEFACT. A node finishes by calling `report`, and what
 *     it reports is what the instrument measures. Nothing reads the workspace to grade a
 *     node, because nodes share one plane and every node changed the same tree.
 *
 * The model is scripted rather than live, exactly as the depth suite's is, for the reason
 * that suite records: the instrument is real and the model is the part under control. A
 * scripted model that must issue three different tool calls in sequence and read one
 * verdict back still proves the loop, the surface and the journal — which is what the
 * requirement is about.
 *
 * Specified by docs/EXPLORATION.md — "A node is an agent", "Arbitration",
 * "Inherited context", "Isolation" and "The six axes".
 */
import { describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { scriptedTurnModel } from '@proteus/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers';
import { MissionGovernor } from '../src/mission-budget';
import {
  createAgentsCodemodeProvider, createStrategyRegistry, type AgentsToolDeps,
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

/* ── The task, and it is measured ─────────────────────────────────────────── */

/** Small because every measurement spawns a real process inside the workspace shell. */
const N = 24;

/** The wasteful-but-correct starting point, and a real file in the workspace: it is what
 *  a node READS with the `file` tool before it answers. */
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

/** One linear scan: n-1 comparisons, the optimum, and what a node reports. */
const OPTIMAL = `export function solve(input, oracle) {
  const t = input.tokens;
  let best = t[0];
  for (let i = 1; i < t.length; i += 1) {
    if (oracle.greater(t[i], best)) best = t[i];
  }
  return best;
}
`;

/** Where the reference sits in the workspace. A node reads it; the instrument does not. */
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
    // The whole point: an AGENT node, not the `unit` axis's degenerate point (*The six axes*).
    unit: { kind: 'answer' },
    // The first level continues the origin's framing and the second level asks for
    // what it wants; a `fresh` search could not accept an inheriting child at all.
    context: 'fork',
    expand: 'sample',
    score: { kind: 'verify' }, advance: { kind: 'uct' }, carry: { kind: 'none' },
    ...over,
  };
}

/** What every run below asks for. One string, because the ledger suite dispatches the
 *  same search through `agents.swarm` and a second copy could drift from this one. */
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

/* ── The model: a node that actually works ────────────────────────────────── */

/** What one scripted node did, so the suite can assert the loop rather than the text. */
interface ScriptedRun {
  /** Every tool the model asked for, in order, across every node. */
  readonly calls: string[];
  /** Verdict strings `propose_branch` handed back — *Arbitration*'s return-value
   *  contract. */
  readonly verdicts: string[];
  /** The tool names the surface actually offered, read off the request. */
  readonly offered: Set<string>;
  /**
   * How many assistant turns each node ALREADY HAD in front of it on its first step.
   *
   * The discriminator *Inherited context* turns on, observed rather than inferred: a
   * `fork` child's prompt opens with its parent's own turns, and a `fresh` child's opens
   * with the seed alone. Zero therefore means "started from the seed", and non-zero
   * means "inherited a conversation".
   */
  readonly inheritedTurns: number[];
  /** How many `doGenerate` calls the run made, which is the model-call count. */
  count: () => number;
}

/**
 * A node that reads the workspace, proposes once, and reports.
 *
 * Scripted off ITS OWN TURNS rather than off a shared counter, and that is not a detail:
 * several nodes are mid-loop at once under one `Promise.allSettled`, so a counter would
 * interleave their scripts. A node's own turns are exactly the assistant messages AFTER
 * the last user message, because inheritance is append-only and the task block is last —
 * which also means this works identically for a child that inherited a conversation and
 * one that did not.
 */
interface ScriptedNode {
  readonly model: MockLanguageModelV3;
  readonly script: ScriptedRun;
}

/** What this model reports for EVERY call it serves. Named because the ledger suite
 *  below multiplies them by the call count the script observed: the expected total is
 *  then the provider's own arithmetic, not a number read back off the ledger. */
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
        // Look at the real workspace before answering. The result comes back through the
        // real VFS, so a broken surface fails here rather than later.
        content.push({ type: 'text', text: 'Reading the current implementation first.' });
        content.push({
          type: 'tool-call', toolCallId: `read-${String(generations)}`, toolName: 'file',
          input: JSON.stringify({ action: 'read', path: REFERENCE_PATH }),
        });
        calls.push('file');
      } else if (proposes && own === 1) {
        // Ask for a branch, and read the verdict off the return value.
        content.push({ type: 'text', text: 'The tail of this deserves its own thread.' });
        content.push({
          type: 'tool-call', toolCallId: `propose-${String(generations)}`, toolName: PROPOSE_BRANCH_TOOL,
          input: JSON.stringify({
            rationale: 'one thread should try a tournament and one a single scan',
            branches: [
              { task: 'find the largest with a single linear scan', rationale: 'fewest calls', context: 'fork' },
              { task: 'find the largest with a pairwise tournament', rationale: 'a different shape', context: 'fresh' },
            ],
          }),
        });
        calls.push(PROPOSE_BRANCH_TOOL);
      } else if (own === reportAt) {
        // Report the candidate. What is reported is what is measured.
        content.push({
          type: 'tool-call', toolCallId: `report-${String(generations)}`, toolName: 'report',
          input: JSON.stringify({
            status: 'completed',
            content: `A single scan is enough.\n\n\`\`\`javascript\n${OPTIMAL}\`\`\``,
          }),
        });
        calls.push('report');
      } else {
        // Close. A tool call makes the SDK take another step whatever the finish reason
        // says, so a node whose last word was a tool call would run to its step envelope
        // and be reported `budget_exceeded` for having finished its work.
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

/** A runtime whose workspace holds the reference implementation, so the `file` tool has
 *  something real to return. Shared by both harnesses below. */
async function workspace(): Promise<{ rt: AgentRuntime }> {
  const { rt } = createTestRuntime();
  await rt.storage.vfs.mkdir('candidate', { recursive: true });
  await rt.storage.vfs.writeFile(REFERENCE_PATH, `// a nested loop over every pair\n${REFERENCE}`);
  return { rt };
}

/* ── The run ──────────────────────────────────────────────────────────────── */

async function run(input: {
  readonly depth: number;
  readonly branches: number;
  readonly proposeAtDepth1: boolean;
}) {
  const { rt } = await workspace();
  const logger = createRecordingLogger();
  const { model, script } = workingNode({ proposeAtDepth1: input.proposeAtDepth1 });
  const startedAt = Date.now();
  const result = await runSwarm(
    { rt, model, mode: 'build', logger, maxSteps: 6 },
    resolved(input.depth, input.branches),
  );
  const wallClockMs = Date.now() - startedAt;
  const nodes = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
  return { rt, logger, nodes, result, script, journal: new HeadJournal(rt.storage.sql), wallClockMs };
}

describe('a depth-2 swarm of tool-using agents, end to end', () => {
  test('every node runs a tool loop, the tree reaches depth 2, and the objective is met', async () => {
    const { nodes, result, script, logger } = await run({
      depth: 2, branches: 2, proposeAtDepth1: true,
    });
    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // A LOOP, not a generation: every node issued at least a read and a report, so a
    // node's turn count is greater than one by construction.
    expect(script.calls.filter((name) => name === 'file').length).toBeGreaterThanOrEqual(3);
    expect(script.calls.filter((name) => name === 'report').length).toBeGreaterThanOrEqual(3);
    expect(script.calls).toContain(PROPOSE_BRANCH_TOOL);

    // THE SURFACE. *A node is an agent* on its tool surface and on its lack of delegation
    // authority: the four confined builtins the runtime could build, the report, the
    // proposal — and no `agents` tool, which is not withheld by a check but absent
    // because the dep was never wired.
    expect(script.offered.has('file')).toBe(true);
    expect(script.offered.has('report')).toBe(true);
    expect(script.offered.has(PROPOSE_BRANCH_TOOL)).toBe(true);
    expect(script.offered.has('agents')).toBe(false);
    for (const name of script.offered) {
      expect([...NODE_BUILTIN_TOOLS, PROPOSE_BRANCH_TOOL]).toContain(name);
    }

    // DEPTH 2, and every node's depth derived from the row its parent got.
    const depths = nodes.map((node) => node.depth);
    expect(Math.max(...depths)).toBe(2);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      if (node.parent_id === null) continue;
      expect(node.depth).toBe((byId.get(node.parent_id)?.depth ?? -99) + 1);
    }

    // THE VERDICT CAME BACK THROUGH THE TOOL — *Arbitration*'s return-value contract,
    // which is what a toolless node cannot have.
    expect(script.verdicts.some((verdict) => verdict.startsWith('Granted:'))).toBe(true);
    expect(logger.emitted.map((line) => line.event)).toContain('swarm.branch_accepted');

    // AND THE OBJECTIVE WAS MEASURED, off the reported candidate. The scan is optimal, so
    // it measures the target and scores 1 — through the real instrument, in the real
    // shell.
    expect(result.best).not.toBeNull();
    expect(result.best?.measured?.kind).toBe('measured');
    expect(result.best?.measured?.value).toBe(N - 1);
    expect(result.best?.score).toBe(1);
    expect(result.report.baseline).toBeGreaterThan(N - 1);
    expect(result.publication.state.kind).toBe('open');
  }, 180_000);

  test('every node has a transcript that can be read back, with its tool calls in it', async () => {
    const { nodes, result, journal, logger } = await run({
      depth: 2, branches: 2, proposeAtDepth1: true,
    });
    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // The run groups under ONE root, so the journal shows a search rather than N
    // unrelated single-node runs.
    const rootId = nodes.find((node) => node.parent_id === null)?.root_id;
    expect(rootId).toBeTruthy();
    const view = journal.readRun(rootId ?? '');
    expect(view).not.toBeNull();
    if (!view) return;

    // ONE JOURNAL ROW PER MODEL-WRITTEN NODE. The root is the workspace as found and no
    // model wrote it, so it has no transcript and is not counted.
    const modelWritten = nodes.filter((node) => node.parent_id !== null);
    expect(view.heads).toHaveLength(modelWritten.length);

    for (const head of view.heads) {
      // A READABLE TRANSCRIPT: ordered steps, each with what the node said and what it
      // called. This is what R13 renders and what makes a node auditable.
      expect(head.steps.length).toBeGreaterThan(0);
      const toolNames = head.steps.flatMap((step) => step.toolCalls.map((call) => call.name));
      // Every node finishes through its own report, and the journal holds the call.
      expect(toolNames).toContain('report');
      // The node reported, and the journal holds what it said.
      expect(head.status).toBe('completed');
      expect(head.summary ?? '').not.toBe('');
      // Its own spend, per node, from the provider's own numbers.
      expect(head.usage.input).toBeGreaterThan(0);
      expect(head.wallClockMs).toBeGreaterThanOrEqual(0);
    }

    // THE FIRST LEVEL READ THE WORKSPACE, and the trace carries the tool's OUTPUT and not
    // only its name — a trace of names cannot answer why a node concluded what it did.
    const firstLevel = modelWritten.filter((node) => node.depth === 1).map((node) => node.id);
    for (const id of firstLevel) {
      const head = view.heads.find((candidate) => candidate.id === id);
      const fileStep = head?.steps.find(
        (step) => step.toolCalls.some((call) => call.name === 'file'),
      );
      expect(fileStep).toBeDefined();
      expect(JSON.stringify(fileStep?.toolCalls)).toContain(REFERENCE_PATH);
    }

    // And exactly one of them asked for a branch, through the tool.
    const proposals = view.heads.flatMap(
      (head) => head.steps.flatMap(
        (step) => step.toolCalls.filter((call) => call.name === PROPOSE_BRANCH_TOOL),
      ),
    );
    expect(proposals.length).toBeGreaterThanOrEqual(1);

    // THE ISOLATION STATE IS REPORTED RATHER THAN ASSUMED. *Isolation* allows exactly two
    // states and this test host has no credentialled filesystem to provision, so every
    // node says `shared-origin-plane` instead of the run implying a boundary it does not
    // have.
    const settled = logger.emitted.filter((line) => line.event === 'swarm.node_settled');
    expect(settled.length).toBe(modelWritten.length);
    for (const line of settled) {
      expect(line.fields.isolation).toBe('shared-origin-plane');
      expect(line.fields.reported).toBe('self');
    }
  }, 180_000);

  test('a fork child inherits its parents conversation and a fresh child does not', async () => {
    // The two shapes *Inherited context* names, observed where they DIFFER. Every node's
    // first step is recorded with the number of assistant turns already in front of it: a
    // `fork` child opens on its parent's own turns, a `fresh` child opens on the seed
    // alone. Both carry the parent's report and their own focus, which is what makes them
    // two values of one axis rather than two mechanisms.
    const { result, journal, nodes, script } = await run({
      depth: 2, branches: 2, proposeAtDepth1: true,
    });
    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    const rootId = nodes.find((node) => node.parent_id === null)?.root_id ?? '';
    const deep = journal.readTree(rootId).filter((row) => row.depth === 2);
    expect(deep.length).toBe(2);
    // The granted branches were one `fork` and one `fresh`, and the engine created both
    // with the FOCUS the proposal named — without it a child is a re-run of its parent.
    const rationales = deep.map((row) => row.rationale ?? '');
    expect(rationales.some((rationale) => rationale.includes('fewest calls'))).toBe(true);
    expect(rationales.some((rationale) => rationale.includes('a different shape'))).toBe(true);

    // THE DISCRIMINATOR. Four nodes ran: two at depth 1 (which inherit the origin's
    // conversation, and the suite wires none, so zero), and two at depth 2 — one forking,
    // which sees its parent's turns, and one fresh, which sees none.
    expect(script.inheritedTurns).toHaveLength(4);
    expect(script.inheritedTurns.filter((turns) => turns > 0)).toHaveLength(1);
    expect(script.inheritedTurns.filter((turns) => turns === 0)).toHaveLength(3);
  }, 180_000);

  test('the run states what it spent: model calls, per-node steps, and wall clock', async () => {
    // Not a threshold — a DISCLOSURE. A search that cannot say what it cost cannot be
    // compared to yesterday's, and the numbers below are the ones the report carries.
    const { result, script, wallClockMs, logger } = await run({
      depth: 2, branches: 2, proposeAtDepth1: true,
    });
    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // One `doGenerate` per node step, summed across every node.
    expect(script.count()).toBeGreaterThanOrEqual(4);
    // Per-node steps reach the diagnostics stream, so a node that stalled is visible
    // without opening its transcript.
    const settled = logger.emitted.filter((line) => line.event === 'swarm.node_settled');
    const steps = settled.map((line) => Number(line.fields.steps));
    expect(steps.every((count) => count >= 2)).toBe(true);
    expect(steps.reduce((sum, count) => sum + count, 0)).toBe(script.count());
    // The report's own numbers: tokens summed off each node's report, and a duration the
    // suite can bound from outside.
    expect(result.report.tokens).toBeGreaterThan(0);
    expect(result.report.durationMs).toBeGreaterThan(0);
    expect(result.report.durationMs).toBeLessThanOrEqual(wallClockMs);
  }, 180_000);

  test('a refused proposal reaches the node as its next instruction, and it still finishes', async () => {
    // depth 1 with a tree advance: `propose_branch` is absent at build time, because a
    // request that can only ever be refused must not be offered. The node then finishes
    // without it — which is the check that the build-time gate does not strand a node.
    const { result, script } = await run({ depth: 1, branches: 2, proposeAtDepth1: true });
    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);
    expect(script.offered.has(PROPOSE_BRANCH_TOOL)).toBe(false);
    expect(script.calls).not.toContain(PROPOSE_BRANCH_TOOL);
    expect(result.report.expansions).toBe(2);
    expect(result.best?.score).toBe(1);
  }, 180_000);
});

/**
 * WHAT A LATER READER SEES OF THE RUN ABOVE.
 *
 * The suite above proves a swarm of agents writes a tree AND a transcript per node.
 * These read the same workspace back through the production read model, because the
 * two stores were what broke it: the list tagged each with one of the removed `fork`
 * verb's two settlements, so this exact run arrived as TWO rows sharing one root id
 * and the canvas handed each row one half. The tree-less half sorts newer, so a
 * caller's dedup kept the row with `tree: []`.
 */
describe('the run a reader gets back', () => {
  test('is ONE run carrying its tree, its transcripts, its params and its task', async () => {
    const { rt, result, nodes } = await run({ depth: 2, branches: 2, proposeAtDepth1: true });
    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // The denominators, before anything is claimed about the row: this workspace really
    // holds both halves. A read model asserted over an empty tree or an empty journal
    // passes for the wrong reason, which is the defect this repository keeps finding.
    expect(nodes.length).toBeGreaterThan(0);
    const journalled = rt.storage.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal`[0]?.n ?? 0;
    expect(journalled).toBeGreaterThan(0);

    const page = readExplorationCanvas(rt.storage.sql);
    expect(page.items).toHaveLength(1);
    const entry = page.items[0]!;
    expect(entry.run.hasSearchTree).toBe(true);
    expect(entry.run.hasNodeTranscripts).toBe(true);
    // Both halves in full, against the two stores the engine wrote.
    expect(entry.tree).toHaveLength(nodes.length);
    expect(entry.head?.heads.length).toBe(journalled);
    // The TASK, not `label` — which is `agent-nodes` here and is what `recordSplit`
    // stamps into `head_runs.rationale`, the column the list used to read as the task.
    expect(entry.run.task).toContain('opaque tokens');
    expect(entry.run.task).not.toBe('agent-nodes');
    expect(entry.head?.rationale).toBe('agent-nodes');
    // REAL PARAMS, from a ledger row the swarm path used to write nowhere at all.
    expect(entry.params?.search).toMatchObject({
      branches: 2, maxDepth: 2, budget: 4, mode: 'build',
    });
    expect(entry.params?.transcripts?.branches).toBe(journalled);
    // A verify-scored run asked no judge, so it honestly claims no ensemble.
    expect(entry.params?.search?.judgeSamplesRequested).toBeNull();
    expect(entry.params?.search?.judgeSamplesRealised).toBeNull();
    // And the permalink read says the same thing about the same run.
    expect(readExplorationRun(rt.storage.sql, entry.run.id)).toEqual(entry);
  }, 180_000);

  test('the ledger row says the run settled, with what it actually spent', async () => {
    const { rt, result } = await run({ depth: 1, branches: 2, proposeAtDepth1: true });
    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    const ledger = new MctsSearchStore(rt.storage.sql).list(10);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      engine: 'swarm',
      status: 'converged',
      // A swarm's budget unit is one child, so the candidates it produced ARE the
      // expansions it spent and the rest is what it never reached.
      iteration: result.report.expansions,
      budget: 2 - result.report.expansions,
    });
    // `findResumable` cannot reach this row — it is `converged` — and it must not reach a
    // swarm row that IS still running either. That direction needs a row nothing settled,
    // so it is proven against the store in unit-mcts-resume.test.ts rather than asserted
    // vacuously here.
  }, 180_000);
});

/**
 * WHAT THE SEARCH COST ITS CALLER, ACROSS EVERY PATH THAT COULD CHARGE IT.
 *
 * A swarm node's steps debit the mission ledger as they happen — through
 * `SwarmRunDeps.mission`, from inside each node's own loop — and the `agents.swarm`
 * seam then records the spawn. Both look at the same tokens: `report.tokens` is the
 * sum of exactly the calls the port already charged. So the seam that records the
 * spawn must charge no tokens, and the defect this suite exists to make impossible is
 * the one where it does.
 *
 * OVER-CHARGING IS THE FAILURE THAT HIDES ITSELF. A run billed twice reads as a run
 * that cost twice as much, and a cap tripping early on a doubled ledger is
 * indistinguishable from a cap working. So the expected total here is the PROVIDER'S
 * OWN ARITHMETIC — the calls the scripted model actually served, times what it
 * reported for each — and never a figure read back off the ledger under test.
 *
 * TWO LEVELS AND SEVERAL NODES, deliberately: a one-node total is satisfied by any
 * accounting that happens to charge one node once, and the doubling that shipped
 * would have been invisible in it.
 *
 * These runs go through `agents.swarm` rather than `runSwarm`, because the seam that
 * holds the spawn record is the tool dispatch and a test below it cannot see a lump
 * charged above it.
 */
describe('the mission ledger a search charges', () => {
  const LABEL = 'nightly';

  /**
   * The suite's own objective as the TOOL takes it: the surface is snake_case and the
   * type the search reads is not (`tools/swarm-input.ts` owns the mapping). Derived
   * from {@link objective} rather than restated, so the dispatched search and the
   * direct one cannot come to measure different things.
   */
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

  /** The same depth-2 agent search, dispatched through `agents.swarm` under a declared
   *  mission label. Returns the ledger, the script and the run's own report. */
  async function runUnderMission(input: {
    readonly depth: number;
    readonly branches: number;
    readonly tokens?: number;
  }) {
    const { rt } = await workspace();
    const db = new Database(':memory:');
    const governor = new MissionGovernor({
      storage: { sql: makeSql(db), execRaw: makeExecRaw(db) },
    });
    governor.declare(LABEL, input.tokens === undefined ? {} : { tokens: input.tokens });
    governor.activate([LABEL]);
    const { model, script } = workingNode({ proposeAtDepth1: true });
    const deps: AgentsToolDeps = {
      mode: 'build',
      fork: { registry: createStrategyRegistry(), rt, model },
      budget: governor,
    };
    const provider = createAgentsCodemodeProvider(() => deps);
    const out = await provider.tools.swarm!.execute({
      preset: 'custom',
      label: 'agent-nodes',
      task: TASK,
      objective: wireObjective(),
      config: agentConfig(),
      depth: input.depth,
      branches: input.branches,
    });
    const nodes = rt.storage.sql<SearchNode>`
      SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
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

    // THE DENOMINATORS, and every one of them is load-bearing. A ledger asserted
    // against zero calls, one node or one level would pass for the wrong reason — which
    // is the whole defect class: an over-charge test that passes because nothing was
    // charged catches nothing.
    expect(script.count()).toBeGreaterThan(1);
    expect(nodes.filter((node) => node.depth === 1).length).toBeGreaterThan(1);
    expect(nodes.some((node) => node.depth === 2)).toBe(true);
    expect(out.report.expansions).toBeGreaterThan(2);

    // THE CLAIM. What the provider said it served, summed by the suite, is what the
    // ledger holds — not twice it, and not one node's worth of it.
    const served = script.count() * CALL_TOKENS;
    expect(served).toBeGreaterThan(0);
    const [mission] = governor.snapshot(LABEL);
    expect(mission?.spent.tokens).toBe(served);
    expect(mission?.calls).toBe(script.count());
    // ONE SPAWN for one search, whatever the tree underneath it did.
    expect(mission?.spawns).toBe(1);

    // And the run's own report agrees with the ledger, which is the equality a double
    // bill breaks: the report sums the node reports, the ledger sums the debits, and
    // they are the same calls counted by two independent accumulators.
    expect(out.report.tokens).toBe(served);
  }, 180_000);

  test('an exhausted label stops the search mid-flight, before the level it cannot pay for', async () => {
    // THE CAP, AND WHY MID-RUN MATTERS. A lump charged after a run cannot decline
    // anything: by the time the ledger moves, every call is paid for. The cap here is
    // exactly what the FIRST level reports — two nodes, one call each — so the first
    // level lands on it and the second is refusable. Nothing but a ledger consulted
    // while the run is still going can refuse it.
    const cap = CALL_TOKENS * 2;
    const { governor, script, nodes, out } = await runUnderMission({
      depth: 2, branches: 2, tokens: cap,
    });

    // The denominator: the search really did issue calls and really did charge them, so
    // a run that never started cannot pass this as a cap being honoured.
    expect(script.count()).toBeGreaterThan(0);
    const [mission] = governor.snapshot(LABEL);
    expect(mission?.spent.tokens).toBeGreaterThan(0);
    expect(mission?.exhausted).toBe(true);

    // STOPPED SHORT, and it says so. Four expansions were affordable to the SEARCH
    // budget — two levels of two — and this run made two: the ledger emptied at the end
    // of the first level and the second never opened. `stop` therefore says `budget`
    // rather than claiming the space was exhausted.
    expect(out.report.expansions).toBe(2);
    expect(nodes.some((node) => node.depth === 2)).toBe(false);
    expect(out.report.stop).toBe('budget');

    // AND IT STILL CHARGED ONLY WHAT IT SERVED. A cap does not license a lump: the
    // ledger holds the calls the provider reported and stops there, one call per node.
    expect(mission?.spent.tokens).toBe(script.count() * CALL_TOKENS);
    expect(mission?.spent.tokens).toBe(cap);
  }, 180_000);
});
