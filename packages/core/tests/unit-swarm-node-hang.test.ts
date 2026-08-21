/**
 * A NODE THAT FAILED IS NOT A NODE STILL WORKING, and a level cannot wait forever.
 *
 * WHAT WAS MEASURED, and why this suite exists. One credentialled run of
 * `tests/evals/swarm.eval.ts` against a worker proxy whose upstream Cloudflare login had
 * expired left three depth-1 heads at `status:'running'`, `completed_at: NULL`, ZERO
 * steps, for sixty-three minutes — no store write, no exit — while their three siblings
 * errored in about a second with a clear upstream message. Two separate defects sat
 * behind that, and both are asserted here:
 *
 *   - THE STORE COULD NOT SAY. `head_journal.status` reads `running` from `insertSpawn`
 *     until `recordReport` replaces it, so any path that reaches neither leaves a row
 *     claiming a node is mid-flight for the life of the store. That is `null`-for-absent
 *     and `null`-for-broken in one column: the engine had already counted the node as one
 *     it could not measure while the journal still said it was working.
 *   - THE BARRIER COULD NOT STOP. The wave was awaited with `Promise.allSettled`, and
 *     `allSettled` over a promise nothing can settle waits for the life of the process.
 *
 * THE WRITE SEQUENCE ONE NODE PRODUCES, since the defect is a gap in it. `runNodeAgent`
 * provisions the home, then `insertSpawn` writes the `head_journal` row as `running` with
 * `completed_at` NULL and no usage columns; then the loop runs and each finished step
 * INSERTs a `head_steps` row through `appendStep`, which is the only progress record there
 * is; then `recordReport` replaces the status with the report's own — `completed`,
 * `errored`, `aborted` or `budget_exceeded` — and stamps `completed_at`, the usage columns
 * and `error_message`. `abandonRunning` is the only other writer of that status.
 *
 * WHICH OF THOSE THE HUNG NODES REACHED: the first and nothing after it. Zero `head_steps`
 * rows means no step ever FINISHED, and `runHeadInference` catches every throw into an
 * `errored` report, so a node that neither stepped nor errored did not receive a model
 * response and did not fail trying — it was still inside its first `generateText` call
 * with nothing in this tree able to end it.
 *
 * WHERE THE BOUND LIVES NOW, and it is not this file's and not the barrier's. A node runs
 * on the shared turn loop, whose stall watchdog cuts a step where NOTHING flows — no
 * provider chunk, no tool result — so a request that goes silent before its first chunk is
 * ended from INSIDE the node and arrives at the barrier as a named failure. That is the
 * capability the node acquired by being put on the shared loop: the actor has had it all
 * along, and the node lacked it PRECISELY because it ran a loop of its own.
 *
 * The level clock that used to sit outside the members is gone. It was never a measured
 * quantity — reusing a measured constant does not measure a different thing — and its
 * first live outing gave up on three nodes at 600,002 / 600,028 / 600,029 ms and reported
 * "a provider or transport that is not answering" while that provider answered a direct
 * request in 1.5 s. It could not tell a node that never started from one legitimately
 * waiting, and now that a node can background work and await a wake, no elapsed-time
 * instrument can.
 *
 * WHAT IS UNDER TEST IS BOUNDEDNESS AND ATTRIBUTION, never a magnitude. `stallTimeoutMs`
 * is a fixture value here for the reason the judge-call timeout is one in its own suite: a
 * bound whose only value is five minutes cannot be exercised by a test that has to finish.
 * The relationship asserted — a step where nothing flows ends, names itself, and leaves no
 * row reading `running` — is the same one {@link STALL_TIMEOUT_MS} runs in production, and
 * the derivation of that number lives on the constant beside the 30 s detach threshold it
 * was reasoned against.
 *
 * THE PROVIDERS ARE FAKE AND EXACT. One raises the upstream authentication error verbatim;
 * one never resolves at all. Both are what the measured run met, and neither costs a
 * credential or twenty minutes to reproduce.
 */
import { describe, expect, test } from 'bun:test';
import type { MockLanguageModelV3 } from 'ai/test';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import { createTestRuntime } from './helpers';
import { createRecordingLogger } from '../src/obs/index';
import type { RecordingLogger, Refusal } from '../src/obs/index';
import { HeadJournal } from '../src/heads/journal';
import { nodeWallClockEnvelopeMs, runNodeAgent } from '../src/strategy/node-agent';
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

/** A tiny step envelope: every arm here is decided on a node's FIRST call, so a larger
 *  one would only buy the fixture room it never uses. */
const NODE_STEPS = 4;

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

/** Never answers and never fails — the promise the barrier used to wait on forever.
 *  `withResolvers` without its resolvers is the honest spelling of that. */
const SILENT_MODEL = scriptedTurnModel({
  provider: 'fake',
  modelId: 'fake-silent',
  doGenerate: () => Promise.withResolvers<never>().promise,
});

/**
 * One node answers; every other node meets `siblings`.
 *
 * The answering node is chosen by its own SEED rather than by a call counter: siblings
 * run concurrently under one barrier, so a counter would pick whichever node the
 * scheduler happened to start first and could split one node's turns across both
 * behaviours. A seed is unique per sibling — each carries its own diversity angle — so
 * this keeps exactly one node answering across all of its steps.
 *
 * BOTH SIBLING FATES ARE THE MEASURED ONES. `silent` is the provider that never answers;
 * `raising` is the expired credential, which is what the live `preset:'ideate'` drill met
 * partway through its wave — one node had already reported when the login went.
 */
function oneAnsweringProvider(siblings: 'silent' | 'raising'): MockLanguageModelV3 {
  let chosen: string | null = null;
  return scriptedTurnModel({
    provider: 'fake',
    modelId: `fake-one-answers-${siblings}`,
    doGenerate: ({ prompt }) => {
      let seed = '';
      for (const message of prompt) {
        if (message.role === 'user') seed = JSON.stringify(message.content);
      }
      chosen ??= seed;
      if (seed !== chosen) {
        return siblings === 'silent'
          ? Promise.withResolvers<never>().promise
          : Promise.reject(new Error(UPSTREAM));
      }
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
 * A node that takes LONGER THAN ONE ENVELOPE IN TOTAL while never being silent for one —
 * the population a runtime bound would kill and a progress bound must not.
 *
 * It reads the reference, then reports, then closes, pausing before each answer. Every gap
 * is inside the envelope and the sum of them is outside it, which is the whole difference
 * between the two kinds of bound: the measured healthy nodes ran 1,216,358 ms with a step
 * every 55,289 ms, so this is their shape at test scale rather than a contrived one.
 *
 * REAL TIME, DELIBERATELY, and the only instrument that can answer this question. The
 * watchdog under test IS a `setTimeout` re-armed off `Date.now()`, so a frozen clock stops
 * it firing and a frozen `Date.now()` reads every member as idle for zero — the arm would
 * pass against a bound that does not exist. The pause is also cheaper than the
 * alternative: exceeding the envelope on real work alone would need roughly twenty steps
 * of VFS and SQL per node instead of three sleeps.
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
    maxSteps: NODE_STEPS,
    // The node's own deadline, which neither arm here reaches: both providers fail or
    // stall on the first call, so nothing gets far enough to run a clock down. Declared
    // rather than omitted because a node with no deadline has no clock at all. Taken
    // from the shared derivation rather than re-multiplied here, so a change to how a
    // node's envelope is derived reaches this fixture instead of passing it by.
    maxWallClockMs: nodeWallClockEnvelopeMs(NODE_STEPS),
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

/* ── A level whose nodes never answer ends the run ─────────────────────────── */

interface SilentRun {
  readonly result: SwarmResult | Refusal;
  readonly rows: readonly HeadJournalRow[];
  /** The tree the run actually wrote — the store the drill's own database was read back
   *  from, where a dropped sibling leaves no row at all. */
  readonly tree: readonly SearchNode[];
  readonly logger: RecordingLogger;
  readonly elapsedMs: number;
}

const STALL_MS = 250;

async function runWith(
  model: MockLanguageModelV3,
  call: ResolvedSwarm = resolved(),
): Promise<SilentRun> {
  const { rt } = createTestRuntime();
  // A real file, so a node that reads before it answers reads something. The read is what
  // makes a step a step: a text-only turn ends the loop, so a node cannot demonstrate
  // progress over several steps without a tool call in each of them.
  await rt.storage.vfs.mkdir('candidate', { recursive: true });
  await rt.storage.vfs.writeFile(REFERENCE_PATH, REFERENCE);
  const logger = createRecordingLogger();
  const startedAt = Date.now();
  const result = await runSwarm(
    { rt, model, mode: 'build', logger, maxSteps: NODE_STEPS, stallTimeoutMs: STALL_MS },
    call,
  );
  const elapsedMs = Date.now() - startedAt;
  const rows = rt.storage.sql<HeadJournalRow>`
    SELECT id, parent_id, root_id, depth, task, rationale, status, spawned_at,
           completed_at, token_input, token_output, token_cache_read, token_cache_write,
           token_cache_write_1h, token_reasoning, neurons, wall_clock_ms, summary,
           error_message, merge_strategy
    FROM head_journal ORDER BY spawned_at`;
  const tree = rt.storage.sql<SearchNode>`
    SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
  return { result, rows, tree, logger, elapsedMs };
}

describe('a level whose nodes never answer', () => {
  test('every node ends itself, and the level that produced nothing ends the run by name', async () => {
    const { result, rows, logger, elapsedMs } = await runWith(SILENT_MODEL);

    // A REFUSAL and not a report: a run that crowned nothing over a level that produced
    // nothing has a cause, and `stop:'budget'` would have said it ran out of room instead.
    expect('reason' in result).toBe(true);
    const refusal = 'reason' in result ? result : null;
    expect(refusal?.reason).toBe('unavailable');
    expect(refusal?.error).toContain('depth 1');
    expect(refusal?.error).toContain('produced no candidate');
    // THE CAUSE IS QUOTED, per node. A count alone is what made a dead provider read as
    // `best: null` with nothing anywhere saying why.
    expect(refusal?.error).toContain('stalled');
    for (const row of rows) expect(refusal?.error).toContain(row.id);

    // BOUNDED, and bounded from INSIDE each node: nothing outside the members is watching
    // a clock any more. A generous multiple of one stall envelope still fails a barrier
    // that waits forever, which is the defect this replaces.
    expect(elapsedMs).toBeLessThan(STALL_MS * 20);

    // THE STORE. Every node this run opened is settled, with its own cause on its own row
    // — written by the node's own report rather than by a sweep at the level above.
    expect(rows.length).toBe(BRANCHES);
    for (const row of rows) {
      expect(row.status).toBe('errored');
      expect(row.completed_at).toBeGreaterThan(0);
      expect(row.error_message).toContain('stalled');
    }

    // Attributed per node in the stream too, through the ordinary branch-failure event
    // rather than a second vocabulary only a clock could reach.
    const failed = logger.emitted.filter((line) => line.event === 'swarm.branch_failed');
    expect(failed.length).toBe(BRANCHES);
    for (const line of failed) expect(String(line.fields.error)).toContain('stalled');
    // THE DELETED PATH, asserted absent: no event of the level clock's vocabulary is
    // emitted at all, so a re-introduced clock fails here rather than passing quietly.
    expect(logger.emitted.filter((line) => line.event === 'swarm.node_silent')).toEqual([]);
    expect(logger.emitted.filter((line) => line.event === 'swarm.level_silent')).toEqual([]);
  });

  test('a level that answered once keeps that answer and reports the rest', async () => {
    // The boundary: losing a member NARROWS the run, and only a level that produced
    // nothing at all ends it. A barrier that refused on the first failed sibling would
    // throw away work the search had already paid for.
    const { result, rows, elapsedMs } = await runWith(oneAnsweringProvider('silent'));

    expect('reason' in result).toBe(false);
    expect(elapsedMs).toBeLessThan(STALL_MS * 60);

    expect(rows.length).toBe(BRANCHES);
    const answered = rows.filter((row) => row.status === 'completed');
    const stalled = rows.filter((row) => row.error_message?.includes('stalled') ?? false);
    expect(answered.length).toBe(1);
    expect(stalled.length).toBe(BRANCHES - 1);
    // No row is left mid-flight either way, which is the whole claim.
    for (const row of rows) {
      expect(row.status).not.toBe('running');
      expect(row.completed_at).toBeGreaterThan(0);
    }

    // AND THE RUN REPORTS THE REST RATHER THAN SHEDDING IT. A node that ended `errored`
    // was thrown at the barrier, so a caller saw a smaller wave and no reason for it.
    if ('reason' in result) return;
    expect(result.candidates).toHaveLength(BRANCHES);
    for (const candidate of result.candidates.filter((entry) => entry.incomplete !== null)) {
      expect(candidate.incomplete).toContain('stalled');
      expect(candidate.measured).toBeNull();
      expect(candidate.score).toBeNull();
    }
    // THE RANKING IS UNTOUCHED BY THAT: an unfinished node is not measured, not scored
    // and cannot be crowned, so the node that answered is still the one that wins on the
    // instrument's own number.
    expect(result.best?.incomplete).toBeNull();
    expect(result.best?.measured?.value).toBe(N - 1);
  });

  test('a node slower than the envelope survives it, because the bound is FLOW and not time', async () => {
    // THE DIFFERENCE BETWEEN THE TWO KINDS OF BOUND, and the reason a runtime deadline
    // cannot be substituted here. Every node outlives one stall envelope in total and none
    // is ever silent for one, so a flat deadline would cut all three off mid-work while
    // the watchdog lets them finish. Without this arm a refactor to a runtime bound passes.
    const pauseMs = Math.floor(STALL_MS / 2);
    const { result, rows } = await runWith(slowSteppingProvider(pauseMs));

    expect('reason' in result).toBe(false);
    expect(rows.length).toBe(BRANCHES);
    for (const row of rows) {
      expect(row.status).toBe('completed');
      // The load-bearing number: the node's own recorded lifetime is past the envelope it
      // was watched against, and it was not cut off.
      expect(row.wall_clock_ms).toBeGreaterThan(STALL_MS);
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
      oneAnsweringProvider('raising'), resolvedIdeate(),
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
