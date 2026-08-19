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
 * WHAT IS UNDER TEST IS BOUNDEDNESS AND ATTRIBUTION, never a magnitude. `levelProgressMs`
 * is a fixture value here for the reason the judge-call timeout is one in its own suite: a
 * bound whose only value is one measured turn envelope cannot be exercised by a test that
 * has to finish. The relationship asserted — the barrier ends its wait at the envelope it
 * was given, names the cause, and leaves no row reading `running` — is the same one
 * {@link LEVEL_PROGRESS_ENVELOPE_MS} runs in production. The derivation of that number
 * lives on the constant, where the measurement it comes from is stated.
 *
 * THE PROVIDERS ARE FAKE AND EXACT. One raises the upstream authentication error verbatim;
 * one never resolves at all. Both are what the measured run met, and neither costs a
 * credential or twenty minutes to reproduce.
 */
import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
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

/* ── The two providers the measured run actually met ───────────────────────── */

/** Raises the upstream authentication error on every call, exactly as the expired
 *  credential did. Stateless, so one instance serves every arm. */
const RAISING_MODEL = new MockLanguageModelV3({
  provider: 'fake',
  modelId: 'fake-raising',
  doGenerate: () => Promise.reject(new Error(UPSTREAM)),
});

/** Never answers and never fails — the promise the barrier used to wait on forever.
 *  `withResolvers` without its resolvers is the honest spelling of that. */
const SILENT_MODEL = new MockLanguageModelV3({
  provider: 'fake',
  modelId: 'fake-silent',
  doGenerate: () => Promise.withResolvers<never>().promise,
});

/**
 * One node answers and every other node is silent.
 *
 * The answering node is chosen by its own SEED rather than by a call counter: siblings
 * run concurrently under one barrier, so a counter would pick whichever node the
 * scheduler happened to start first and could split one node's turns across both
 * behaviours. A seed is unique per sibling — each carries its own diversity angle — so
 * this keeps exactly one node answering across all of its steps.
 */
function oneAnsweringProvider(): MockLanguageModelV3 {
  let chosen: string | null = null;
  return new MockLanguageModelV3({
    provider: 'fake',
    modelId: 'fake-one-answers',
    doGenerate: ({ prompt }) => {
      let seed = '';
      for (const message of prompt) {
        if (message.role === 'user') seed = JSON.stringify(message.content);
      }
      chosen ??= seed;
      if (seed !== chosen) return Promise.withResolvers<never>().promise;
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
  return new MockLanguageModelV3({
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
  readonly logger: RecordingLogger;
  readonly elapsedMs: number;
}

const PROGRESS_MS = 250;

async function runWith(model: MockLanguageModelV3): Promise<SilentRun> {
  const { rt } = createTestRuntime();
  // A real file, so a node that reads before it answers reads something. The read is what
  // makes a step a step: a text-only turn ends the loop, so a node cannot demonstrate
  // progress over several steps without a tool call in each of them.
  await rt.storage.vfs.mkdir('candidate', { recursive: true });
  await rt.storage.vfs.writeFile(REFERENCE_PATH, REFERENCE);
  const logger = createRecordingLogger();
  const startedAt = Date.now();
  const result = await runSwarm(
    { rt, model, mode: 'build', logger, maxSteps: NODE_STEPS, levelProgressMs: PROGRESS_MS },
    resolved(),
  );
  const elapsedMs = Date.now() - startedAt;
  const rows = rt.storage.sql<HeadJournalRow>`
    SELECT id, parent_id, root_id, depth, task, rationale, status, spawned_at,
           completed_at, token_input, token_output, token_cache_read, token_cache_write,
           token_cache_write_1h, token_reasoning, neurons, wall_clock_ms, summary,
           error_message, merge_strategy
    FROM head_journal ORDER BY spawned_at`;
  return { result, rows, logger, elapsedMs };
}

describe('a level whose nodes never answer', () => {
  test('ends the run with a refusal naming why, and settles every row', async () => {
    const { result, rows, logger, elapsedMs } = await runWith(SILENT_MODEL);

    // A REFUSAL and not a report: a run that crowned nothing over a level it never heard
    // from has a cause, and `stop:'budget'` would have said it ran out of room instead.
    expect('reason' in result).toBe(true);
    const refusal = 'reason' in result ? result : null;
    expect(refusal?.reason).toBe('unavailable');
    expect(refusal?.error).toContain('recorded nothing');
    expect(refusal?.error).toContain(String(PROGRESS_MS));
    expect(refusal?.error).toContain('depth 1');

    // BOUNDED. The bound is the envelope the run was given, and the barrier waits it once
    // for a whole concurrent wave rather than once per sibling — so a generous multiple of
    // one envelope still fails a barrier that waits per node, and any multiple at all
    // fails one that never stops.
    expect(elapsedMs).toBeLessThan(PROGRESS_MS * 8);

    // THE STORE. Every node this run opened is settled, with the cause on the row.
    expect(rows.length).toBe(BRANCHES);
    for (const row of rows) {
      expect(row.status).not.toBe('running');
      expect(row.completed_at).toBeGreaterThan(0);
      expect(row.error_message).toContain('recorded nothing');
    }

    // And it is attributed per node rather than as one anonymous stop.
    const silent = logger.emitted.filter((line) => line.event === 'swarm.node_silent');
    expect(silent.length).toBe(BRANCHES);
    for (const line of silent) {
      expect(line.fields.envelope_ms).toBe(PROGRESS_MS);
      expect(Number(line.fields.idle_ms)).toBeGreaterThanOrEqual(PROGRESS_MS);
    }
  });

  test('a level that answered once keeps that answer and settles only the silent', async () => {
    // The boundary: giving up on a member NARROWS the run, and only a level that produced
    // nothing at all ends it. A barrier that refused on the first silent sibling would
    // throw away work the search had already paid for.
    const { result, rows, elapsedMs } = await runWith(oneAnsweringProvider());

    expect('reason' in result).toBe(false);
    expect(elapsedMs).toBeLessThan(PROGRESS_MS * 40);

    expect(rows.length).toBe(BRANCHES);
    const answered = rows.filter((row) => row.status === 'completed');
    const silent = rows.filter((row) => row.error_message?.includes('recorded nothing') ?? false);
    expect(answered.length).toBe(1);
    expect(silent.length).toBe(BRANCHES - 1);
    // No row is left mid-flight either way, which is the whole claim.
    for (const row of rows) {
      expect(row.status).not.toBe('running');
      expect(row.completed_at).toBeGreaterThan(0);
    }
  });

  test('a node slower than the envelope survives it by making progress', async () => {
    // THE DIFFERENCE BETWEEN THE TWO KINDS OF BOUND, and the reason the barrier reads the
    // journal instead of a stopwatch. Every node here outlives one envelope and none is
    // ever silent for one, so a flat deadline would cut all three off mid-work while this
    // barrier lets them finish. Without this arm a refactor to a runtime bound passes.
    const pauseMs = Math.floor(PROGRESS_MS / 2);
    const { result, rows } = await runWith(slowSteppingProvider(pauseMs));

    expect('reason' in result).toBe(false);
    expect(rows.length).toBe(BRANCHES);
    for (const row of rows) {
      expect(row.status).toBe('completed');
      // The load-bearing number: the node's own recorded lifetime is past the envelope it
      // was watched against, and it was not given up on.
      expect(row.wall_clock_ms).toBeGreaterThan(PROGRESS_MS);
      expect(row.error_message).toBeNull();
    }
  });
});
