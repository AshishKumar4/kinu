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
import type { SwarmNodeRecord } from '../src/strategy/swarm-resume';
import {
  harvestSwarm, initSwarmNodeRecords, recordSwarmNode,
  reenterSwarm, RECORD_SCHEMA_VERSION,
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
  initSearchTables(makeExecRaw(db), sql);
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

  test('the caller context round-trips through the swarm ledger', () => {
    const store = ledgerOnly();
    store.begin({
      rootId: 'context-root',
      task: TASK,
      engine: 'swarm',
      rootMsgId: null,
      config: {
        budget: 1,
        branches: 1,
        mode: 'build',
        originContext: [{ role: 'user', content: 'frozen caller context' }],
      },
      budget: 1,
      now: 1_000,
    });

    expect(store.readSwarmOriginContext('context-root')).toEqual([
      { role: 'user', content: 'frozen caller context' },
    ]);
  });
});

/**
 * S12: A SWARM'S PROGRESS LIVES IN THE TREE, NOT THE ROW. The ledger row's
 * integer columns are the MCTS loop's checkpoint; a swarm used to write its
 * level barriers into them, so a run cut inside a level read the level before
 * it. Now every swarm progress reader derives iteration (children the tree
 * records) and remaining budget (the persisted initial budget minus those
 * children) at read time, and the row's own writes shrink to an epoch-fenced
 * liveness touch.
 */
describe('swarm progress reads the durable tree, not the row', () => {
  function treeAndLedger() {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initSearchTables(execRaw, sql);
    initMctsSearchTable(execRaw, sql);
    const ledger = new MctsSearchStore(sql);
    ledger.begin({
      rootId: 'mid-level', task: TASK, engine: 'swarm', rootMsgId: null,
      config: { budget: 6, branches: 3, mode: 'build', maxDepth: 2 }, budget: 6, now: 1_000,
    });
    void sql`INSERT INTO search_nodes (id, root_id, task, observation)
      VALUES ('mid-level', 'mid-level', ${TASK}, 'root')`;
    return { sql, ledger };
  }

  function expand(sql: SqlExecutor, ids: readonly (readonly [string, string | null])[], depth: number): void {
    for (const [id, parent] of ids) {
      void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
        VALUES (${id}, ${parent}, 'mid-level', ${TASK}, 'node', ${depth})`;
    }
  }

  test('a poll halfway through a level reads the children on disk, with no checkpoint written', () => {
    const { sql, ledger } = treeAndLedger();
    expand(sql, [['c1', 'mid-level'], ['c2', 'mid-level'], ['c3', 'mid-level']], 1);

    // Every reader agrees, and none of them read the row's integer columns:
    // those still hold what `begin` wrote, because nothing has written since.
    expect(ledger.findRunningSwarms(TASK)).toEqual([
      { rootId: 'mid-level', iteration: 3, budget: 3, epoch: 0 },
    ]);
    expect(ledger.get('mid-level')).toMatchObject({ iteration: 3, budget: 3 });
    expect(ledger.list(10)[0]).toMatchObject({ iteration: 3, budget: 3 });
    const cols = sql<{ iteration: number; budget: number }>`
      SELECT iteration, budget FROM mcts_search_runs WHERE root_id = 'mid-level'`[0];
    expect(cols).toEqual({ iteration: 0, budget: 6 });
  });

  test('after re-entry the same readers count what the new attempt added', () => {
    const { sql, ledger } = treeAndLedger();
    expand(sql, [['c1', 'mid-level'], ['c2', 'mid-level']], 1);
    const epoch = ledger.reclaim('mid-level');
    expect(epoch).toBe(1);
    expand(sql, [['g1', 'c1'], ['g2', 'c1']], 2);

    expect(ledger.findRunningSwarms(TASK)).toEqual([
      { rootId: 'mid-level', iteration: 4, budget: 2, epoch: 1 },
    ]);
    expect(ledger.get('mid-level')).toMatchObject({ iteration: 4, budget: 2, epoch: 1 });
  });

  test('touch is the only row write a live swarm makes: heartbeat, fenced on epoch', () => {
    const { sql, ledger } = treeAndLedger();
    expand(sql, [['c1', 'mid-level']], 1);

    ledger.touch('mid-level', 0, 5_000);
    const row = sql<{ updated_at: number; status: string; iteration: number; budget: number; epoch: number }>`
      SELECT updated_at, status, iteration, budget, epoch FROM mcts_search_runs WHERE root_id = 'mid-level'`[0];
    expect(row?.updated_at).toBe(5_000);
    expect(row).toMatchObject({ status: 'running', iteration: 0, budget: 6, epoch: 0 });

    // A zombie holding a stale lease cannot even move the heartbeat.
    ledger.touch('mid-level', 7, 6_000);
    expect(sql<{ updated_at: number }>`
      SELECT updated_at FROM mcts_search_runs WHERE root_id = 'mid-level'`[0]?.updated_at).toBe(5_000);

    // And once the run settled, nothing re-livens it.
    ledger.converge('mid-level', 0, 7_000);
    ledger.touch('mid-level', 0, 8_000);
    expect(ledger.get('mid-level')).toMatchObject({ status: 'converged' });
    expect(sql<{ updated_at: number }>`
      SELECT updated_at FROM mcts_search_runs WHERE root_id = 'mid-level'`[0]?.updated_at).toBe(7_000);
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

  test('an unknown record version is unreadable during harvest', () => {
    const { sql, ledger } = setupHarvest();
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
      VALUES
        ('future', 'harvest-root', 'harvest-root', ${TASK}, 'future answer', 1),
        ('good', 'harvest-root', 'harvest-root', ${TASK}, 'usable answer', 1)`;
    void sql`INSERT INTO swarm_node_records (node_id, root_id, record_json, created_at)
      VALUES ('future', 'harvest-root', ${JSON.stringify({
        v: 99, outcome: null, conclusion: null, aggregated: [], tokens: null,
      })}, 2_000)`;
    recordSwarmNode(sql, {
      rootId: 'harvest-root',
      nodeId: 'good',
      record: { outcome: null, conclusion: null, aggregated: [], tokens: null },
      now: 2_000,
    });

    const harvest = harvestSwarm({ sql, ledger }, TASK);
    expect(harvest?.candidates.map((candidate) => candidate.nodeId)).toEqual(['good']);
    expect(harvest?.unreadableNodes).toEqual(['future']);
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

/* ── the record envelope: stamped, refused, or corrupt ───────────────────── */

describe('the durable record envelope is versioned', () => {
  /** The record FIELDS. A stored row is these plus the `v` stamp `recordSwarmNode`
   *  writes; nothing else is a readable envelope. */
  const A_RECORD: SwarmNodeRecord = {
    outcome: {
      kind: 'scored',
      measurement: { kind: 'measured', value: N - 1, detail: 'oracle calls' },
      score: 0.5,
    },
    conclusion: 'a single scan',
    aggregated: ['child-b'],
    tokens: CALL_TOKENS,
  };

  function resumeFixture() {
    // The production workspace schema, so head_journal exists for the re-entry's
    // start-of-life sweep; the search tables are re-initialised idempotently.
    const { rt } = createTestRuntime();
    const sql = rt.storage.sql;
    initSearchTables(rt.storage.execRaw, sql);
    initMctsSearchTable(rt.storage.execRaw, sql);
    initSwarmNodeRecords(rt.storage.execRaw);
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);
    beganSwarm(ledger, 'root', 1_000);
    void sql`INSERT INTO search_nodes (id, root_id, task, observation)
      VALUES ('root', 'root', ${TASK}, 'root')`;
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
      VALUES ('n1', 'root', 'root', ${TASK}, 'answer one', 1)`;
    return { sql, ledger, journal };
  }

  interface Fixture {
    readonly sql: SqlExecutor;
    readonly ledger: MctsSearchStore;
    readonly journal: HeadJournal;
  }

  function reenter(fixture: Fixture) {
    return reenterSwarm(fixture, { task: TASK, now: 3_000 });
  }

  test('the writer stamps v1 and the reader round-trips it', () => {
    const fixture = resumeFixture();
    recordSwarmNode(fixture.sql, {
      rootId: 'root', nodeId: 'n1', record: A_RECORD, now: 2_000,
    });
    const [stored] = fixture.sql<{ record_json: string }>`
      SELECT record_json FROM swarm_node_records WHERE node_id = 'n1'`;
    expect(JSON.parse(stored.record_json).v).toBe(RECORD_SCHEMA_VERSION);
    expect(reenter(fixture)?.nodes.find((node) => node.id === 'n1')?.record).toEqual(A_RECORD);
  });

  test('an unstamped row is corruption, not an older shape', () => {
    // Field-perfect but stampless: there is one schema and the stamp is in it, so
    // this fails by name rather than falling through to a second read path.
    const fixture = resumeFixture();
    void fixture.sql`INSERT INTO swarm_node_records (node_id, root_id, record_json, created_at)
      VALUES ('n1', 'root', ${JSON.stringify(A_RECORD)}, 2_000)`;
    expect(() => reenter(fixture)).toThrow('corruption rather than an old shape');
  });

  test('an unknown envelope version refuses and names the version', () => {
    const fixture = resumeFixture();
    void fixture.sql`INSERT INTO swarm_node_records (node_id, root_id, record_json, created_at)
      VALUES ('n1', 'root', ${JSON.stringify({ v: 99, ...A_RECORD })}, 2_000)`;
    expect(() => reenter(fixture)).toThrow(/schema version 99/);
  });

  test('a stamped row this build cannot parse refuses, naming itself as the writer', () => {
    // An outcome arm no version of this engine ever wrote.
    const badArm = resumeFixture();
    void badArm.sql`INSERT INTO swarm_node_records (node_id, root_id, record_json, created_at)
      VALUES ('n1', 'root', ${JSON.stringify({
        v: RECORD_SCHEMA_VERSION,
        ...A_RECORD,
        outcome: { ...A_RECORD.outcome, kind: 'teleported' },
      })}, 2_000)`;
    expect(() => reenter(badArm)).toThrow('corruption rather than an old shape');

    // A field this build's own schema requires, missing.
    const missingField = resumeFixture();
    void missingField.sql`INSERT INTO swarm_node_records (node_id, root_id, record_json, created_at)
      VALUES ('n1', 'root', ${JSON.stringify({
        v: RECORD_SCHEMA_VERSION, outcome: null, conclusion: null, aggregated: [],
      })}, 2_000)`;
    expect(() => reenter(missingField)).toThrow('under its own schema version 1');
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
/** The CAPS both halves of a suite must agree on: the TOOL input and the resolved
 *  call have to name the same two, or the re-drive replays a different search from
 *  the one the first attempt ran. */
interface SearchCaps {
  readonly depth: number;
  readonly branches: number;
}

const DEEP_SEARCH: SearchCaps = { depth: 2, branches: 2 };

/** The call as the TOOL takes it: the surface is snake_case where the type is not. */
function swarmCall(caps: SearchCaps = DEEP_SEARCH): AgentsToolInput {
  return {
    action: 'swarm',
    preset: 'custom',
    label: 'resume-proof',
    task: TASK,
    objective: objective(),
    config: config(),
    depth: caps.depth,
    branches: caps.branches,
  };
}

function resolved(caps: SearchCaps = DEEP_SEARCH): ResolvedSwarm {
  const call = resolveSwarm({
    preset: 'custom', label: 'resume-proof', task: TASK,
    objective: objective(), config: config(),
    depth: caps.depth, branches: caps.branches,
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
function nodeModel(opts: {
  readonly freezeFromStart?: number;
  /** How many frozen starts settle {@link Script.frozen}. The default is the deep
   *  shape's level-2 wave; a wider run has to wait for all of its own. */
  readonly frozenNodes?: number;
} = {}) {
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
          if (frozenStarts >= (opts.frozenNodes ?? FROZEN_NODES)) gate.resolve();
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

const MISSION_LABEL = 'nightly';
/** Both children in the frozen level must start before the test reads its journal. */
const FROZEN_NODES = 2;


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
    expect(journal.listLive().items.find((run) => run.rootId === rootId)?.running).toBe(FROZEN_NODES);
    // The ids of those two, held so the re-entry can be checked against them by
    // IDENTITY and not merely by count. A run that retires these and mints two more
    // passes every count assertion below and is exactly the reported defect.
    const frozenNodeIds = sql<{ id: string }>`
      SELECT id FROM head_journal WHERE root_id = ${rootId} AND depth = 2 ORDER BY rowid ASC`
      .map((row) => row.id);
    expect(frozenNodeIds).toHaveLength(FROZEN_NODES);
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

    // EXACTLY AS MANY LOGICAL NODES AS THE SEARCH ASKED FOR, and this is the
    // reported defect's own assertion. `depth * branches` is four, so four nodes and
    // one root — across the eviction, not per attempt. The incident produced
    // `branches` extra journal rows on every re-drive until thirty rows described
    // five nodes.
    const journalled = sql<{ id: string; status: string; error_message: string | null; depth: number }>`
      SELECT id, status, error_message, depth FROM head_journal WHERE root_id = ${rootId}
      ORDER BY depth ASC, rowid ASC`;
    expect(journalled).toHaveLength(4);
    // …and the two the first attempt spawned are the same two the second one ran.
    expect(journalled.filter((row) => row.depth === 2).map((row) => row.id))
      .toEqual(frozenNodeIds);
    expect(tree.filter((node) => node.depth === 2).map((node) => node.id).sort())
      .toEqual([...frozenNodeIds].sort());

    // NO FAKE TERMINAL ROW ANYWHERE. Every row reached a real outcome, and none
    // carries the takeover prose that used to be written on a node that was about to
    // be re-run: "Interrupted before it reported. This search was re-entered from its
    // durable rows, and the nodes after it are the continuation."
    expect(journalled.map((row) => row.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    for (const row of journalled) expect(row.error_message).toBeNull();
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal WHERE error_message LIKE '%re-entered from its durable rows%'`[0]?.n)
      .toBe(0);
    // The re-run cleared the dead attempt's partial transcript rather than
    // interleaving it: every step under a node belongs to the attempt that answered.
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_steps WHERE head_id NOT IN (SELECT id FROM head_journal)`[0]?.n)
      .toBe(0);

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
      // FOUR, not two. The union of both durable records of a node's existence: the
      // two level-1 nodes the tree holds, and the two level-2 nodes the journal holds
      // and the tree does not. Counting tree rows alone read this as two, recreated
      // half the budget, and expanded a SECOND level-2 wave under fresh ids.
      inheritedExpansions: 4,
      // `depth * branches` is 4 and all four expansions exist, so this attempt buys
      // nothing: it re-runs the two it already owns and settles.
      remainingBudget: 0,
      // The two the first attempt spawned and never recorded. Re-run under their own
      // ids, not retired and not replaced.
      resumedNodes: 2,
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

    // THE ZOMBIE IS FENCED. If the first attempt's activation ever came back, its
    // writes carry epoch 0: its heartbeat touch cannot move the row this run settled,
    // and neither can its settle — which is what makes the wake idempotent rather than
    // merely unlikely.
    ledger.touch(rootId, 0, Date.now());
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
 * THE REPORTED DEFECT, VERBATIM: "a swarm sized for 5 spawns several MORE failed
 * nodes, and the search keeps running".
 *
 * WHAT THE OWNER SAW. Five nodes were requested. The activation died inside the one
 * and only level — before ANY node had a tree row, which is the ordinary eviction and
 * the case the suite above does not cover, because there a level had already settled.
 * The re-drive then did two wrong things at once, and they compounded:
 *
 *   - it stamped all five unreported rows `aborted` with "Interrupted before it
 *     reported. This search was re-entered from its durable rows, and the nodes after
 *     it are the continuation." — a terminal claim about work nothing had finished
 *     with;
 *   - and, because the ONLY evidence the accounting read was the tree, it counted
 *     ZERO expansions, recreated the whole five-expansion budget, and bought the
 *     "nodes after it" as five FRESH ids.
 *
 * Ten journal rows for a five-node search, five of them failures, and `branches` more
 * on every eviction — which is how one root came to hold thirty rows.
 *
 * THE INVARIANT THIS PINS: the number of logical nodes a search holds is decided by
 * its caps and by nothing else, across any number of re-entries. Asserted by IDENTITY
 * and not only by count, because retiring five rows and minting five more keeps the
 * count.
 */
describe('a swarm cut before any node reported re-runs those nodes, and creates none', () => {
  const FLAT_SEARCH: SearchCaps = { depth: 1, branches: 5 };

  test('five requested, five journalled, five re-run under their own ids', async () => {
    const { rt, db } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);

    // ── ATTEMPT ONE: every node freezes on its first call ──────────────────
    const first = nodeModel({ freezeFromStart: 1, frozenNodes: FLAT_SEARCH.branches });
    const frozen = runSwarm(
      { rt, model: first.model, mode: 'build', logger: createRecordingLogger() },
      resolved(FLAT_SEARCH),
    );
    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;

    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(rootId).not.toBe('');
    // THE INCIDENT'S EXACT ON-DISK STATE: the root and nothing else in the tree, five
    // journal rows claiming to be running, one ledger row at iteration 0.
    expect(treeOf(sql)).toHaveLength(1);
    expect(ledger.get(rootId)).toMatchObject({ status: 'running', iteration: 0, epoch: 0 });
    const spawnedIds = sql<{ id: string }>`
      SELECT id FROM head_journal WHERE root_id = ${rootId} ORDER BY rowid ASC`
      .map((row) => row.id);
    expect(spawnedIds).toHaveLength(FLAT_SEARCH.branches);

    // ── ATTEMPT TWO, through the REAL runner path ──────────────────────────
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
    const jobId = 'bgjob-flat-swarm';
    jobs.create({
      id: jobId, kind: 'agents', workMode: 'build', now: Date.now(),
      input: JSON.stringify(swarmCall(FLAT_SEARCH)),
    });
    // Both halves of a cold activation, in the order it runs them: the journal
    // reconciliation, with the job sweep as its resume gate.
    const retired = await reconcileInterruptedForks({
      journal,
      signals: agent.signals,
      search: ledger,
      resume: async () => {
        await runner.recoverOrphans();
        return [rootId];
      },
    });
    await settled();

    // FIVE LOGICAL NODES, AND THEY ARE THE SAME FIVE. This is the assertion the
    // incident fails: it produced ten rows here, five of them aborted.
    const journalled = sql<{ id: string; status: string; error_message: string | null }>`
      SELECT id, status, error_message FROM head_journal WHERE root_id = ${rootId}
      ORDER BY rowid ASC`;
    expect(journalled.map((row) => row.id)).toEqual(spawnedIds);
    expect(journalled.map((row) => row.status))
      .toEqual(Array.from({ length: FLAT_SEARCH.branches }, () => 'completed'));
    // NO FAKE TERMINAL ROW: no row carries a retirement reason of any kind, because
    // no row was retired — each was re-entered.
    for (const row of journalled) expect(row.error_message).toBeNull();
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal WHERE error_message IS NOT NULL`[0]?.n).toBe(0);
    expect(retired).toEqual([]);

    // The tree holds the root and those same five nodes — no sixth, no replacement.
    const tree = treeOf(sql);
    expect(tree).toHaveLength(FLAT_SEARCH.branches + 1);
    expect(tree.filter((node) => node.parent_id !== null).map((node) => node.id).sort())
      .toEqual([...spawnedIds].sort());
    expect(new Set(tree.map((node) => node.root_id))).toEqual(new Set([rootId]));

    // ONE ledger row, settled under the reclaimed lease, counting five expansions.
    expect(ledger.list(10).filter((row) => row.engine === 'swarm').map((row) => row.rootId))
      .toEqual([rootId]);
    expect(ledger.get(rootId)).toMatchObject({ epoch: 1, iteration: FLAT_SEARCH.branches });

    // EVERY REPORT COMPILED, EXACTLY ONCE. Five nodes settled in one wave and the
    // run's own record counts five — one record row per node, and one candidate per
    // record.
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM swarm_node_records WHERE root_id = ${rootId}`[0]?.n)
      .toBe(FLAT_SEARCH.branches);
    const report = jobResultReport(jobs.get(jobId)?.result ?? null);
    expect(report.expansions).toBe(FLAT_SEARCH.branches);
    expect(report.resumed).toMatchObject({
      rootId,
      inheritedExpansions: FLAT_SEARCH.branches,
      remainingBudget: 0,
      resumedNodes: FLAT_SEARCH.branches,
      attempt: 2,
    });

    // AND THE AGENT WAS TOLD ONCE. The job settled once and no interrupted-fork card
    // was delivered beside it: a run being continued is not a run that was lost, and
    // two events for one transition is the duplicate the surface renders twice.
    expect(jobs.get(jobId)?.status).toBe('completed');
    expect(agent.enqueued).toHaveLength(1);
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent))
      .not.toContain(FORK_INTERRUPTED_SIGNAL);

    // The five re-runs are the only model work this attempt did: no sixth node
    // started, so nothing was paid for twice.
    expect(second.script.starts()).toBe(FLAT_SEARCH.branches);
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
    expect(journal.listLive().items.find((run) => run.rootId === rootId)?.running).toBe(FROZEN_NODES);

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
    expect(journal.listLive().items.find((run) => run.rootId === rootId)?.running ?? 0)
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
    expect(journal.listLive()).toEqual({ items: [], total: 0 });
  }, 300_000);

  test('a run a LATER activation refuses is still retired, not left interrupted forever', async () => {
    // THE HOLE THIS CLOSES. Retirement used to be gated on THIS activation having
    // marked something (`if (interrupted.length === 0) return []`), which is a
    // different question from "did the gate refuse it". A run marked `interrupted` by
    // an earlier activation is not marked again, so on the activation whose gate
    // finally refuses it the early return fired and its rows stayed `interrupted` for
    // the life of the workspace: no report, no terminal state, and no card. The
    // ledger row beside them was already closed on the gate's answer alone, so one
    // sweep's two halves disagreed about which activation was allowed to settle.
    //
    // Reachable because a swarm's re-entry no longer writes terminal rows of its own:
    // it re-runs what it owns, so the only writer left for a genuinely dead run is
    // this sweep.
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql);
    const journal = new HeadJournal(sql);
    const first = nodeModel({ freezeFromStart: 3 });
    void runSwarm(
      { rt, model: first.model, mode: 'build', logger: createRecordingLogger() },
      resolved(),
    );
    await first.script.frozen;
    const rootId = firstRoot(sql)?.root_id ?? '';
    const agent = idleAgent();

    // ACTIVATION TWO: the gate claims the run, so nothing is retired and the rows are
    // left `interrupted` for a re-entry that never lands.
    const claimed = await reconcileInterruptedForks({
      journal, signals: agent.signals, search: ledger, resume: async () => [rootId],
    });
    expect(claimed).toEqual([]);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal WHERE status = 'interrupted'`[0]?.n)
      .toBe(FROZEN_NODES);

    // ACTIVATION THREE: the job is past its resume cap, so the gate refuses. Nothing
    // is newly marked — the rows are already `interrupted` — and the run must still
    // settle definitively.
    const retired = await reconcileInterruptedForks({
      journal, signals: agent.signals, search: ledger, resume: async () => [],
    });

    expect(retired.map((run) => run.rootId)).toEqual([rootId]);
    expect(retired[0]?.abandoned).toBe(FROZEN_NODES);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE error_message = ${FORK_INTERRUPTED_REASON}`[0]?.n).toBe(FROZEN_NODES);
    expect(ledger.get(rootId)?.status).toBe('failed');
    // Told ONCE, on the activation that actually settled it. The claimed activation
    // said nothing, so the agent gets one card for one transition.
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent))
      .toEqual([FORK_INTERRUPTED_SIGNAL]);
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
      { rt, model: first.model, mode: 'build', logger: createRecordingLogger() },
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
      { rt, model: first.model, mode: 'build', logger: createRecordingLogger() },
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
      resumedNodes: v.number(),
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

    // The state the first attempt left: its own root, still running, two children
    // expanded — written where progress actually lives, the tree, not a checkpoint.
    beganSwarm(ledger, 'root-in-flight', Date.now());
    void sql`INSERT INTO search_nodes (id, root_id, task, observation)
      VALUES ('root-in-flight', 'root-in-flight', ${TASK}, 'root')`;
    for (const id of ['c1', 'c2']) {
      void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
        VALUES (${id}, 'root-in-flight', 'root-in-flight', ${TASK}, 'node', 1)`;
    }
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
    const seededTree = sql<{ id: string }>`SELECT id FROM search_nodes ORDER BY id`.map((r) => r.id);
    expect(ledger.list(10).filter((row) => row.engine === 'swarm').map((row) => row.rootId))
      .toEqual(['root-in-flight']);
    expect(ledger.get('root-in-flight')).toMatchObject({ status: 'running', epoch: 0 });

    // …and the refusal ADDED nothing to the tree it read.
    expect(sql<{ id: string }>`SELECT id FROM search_nodes ORDER BY id`.map((r) => r.id))
      .toEqual(seededTree);

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

describe('harvested witness verdict', () => {
  test('per-candidate and aggregate witness evidence survive bounded harvest', () => {
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
    void sql`INSERT INTO search_nodes (id, parent_id, root_id, task, observation, depth)
      VALUES ('witness', 'harvest-root', 'harvest-root', ${TASK}, 'certificate', 1)`;
    recordSwarmNode(sql, {
      rootId: 'harvest-root',
      nodeId: 'witness',
      record: {
        outcome: {
          kind: 'scored',
          measurement: { kind: 'measured', value: 0.3, detail: 'proxy' },
          score: 0.3,
          witnessFound: true,
        },
        conclusion: null,
        aggregated: [],
        tokens: 1,
      },
      now: 2_000,
    });

    const harvest = harvestSwarm({ sql, ledger }, TASK);
    expect(harvest?.witnessFound).toBe(true);
    expect(harvest?.candidates[0]?.witnessFound).toBe(true);
  });
});
