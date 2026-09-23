/**
 * A swarm killed mid-flight is re-entered by the real job-resume path, not started again.
 * An eviction keeps storage and loses the isolate: attempt one freezes on a never-settling call;
 * attempt two shares only the database and workspace. Spec: docs/EXPLORATION.md, docs/MCTS.md.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModelV3Content } from '@ai-sdk/provider';
import * as v from 'valibot';
import { scriptedTurnModel, createTestActorsOver } from '@kinu.run/test-utils';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers';
import { MissionGovernor } from '../src/mission-budget';
import { MctsSearchStore, initMctsSearchTable } from '../src/mcts/search-store';
import { initSearchTables } from '../src/mcts/schemas';
import { HeadJournal } from '../src/heads/journal';
import { createRecordingLogger } from '../src/obs/index';
import { createAgentsTool, type AgentsToolDeps, type AgentsToolInput } from '../src/delegation/agents-tool';
import { resumeBackgroundJob } from '../src/orchestrator/background-tools';
import { BackgroundJobRunner } from '../src/jobs/runner';
import { BackgroundJobStore, initBackgroundJobsTable } from '../src/jobs/store';
import { Inbox } from '../src/orchestrator/inbox';
import { readForkRun } from '../src/read-models/fork-runs';
import {
  reconcileInterruptedForks, FORK_INTERRUPTED_SIGNAL, FORK_INTERRUPTED_REASON,
} from '../src/heads/reconcile';
import { runSwarm, type SwarmRunDeps } from '../src/strategy/swarm-run';
import { hostedSeatsOver } from './helpers-actor-host';
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
import type { ActorHandle } from '../src/identity/actor-handle';

const TASK = 'find the largest of 12 opaque tokens in the fewest oracle calls';

function ledgerOnly() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  initSearchTables(makeExecRaw(db));
  initMctsSearchTable(makeExecRaw(db));

  return new MctsSearchStore(sql, createTestActorsOver(db).main);
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
    // Differs only in engine: without the discriminator a judged search's checkpoint reaches the swarm runner.
    store.begin({
      rootId: 'mcts-row', task: TASK, engine: 'mcts', rootMsgId: 'm1',
      config: { budget: 4, branches: 2, mode: 'build' }, budget: 4, now: 3_000,
    });
    expect(store.findResumable(TASK, 'build')?.rootId).toBe('mcts-row');

    expect(store.findRunningSwarms(TASK).map((row) => row.rootId)).toEqual(['newer', 'older']);
  });

  test('a settled swarm row is not a resume target, whichever way it settled', () => {
    const store = ledgerOnly();
    beganSwarm(store, 'converged', 1_000);
    beganSwarm(store, 'failed', 2_000);
    beganSwarm(store, 'superseded', 3_000);
    // Distinct instants: `list` orders on `updated_at`, so a shared timestamp would test the tie-break.
    store.converge('converged', 0, 4_000);
    store.fail('failed', 0, 5_000);
    store.supersede('superseded', 6_000);

    expect(store.findRunningSwarms(TASK)).toEqual([]);
    // `superseded` is not `failed`: a newer attempt took the run over.
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
 * S12: a swarm's progress lives in the tree, not the ledger row's integer columns;
 * readers derive iteration and remaining budget from tree children.
 */
describe('swarm progress reads the durable tree, not the row', () => {
  function treeAndLedger() {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initSearchTables(execRaw);
    initMctsSearchTable(execRaw);
    const actor = createTestActorsOver(db).main;
    const ledger = new MctsSearchStore(sql, actor);
    ledger.begin({
      rootId: 'mid-level', task: TASK, engine: 'swarm', rootMsgId: null,
      config: { budget: 6, branches: 3, mode: 'build', maxDepth: 2 }, budget: 6, now: 1_000,
    });
    void sql`INSERT INTO search_nodes (actor_id, id, root_id, task, observation)
      VALUES (${actor.actorId}, 'mid-level', 'mid-level', ${TASK}, 'root')`;

    return { sql, ledger, actor };
  }

  /** One row per child under the run's own actor: `search_nodes` is keyed `(actor_id, id)`. */
  function expand(
    sql: SqlExecutor, actor: ActorHandle,
    ids: readonly (readonly [string, string | null])[], depth: number,
  ): void {
    for (const [id, parent] of ids) {
      void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
        VALUES (${actor.actorId}, ${id}, ${parent}, 'mid-level', ${TASK}, 'node', ${depth})`;
    }
  }

  test('a poll halfway through a level reads the children on disk, with no checkpoint written', () => {
    const { sql, ledger, actor } = treeAndLedger();
    expand(sql, actor, [['c1', 'mid-level'], ['c2', 'mid-level'], ['c3', 'mid-level']], 1);

    // No reader uses the row's integer columns; they still hold what `begin` wrote.
    expect(ledger.findRunningSwarms(TASK)).toEqual([
      { rootId: 'mid-level', iteration: 3, budget: 3, epoch: 0 },
    ]);
    expect(ledger.get('mid-level')).toMatchObject({ iteration: 3, budget: 3 });
    expect(ledger.list(10)[0]).toMatchObject({ iteration: 3, budget: 3 });

    const cols = sql<{ iteration: number; budget: number }>`
      SELECT iteration, budget FROM mcts_search_runs
      WHERE actor_id = ${actor.actorId} AND root_id = 'mid-level'`[0];

    expect(cols).toEqual({ iteration: 0, budget: 6 });
  });

  test('after re-entry the same readers count what the new attempt added', () => {
    const { sql, ledger, actor } = treeAndLedger();
    expand(sql, actor, [['c1', 'mid-level'], ['c2', 'mid-level']], 1);
    const epoch = ledger.reclaim('mid-level');
    expect(epoch).toBe(1);
    expand(sql, actor, [['g1', 'c1'], ['g2', 'c1']], 2);

    expect(ledger.findRunningSwarms(TASK)).toEqual([
      { rootId: 'mid-level', iteration: 4, budget: 2, epoch: 1 },
    ]);
    expect(ledger.get('mid-level')).toMatchObject({ iteration: 4, budget: 2, epoch: 1 });
  });

  test('touch is the only row write a live swarm makes: heartbeat, fenced on epoch', () => {
    const { sql, ledger, actor } = treeAndLedger();
    expand(sql, actor, [['c1', 'mid-level']], 1);

    ledger.touch('mid-level', 0, 5_000);

    const row = sql<{ updated_at: number; status: string; iteration: number; budget: number; epoch: number }>`
      SELECT updated_at, status, iteration, budget, epoch FROM mcts_search_runs
      WHERE actor_id = ${actor.actorId} AND root_id = 'mid-level'`[0];

    expect(row?.updated_at).toBe(5_000);
    expect(row).toMatchObject({ status: 'running', iteration: 0, budget: 6, epoch: 0 });

    ledger.touch('mid-level', 7, 6_000);
    expect(sql<{ updated_at: number }>`
      SELECT updated_at FROM mcts_search_runs
      WHERE actor_id = ${actor.actorId} AND root_id = 'mid-level'`[0]?.updated_at).toBe(5_000);

    ledger.converge('mid-level', 0, 7_000);
    ledger.touch('mid-level', 0, 8_000);
    expect(ledger.get('mid-level')).toMatchObject({ status: 'converged' });
    expect(sql<{ updated_at: number }>`
      SELECT updated_at FROM mcts_search_runs
      WHERE actor_id = ${actor.actorId} AND root_id = 'mid-level'`[0]?.updated_at).toBe(7_000);
  });
});

describe('harvesting a capped swarm', () => {
  /** The harvested search and the actor that opened it; reads are keyed `(actor_id, …)`. */
  function setupHarvest() {
    const db = new Database(':memory:');
    const sql = makeSql(db);
    const execRaw = makeExecRaw(db);
    initSearchTables(execRaw);
    initMctsSearchTable(execRaw);
    initSwarmNodeRecords(execRaw);
    const actors = createTestActorsOver(db);
    const actor = actors.main;
    const ledger = new MctsSearchStore(sql, actor);
    beganSwarm(ledger, 'harvest-root', 1_000);
    void sql`INSERT INTO search_nodes (actor_id, id, root_id, task, observation)
      VALUES (${actor.actorId}, 'harvest-root', 'harvest-root', ${TASK}, 'root')`;

    return { sql, ledger, actor, sibling: actors.sibling.bind(actors) };
  }

  test('an all-incomplete search has no candidate to report as completed', () => {
    const { sql, ledger, actor } = setupHarvest();
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES (${actor.actorId}, 'incomplete', 'harvest-root', 'harvest-root', ${TASK},
              'stopped before an answer', 1)`;
    recordSwarmNode(sql, actor, {
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
    expect(harvestSwarm({ sql, ledger, actor }, TASK)).toBeNull();
  });

  test('one malformed record cannot hide another usable candidate', () => {
    const { sql, ledger, actor } = setupHarvest();
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES
        (${actor.actorId}, 'bad', 'harvest-root', 'harvest-root', ${TASK}, 'bad artifact', 1),
        (${actor.actorId}, 'good', 'harvest-root', 'harvest-root', ${TASK}, 'usable answer', 1)`;
    void sql`INSERT INTO swarm_node_records (actor_id, node_id, root_id, record_json, created_at)
      VALUES (${actor.actorId}, 'bad', 'harvest-root', '{', 2_000)`;
    recordSwarmNode(sql, actor, {
      rootId: 'harvest-root',
      nodeId: 'good',
      record: { outcome: null, conclusion: null, aggregated: [], tokens: null },
      now: 2_000,
    });
    const harvest = harvestSwarm({ sql, ledger, actor }, TASK);
    expect(harvest?.candidates.map((candidate) => candidate.nodeId)).toEqual(['good']);
    expect(harvest?.candidates[0]?.artifact).toBe('usable answer');
    expect(harvest?.unreadableNodes).toEqual(['bad']);
    expect(harvest?.publication).toEqual({ state: { kind: 'open' }, caveat: null });
  });

  test('an unknown record version is unreadable during harvest', () => {
    const { sql, ledger, actor } = setupHarvest();
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES
        (${actor.actorId}, 'future', 'harvest-root', 'harvest-root', ${TASK}, 'future answer', 1),
        (${actor.actorId}, 'good', 'harvest-root', 'harvest-root', ${TASK}, 'usable answer', 1)`;
    void sql`INSERT INTO swarm_node_records (actor_id, node_id, root_id, record_json, created_at)
      VALUES (${actor.actorId}, 'future', 'harvest-root', ${JSON.stringify({
        v: 99, outcome: null, conclusion: null, aggregated: [], tokens: null,
      })}, 2_000)`;
    recordSwarmNode(sql, actor, {
      rootId: 'harvest-root',
      nodeId: 'good',
      record: { outcome: null, conclusion: null, aggregated: [], tokens: null },
      now: 2_000,
    });

    const harvest = harvestSwarm({ sql, ledger, actor }, TASK);
    expect(harvest?.candidates.map((candidate) => candidate.nodeId)).toEqual(['good']);
    expect(harvest?.unreadableNodes).toEqual(['future']);
  });

  test('an all-corrupt harvest fails distinctly from an empty search', () => {
    const { sql, ledger, actor } = setupHarvest();
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES (${actor.actorId}, 'bad', 'harvest-root', 'harvest-root', ${TASK},
              'unreadable answer', 1)`;
    void sql`INSERT INTO swarm_node_records (actor_id, node_id, root_id, record_json, created_at)
      VALUES (${actor.actorId}, 'bad', 'harvest-root', '{', 2_000)`;
    expect(() => harvestSwarm({ sql, ledger, actor }, TASK)).toThrow('none can be decoded');
  });

  test('a sealed candidate carries its breach and publication caveat', () => {
    const { sql, ledger, actor } = setupHarvest();
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES (${actor.actorId}, 'sealed', 'harvest-root', 'harvest-root', ${TASK},
              'candidate answer', 1)`;

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

    recordSwarmNode(sql, actor, {
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
    const harvest = harvestSwarm({ sql, ledger, actor }, TASK);
    expect(harvest?.candidates[0]?.breach).toEqual(breach);
    expect(harvest?.publication.state).toEqual({ kind: 'sealed', breach });
    expect(harvest?.publication.caveat).toContain('not publishable');
  });

  test('a harvest under another actor of the same workspace reports NOTHING', () => {
    // A sibling actor harvesting the same rows sees nothing; otherwise wrong-actor and settled-search both read `null`.
    const { sql, ledger, actor, sibling: issue } = setupHarvest();
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES (${actor.actorId}, 'good', 'harvest-root', 'harvest-root', ${TASK},
              'usable answer', 1)`;
    recordSwarmNode(sql, actor, {
      rootId: 'harvest-root',
      nodeId: 'good',
      record: { outcome: null, conclusion: null, aggregated: [], tokens: null },
      now: 2_000,
    });
    expect(harvestSwarm({ sql, ledger, actor }, TASK)?.candidates.map((c) => c.nodeId))
      .toEqual(['good']);

    const sibling = issue('other');
    const siblingLedger = new MctsSearchStore(sql, sibling);
    expect(siblingLedger.findRunningSwarms(TASK)).toEqual([]);
    expect(harvestSwarm({ sql, ledger: siblingLedger, actor: sibling }, TASK)).toBeNull();
  });
});

describe('the durable record envelope is versioned', () => {
  /** The record fields; a stored row is these plus the `v` stamp. */
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
    // Production schema, so head_journal exists for the re-entry's start-of-life sweep.
    const { rt } = createTestRuntime();
    const sql = rt.storage.sql;
    initSearchTables(rt.storage.execRaw);
    initMctsSearchTable(rt.storage.execRaw);
    initSwarmNodeRecords(rt.storage.execRaw);
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);
    beganSwarm(ledger, 'root', 1_000);
    void sql`INSERT INTO search_nodes (actor_id, id, root_id, task, observation)
      VALUES (${rt.actor.actorId}, 'root', 'root', ${TASK}, 'root')`;
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES (${rt.actor.actorId}, 'n1', 'root', 'root', ${TASK}, 'answer one', 1)`;

    return { sql, ledger, journal, actor: rt.actor };
  }

  interface Fixture {
    readonly sql: SqlExecutor;
    readonly ledger: MctsSearchStore;
    readonly journal: HeadJournal;
    readonly actor: ActorHandle;
  }

  function reenter(fixture: Fixture) {
    return reenterSwarm(fixture, { task: TASK, now: 3_000 });
  }

  test('the writer stamps v1 and the reader round-trips it', () => {
    const fixture = resumeFixture();
    recordSwarmNode(fixture.sql, fixture.actor, {
      rootId: 'root', nodeId: 'n1', record: A_RECORD, now: 2_000,
    });

    const [stored] = fixture.sql<{ record_json: string }>`
      SELECT record_json FROM swarm_node_records
        WHERE actor_id = ${fixture.actor.actorId} AND node_id = 'n1'`;

    expect(JSON.parse(stored.record_json).v).toBe(RECORD_SCHEMA_VERSION);
    expect(reenter(fixture)?.nodes.find((node) => node.id === 'n1')?.record).toEqual(A_RECORD);
  });

  test('an unstamped row is corruption, not an older shape', () => {
    const fixture = resumeFixture();
    void fixture.sql`INSERT INTO swarm_node_records
        (actor_id, node_id, root_id, record_json, created_at)
      VALUES (${fixture.actor.actorId}, 'n1', 'root', ${JSON.stringify(A_RECORD)}, 2_000)`;
    expect(() => reenter(fixture)).toThrow('corruption rather than an old shape');
  });

  test('an unknown envelope version refuses and names the version', () => {
    const fixture = resumeFixture();
    void fixture.sql`INSERT INTO swarm_node_records
        (actor_id, node_id, root_id, record_json, created_at)
      VALUES (${fixture.actor.actorId}, 'n1', 'root',
              ${JSON.stringify({ v: 99, ...A_RECORD })}, 2_000)`;
    expect(() => reenter(fixture)).toThrow(/schema version 99/);
  });

  test('a stamped row this build cannot parse refuses, naming itself as the writer', () => {
    const badArm = resumeFixture();
    void badArm.sql`INSERT INTO swarm_node_records
        (actor_id, node_id, root_id, record_json, created_at)
      VALUES (${badArm.actor.actorId}, 'n1', 'root', ${JSON.stringify({
        v: RECORD_SCHEMA_VERSION,
        ...A_RECORD,
        outcome: { ...A_RECORD.outcome, kind: 'teleported' },
      })}, 2_000)`;
    expect(() => reenter(badArm)).toThrow('corruption rather than an old shape');

    const missingField = resumeFixture();
    void missingField.sql`INSERT INTO swarm_node_records
        (actor_id, node_id, root_id, record_json, created_at)
      VALUES (${missingField.actor.actorId}, 'n1', 'root', ${JSON.stringify({
        v: RECORD_SCHEMA_VERSION, outcome: null, conclusion: null, aggregated: [],
      })}, 2_000)`;
    expect(() => reenter(missingField)).toThrow('under its own schema version 1');
  });
});

/** Small: every measurement spawns a real process in the workspace shell. */
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

/** `context:'inherit'`: a level-2 node of a re-entered parent can only inherit from the journal. */
function config(): SwarmConfig {
  return {
    unit: { kind: 'answer' },
    context: 'inherit',
    expand: 'sample',
    score: { kind: 'verify' },
    advance: { kind: 'uct' },
    carry: { kind: 'none' },
  };
}

/** The tool input and the resolved call must name the same caps, or the re-drive replays a different search. */
interface SearchCaps {
  readonly depth: number;
  readonly branches: number;
}

const DEEP_SEARCH: SearchCaps = { depth: 2, branches: 2 };

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

const CALL_INPUT_TOKENS = 100;

const CALL_OUTPUT_TOKENS = 40;

const CALL_TOKENS = CALL_INPUT_TOKENS + CALL_OUTPUT_TOKENS;

interface Script {
  calls: () => number;
  /** Calls whose prompt holds no turn of the node's own. */
  starts: () => number;
  /** Inherited assistant turns per node on its first step; zero means it started from the seed. */
  readonly inherited: number[];
  /** Resolves once {@link FROZEN_NODES} node-starts have frozen. */
  readonly frozen: Promise<void>;
}

/**
 * Scripted off the node's own turns (assistant messages after the last user message),
 * since concurrent nodes would interleave a shared counter. `freezeFromStart` is the eviction.
 */
function nodeModel(opts: {
  readonly freezeFromStart?: number;
  readonly frozenNodes?: number;
} = {}) {
  // Inferred, not annotated: an annotation would discard the mock's type; `satisfies` proves it.
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

          // The eviction: never settled nor rejected, and no timer holds the event loop.
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

/**
 * Workspace both attempts share, with real hosted seats keyed `(parent, creationId)`.
 * Call `activation()` once per attempt: a shared host would refuse the re-entry because
 * attempt one's frozen turns stay admitted on its in-memory sessions.
 */
async function workspace(): Promise<{
  rt: AgentRuntime;
  db: Database;
  activation: () => SwarmRunDeps['hostNode'];
}> {
  const { rt, db } = createTestRuntime();
  await rt.storage.vfs.mkdir('candidate', { recursive: true });
  await rt.storage.vfs.writeFile(REFERENCE_PATH, `// a nested loop over every pair\n${REFERENCE}`);

  return { rt, db, activation: () => hostedSeatsOver({ rt, db }).hostNode };
}

function inlineFiber() {
  const runs: Promise<unknown>[] = [];

  const fiber: Schedule['fiber'] = async (_name, fn) => {
    const body = fn({ stash: () => {}, snapshot: null });
    runs.push(body);

    return body;
  };

  return { fiber, settled: () => Promise.all(runs) };
}

/** Idle, so a settle wake routes through `enqueueTurn`. */
function idleAgent() {
  const enqueued: ProgrammaticTurn[] = [];

  const host: BackendHost = {
    broadcast: () => {},
    enqueueTurn: async (turn) => {
      enqueued.push(turn);

      return { status: 'queued' };
    },
    turnInFlight: () => false,
    setTimer: () => {},
  };

  return { enqueued, inbox: new Inbox(host) };
}

const MISSION_LABEL = 'nightly';

const FROZEN_NODES = 2;


function treeOf(sql: SqlExecutor): SearchNode[] {
  return sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth ASC, created_at ASC`;
}

describe('a swarm killed mid-flight is re-entered by the real resume path', () => {
  test('same root, settled scores kept, one ledger row, and the report says it resumed', async () => {
    const { rt, db, activation } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);

    const governor = new MissionGovernor({
      storage: { sql: makeSql(db), execRaw: makeExecRaw(db) },
      // A mission ledger is per actor; the caller's actor pays.
      actor: rt.actor,
    });

    governor.declare(MISSION_LABEL, {});
    governor.activate([MISSION_LABEL]);

    const log = createRecordingLogger();
    const first = nodeModel({ freezeFromStart: 3 });

    const frozen = runSwarm(
      { rt, hostNode: activation(), model: first.model, mode: 'build', logger: log },
      resolved(),
    );

    // Never awaited: an evicted activation never returns.
    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;

    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(rootId).not.toBe('');
    expect(log.emitted.map((line) => line.event)).toContain('swarm.checkpoint_reached');
    expect(ledger.get(rootId)).toMatchObject({ status: 'running', iteration: 2, epoch: 0 });
    expect(treeOf(sql).filter((node) => node.depth === 1)).toHaveLength(2);
    expect(treeOf(sql).filter((node) => node.depth === 2)).toHaveLength(0);
    expect(journal.listLive().items.find((run) => run.rootId === rootId)?.running).toBe(FROZEN_NODES);

    // Checked by identity below: retiring these and minting two more would pass a count check.
    const frozenNodeIds = sql<{ id: string }>`
      SELECT id FROM head_journal
      WHERE actor_id = ${rt.actor.actorId} AND root_id = ${rootId} AND depth = 2
      ORDER BY rowid ASC`
      .map((row) => row.id);

    expect(frozenNodeIds).toHaveLength(FROZEN_NODES);
    // No mission scope here, so every charged token belongs to attempt two.
    expect(governor.snapshot(MISSION_LABEL)[0]?.spent.tokens ?? 0).toBe(0);
    expect(first.script.calls()).toBeGreaterThan(0);

    const second = nodeModel();
    initBackgroundJobsTable(makeExecRaw(db));
    const jobs = new BackgroundJobStore(makeSql(db), rt.actor);
    const agent = idleAgent();
    const { fiber, settled } = inlineFiber();
    const notified: string[] = [];

    const deps: AgentsToolDeps = {
      mode: 'build',
      swarm: { rt, hostNode: activation(), model: second.model },
      budget: governor,
    };

    const agents = createAgentsTool(deps);

    const runner = new BackgroundJobRunner({
      store: jobs,
      fiber,
      inbox: agent.inbox,
      resume: (kind, input, mode, signal) =>
        resumeBackgroundJob({ rawTools: () => ({ agents }), kind, input, mode, signal }),
      onSettled: (job) => notified.push(job.status),
    });

    const jobId = 'bgjob-swarm';
    jobs.create({
      id: jobId, kind: 'agents', workMode: 'build', now: Date.now(),
      input: JSON.stringify(swarmCall()),
    });
    await runner.recoverOrphans();
    await settled();

    // One root, and it is the first attempt's.
    const tree = treeOf(sql);
    expect(new Set(tree.map((node) => node.root_id))).toEqual(new Set([rootId]));
    expect(tree.filter((node) => node.parent_id === null)).toHaveLength(1);
    expect(tree.filter((node) => node.depth === 1)).toHaveLength(2);
    expect(tree.filter((node) => node.depth === 2)).toHaveLength(2);

    // `depth * branches` logical nodes across the eviction, not per attempt.
    const journalled = sql<{ id: string; status: string; error_message: string | null; depth: number }>`
      SELECT id, status, error_message, depth FROM head_journal
      WHERE actor_id = ${rt.actor.actorId} AND root_id = ${rootId}
      ORDER BY depth ASC, rowid ASC`;

    expect(journalled).toHaveLength(4);
    expect(journalled.filter((row) => row.depth === 2).map((row) => row.id))
      .toEqual(frozenNodeIds);
    expect(tree.filter((node) => node.depth === 2).map((node) => node.id).sort())
      .toEqual([...frozenNodeIds].sort());

    // No row carries the takeover prose of a retirement.
    expect(journalled.map((row) => row.status)).toEqual(['completed', 'completed', 'completed', 'completed']);

    for (const row of journalled) expect(row.error_message).toBeNull();
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${rt.actor.actorId}
        AND error_message LIKE '%re-entered from its durable rows%'`[0]?.n)
      .toBe(0);
    // Every step under a node belongs to the attempt that answered.
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_steps
      WHERE actor_id = ${rt.actor.actorId}
        AND head_id NOT IN (
          SELECT id FROM head_journal WHERE actor_id = ${rt.actor.actorId}
        )`[0]?.n)
      .toBe(0);

    const rows = ledger.list(10).filter((row) => row.engine === 'swarm');
    expect(rows.map((row) => row.rootId)).toEqual([rootId]);
    expect(rows[0]).toMatchObject({ status: 'converged', epoch: 1, iteration: 4 });

    expect(jobs.get(jobId)?.status).toBe('completed');
    expect(notified).toEqual(['completed']);
    expect(agent.enqueued).toHaveLength(1);

    // The report discloses the resume.
    const report = jobResultReport(jobs.get(jobId)?.result ?? null);
    expect(report.resumed).not.toBeNull();
    expect(report.resumed).toMatchObject({
      rootId,
      // Four: tree rows plus journal-only level-2 rows; counting the tree alone recreates half the budget.
      inheritedExpansions: 4,
      remainingBudget: 0,
      // Re-run under their own ids, not replaced.
      resumedNodes: 2,
      superseded: [],
      attempt: 2,
    });
    // Settled scores survive: four expansions, not the two this activation ran.
    expect(report.expansions).toBe(4);
    // Same `budget` answer a fresh depth-2 run of this shape gives.
    expect(report.stop).toBe('budget');

    // Nothing charged twice; the expected total is the providers' own count, not a ledger read.
    const servedSecond = second.script.calls();
    expect(servedSecond).toBeGreaterThan(0);
    const spent = governor.snapshot(MISSION_LABEL)[0]?.spent.tokens ?? 0;
    expect(spent).toBe(servedSecond * CALL_TOKENS);
    expect(second.script.starts()).toBe(2);

    // Under `context:'inherit'` this prefix can only come from the journal.
    expect(second.script.inherited).toHaveLength(2);

    for (const turns of second.script.inherited) expect(turns).toBeGreaterThan(0);

    // Epoch fencing: attempt one's heartbeat and settle cannot move the row.
    ledger.touch(rootId, 0, Date.now());
    ledger.fail(rootId, 0, Date.now());
    expect(ledger.get(rootId)).toMatchObject({ status: 'converged', iteration: 4 });

    await runner.recoverOrphans();
    expect(jobs.get(jobId)?.status).toBe('completed');
    expect(notified).toEqual(['completed']);
    expect(treeOf(sql)).toHaveLength(tree.length);
    expect(ledger.list(10).filter((row) => row.engine === 'swarm')).toHaveLength(1);
  });
});

/**
 * Eviction before any node has a tree row: the re-entry must re-run the same five nodes,
 * not mark them aborted and mint five more. Logical node count is fixed by the caps; asserted by identity.
 */
describe('a swarm cut before any node reported re-runs those nodes, and creates none', () => {
  const FLAT_SEARCH: SearchCaps = { depth: 1, branches: 5 };

  test('five requested, five journalled, five re-run under their own ids', async () => {
    const { rt, db, activation } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);

    const first = nodeModel({ freezeFromStart: 1, frozenNodes: FLAT_SEARCH.branches });

    const frozen = runSwarm(
      { rt, hostNode: activation(), model: first.model, mode: 'build', logger: createRecordingLogger() },
      resolved(FLAT_SEARCH),
    );

    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;

    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(rootId).not.toBe('');
    expect(treeOf(sql)).toHaveLength(1);
    expect(ledger.get(rootId)).toMatchObject({ status: 'running', iteration: 0, epoch: 0 });

    const spawnedIds = sql<{ id: string }>`
      SELECT id FROM head_journal
      WHERE actor_id = ${rt.actor.actorId} AND root_id = ${rootId} ORDER BY rowid ASC`
      .map((row) => row.id);

    expect(spawnedIds).toHaveLength(FLAT_SEARCH.branches);

    const second = nodeModel();
    initBackgroundJobsTable(makeExecRaw(db));
    const jobs = new BackgroundJobStore(makeSql(db), rt.actor);
    const agent = idleAgent();
    const { fiber, settled } = inlineFiber();

    const agents = createAgentsTool({
      mode: 'build', swarm: { rt, hostNode: activation(), model: second.model },
    });

    const runner = new BackgroundJobRunner({
      store: jobs,
      fiber,
      inbox: agent.inbox,
      resume: (kind, input, mode, signal) =>
        resumeBackgroundJob({ rawTools: () => ({ agents }), kind, input, mode, signal }),
    });

    const jobId = 'bgjob-flat-swarm';
    jobs.create({
      id: jobId, kind: 'agents', workMode: 'build', now: Date.now(),
      input: JSON.stringify(swarmCall(FLAT_SEARCH)),
    });

    // A cold activation runs journal reconciliation with the job sweep as its resume gate.
    const retired = await reconcileInterruptedForks({
      journal,
      inbox: agent.inbox,
      search: ledger,
      resume: async () => {
        await runner.recoverOrphans();

        return [rootId];
      },
    });

    await settled();

    const journalled = sql<{ id: string; status: string; error_message: string | null }>`
      SELECT id, status, error_message FROM head_journal
      WHERE actor_id = ${rt.actor.actorId} AND root_id = ${rootId}
      ORDER BY rowid ASC`;

    expect(journalled.map((row) => row.id)).toEqual(spawnedIds);
    expect(journalled.map((row) => row.status))
      .toEqual(Array.from({ length: FLAT_SEARCH.branches }, () => 'completed'));

    for (const row of journalled) expect(row.error_message).toBeNull();
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${rt.actor.actorId} AND error_message IS NOT NULL`[0]?.n).toBe(0);
    expect(retired).toEqual([]);

    const tree = treeOf(sql);
    expect(tree).toHaveLength(FLAT_SEARCH.branches + 1);
    expect(tree.filter((node) => node.parent_id !== null).map((node) => node.id).sort())
      .toEqual([...spawnedIds].sort());
    expect(new Set(tree.map((node) => node.root_id))).toEqual(new Set([rootId]));

    expect(ledger.list(10).filter((row) => row.engine === 'swarm').map((row) => row.rootId))
      .toEqual([rootId]);
    expect(ledger.get(rootId)).toMatchObject({ epoch: 1, iteration: FLAT_SEARCH.branches });

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

    // No interrupted-fork card beside the settle: a continued run is not a lost one.
    expect(jobs.get(jobId)?.status).toBe('completed');
    expect(agent.enqueued).toHaveLength(1);
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent))
      .not.toContain(FORK_INTERRUPTED_SIGNAL);

    expect(second.script.starts()).toBe(FLAT_SEARCH.branches);
  });
});

/**
 * A cold activation also reconciles the fork journal; the sweep must consult the resume gate
 * and not retire heads the re-drive is about to run.
 */
describe('the start-of-life sweep does not retire a swarm the re-drive can re-enter', () => {
  test('the run is re-entered, and the agent is told nothing was lost', async () => {
    const { rt, db, activation } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);

    const first = nodeModel({ freezeFromStart: 3 });

    const frozen = runSwarm(
      { rt, hostNode: activation(), model: first.model, mode: 'build', logger: createRecordingLogger() },
      resolved(),
    );

    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;

    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(rootId).not.toBe('');
    expect(ledger.get(rootId)).toMatchObject({ status: 'running' });
    expect(journal.listLive().items.find((run) => run.rootId === rootId)?.running).toBe(FROZEN_NODES);

    const second = nodeModel();
    initBackgroundJobsTable(makeExecRaw(db));
    const jobs = new BackgroundJobStore(makeSql(db), rt.actor);
    const agent = idleAgent();
    const { fiber, settled } = inlineFiber();

    // A second host: an eviction is what destroys the first one's admitted turns.
    const agents = createAgentsTool({
      mode: 'build', swarm: { rt, hostNode: activation(), model: second.model },
    });

    const runner = new BackgroundJobRunner({
      store: jobs,
      fiber,
      inbox: agent.inbox,
      resume: (kind, input, mode, signal) =>
        resumeBackgroundJob({ rawTools: () => ({ agents }), kind, input, mode, signal }),
    });

    jobs.create({
      id: 'bgjob-swarm', kind: 'agents', workMode: 'build', now: Date.now(),
      input: JSON.stringify(swarmCall()),
    });

    const retired = await reconcileInterruptedForks({
      journal,
      inbox: agent.inbox,
      resume: async () => {
        await runner.recoverOrphans();

        return [rootId];
      },
    });

    await settled();

    expect(retired).toEqual([]);
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent))
      .not.toContain(FORK_INTERRUPTED_SIGNAL);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${rt.actor.actorId}
        AND error_message = ${FORK_INTERRUPTED_REASON}`[0]?.n).toBe(0);

    const tree = treeOf(sql);
    expect(new Set(tree.map((node) => node.root_id))).toEqual(new Set([rootId]));
    expect(tree.filter((node) => node.depth === 2)).toHaveLength(2);
    expect(ledger.list(10).filter((row) => row.engine === 'swarm').map((row) => row.rootId))
      .toEqual([rootId]);

    // The frozen nodes stop counting as running even though the run continues.
    expect(journal.listLive().items.find((run) => run.rootId === rootId)?.running ?? 0)
      .not.toBe(FROZEN_NODES);
  });

  test('a run the re-drive REFUSED is retired, and the agent is told', async () => {
    // No durable job: nothing can re-enter the run, so retirement must still fire.
    const { rt, db, activation } = await workspace();
    const hostNode = activation();
    const sql = rt.storage.sql;
    const journal = new HeadJournal(sql, rt.actor);
    const first = nodeModel({ freezeFromStart: 3 });

    const frozen = runSwarm(
      { rt, hostNode, model: first.model, mode: 'build', logger: createRecordingLogger() },
      resolved(),
    );

    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;
    const rootId = firstRoot(sql)?.root_id ?? '';
    initBackgroundJobsTable(makeExecRaw(db));
    const agent = idleAgent();

    const retired = await reconcileInterruptedForks({
      journal,
      inbox: agent.inbox,
      resume: async () => [],
    });

    expect(retired.map((run) => run.rootId)).toEqual([rootId]);
    expect(retired[0]?.abandoned).toBe(FROZEN_NODES);
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent)).toContain(FORK_INTERRUPTED_SIGNAL);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${rt.actor.actorId}
        AND error_message = ${FORK_INTERRUPTED_REASON}`[0]?.n).toBe(FROZEN_NODES);
    expect(journal.listLive()).toEqual({ items: [], total: 0 });
  });

  test('a run a LATER activation refuses is still retired, not left interrupted forever', async () => {
    // A run marked `interrupted` by an earlier activation must still settle when a later gate refuses it;
    // gating on this activation having marked something would strand its rows.
    const { rt, activation } = await workspace();
    const hostNode = activation();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);
    const first = nodeModel({ freezeFromStart: 3 });

    const frozen = runSwarm(
      { rt, hostNode, model: first.model, mode: 'build', logger: createRecordingLogger() },
      resolved(),
    );

    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;
    const rootId = firstRoot(sql)?.root_id ?? '';
    const agent = idleAgent();

    const claimed = await reconcileInterruptedForks({
      journal, inbox: agent.inbox, search: ledger, resume: async () => [rootId],
    });

    expect(claimed).toEqual([]);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${rt.actor.actorId} AND status = 'interrupted'`[0]?.n)
      .toBe(FROZEN_NODES);

    const retired = await reconcileInterruptedForks({
      journal, inbox: agent.inbox, search: ledger, resume: async () => [],
    });

    expect(retired.map((run) => run.rootId)).toEqual([rootId]);
    expect(retired[0]?.abandoned).toBe(FROZEN_NODES);
    expect(sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM head_journal
      WHERE actor_id = ${rt.actor.actorId}
        AND error_message = ${FORK_INTERRUPTED_REASON}`[0]?.n).toBe(FROZEN_NODES);
    expect(ledger.get(rootId)?.status).toBe('failed');
    // One card, on the activation that settled it.
    expect(agent.enqueued.map((turn) => turn.metadata?.kinuEvent))
      .toEqual([FORK_INTERRUPTED_SIGNAL]);
  });
});

describe('the start-of-life sweep reaches registry-only jobs', () => {
  test('a wired resume gate runs even when no head or search row exists', async () => {
    let calls = 0;
    await reconcileInterruptedForks({
      journal: {
        markInterrupted: () => [],
        unfinishedRoots: () => [],
        abandonRunning: () => [],
      },
      inbox: idleAgent().inbox,
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
 * A swarm whose job the resume gate refuses must not leave its `mcts_search_runs` row `running`:
 * the start-of-life sweep closes the ledger row with the journal rows.
 */
describe('the start-of-life sweep closes a swarm row nothing re-drives', () => {
  test('a refused run\'s ledger row is failed, and the surface stops calling it running', async () => {
    const { rt, activation } = await workspace();
    const hostNode = activation();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);
    const first = nodeModel({ freezeFromStart: 3 });

    const frozen = runSwarm(
      { rt, hostNode, model: first.model, mode: 'build', logger: createRecordingLogger() },
      resolved(),
    );

    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;
    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(ledger.get(rootId)).toMatchObject({ status: 'running' });
    const agent = idleAgent();

    const retired = await reconcileInterruptedForks({
      journal,
      inbox: agent.inbox,
      search: ledger,
      resume: async () => [],
    });

    expect(retired.map((run) => run.rootId)).toEqual([rootId]);
    expect(ledger.get(rootId)?.status).toBe('failed');
    expect(readForkRun(sql, rt.actor, rootId)?.status).not.toBe('running');
  });

  test('a claimed run keeps its ledger row for the re-entry to settle', async () => {
    const { rt, activation } = await workspace();
    const hostNode = activation();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);
    const first = nodeModel({ freezeFromStart: 3 });

    const frozen = runSwarm(
      { rt, hostNode, model: first.model, mode: 'build', logger: createRecordingLogger() },
      resolved(),
    );

    expect(frozen).toBeInstanceOf(Promise);
    await first.script.frozen;
    const rootId = firstRoot(sql)?.root_id ?? '';
    const agent = idleAgent();

    await reconcileInterruptedForks({
      journal,
      inbox: agent.inbox,
      search: ledger,
      resume: async () => [rootId],
    });

    // Still the re-drive's row: closing it here would fail a search about to continue.
    expect(ledger.get(rootId)?.status).toBe('running');
  });

  test('a search-only root is offered to the resume gate before closure', async () => {
    const { rt } = await workspace();
    const ledger = new MctsSearchStore(rt.storage.sql, rt.actor);
    const journal = new HeadJournal(rt.storage.sql, rt.actor);
    beganSwarm(ledger, 'root-search-only', Date.now() - 1_000);
    const offered: string[][] = [];

    await reconcileInterruptedForks({
      journal,
      inbox: idleAgent().inbox,
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
    // A `unit:'thought'` swarm journals no head rows, so the sweep must still check the ledger.
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);
    beganSwarm(ledger, 'root-thought-only', Date.now() - 1_000);
    const agent = idleAgent();

    await reconcileInterruptedForks({
      journal,
      inbox: agent.inbox,
      search: ledger,
      resume: async () => [],
    });

    expect(ledger.get('root-thought-only')?.status).toBe('failed');
  });

  test('a gate that throws closes nothing', async () => {
    const { rt } = await workspace();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const journal = new HeadJournal(sql, rt.actor);
    beganSwarm(ledger, 'root-ungated', Date.now() - 1_000);
    const agent = idleAgent();

    await reconcileInterruptedForks({
      journal,
      inbox: agent.inbox,
      search: ledger,
      resume: async () => {
        throw new Error('the gate could not answer');
      },
    });

    // An unanswered gate is not a refusal.
    expect(ledger.get('root-ungated')?.status).toBe('running');
  });
});

/** The name passed to `agents.swarm` becomes the search root's label and the run summary's name. */
describe('a named swarm is called by its name', () => {
  test('the name reaches the root row and the run summary', async () => {
    const { rt, activation } = await workspace();
    const hostNode = activation();
    const sql = rt.storage.sql;

    const named = resolveSwarm({
      preset: 'custom', label: 'resume-proof', name: 'token duel', task: TASK,
      objective: objective(), config: config(), depth: 1, branches: 2,
    });

    if ('reason' in named) throw new Error(`the suite's own composition does not resolve: ${named.error}`);
    const model = nodeModel();
    await runSwarm(
      { rt, hostNode, model: model.model, mode: 'build', logger: createRecordingLogger() },
      named,
    );

    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(rootId).not.toBe('');
    expect(sql<{ action: string }>`
      SELECT action FROM search_nodes WHERE id = ${rootId}`[0]?.action).toBe('token duel');
    expect(readForkRun(sql, rt.actor, rootId)?.name).toBe('token duel');
  });

  test('a composition with no name falls back to its provenance label', async () => {
    const { rt, activation } = await workspace();
    const hostNode = activation();
    const sql = rt.storage.sql;
    const model = nodeModel();
    await runSwarm(
      { rt, hostNode, model: model.model, mode: 'build', logger: createRecordingLogger() },
      resolved(),
    );
    const rootId = firstRoot(sql)?.root_id ?? '';
    expect(readForkRun(sql, rt.actor, rootId)?.name).toBe('resume-proof');
  });
});

function firstRoot(sql: SqlExecutor): { root_id: string } | undefined {
  return sql<{ root_id: string }>`
    SELECT root_id FROM search_nodes WHERE parent_id IS NULL LIMIT 1`[0];
}

/** The settle report parsed from the job row, which is what a caller receives after a resume. */
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

/**
 * A non-re-drive call over a task this workspace is still searching is refused, not given a new root.
 * A `running` ledger row is the guard's whole input (`findRunningSwarms`).
 */
describe('a second search over a task already running is refused', () => {
  test('no new root, no new ledger row, and the refusal names the run to wait for', async () => {
    const { rt, activation } = await workspace();
    const hostNode = activation();
    const sql = rt.storage.sql;
    const ledger = new MctsSearchStore(sql, rt.actor);
    const log = createRecordingLogger();

    beganSwarm(ledger, 'root-in-flight', Date.now());
    void sql`INSERT INTO search_nodes (actor_id, id, root_id, task, observation)
      VALUES (${rt.actor.actorId}, 'root-in-flight', 'root-in-flight', ${TASK}, 'root')`;

    for (const id of ['c1', 'c2']) {
      void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
        VALUES (${rt.actor.actorId}, ${id}, 'root-in-flight', 'root-in-flight', ${TASK}, 'node', 1)`;
    }

    expect(ledger.findRunningSwarms(TASK).map((row) => row.rootId)).toEqual(['root-in-flight']);

    const second = nodeModel();

    const result = await runSwarm(
      { rt, hostNode, model: second.model, mode: 'build', logger: log },
      resolved(),
    );

    // The refusal names the run and its progress, so the caller does not re-spawn.
    expect('reason' in result).toBe(true);

    if ('reason' in result) {
      expect(result.error).toContain('root-in-flight');
      expect(result.error).toContain('iteration 2');
      expect(result.error).toMatch(/wake/i);
    }

    // No second root or ledger row; the live row is not superseded.
    const seededTree = sql<{ id: string }>`SELECT id FROM search_nodes
                                             WHERE actor_id = ${rt.actor.actorId}
                                             ORDER BY id`.map((r) => r.id);

    expect(ledger.list(10).filter((row) => row.engine === 'swarm').map((row) => row.rootId))
      .toEqual(['root-in-flight']);
    expect(ledger.get('root-in-flight')).toMatchObject({ status: 'running', epoch: 0 });

    expect(sql<{ id: string }>`SELECT id FROM search_nodes
                                 WHERE actor_id = ${rt.actor.actorId} ORDER BY id`.map((r) => r.id))
      .toEqual(seededTree);

    expect(second.script.calls()).toBe(0);

    const refused = log.emitted.filter((line) => line.event === 'swarm.duplicate_root_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.fields).toMatchObject({ root: 'root-in-flight', redrive: false, running: 1 });
  });

  test('a task nothing is running is not refused, so the guard cannot block a first call', () => {
    // Without this arm, refusing every call would pass.
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
    initSearchTables(execRaw);
    initMctsSearchTable(execRaw);
    initSwarmNodeRecords(execRaw);
    const actor = createTestActorsOver(db).main;
    const ledger = new MctsSearchStore(sql, actor);
    beganSwarm(ledger, 'harvest-root', 1_000);
    void sql`INSERT INTO search_nodes (actor_id, id, root_id, task, observation)
      VALUES (${actor.actorId}, 'harvest-root', 'harvest-root', ${TASK}, 'root')`;
    void sql`INSERT INTO search_nodes (actor_id, id, parent_id, root_id, task, observation, depth)
      VALUES (${actor.actorId}, 'witness', 'harvest-root', 'harvest-root', ${TASK}, 'certificate', 1)`;
    recordSwarmNode(sql, actor, {
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

    const harvest = harvestSwarm({ sql, ledger, actor }, TASK);
    expect(harvest?.witnessFound).toBe(true);
    expect(harvest?.candidates[0]?.witnessFound).toBe(true);
  });
});
