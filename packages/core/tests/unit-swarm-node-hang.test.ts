/**
 * A DEFINITIVE NODE FAILURE IS NOT A NODE STILL WORKING.
 *
 * One live run left three nodes `running` with no steps after an upstream
 * credential expired, while their siblings recorded the authentication error.
 * The durable requirement survives the time-policy cutover: a provider or host
 * error must settle the node row and retain its cause, and a flat run must
 * return every failed candidate with that reason.
 *
 * Elapsed silence is deliberately not a failure now. The shared turn loop has
 * no watchdog or timeout retry, so this suite no longer invents a small clock to
 * turn a pending provider into an error. Its slow-node arm instead proves that
 * active work may outlive any former envelope and still complete.
 */
import { describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { createTestRuntime } from './helpers';
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

/** The exact string the expired credential produced, kept verbatim: the point of the
 *  terminal write is that a human reading the row learns THIS rather than "errored". */
const UPSTREAM = 'Your Cloudflare login is no longer valid. Please run `wrangler login` '
  + '(upstream: Authentication error)';

/* ── A measurable run, small enough that the instrument is not the subject ─── */

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

/** Where the reference sits in the workspace, so a node has a real file to read. */
const REFERENCE_PATH = 'candidate/reference.js';

const BODY = `
const values = shuffle(Array.from({ length: P.n }, (_unused, i) => i + 1));
const tokens = values.map(tok);
const oracle = { greater: meter((a, b) => valueOf(a) > valueOf(b)) };
const decode = (out) => (out === undefined || out === null ? null : valueOf(out));
emitTrials([trial({ tokens }, oracle, decode, P.n)]);
`;

/** One linear scan — what the answering node reports, so the arm that keeps a usable
 *  candidate keeps a real one rather than a string the instrument cannot run. */
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
    // AGENT nodes, which is the only kind that has a journal row to leave lying.
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

/**
 * The FLAT preset, resolved through the real resolver: `ideate` at the drill's own
 * width.
 *
 * It measures nothing and ranks nothing — score:'none', advance:'none', carry:'none' —
 * so what it owes its caller is the whole set of answers its nodes produced. A search
 * that returns one of three has under-delivered its own contract however its nodes
 * fared, which is why this arm asks for no objective and asserts no score.
 */
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

/* ── The two providers the measured run actually met ───────────────────────── */

/** Raises the upstream authentication error on every call, exactly as the expired
 *  credential did. Stateless, so one instance serves every arm. */
const RAISING_MODEL = scriptedTurnModel({
  provider: 'fake',
  modelId: 'fake-raising',
  doGenerate: () => Promise.reject(new Error(UPSTREAM)),
});

/**
 * One node answers; every sibling gets the measured upstream authentication
 * error. The answering node is chosen by its own seed rather than a call
 * counter, because siblings run concurrently.
 */
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

/**
 * A deliberately slow, active provider. It reads the reference, reports, then
 * closes, pausing before each answer. The test reads the node's own
 * `wall_clock_ms`, so real time is the observable contract here: the point is
 * that no default elapsed envelope cuts work which continues to make progress.
 */
function slowSteppingProvider(pauseMs: number): MockLanguageModelV3 {
  return scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-slow-stepping',
    doGenerate: async ({ prompt }) => {
      await Bun.sleep(pauseMs);
      const read = prompt.some((message) => message.role === 'tool');
      const reported = prompt.filter((message) => message.role === 'tool').length > 1;
      const content: LanguageModelV3Content[] = reported
        ? [{ type: 'text', text: 'Reported: a single linear scan.' }]
        : read
          ? [{
            type: 'tool-call',
            toolCallId: 'report-1',
            toolName: 'report',
            input: JSON.stringify({
              status: 'completed',
              content: `A single scan is enough.\n\n\`\`\`javascript\n${OPTIMAL}\`\`\``,
            }),
          }]
          : [
            { type: 'text', text: 'Reading the current implementation first.' },
            {
              type: 'tool-call',
              toolCallId: 'read-1',
              toolName: 'file',
              input: JSON.stringify({ action: 'read', path: REFERENCE_PATH }),
            },
          ];
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

/* ── Running one node directly, to reach the transport ─────────────────────── */

interface NodeFixture {
  readonly input: NodeAgentInput;
  readonly deps: NodeAgentDeps;
  readonly journal: HeadJournal;
}

function nodeFixture(over?: { readonly host?: NodeAgentDeps['host'] }): NodeFixture {
  const { rt } = createTestRuntime();
  const journal = new HeadJournal(rt.storage.sql);
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
    rt,
    model: RAISING_MODEL,
    journal,

    // The node's own deadline, which neither arm here reaches: both providers fail or
    // stall on the first call, so nothing gets far enough to run a clock down. Declared
    // rather than omitted because a node with no deadline has no clock at all. Taken
    // from the shared derivation rather than re-multiplied here, so a change to how a
    // node's envelope is derived reaches this fixture instead of passing it by.
    maxWallClockMs: 60_000,
    logger: createRecordingLogger(),
  };
  if (over?.host !== undefined) deps.host = over.host;
  return { input, deps, journal };
}

/* ── A node that failed is distinguishable from a node still working ───────── */

describe('a node that failed is not a node still working', () => {
  test('a transport that raises leaves a terminal row with the cause chained', async () => {
    // A host is an RPC to another Durable Object; a rejection there arrives with no
    // report behind it, which is the one path that reached neither terminal writer.
    const { input, deps, journal } = nodeFixture({
      host: () => Promise.reject(new Error(UPSTREAM)),
    });

    let failure: Error | null = null;
    try {
      await runNodeAgent(input, deps);
    } catch (cause) {
      failure = cause instanceof Error ? cause : null;
    }

    // The failure is a VALUE the search can read, not a swallowed one: it names what we
    // were doing and keeps the upstream message as its cause.
    expect(failure).not.toBeNull();
    expect(failure?.message).toContain('run node n1');
    const cause = failure?.cause;
    expect(cause instanceof Error ? cause.message : '').toBe(UPSTREAM);

    // The denominator: the row has to EXIST before its status can be asserted, because a
    // node that was never spawned and a node that was spawned and abandoned are the two
    // states this whole suite is about telling apart.
    const row = journal.readHead('n1');
    expect(row).not.toBeNull();
    expect(row?.status).toBe('errored');
    // Greater than zero rather than not-null: an absent row would read `undefined` here
    // and satisfy a not-null assertion, which is the confusion under test.
    expect(row?.completed_at).toBeGreaterThan(0);
    expect(row?.error_message).toContain(UPSTREAM);
    // Absent and not zero: no report came back, so nothing can say what the node spent.
    expect(row?.token_input).toBeNull();
  });

  test('a provider that raises inside the loop lands the same terminal row', async () => {
    // The other half of the measured pair — the siblings that errored in about a second.
    // Their path already reported; asserted here so the two failures are known to land
    // the SAME readable status rather than one row and one silence.
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
  /** The tree the run actually wrote — the same store the live view reads. */
  readonly tree: readonly SearchNode[];
}

async function runWith(
  model: MockLanguageModelV3,
  call: ResolvedSwarm = resolved(),
): Promise<SwarmRunResult> {
  const { rt } = createTestRuntime();
  await rt.storage.vfs.mkdir('candidate', { recursive: true });
  await rt.storage.vfs.writeFile(REFERENCE_PATH, REFERENCE);
  const logger = createRecordingLogger();
  const result = await runSwarm(
    { rt, model, mode: 'build', logger },
    call,
  );
  const rows = rt.storage.sql<HeadJournalRow>`
    SELECT id, parent_id, root_id, depth, task, rationale, status, spawned_at,
           completed_at, token_input, token_output, token_cache_read, token_cache_write,
           token_cache_write_1h, token_reasoning, neurons, wall_clock_ms, summary,
           error_message, merge_strategy
    FROM head_journal ORDER BY spawned_at`;
  const tree = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
  return { result, rows, tree };
}

describe('a slow level has no default envelope', () => {
  test('nodes complete after as much active work as they need', async () => {
    const pauseMs = 125;
    const { result, rows } = await runWith(slowSteppingProvider(pauseMs), resolved());

    expect('reason' in result).toBe(false);
    expect(rows).toHaveLength(BRANCHES);
    for (const row of rows) {
      expect(row.status).toBe('completed');
      expect(row.wall_clock_ms).toBeGreaterThan(pauseMs);
      expect(row.error_message).toBeNull();
    }
  });
});

/* ── A flat preset owes its caller every node it ran ───────────────────────── */

/**
 * THE DRILL THIS CLOSES, run on this box on 2026-08-20: `agents action=swarm
 * preset=ideate branches=3 depth=1` against a workers-ai model on a local workspace.
 * Three nodes ran; one reported, and the signed-in proxy's Cloudflare login expired
 * under the other two. The tool result carried `candidates: 1`, `report.expansions: 1`
 * and `report.stop: 'budget'` with `resumed: null`, while the drill workspace's own
 * database held ONE depth-1 `search_nodes` row against THREE `head_journal` rows — one
 * `completed`, two `errored` with "Your Cloudflare login is no longer valid" on each.
 * The caller recovered the other two answers out of workspace files.
 *
 * ONE LINE MADE ALL OF THAT. A node whose report said `errored` was thrown out of
 * `expandChild`, so the barrier read it as a member that never arrived: no candidate, no
 * tree row, no record, and `lost` counting it — which is why `stop` said `budget` about a
 * call that passed no cap. The throw predated `Expansion.incomplete`, the mechanism that
 * already carries an unfinished node without measuring it, and the two disagreed.
 *
 * `ideate` is documented as returning "a set of distinct approaches, unranked", so a
 * 3-branch ideate returning one candidate under-delivers its own contract however its
 * nodes fared. What it owes is every node it ran: the ones that answered with their
 * answers, the ones that did not with their reason.
 */
describe('a flat preset returns every node it ran', () => {
  test('a 3-branch ideate returns 3 candidates when the credential dies under two of them', async () => {
    const { result, rows, tree } = await runWith(
      oneAnsweringProvider(), resolvedIdeate(),
    );
    if ('reason' in result) throw new Error(`the run must not refuse: ${result.error}`);

    // THE DRILL'S OWN SHAPE, asserted first as the denominator: three nodes ran, one
    // reported and two met the expired credential. A result of three candidates over a
    // wave of one would satisfy the claim below for the wrong reason.
    expect(rows.length).toBe(BRANCHES);
    expect(rows.filter((row) => row.status === 'completed').length).toBe(1);
    const broken = rows.filter((row) => row.status === 'errored');
    expect(broken.length).toBe(BRANCHES - 1);
    for (const row of broken) expect(row.error_message).toContain('Authentication error');

    // THE CONTRACT: every node the search ran is in the result, and in the tree — where
    // the drill's database had one row for three nodes.
    expect(result.candidates).toHaveLength(BRANCHES);
    expect(result.report.expansions).toBe(BRANCHES);
    expect(tree.filter((node) => node.depth === 1)).toHaveLength(BRANCHES);

    // THE ONE THAT ANSWERED carries its answer and has nothing to explain.
    const answered = result.candidates.filter((candidate) => candidate.incomplete === null);
    expect(answered).toHaveLength(1);
    expect(answered[0]?.artifact).toContain('let best = t[0]');

    // THE TWO THAT BROKE carry the cause, in the RESULT, which is where the drill's
    // caller could not read it — it went to the workspace for the answers instead.
    const cut = result.candidates.filter((candidate) => candidate.incomplete !== null);
    expect(cut).toHaveLength(BRANCHES - 1);
    for (const candidate of cut) {
      expect(candidate.incomplete).toStartWith('errored after');
      expect(candidate.incomplete).toContain('Authentication error');
      // Unmeasured rather than measured badly. This preset measures nothing at all, and
      // a broken node would carry no number under one that did.
      expect(candidate.measured).toBeNull();
      expect(candidate.score).toBeNull();
      expect(candidate.unmeasurable).toBeNull();
    }

    // AND `stop` NAMES WHAT ENDED IT. The run spent its whole configured width and had
    // nothing left to select. `budget` is what sent the drill's reader looking for a cap
    // the call never passed.
    expect(result.report.stop).toBe('settled');
  });
});
