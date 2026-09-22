/**
 * A provider or host error settles the node row with its cause, and a flat run returns every
 * candidate with its reason. Elapsed silence is not a failure: the turn loop has no watchdog.
 */
import { describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { handClock, scriptedTurnModel, type HandClock } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { createTestRuntime } from './helpers';
import { hostedSeatsOver } from './helpers-actor-host';
import { createRecordingLogger } from '../src/obs/index';
import type { Refusal } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { runNodeAgent } from '../src/strategy/node-agent';
import type { NodeAgentDeps, NodeAgentInput } from '../src/strategy/node-agent';
import { runSwarm } from '../src/strategy/swarm-run';
import { resolveSwarm, swarmValidity } from '../src/strategy/swarm';
import type { ResolvedSwarm, SwarmConfig, SwarmResult } from '../src/strategy/swarm';
import type { Objective } from '../src/strategy/objective';
import type { HeadJournalRow } from '../src/heads/journal';
import type { SearchNode } from '../src/types/mcts';

function contentFor({ reported, read }: { reported: boolean; read: boolean }): LanguageModelV3Content[] {
  if (reported) return [{ type: 'text', text: 'Reported: a single linear scan.' }];

  if (read) {
    return [{
      type: 'tool-call',
      toolCallId: 'report-1',
      toolName: 'report',
      input: JSON.stringify({
        status: 'completed',
        content: `A single scan is enough.\n\n\`\`\`javascript\n${OPTIMAL}\`\`\``,
      }),
    }];
  }

  return [
    { type: 'text', text: 'Reading the current implementation first.' },
    {
      type: 'tool-call',
      toolCallId: 'read-1',
      toolName: 'file',
      input: JSON.stringify({ action: 'read', path: REFERENCE_PATH }),
    },
  ];
}

/** The expired credential's error, verbatim: the row must carry this, not just "errored". */
const UPSTREAM = 'Your Cloudflare login is no longer valid. Please run `wrangler login` '
  + '(upstream: Authentication error)';

const N = 8;

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

const REFERENCE_PATH = 'candidate/reference.js';

const BODY = `
const values = shuffle(Array.from({ length: P.n }, (_unused, i) => i + 1));
const tokens = values.map(tok);
const oracle = { greater: meter((a, b) => valueOf(a) > valueOf(b)) };
const decode = (out) => (out === undefined || out === null ? null : valueOf(out));
emitTrials([trial({ tokens }, oracle, decode, P.n)]);
`;

/** One linear scan: a real candidate the instrument can run. */
const OPTIMAL = `export function solve(input, oracle) {
  const t = input.tokens;
  let best = t[0];
  for (let i = 1; i < t.length; i += 1) {
    if (oracle.greater(t[i], best)) best = t[i];
  }
  return best;
}
`;

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
        params: { n: N, seed: 7 },
        reference: REFERENCE,
        body: BODY,
        targetOps: N - 1,
        lowerBoundOps: Math.ceil(N / 2),
      },
    },
  };
}

const BRANCHES = 3;

function config(): SwarmConfig {
  return {
    unit: { kind: 'answer' },
    context: 'fresh',
    expand: 'sample',
    score: { kind: 'verify' },
    advance: { kind: 'uct' },
    carry: { kind: 'none' },
  };
}

function resolved(): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'custom',
    label: 'node-hang',
    task: `Return the largest of ${String(N)} opaque tokens using the fewest oracle calls.`,
    objective: objective(),
    config: config(),
    depth: 1,
    branches: BRANCHES,
  });

  if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
  const illegal = swarmValidity(call);

  if (illegal) throw new Error(`the suite's own composition is not legal: ${illegal.error}`);

  return call;
}

/** The `ideate` preset via the real resolver: it ranks nothing, so it owes every node's answer. */
function resolvedIdeate(): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'ideate',
    task: 'Propose a naming scheme for a CLI tool that schedules cron jobs.',
    depth: 1,
    branches: BRANCHES,
  });

  if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
  const illegal = swarmValidity(call);

  if (illegal) throw new Error(`the suite's own composition is not legal: ${illegal.error}`);

  return call;
}

/** Raises the upstream authentication error on every call. Stateless. */
const RAISING_MODEL = scriptedTurnModel({
  provider: 'fake',
  modelId: 'fake-raising',
  doGenerate: () => Promise.reject(new Error(UPSTREAM)),
});

/** One node answers, siblings get the auth error; chosen by seed, not a call counter, since siblings run concurrently. */
function oneAnsweringProvider(): MockLanguageModelV3 {
  let chosen: string | null = null;

  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-one-answers',
    doGenerate: ({ prompt }) => {
      let seed = '';

      for (const message of prompt) {
        if (message.role === 'user') seed = JSON.stringify(message.content);
      }

      chosen ??= seed;

      if (seed !== chosen) return Promise.reject(new Error(UPSTREAM));
      const reported = prompt.some((message) => message.role === 'tool');

      const content: LanguageModelV3Content[] = reported
        ? [{ type: 'text', text: 'Reported: a single linear scan.' }]
        : [{
          type: 'tool-call',
          toolCallId: 'report-1',
          toolName: 'report',
          input: JSON.stringify({
            status: 'completed',
            content: `A single scan is enough.\n\n\`\`\`javascript\n${OPTIMAL}\`\`\``,
          }),
        }];

      return Promise.resolve({
        content,
        finishReason: { unified: reported ? 'stop' as const : 'tool-calls' as const, raw: undefined },
        usage: {
          inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 12, text: 12, reasoning: undefined },
        },
        warnings: [],
      });
    },
  });
}

/** Per-step cost on the swarm's clock (D19), without a real pause. */
const STEP_MS = 125;

const STEPS_PER_NODE = 3;

/**
 * A multi-step active provider: no default elapsed envelope may cut work that keeps progressing
 * (`no-elapsed-work-deadline`); each step advances the swarm's clock (D19).
 */
function steppingProvider(clock: HandClock): MockLanguageModelV3 {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-stepping',
    doGenerate: ({ prompt }) => {
      clock.advance(STEP_MS);
      const read = prompt.some((message) => message.role === 'tool');
      const reported = prompt.filter((message) => message.role === 'tool').length > 1;

      const content: LanguageModelV3Content[] = contentFor({ reported, read });

      return {
        content,
        finishReason: { unified: reported ? 'stop' as const : 'tool-calls' as const, raw: undefined },
        usage: {
          inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 12, text: 12, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

interface NodeFixture {
  readonly input: NodeAgentInput;
  readonly deps: NodeAgentDeps;
  readonly journal: HeadJournal;
}

function nodeFixture(over?: { readonly runtimeForWorkspace?: NodeAgentDeps['runtimeForWorkspace'] }): NodeFixture {
  const { rt, db } = createTestRuntime();
  const journal = new HeadJournal(rt.storage.sql, rt.actor);

  const input: NodeAgentInput = {
    nodeId: 'n1',
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
    arbitrate: null,
  };

  const deps: NodeAgentDeps = {
    // The node's own actor, per node id: a shared handle would give a wave one claim ledger and loop pointer.
    hostNode: hostedSeatsOver({ rt, db }).hostNode,
    model: RAISING_MODEL,
    journal,

    // Never reached here, but a node with no deadline has no clock; taken from the shared derivation.
    maxWallClockMs: 60_000,
    logger: createRecordingLogger(),
  };

  if (over?.runtimeForWorkspace !== undefined) deps.runtimeForWorkspace = over.runtimeForWorkspace;

  return { input, deps, journal };
}

describe('a node that failed is not a node still working', () => {
  test('a transport that raises leaves a terminal row with the cause chained', async () => {
    // A failure building the node's own runtime arrives with no report behind it.
    const { input, deps, journal } = nodeFixture({
      runtimeForWorkspace: () => Promise.reject(new Error(UPSTREAM)),
    });

    let failure: Error | null = null;

    try {
      await runNodeAgent(input, deps);
    } catch (cause) {
      failure = cause instanceof Error ? cause : null;
    }

    // The failure is a readable value, with the upstream message as its cause.
    expect(failure).not.toBeNull();
    expect(failure?.message).toContain('run node n1');
    const cause = failure?.cause;
    expect(cause instanceof Error ? cause.message : '').toBe(UPSTREAM);

    // The row must exist: never-spawned and spawned-then-abandoned are the states under test.
    const row = journal.readHead('n1');
    expect(row).not.toBeNull();
    expect(row?.status).toBe('errored');
    // Greater than zero, not not-null: an absent row reads `undefined` and would pass not-null.
    expect(row?.completed_at).toBeGreaterThan(0);
    expect(row?.error_message).toContain(UPSTREAM);
    // Absent, not zero: no report came back.
    expect(row?.token_input).toBeNull();
  });

  test('a provider that raises inside the loop lands the same terminal row', async () => {
    // The siblings land the same readable status.
    const { input, deps, journal } = nodeFixture();
    const run = await runNodeAgent(input, deps);

    expect(run.report.status).toBe('errored');
    const row = journal.readHead('n1');
    expect(row).not.toBeNull();
    expect(row?.status).toBe('errored');
    expect(row?.completed_at).toBeGreaterThan(0);
    expect(row?.error_message).toContain('Authentication error');
  });
});

interface SwarmRunResult {
  readonly result: SwarmResult | Refusal;
  readonly rows: readonly HeadJournalRow[];
  readonly tree: readonly SearchNode[];
}

async function runWith(
  model: MockLanguageModelV3,
  call: ResolvedSwarm = resolved(),
  clock: HandClock = handClock(),
): Promise<SwarmRunResult> {
  const { rt, db } = createTestRuntime();
  await rt.storage.vfs.mkdir('candidate', { recursive: true });
  await rt.storage.vfs.writeFile(REFERENCE_PATH, REFERENCE);
  const logger = createRecordingLogger();

  const result = await runSwarm(
    { rt, hostNode: hostedSeatsOver({ rt, db }).hostNode, model, mode: 'build', logger, clock },
    call,
  );

  const rows = rt.storage.sql<HeadJournalRow>`
    SELECT id, parent_id, root_id, depth, task, rationale, status, spawned_at,
           completed_at, token_input, token_output, token_cache_read, token_cache_write,
           token_cache_write_1h, token_reasoning, neurons, wall_clock_ms, summary,
           error_message, merge_strategy
    FROM head_journal WHERE actor_id = ${rt.actor.actorId} ORDER BY spawned_at`;

  // Scoped to the caller's actor: an unscoped `SELECT *` would fold in node actors' rows.
  const tree = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes WHERE actor_id = ${rt.actor.actorId}
    ORDER BY depth ASC, created_at ASC`;

  return { result, rows, tree };
}

describe('a slow level has no default envelope', () => {
  test('nodes complete after as much active work as they need, and the ledger carries that time', async () => {
    const clock = handClock();
    const { result, rows } = await runWith(steppingProvider(clock), resolved(), clock);

    expect('reason' in result).toBe(false);
    expect(rows).toHaveLength(BRANCHES);

    for (const row of rows) {
      expect(row.status).toBe('completed');
      // At least three steps' worth of wall clock: catches a cut-short node or a zero recording.
      expect(row.wall_clock_ms).toBeGreaterThanOrEqual(STEPS_PER_NODE * STEP_MS);
      expect(row.error_message).toBeNull();
    }
  });
});

/**
 * `ideate` returns "a set of distinct approaches, unranked": every node it ran, answered or not,
 * must be in the result with its answer or its reason.
 */
describe('a flat preset returns every node it ran', () => {
  test('a 3-branch ideate returns 3 candidates when the credential dies under two of them', async () => {
    const { result, rows, tree } = await runWith(
      oneAnsweringProvider(), resolvedIdeate(),
    );

    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // Denominator: three nodes, one reported, two met the expired credential.
    expect(rows.length).toBe(BRANCHES);
    expect(rows.filter((row) => row.status === 'completed').length).toBe(1);
    const broken = rows.filter((row) => row.status === 'errored');
    expect(broken.length).toBe(BRANCHES - 1);

    for (const row of broken) expect(row.error_message).toContain('Authentication error');

    // Every node the search ran is in the result and in the tree.
    expect(result.candidates).toHaveLength(BRANCHES);
    expect(result.report.expansions).toBe(BRANCHES);
    expect(tree.filter((node) => node.depth === 1)).toHaveLength(BRANCHES);

    const answered = result.candidates.filter((candidate) => candidate.incomplete === null);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.artifact).toContain('let best = t[0]');

    // The broken nodes carry their cause in the result.
    const cut = result.candidates.filter((candidate) => candidate.incomplete !== null);
    expect(cut).toHaveLength(BRANCHES - 1);

    for (const candidate of cut) {
      expect(candidate.incomplete).toStartWith('errored after');
      expect(candidate.incomplete).toContain('Authentication error');
      // Unmeasured: this preset measures nothing.
      expect(candidate.measured).toBeNull();
      expect(candidate.score).toBeNull();
      expect(candidate.unmeasurable).toBeNull();
    }

    // `stop` names what ended it: the width was spent, not a `budget` cap the call never passed.
    expect(result.report.stop).toBe('settled');
  });
});
