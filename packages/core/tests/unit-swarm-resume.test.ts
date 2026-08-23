/**
 * THE SECOND-SEARCH DEFECT, AS A TEST: a swarm killed mid-flight is RE-ENTERED by the
 * real job-resume path, not started again.
 *
 * WHAT WAS MEASURED IN PRODUCTION. A `preset:'ideate'` swarm spawned five heads, the
 * Durable Object idled after the turn and was evicted inside five minutes, and on the
 * next wake `BackgroundJobRunner.recoverJob` reclaimed the job and `resumeBackgroundJob`
 * re-ran the stored input FROM SCRATCH — a second search under a second root, while the
 * first tree sat abandoned. The second died the same way. The job settled
 * `completed — took 18m` carrying an aborted result, and two ledger rows still read
 * `running iter=0/5` eleven hours later.
 *
 * WHAT "KILLED MID-FLIGHT" MEANS HERE, precisely, because a simulation that cheats
 * proves nothing. An eviction destroys the ISOLATE and keeps the STORAGE, so:
 *
 *   - the first attempt's model FREEZES on the first call of its level-2 wave — a
 *     promise that never settles, which is what an `await` inside a destroyed isolate
 *     looks like from the outside. Nothing settles the run, nothing settles the ledger
 *     row, and nothing settles the journal rows of the nodes that were starting. That is
 *     the exact on-disk state the incident left behind;
 *   - the second attempt keeps the DATABASE and the WORKSPACE — the durable half — and
 *     shares no in-memory state with the first, because every accumulator a swarm run
 *     owns is local to the `runSwarm` call. A fresh call therefore starts from nothing
 *     but the rows, which is what the resume has to work from;
 *   - and it is driven through the REAL path: a `running` row in `background_jobs`, a
 *     `BackgroundJobRunner` with `resume: resumeBackgroundJob` wired over the real
 *     `agents` tool, and `recoverOrphans()`. Nothing here calls `reenterSwarm`.
 *
 * The instrument is real (the registered `exec-ratio` verifier, in the workspace shell)
 * and the model is scripted, for the reason the agent-node suite records: the
 * measurement is the part that must not be faked and the model is the part that must be
 * controlled.
 * Specified by docs/EXPLORATION.md — "A node is an agent", "Inherited context" and
 * "Budget conservation"; docs/MCTS.md for the shared search ledger.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import * as v from 'valibot';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers';
import { MissionGovernor } from '../src/mission-budget';
import { MctsSearchStore, initMctsSearchTable } from '../src/mcts/search-store';
import { initSearchTables } from '../src/mcts/schemas';
import { HeadJournal } from '../src/heads/journal';
import { createRecordingLogger } from '../src/obs/index';
import { createAgentsTool, type AgentsToolDeps, type AgentsToolInput } from '../src/tools/agents-tool';
import { resumeBackgroundJob } from '../src/orchestrator/background-tools';
import { BackgroundJobRunner } from '../src/jobs/runner';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { SignalDelivery } from '../src/orchestrator/signals';
import { readForkRun } from '../src/read-models/fork-runs';
import {
  reconcileInterruptedForks, FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
} from '../src/heads/reconcile';
import { runSwarm } from '../src/strategy/swarm-run';
import { resolveSwarm, swarmValidity } from '../src/strategy/swarm';
import {
  harvestSwarm, initSwarmNodeRecords, recordSwarmNode,
} from '../src/strategy/swarm-resume';
import type { ResolvedSwarm, SwarmConfig } from '../src/strategy/swarm';
import type { Objective } from '../src/strategy/objective';
import type { AgentRuntime } from '../src/types/agent-runtime';
import type { BackendHost, ProgrammaticTurn } from '../src/types/backend-host';
import type { Schedule, SqlExecutor } from '../src/types/primitives';
import type { SearchNode } from '../src/types/mcts';

/* ── the ledger's own collision rule, over the store ──────────────────────── */

const TASK = 'find the largest of 12 opaque tokens in the fewest oracle calls';

function ledgerOnly() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initMctsSearchTable(makeExecRaw(db), sql);
  return new MctsSearchStore(sql);
}

function beganSwarm(store: MctsSearchStore, rootId: string, at: number): void {
  store.begin({
    rootId, task: TASK, engine: 'swarm', rootMsgId: null,
    config: { budget: 4, branches: 2, mode: 'build', maxDepth: 2 }, budget: 4, now: at,
  });
}

describe('the swarm-scoped resume lookup, and what it does about a collision', () => {
  test('returns every running row for the task, newest first, and no other engine\'s', () => {
    const store = ledgerOnly();
    beganSwarm(store, 'older', 1_000);
    beganSwarm(store, 'newer', 2_000);
    // The MCTS row is every condition the query matches on EXCEPT the engine, which is
    // the denominator: without the discriminator this list would hand a judged search's
    // checkpoint to the swarm runner.
    store.begin({
      rootId: 'mcts-row', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 4, branches: 2, mode: 'build' }, budget: 4, now: 3_000,
    });
    // …and it still resumes on its own loop, so the filter is a filter and not a resume
    // that quietly stopped working.
    expect(store.findResumable(TASK, 'build')?.rootId).toBe('mcts-row');

    expect(store.findRunningSwarms(TASK).map((row) => row.rootId)).toEqual(['newer', 'older']);
  });

  test('a settled swarm row is not a resume target, whichever way it settled', () => {
    const store = ledgerOnly();
    beganSwarm(store, 'converged', 1_000);
    beganSwarm(store, 'failed', 2_000);
    beganSwarm(store, 'superseded', 3_000);
    // Each settled at its OWN instant: `list` orders on `updated_at`, so settling all
    // three at one timestamp would make the order below a fact about SQLite's tie-break
    // rather than about the query.
    store.converge('converged', 0, 4_000);
    store.fail('failed', 0, 5_000);
    store.supersede('superseded', 6_000);

    expect(store.findRunningSwarms(TASK)).toEqual([]);
    // And each row says which of the three it was. `superseded` is not `failed`: the run
    // did not break, a newer attempt of the same task took it over, and a reader who
    // cannot tell those apart goes looking for a fault that never happened.
    expect(store.get('converged')?.status).toBe('converged');
    expect(store.get('failed')?.status).toBe('failed');
    expect(store.get('superseded')?.status).toBe('superseded');
    expect(store.list(10).map((row) => [row.rootId, row.status])).toEqual([
      ['superseded', 'superseded'], ['failed', 'failed'], ['converged', 'converged'],
    ]);
  });

  test('supersede is fenced on the row still running, so it cannot reopen a settled one', () => {
    const store = ledgerOnly();
    beganSwarm(store, 'root', 1_000);
    store.converge('root', 0, 2_000);
    store.supersede('root', 3_000);
    expect(store.get('root')?.status).toBe('converged');
  });
});

describe('harvesting a capped swarm', () => {
  function setupHarvest() {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initSearchTables(execRaw, sql);
    initMctsSearchTable(execRaw, sql);
    initSwarmNodeRecords(execRaw);
    const ledger = new MctsSearchStore(sql);
    beganSwarm(ledger, 'harvest-root', 1_000);
    void sql`INSERT INTO search_nodes (id, root_id, task, observation)
      VALUES ('harvest-root', 'harvest-root', ${TASK}, 'root')`;
    return { sql, ledger };
  }

  test('an all-incomplete search has no candidate to report as completed', () => {
    const { sql, ledger } = setupHarvest();
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
      VALUES ('incomplete', 'harvest-root', 'harvest-root', ${TASK}, 'stopped before an answer', 1)`;
    recordSwarmNode(sql, {
      rootId: 'harvest-root',
      nodeId: 'incomplete',
      record: {
        outcome: { kind: 'incomplete', detail: 'evicted before completion' },
        conclusion: null,
        aggregated: [],
        tokens: null,
      },
      now: 2_000,
    });
    expect(harvestSwarm({ sql, ledger }, TASK)).toBeNull();
  });

  test('one malformed record cannot hide another usable candidate', () => {
    const { sql, ledger } = setupHarvest();
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
      VALUES
        ('bad', 'harvest-root', 'harvest-root', ${TASK}, 'bad artifact', 1),
        ('good', 'harvest-root', 'harvest-root', ${TASK}, 'usable answer', 1)`;
    void sql`INSERT INTO swarm_node_records (node_id, root_id, record_json, created_at)
      VALUES ('bad', 'harvest-root', '{', 2_000)`;
    recordSwarmNode(sql, {
      rootId: 'harvest-root',
      nodeId: 'good',
      record: { outcome: null, conclusion: null, aggregated: [], tokens: null },
      now: 2_000,
    });
    const harvest = harvestSwarm({ sql, ledger }, TASK);
    expect(harvest?.candidates.map((candidate) => candidate.nodeId)).toEqual(['good']);
    expect(harvest?.candidates[0]?.artifact).toBe('usable answer');
    expect(harvest?.unreadableNodes).toEqual(['bad']);
    expect(harvest?.publication).toEqual({ state: { kind: 'open' }, caveat: null });
  });

  test('an all-corrupt harvest fails distinctly from an empty search', () => {
    const { sql, ledger } = setupHarvest();
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
      VALUES ('bad', 'harvest-root', 'harvest-root', ${TASK}, 'unreadable answer', 1)`;
    void sql`INSERT INTO swarm_node_records (node_id, root_id, record_json, created_at)
      VALUES ('bad', 'harvest-root', '{', 2_000)`;
    expect(() => harvestSwarm({ sql, ledger }, TASK)).toThrow('none can be decoded');
  });

  test('a sealed candidate carries its breach and publication caveat', () => {
    const { sql, ledger } = setupHarvest();
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
      VALUES ('sealed', 'harvest-root', 'harvest-root', ${TASK}, 'candidate answer', 1)`;
    const breach = {
      floor: {
        value: 1_200,
        proof: 'every token appears in one comparison',
        kind: 'certificate' as const,
        bestKnownHonest: 2_992,
      },
      measured: { kind: 'measured' as const, value: 900, detail: 'oracle calls' },
      margin: 0.599,
      hypotheses: ['floor_wrong', 'verifier_gameable'] as const,
    };
    recordSwarmNode(sql, {
      rootId: 'harvest-root',
      nodeId: 'sealed',
      record: {
        outcome: {
          kind: 'sealed',
          measurement: breach.measured,
          breach,
        },
        conclusion: 'candidate answer',
        aggregated: [],
        tokens: 10,
      },
      now: 2_000,
    });
    const harvest = harvestSwarm({ sql, ledger }, TASK);
    expect(harvest?.candidates[0]?.breach).toEqual(breach);
    expect(harvest?.publication.state).toEqual({ kind: 'sealed', breach, clearedBy: null });
    expect(harvest?.publication.caveat).toContain('not publishable');
  });
});

/* ── the task, measured for real ──────────────────────────────────────────── */

/** Small because every measurement spawns a real process in the workspace shell. */
const N = 12;

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

/** One linear scan: n-1 comparisons, the optimum, and what every node reports. */
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
        params: { n: N, seed: 7 },
        reference: REFERENCE,
        body: BODY,
        targetOps: N - 1,
        lowerBoundOps: Math.ceil(N / 2),
      },
    },
  };
}

/** `context:'fork'` so a level-2 node of a RE-ENTERED parent has to inherit that
 *  parent's conversation — which on a resume can only come out of the journal. */
function config(): SwarmConfig {
  return {
    unit: { kind: 'answer' },
    context: 'fork',
    expand: 'sample',
    score: { kind: 'verify' },
    advance: { kind: 'uct' },
    carry: { kind: 'none' },
  };
}

/** The call as the TOOL takes it: the surface is snake_case where the type is not. */
function swarmCall(): AgentsToolInput {
  return {
    action: 'swarm',
    preset: 'custom',
    label: 'resume-proof',
    task: TASK,
    objective: objective(),
    config: config(),
    depth: 2,
    branches: 2,
  };
}

function resolved(): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'custom', label: 'resume-proof', task: TASK,
    objective: objective(), config: config(), depth: 2, branches: 2,
  });
  if ('reason' in call) throw new Error(`the suite's own composition does not resolve: ${call.error}`);
  const illegal = swarmValidity(call);
  if (illegal) throw new Error(`the suite's own composition is not legal: ${illegal.error}`);
  return call;
}

/* ── the model: a node that works, and (optionally) one that freezes ───────── */

const CALL_INPUT_TOKENS = 100;
const CALL_OUTPUT_TOKENS = 40;
/** `usageTotal` is input + output. */
const CALL_TOKENS = CALL_INPUT_TOKENS + CALL_OUTPUT_TOKENS;

interface Script {
  /** `doGenerate` calls served — the provider's own call count. */
  calls: () => number;
  /** How many nodes STARTED, i.e. calls whose prompt held no turn of the node's own. */
  starts: () => number;
  /** Inherited assistant turns in front of each node on its first step, in start order.
   *  Zero means "started from the seed"; non-zero means "inherited a conversation". */
  readonly inherited: number[];
  /**
   * Resolves once {@link FROZEN_NODES} node-starts have frozen — the run's OWN signal
   * that it is stuck where an evicted isolate would be, awaited instead of a guessed
   * sleep. Never resolves for a model that freezes nothing, which is why only the killed
   * attempt awaits it.
   */
  readonly frozen: Promise<void>;
}

/**
 * A node that reads the workspace and reports.
 *
 * Scripted off ITS OWN TURNS rather than a shared counter, because several nodes are
 * mid-loop at once under one barrier and a counter would interleave their scripts. A
 * node's own turns are the assistant messages after the last user message, because
 * inheritance is append-only and the task block is last.
 *
 * `freezeFromStart` is the eviction: from that node-start onward the call returns a
 * promise that never settles, so the run stops exactly where a destroyed isolate would
 * have stopped it — after everything before it was made durable.
 */
function nodeModel(opts: { readonly freezeFromStart?: number } = {}) {
  // Inferred rather than annotated: an anonymous object type here would discard the
  // mock's own type, and `Script` is proven at the return with `satisfies` instead.
  let generations = 0;
  let starts = 0;
  let frozenStarts = 0;
  const inherited: number[] = [];
  const gate = Promise.withResolvers<void>();

  const model = scriptedTurnModel({
    provider: 'fake',
    modelId: 'fake-resume-node',
    doGenerate: async ({ prompt }) => {
      let lastUser = -1;
      for (const [index, message] of prompt.entries()) {
        if (message.role === 'user') lastUser = index;
      }
      const own = prompt.slice(lastUser + 1).filter((message) => message.role === 'assistant').length;
      if (own === 0) {
        starts += 1;
        inherited.push(prompt.slice(0, lastUser).filter((m) => m.role === 'assistant').length);
        if (opts.freezeFromStart !== undefined && starts >= opts.freezeFromStart) {
          frozenStarts += 1;
          if (frozenStarts >= FROZEN_NODES) gate.resolve();
          // THE EVICTION. Never settled and never rejected — the resolvers are simply
          // dropped — so the run stops exactly where a destroyed isolate would stop it,
          // it holds no timer for the event loop to wait on, and its durable rows stay
          // as they were the instant it stopped.
          return Promise.withResolvers<never>().promise;
        }
      }
      generations += 1;

      const content: LanguageModelV3Content[] = [];
      let finish: 'stop' | 'tool-calls' = 'tool-calls';
      if (own === 0) {
        content.push({ type: 'text', text: 'Reading the current implementation first.' });
        content.push({
          type: 'tool-call', toolCallId: `read-${String(generations)}`, toolName: 'file',
          input: JSON.stringify({ action: 'read', path: REFERENCE_PATH }),
        });
      } else if (own === 1) {
        content.push({
          type: 'tool-call', toolCallId: `report-${String(generations)}`, toolName: 'report',
          input: JSON.stringify({
            status: 'completed',
            content: `A single scan is enough.\n\n\`\`\`javascript\n${OPTIMAL}\`\`\``,
          }),
        });
      } else {
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

  const script = {
    calls: () => generations, starts: () => starts, inherited, frozen: gate.promise,
  } satisfies Script;
  return { model, script };
}

/* ── the workspace, and the durable half that survives the kill ───────────── */

async function workspace(): Promise<{ rt: AgentRuntime; db: Database }> {
  const { rt, db } = createTestRuntime();
  await rt.storage.vfs.mkdir('candidate', { recursive: true });
  await rt.storage.vfs.writeFile(REFERENCE_PATH, `// a nested loop over every pair\n${REFERENCE}`);
  return { rt, db };
}

/** A fiber that runs its body inline and keeps the promise, so a test can await the
 *  re-drive the runner started. */
function inlineFiber() {
  const runs: Promise<unknown>[] = [];
  const fiber: Schedule['fiber'] = async (_name, fn) => {
    const body = fn({ stash: () => {}, snapshot: null });
    runs.push(body);
    return body;
  };
  return { fiber, settled: () => Promise.all(runs) };
}

/** An idle agent, so a settle wake routes through `enqueueTurn` — which is what "the
 *  agent learns at its next step" means when no turn is running. */
function idleAgent() {
  const enqueued: ProgrammaticTurn[] = [];
  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async (turn) => { enqueued.push(turn); return { status: 'queued' }; },
    turnInFlight: () => false,
    setTimer: () => {},
  };
  return { enqueued, signals: new SignalDelivery(host) };
}

/** Where the frozen attempt's wave has to be before the test may look at the rows: both
 *  of its level-2 nodes journalled and stuck. Two, because `branches` is two — a gate on
 *  one would let the test read the journal between the two `insertSpawn` writes. */
const FROZEN_NODES = 2;

/** The sanctioned per-call silence window the frozen runs are given, small enough that
 *  a node stuck on its never-settling model ends (retries exhausted) while the test
 *  still owns the clock. No step cap exists to do that any more. */
const FROZEN_CALL_TIMEOUT_MS = 250;

const MISSION_LABEL = 'nightly';

function treeOf(sql: SqlExecutor): SearchNode[] {
  return sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
}

describe('a swarm killed mid-flight is re-entered by the real resume path', () => {
  test('same root, settled scores kept, one ledger row, and the report says it resumed', async () => {
    const { rt, db } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);
    const governor = new MissionGovernor({ storage: { sql: makeSql(db), execRaw: makeExecRaw(db) } });
    governor.declare(MISSION_LABEL, {});
    governor.activate([MISSION_LABEL]);

    // ── ATTEMPT ONE, killed inside its level-2 wave ────────────────────────
    const log = createRecordingLogger();
    const first = nodeModel({ freezeFromStart: 3 });
    const frozen = runSwarm(
      { rt, model: first.model, mode: 'build',  logger: log },
      resolved(),
    );
    // It is never awaited: an evicted activation's `await` never returns either. Held so
    // the reference is deliberate rather than a dropped promise.
    expect(frozen).toBeInstanceOf(Promise);
    // Awaited on the RUN'S OWN signal: both level-2 nodes are journalled and stuck, so
    // everything before them is on disk and nothing more will ever be written.
    await first.script.frozen;

    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(rootId).not.toBe('');
    // The level-1 barrier landed and SAID SO. The ledger row was previously written at
    // `begin` and at the settle barrier only, so an evicted run left `iter=0` on disk
    // and a re-entry had no progress to read.
    expect(log.emitted.map((line) => line.event)).toContain('swarm.checkpoint_reached');
    expect(ledger.get(rootId)).toMatchObject({ status: 'running', iteration: 2, epoch: 0 });
    expect(treeOf(sql).filter((node) => node.depth === 1)).toHaveLength(2);
    expect(treeOf(sql).filter((node) => node.depth === 2)).toHaveLength(0);
    // …and the run holds the two level-2 nodes it was starting, journalled `running`
    // with nothing left that could report them. Exactly the incident's shape.
    expect(journal.listLive().find((run) => run.rootId === rootId)?.running).toBe(FROZEN_NODES);
    // Nothing charged: this attempt was handed no mission scope, so every token below is
    // the SECOND attempt's and a re-charge of settled nodes cannot hide in the total.
    expect(governor.snapshot(MISSION_LABEL)[0]?.spent.tokens ?? 0).toBe(0);
    expect(first.script.calls()).toBeGreaterThan(0);

    // ── ATTEMPT TWO, through the REAL runner path ──────────────────────────
    // The durable half survives (`db`, the workspace); nothing of the first run's memory
    // does, because every accumulator `runSwarm` owns is local to the call.
    const second = nodeModel();
    initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
    const jobs = new BackgroundJobStore(makeSql(db));
    const agent = idleAgent();
    const { fiber, settled } = inlineFiber();
    const notified: string[] = [];
    const deps: AgentsToolDeps = {
      mode: 'build',
      fork: { rt, model: second.model },
      budget: governor,
    };
    const agents = createAgentsTool(deps);
    const runner = new BackgroundJobRunner({
      store: jobs,
      fiber,
      signals: agent.signals,
      resume: (kind, input, mode, signal) =>
        resumeBackgroundJob(() => ({ agents }), kind, input, mode, signal),
      onSettled: (job) => notified.push(job.status),
    });
    // The row the detach left behind: `running`, carrying the stored tool input, with no
    // executor in this isolate. `recoverOrphans` is what a cold activation runs.
    const jobId = 'bgjob-swarm';
    jobs.create({
      id: jobId, kind: 'agents', workMode: 'build', now: Date.now(),
      input: JSON.stringify(swarmCall()),
    });
    await runner.recoverOrphans();
    await settled();

    // ── WHAT THE RE-ENTRY DID ──────────────────────────────────────────────
    // ONE root, and it is the FIRST attempt's. This is the whole defect: the incident
    // produced a second root here.
    const tree = treeOf(sql);
    expect(new Set(tree.map((node) => node.root_id))).toEqual(new Set([rootId]));
    // The tree grew rather than restarted: one root, the two level-1 nodes the first
    // attempt settled, and two the second added at depth 2.
    expect(tree.filter((node) => node.parent_id === null)).toHaveLength(1);
    expect(tree.filter((node) => node.depth === 1)).toHaveLength(2);
    expect(tree.filter((node) => node.depth === 2)).toHaveLength(2);

    // ONE ledger row for the task, converged under the RECLAIMED lease.
    const rows = ledger.list(10).filter((row) => row.engine === 'swarm');
    expect(rows.map((row) => row.rootId)).toEqual([rootId]);
    expect(rows[0]).toMatchObject({ status: 'converged', epoch: 1, iteration: 4 });

    // THE JOB SETTLED ONCE, with a report rather than an aborted result, and the agent
    // was woken once.
    expect(jobs.get(jobId)?.status).toBe('completed');
    expect(notified).toEqual(['completed']);
    expect(agent.enqueued).toHaveLength(1);

    // THE REPORT DISCLOSES THE RESUME. A resumed run that reads like a fresh one hides
    // the eviction from the operator, which is how an 18-minute wall clock over four
    // expansions went unquestioned.
    const report = jobResultReport(jobs.get(jobId)?.result ?? null);
    expect(report.resumed).not.toBeNull();
    expect(report.resumed).toMatchObject({
      rootId,
      inheritedExpansions: 2,
      // The first attempt bought a level-2 wave from inside a node's own tool call and
      // created none of it. The debit is refunded, because nothing exists that it paid
      // for — `depth * branches` is 4, two are on disk, so two are left.
      remainingBudget: 2,
      abandonedNodes: 2,
      superseded: [],
      attempt: 2,
    });
    // SETTLED SCORES SURVIVED: the whole search is FOUR expansions, not the two this
    // activation ran. That number is the claim — a re-entry that forgot the first
    // attempt's candidates would report two, which is what the incident's second search
    // reported about a tree it had abandoned.
    expect(report.expansions).toBe(4);
    // `budget` rather than `settled`, and it is the same answer a FRESH depth-2 run of
    // this shape gives: `depth * branches` is spent while `uct` can still re-widen a
    // depth-1 node, which is a truncated search by the report's own definition. A
    // resumed run does not get a different vocabulary for the same outcome.
    expect(report.stop).toBe('budget');

    // AND NOTHING WAS CHARGED TWICE. The ledger holds exactly what the two providers
    // said they served — the suite's own arithmetic, never a figure read back off the
    // ledger under test — so a re-entry that re-ran the settled nodes would show tokens
    // nobody served.
    const servedSecond = second.script.calls();
    expect(servedSecond).toBeGreaterThan(0);
    const spent = governor.snapshot(MISSION_LABEL)[0]?.spent.tokens ?? 0;
    expect(spent).toBe(servedSecond * CALL_TOKENS);
    // The first attempt's calls went through no mission port at all, so they are not in
    // this total — and the two settled nodes were not re-served either, which is the
    // claim: `servedSecond` covers the two NEW nodes and no more.
    expect(second.script.starts()).toBe(2);

    // A LEVEL-2 NODE OF A RE-ENTERED PARENT INHERITED ITS PARENT'S CONVERSATION. Under
    // `context:'fork'` that prefix can only have come out of the journal, because the
    // parent's own `ModelMessage[]` died with the first attempt.
    expect(second.script.inherited).toHaveLength(2);
    for (const turns of second.script.inherited) expect(turns).toBeGreaterThan(0);

    // THE ZOMBIE IS FENCED. If the first attempt's activation ever came back, its writes
    // carry epoch 0 and cannot move the row this run settled — which is what makes the
    // wake idempotent rather than merely unlikely.
    ledger.checkpoint(rootId, 0, 99, 99, Date.now());
    ledger.fail(rootId, 0, Date.now());
    expect(ledger.get(rootId)).toMatchObject({ status: 'converged', iteration: 4 });

    // AND A SECOND RECOVERY SWEEP SETTLES NOTHING NEW. The job is terminal, so recovery
    // re-delivers the wake it may have lost and re-drives nothing: one settled result.
    await runner.recoverOrphans();
    expect(jobs.get(jobId)?.status).toBe('completed');
    expect(notified).toEqual(['completed']);
    expect(treeOf(sql)).toHaveLength(tree.length);
    expect(ledger.list(10).filter((row) => row.engine === 'swarm')).toHaveLength(1);
  }, 300_000);
});

/**
 * THE OTHER HALF OF THE SAME WAKE, which the suite above leaves out: a real cold
 * activation does not run only `recoverOrphans()`. It also reconciles the fork
 * journal, because a `running` head row cannot be executing in an isolate that
 * has just started, and that reconciliation used to be the FIRST thing an
 * activation did.
 *
 * MEASURED ON THE OWNER'S WORKSPACE, the run before the one the suite above
 * pins: five heads spawned, none reported, and the next activation retired all
 * five with `no executor: spawned, never reported, and retired when a later
 * activation found nothing left that could run it`. The re-entry never ran. The
 * agent was told its work was gone and re-forked by hand.
 *
 * The order was not a race. The sweep was unconditional and synchronous at start
 * of life while the re-drive was conditional — so the sweep won every eviction,
 * and its own message asserted that nothing could run the heads at the moment
 * something still could.
 *
 * Both halves of one activation, in the order an activation runs them.
 */
describe('the start-of-life sweep does not retire a swarm the re-drive can re-enter', () => {
  test('the run is re-entered, and the agent is told nothing was lost', async () => {
    const { rt, db } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);

    // ── ATTEMPT ONE, killed inside its level-2 wave ────────────────────────
    const first = nodeModel({ freezeFromStart: 3 });
    const frozen = runSwarm(
      { rt, model: first.model, mode: 'build',  logger: createRecordingLogger() },
      resolved(),
    );
    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;

    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(rootId).not.toBe('');
    expect(ledger.get(rootId)).toMatchObject({ status: 'running' });
    expect(journal.listLive().find((run) => run.rootId === rootId)?.running).toBe(FROZEN_NODES);

    // ── THE NEXT ACTIVATION ────────────────────────────────────────────────
    const second = nodeModel();
    initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
    const jobs = new BackgroundJobStore(makeSql(db));
    const agent = idleAgent();
    const { fiber, settled } = inlineFiber();
    const agents = createAgentsTool({ mode: 'build', fork: { rt, model: second.model } });
    const runner = new BackgroundJobRunner({
      store: jobs,
      fiber,
      signals: agent.signals,
      resume: (kind, input, mode, signal) =>
        resumeBackgroundJob(() => ({ agents }), kind, input, mode, signal),
    });
    jobs.create({
      id: 'bgjob-swarm', kind: 'agents', workMode: 'build', now: Date.now(),
      input: JSON.stringify(swarmCall()),
    });

    // The activation's own reconciliation, with the resume gate it is supposed to
    // consult. Nothing here calls `reenterSwarm`: the gate is the real runner.
    const retired = await reconcileInterruptedForks({
      journal,
      signals: agent.signals,
      resume: async () => {
        await runner.recoverOrphans();
        return [rootId];
      },
    });
    await settled();

    // NOTHING WAS RETIRED, because the re-drive claimed the run.
    expect(retired).toEqual([]);
    // …and the agent was told nothing. A card saying work was retired is the
    // wrong thing to say about work that is being continued, and it is what sent
    // the owner's agent off to re-fork by hand.
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent))
      .not.toContain(FORK_INTERRUPTED_SIGNAL);
    // No head carries the retirement reason, on either attempt's rows.
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE error_message = ${FORK_INTERRUPTED_REASON}`[0]?.n).toBe(0);

    // THE RUN WAS RE-ENTERED: one root, the first attempt's, grown rather than
    // restarted.
    const tree = treeOf(sql);
    expect(new Set(tree.map((node) => node.root_id))).toEqual(new Set([rootId]));
    expect(tree.filter((node) => node.depth === 2)).toHaveLength(2);
    expect(ledger.list(10).filter((row) => row.engine === 'swarm').map((row) => row.rootId))
      .toEqual([rootId]);

    // AND THE ROSTER STOPPED LYING ANYWAY. The two frozen nodes are no longer
    // counted as running — that was the whole point of the sweep and it is not
    // given up to keep the run alive.
    expect(journal.listLive().find((run) => run.rootId === rootId)?.running ?? 0)
      .not.toBe(FROZEN_NODES);
  }, 300_000);

  test('a run the re-drive REFUSED is retired, and the agent is told', async () => {
    // The other side of the same gate: no durable job exists, so nothing can ever
    // re-enter this run. That is the case the retirement message describes
    // truthfully, and it must still fire — otherwise a genuinely dead fork sits in
    // the roster forever, which is the defect the sweep was built for.
    const { rt, db } = await workspace();
    const sql = rt.storage.sql;
    const journal = new HeadJournal(sql);
    const first = nodeModel({ freezeFromStart: 3 });
    void runSwarm(
      { rt, model: first.model, mode: 'build',  logger: createRecordingLogger() },
      resolved(),
    );
    await first.script.frozen;
    const rootId = firstRoot(sql)?.root_id ?? '';
    initBackgroundJobsTable(makeExecRaw(db), makeSql(db));
    const agent = idleAgent();

    const retired = await reconcileInterruptedForks({
      journal,
      signals: agent.signals,
      // The gate ran and claimed nothing: there was no job to re-drive.
      resume: async () => [],
    });

    expect(retired.map((run) => run.rootId)).toEqual([rootId]);
    expect(retired[0]?.abandoned).toBe(FROZEN_NODES);
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent)).toContain(FORK_INTERRUPTED_SIGNAL);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE error_message = ${FORK_INTERRUPTED_REASON}`[0]?.n).toBe(FROZEN_NODES);
    expect(journal.listLive()).toEqual([]);
  }, 300_000);
});

describe('the start-of-life sweep reaches registry-only jobs', () => {
  test('a wired resume gate runs even when no head or search row exists', async () => {
    let calls = 0;
    await reconcileInterruptedForks({
      journal: {
        markInterrupted: () => [],
        abandonRunning: () => [],
      },
      signals: idleAgent().signals,
      resume: async (roots) => {
        calls += 1;
        expect(roots).toEqual([]);
        return [];
      },
    });
    expect(calls).toBe(1);
  });
});

/**
 * THE STALE-RUNNING DEFECT, AS A TEST: a swarm whose job settled `failed` — the
 * resume cap exhausted, five evictions, "gave up" — left its `mcts_search_runs`
 * row claiming a live executor forever. Measured on the owner's workspace:
 * root `2rye1eyny1efm9583sqye` read `running · 2 reported · 18 stopped · last
 * step 11h ago`, because the only writers of that row sit inside the executor
 * the platform had already destroyed, and the start-of-life sweep closed the
 * journal rows but never the ledger row beside them.
 */
describe('the start-of-life sweep closes a swarm row nothing re-drives', () => {
  test('a refused run\'s ledger row is failed, and the surface stops calling it running', async () => {
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);
    const first = nodeModel({ freezeFromStart: 3 });
    void runSwarm(
      { rt, model: first.model, mode: 'build', callTimeoutMs: FROZEN_CALL_TIMEOUT_MS, logger: createRecordingLogger() },
      resolved(),
    );
    await first.script.frozen;
    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(ledger.get(rootId)).toMatchObject({ status: 'running' });
    const agent = idleAgent();

    const retired = await reconcileInterruptedForks({
      journal,
      signals: agent.signals,
      search: ledger,
      // The gate ran and claimed nothing: this job is past its resume cap.
      resume: async () => [],
    });

    expect(retired.map((run) => run.rootId)).toEqual([rootId]);
    expect(ledger.get(rootId)?.status).toBe('failed');
    // The read model is what the exploration surface renders; through it, a run
    // whose every node stopped is never `running` again.
    expect(readForkRun(sql, rootId)?.status).not.toBe('running');
  }, 300_000);

  test('a claimed run keeps its ledger row for the re-entry to settle', async () => {
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);
    const first = nodeModel({ freezeFromStart: 3 });
    void runSwarm(
      { rt, model: first.model, mode: 'build', callTimeoutMs: FROZEN_CALL_TIMEOUT_MS, logger: createRecordingLogger() },
      resolved(),
    );
    await first.script.frozen;
    const rootId = firstRoot(sql)?.root_id ?? '';
    const agent = idleAgent();

    await reconcileInterruptedForks({
      journal,
      signals: agent.signals,
      search: ledger,
      resume: async () => [rootId],
    });

    // Still the re-drive's row to close or converge; closing it here would
    // fail a search that is about to continue.
    expect(ledger.get(rootId)?.status).toBe('running');
  }, 300_000);

  test('a search-only root is offered to the resume gate before closure', async () => {
    const { rt } = await workspace();
    const ledger = new MctsSearchStore(rt.storage.sql);
    const journal = new HeadJournal(rt.storage.sql);
    beganSwarm(ledger, 'root-search-only', Date.now() - 1_000);
    const offered: string[][] = [];

    await reconcileInterruptedForks({
      journal,
      signals: idleAgent().signals,
      search: ledger,
      resume: async (roots) => {
        offered.push([...roots]);
        return roots;
      },
    });

    expect(offered).toEqual([['root-search-only']]);
    expect(ledger.get('root-search-only')?.status).toBe('running');
  });

  test('a row with no journalled heads closes too, on its own evidence', async () => {
    // A `unit:'thought'` swarm journals no head rows, so the journal sweep has
    // nothing to find and used to return before anything looked at the ledger.
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);
    beganSwarm(ledger, 'root-thought-only', Date.now() - 1_000);
    const agent = idleAgent();

    await reconcileInterruptedForks({
      journal,
      signals: agent.signals,
      search: ledger,
      resume: async () => [],
    });

    expect(ledger.get('root-thought-only')?.status).toBe('failed');
  }, 300_000);

  test('a gate that throws closes nothing', async () => {
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);
    beganSwarm(ledger, 'root-ungated', Date.now() - 1_000);
    const agent = idleAgent();

    await reconcileInterruptedForks({
      journal,
      signals: agent.signals,
      search: ledger,
      resume: async () => {
        throw new Error('the gate could not answer');
      },
    });

    // An unanswered gate is not a refusal. The row survives until an activation
    // whose gate answers decides its fate.
    expect(ledger.get('root-ungated')?.status).toBe('running');
  }, 300_000);
});

/**
 * THE NAME, END TO END: what the caller passes to `agents.swarm` is what the
 * exploration surface calls the run. The engine writes it as the search root's
 * own label — the field a root has always had and never filled, which is why
 * the tree drew `(root)` — and the read model hands it back.
 */
describe('a named swarm is called by its name', () => {
  test('the name reaches the root row and the run summary', async () => {
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const named = resolveSwarm({
      preset: 'custom', label: 'resume-proof', name: 'token duel', task: TASK,
      objective: objective(), config: config(), depth: 1, branches: 2,
    });
    if ('reason' in named) throw new Error(`the suite's own composition does not resolve: ${named.error}`);
    const model = nodeModel();
    await runSwarm(
      { rt, model: model.model, mode: 'build', logger: createRecordingLogger() },
      named,
    );

    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(rootId).not.toBe('');
    // The root carries it, so the tree draws the name where it drew `(root)`.
    expect(sql<{ action: string }>`
      SELECT action FROM search_nodes WHERE id = ${rootId}`[0]?.action).toBe('token duel');
    // And every surface that reads a run summary gets the same word.
    expect(readForkRun(sql, rootId)?.name).toBe('token duel');
  }, 300_000);

  test('a composition with no name falls back to its provenance label', async () => {
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const model = nodeModel();
    await runSwarm(
      { rt, model: model.model, mode: 'build', logger: createRecordingLogger() },
      resolved(),
    );
    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(readForkRun(sql, rootId)?.name).toBe('resume-proof');
  }, 300_000);
});

/** The search this workspace holds, read off the tree rather than off a variable the
 *  first attempt never returned. */
function firstRoot(sql: SqlExecutor): { root_id: string } | undefined {
  return sql<{ root_id: string }>`
    SELECT root_id FROM search_nodes WHERE parent_id IS NULL LIMIT 1`[0];
}

/**
 * The settle report as the JOB ROW carries it — parsed, not asserted.
 *
 * Read out of the stored result rather than off the value `runSwarm` returned, because
 * what a caller actually receives after a resume is this JSON: a field the run computes
 * and the serialisation drops would pass an in-memory assertion and fail the operator.
 */
const StoredReportSchema = v.object({
  report: v.object({
    expansions: v.number(),
    stop: v.picklist(['settled', 'budget', 'aborted']),
    resumed: v.nullable(v.object({
      rootId: v.string(),
      inheritedExpansions: v.number(),
      remainingBudget: v.number(),
      inheritedTokens: v.nullable(v.number()),
      abandonedNodes: v.number(),
      superseded: v.array(v.string()),
      attempt: v.number(),
    })),
  }),
});

function jobResultReport(result: string | null) {
  if (result === null) throw new Error('the resumed job stored no result');
  return v.parse(StoredReportSchema, JSON.parse(result)).report;
}

/* ── the OTHER second-search defect: a re-spawn, not a re-drive ───────────── */

/**
 * A call that is not a re-drive, over a task this workspace is still searching, is
 * REFUSED rather than given a tree of its own.
 *
 * The suite above closes the EVICTION path. This closes the path a MODEL takes. A
 * failed job's wake said "decide whether to retry or report the failure", the model
 * retried by calling `agents.swarm` again, and that call carries no re-drive marker
 * because it genuinely is not one — so it fell through to a fresh root over a tree the
 * first attempt had left running. Measured on the owner's live workspace: two roots
 * with byte-identical task text, six waves, thirty head spawns against a budget of
 * five.
 *
 * The ledger row is written directly here, and that IS the guard's production input:
 * it reads `findRunningSwarms`, so a `running` row for the task is the whole
 * precondition. Driving a real first attempt to a freeze — as the suite above does —
 * would prove the same thing at a hundred times the cost.
 */
describe('a second search over a task already running is refused', () => {
  test('no new root, no new ledger row, and the refusal names the run to wait for', async () => {
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const log = createRecordingLogger();

    // The state the first attempt left: its own root, still running, mid-search.
    beganSwarm(ledger, 'root-in-flight', Date.now());
    ledger.checkpoint('root-in-flight', 0, 2, 3, Date.now());
    expect(ledger.findRunningSwarms(TASK).map((row) => row.rootId)).toEqual(['root-in-flight']);

    const second = nodeModel();
    const result = await runSwarm(
      { rt, model: second.model, mode: 'build',  logger: log },
      resolved(),
    );

    // REFUSED, and the refusal is actionable: it names the run, says where it got to,
    // and says the result arrives on its own. A caller told only "no" re-spawns again.
    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.error).toContain('root-in-flight');
      expect(result.error).toContain('iteration 2');
      expect(result.error).toMatch(/wake/i);
    }

    // NOTHING WAS CREATED. This is the assertion the incident fails: no second root,
    // no second ledger row, and the live row untouched — not superseded, because this
    // call had no standing to take it over.
    expect(treeOf(sql)).toEqual([]);
    expect(ledger.list(10).filter((row) => row.engine === 'swarm').map((row) => row.rootId))
      .toEqual(['root-in-flight']);
    expect(ledger.get('root-in-flight')).toMatchObject({ status: 'running', epoch: 0 });

    // And no model call was made at all: the refusal lands before the first wave, so a
    // re-spawn costs nothing rather than costing a level.
    expect(second.script.calls()).toBe(0);

    // Attributed in the stream, so six waves against one budget can never again be
    // unexplained.
    const refused = log.emitted.filter((line) => line.event === 'swarm.duplicate_root_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.fields).toMatchObject({ root: 'root-in-flight', redrive: false, running: 1 });
  });

  test('a task nothing is running is not refused, so the guard cannot block a first call', () => {
    // The guard's other direction. Without this arm a change that refuses every call
    // passes the test above.
    const store = ledgerOnly();
    beganSwarm(store, 'other-root', Date.now());
    store.converge('other-root', 0, Date.now());
    expect(store.findRunningSwarms(TASK)).toEqual([]);
  });
});
