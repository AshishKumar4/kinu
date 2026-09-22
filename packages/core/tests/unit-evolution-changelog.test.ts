/**
 * The evolution changelog digest over real seeded ledgers: every entry kind, since
 * filtering, the unseen window as a subset of what the digest renders, the text form,
 * and reverts through the real machinery.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildChangelog, countUnseenChangelog, listUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  initScaffoldTables, initShadowTables, initTurnOutcomeTables, initReplayTables,
  initFactsTable, createFactsStore, initGepaTables, initRunEventTables,
  startGepaRun, finishGepaRun,
  recordTurnOutcome, recordShadowEvaluation,
  modifyScaffold, applyPromotionDecision, getPendingScaffold,
  EvolutionEngine,
  type AgentRuntime, type EvolutionEvent,
} from '../src/index';
import { describePathology } from '../src/evolution/pathology';
import { createRefinementStore, initRefinementTables } from '../src/evolution/refinement';
import { createTestRuntime } from './helpers';
import { RunEventRecorder } from '../src/events/recorder';
import { present } from '@kinu.run/test-utils';

const V0_CODE = 'async function* run(rt, task) { yield "v0"; }';

const V1_CODE = 'async function* run(rt, task) { yield "v1-pending"; }';

const RATIONALE = 'Session reflection: stream tool results incrementally for long tasks.';

function setup() {
  const { rt, stores } = createTestRuntime();
  const execRaw = rt.storage.execRaw;
  initScaffoldTables(execRaw);
  initShadowTables(execRaw);
  initTurnOutcomeTables(execRaw);
  initReplayTables(execRaw);
  initFactsTable(execRaw);
  initGepaTables(execRaw);
  initRefinementTables(execRaw);

  return { rt, stores, facts: createFactsStore(rt.storage.sql, rt.actor) };
}

async function seedScaffoldPending(rt: AgentRuntime): Promise<number> {
  await rt.identity.scaffold.write(V0_CODE);
  void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
                 VALUES (${rt.actor.actorId}, 0, ${Date.now() - 60_000}, ${'bootstrap'}, 'current')`;
  const result = await modifyScaffold(rt, RATIONALE, V1_CODE);
  expect(result.ok).toBe(true);

  return present(result.version, 'the version modifyScaffold assigned');
}

interface ReplayRowSeed {
  id: string;
  at: number;
  n: number;
  mean: number;
  scaffoldVersion: number;
}

describe('buildChangelog — every kind from the seeded ledgers', () => {
  test('scaffold proposal entry carries the shadow record as evidence', async () => {
    const { rt } = setup();
    const version = await seedScaffoldPending(rt);
    recordShadowEvaluation(rt.storage.sql, rt.actor, {
      currentVersion: 0, pendingVersion: version, task: 'task A',
      currentOutput: 'a', pendingOutput: 'b',
      judgeResult: { winner: 'pending', rationale: 'clearer', currentScore: 0.4, pendingScore: 0.8 },
    });
    recordShadowEvaluation(rt.storage.sql, rt.actor, {
      currentVersion: 0, pendingVersion: version, task: 'task B',
      currentOutput: 'a', pendingOutput: 'b',
      judgeResult: { winner: 'current', rationale: 'regressed', currentScore: 0.7, pendingScore: 0.5 },
    });

    const entries = buildChangelog(rt.storage.sql, rt.actor);
    const scaffold = present(entries.find((e) => e.kind === 'scaffold'), 'the scaffold entry');
    expect(scaffold.summary).toBe('I am testing an improvement to how I work');
    expect(scaffold.evidence).toContain(`Proposed scaffold v${version}`);
    expect(scaffold.evidence).toContain('shadow trial in progress');
    expect(scaffold.evidence).toContain('1W-1L-0T');
    expect(scaffold.evidence).toContain('win-rate 50%');
    expect(scaffold.revert).toEqual({ type: 'scaffold_rollback', target: String(version) });
    expect(scaffold.scaffoldVersion).toBe(version);
    // The v0 bootstrap is not a self-change.
    expect(entries.filter((e) => e.kind === 'scaffold')).toHaveLength(1);
    // Nothing named a pathology, so the line claims none.
    expect(scaffold.evidence).not.toContain('targets');
  });

  test('a scaffold entry says which failure the version was written for', async () => {
    const { rt } = setup();
    await rt.identity.scaffold.write(V0_CODE);
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
                   VALUES (${rt.actor.actorId}, 0, ${Date.now() - 60_000}, ${'bootstrap'}, 'current')`;
    const result = await modifyScaffold(rt, RATIONALE, `// pathology: no_action/prose\n${V1_CODE}`);
    expect(result.ok).toBe(true);

    const scaffold = present(
      buildChangelog(rt.storage.sql, rt.actor).find((e) => e.kind === 'scaffold'),
      'the scaffold entry',
    );

    expect(scaffold.evidence).toContain(`targets ${describePathology('no_action/prose')}`);
  });

  test('crafted tool entry shows the EMA score and is informational (no revert)', () => {
    const { rt } = setup();
    rt.craftStore.create({
      name: 'fetch_and_summarize', description: 'Fetch a URL and summarize it',
      code: 'async (args) => args.url', params: null, scope: 'shared',
    });
    void rt.storage.sql`UPDATE crafted_tools SET score = 0.82, uses = 5, last_used_at = ${Date.now()}
        WHERE name = 'fetch_and_summarize'`;

    const [entry] = buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'tool');
    expect(entry.summary).toBe('Created a tool: fetch and summarize');
    expect(entry.evidence).toContain('Crafted tool fetch_and_summarize');
    expect(entry.evidence).toContain('Fetch a URL and summarize it');
    expect(entry.evidence).toContain('EMA 0.82 over 5 uses');
    // A crafted tool carries no Keep/Revert action.
    expect(entry.revert).toBeUndefined();
  });

  test('fact aggregate humanizes rows while retaining raw evidence and reverts', () => {
    const { rt, facts } = setup();
    facts.upsert('sandbox.npm_version', 'npm v10', { confidence: 0.9, source: 'sleep-time-compute' });

    const [entry] = buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'fact');
    expect(entry.summary).toBe('Learned 1 thing about your environment');
    expect(entry.items).toHaveLength(1);
    const [item] = present(entry.items, 'the fact aggregate items');
    expect(item.id).toBe('fact:sandbox.npm_version');
    expect(item.summary).toBe('Your sandbox runs npm v10');
    expect(item.evidence).toContain('sandbox.npm_version = npm v10');
    expect(item.evidence).toContain('confidence 90%');
    expect(item.evidence).toContain('via sleep-time-compute');
    expect(item.revert).toEqual({ type: 'fact_forget', target: 'sandbox.npm_version' });
    expect(entry.revert).toEqual({ type: 'fact_forget_many', targets: ['sandbox.npm_version'] });
  });

  test('groups all facts in the digest window into one aggregate card', () => {
    const { rt, facts } = setup();
    const now = Date.now();
    facts.upsert('old.fact', 'outside');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now - 60_000}
      WHERE actor_id = ${rt.actor.actorId} AND key = 'old.fact'`;
    facts.upsert('sandbox.npm_version', 'npm v10');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now - 2000}
      WHERE actor_id = ${rt.actor.actorId} AND key = 'sandbox.npm_version'`;
    facts.upsert('project.deploy_target', 'example.workers.dev');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now - 1000}
      WHERE actor_id = ${rt.actor.actorId} AND key = 'project.deploy_target'`;

    const [entry] = buildChangelog(rt.storage.sql, rt.actor, { since: now - 30_000 })
      .filter((e) => e.kind === 'fact');

    expect(entry.summary).toBe('Learned 2 things about your environment');
    expect(entry.at).toBe(now - 1000);
    expect(entry.items?.map((item) => item.id)).toEqual([
      'fact:project.deploy_target',
      'fact:sandbox.npm_version',
    ]);
  });

  test('same-value re-observation keeps a stable id and does not refresh the digest', () => {
    const { rt, facts } = setup();
    facts.upsert('sandbox.npm_version', 'npm v10');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = 1000
      WHERE actor_id = ${rt.actor.actorId} AND key = 'sandbox.npm_version'`;
    const original = present(buildChangelog(rt.storage.sql, rt.actor)[0].items, 'the fact items')[0];

    facts.upsert('sandbox.npm_version', 'npm v10', { confidence: 0.9, source: 'sleep-time-compute' });

    const reobserved = present(buildChangelog(rt.storage.sql, rt.actor)[0].items, 'the fact items')[0];

    expect(reobserved.id).toBe(original.id);
    expect(reobserved.at).toBe(1000);
    expect(buildChangelog(rt.storage.sql, rt.actor, { since: 1000 })).toEqual([]);
  });

  test('value change refreshes the stable fact entry', () => {
    const { rt, facts } = setup();
    facts.upsert('sandbox.npm_version', 'npm v9');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = 1000
      WHERE actor_id = ${rt.actor.actorId} AND key = 'sandbox.npm_version'`;

    facts.upsert('sandbox.npm_version', 'npm v10');

    const [entry] = buildChangelog(rt.storage.sql, rt.actor, { since: 1000 });
    const [item] = present(entry.items, 'the fact aggregate items');
    expect(item.id).toBe('fact:sandbox.npm_version');
    expect(item.summary).toBe('Your sandbox runs npm v10');
  });

  test('GEPA, replay, and outcome entries are informational (no revert)', () => {
    const { rt } = setup();
    const sql = rt.storage.sql;
    const actor = rt.actor;
    const runId = startGepaRun(sql, actor, { target: 'scaffold', budget: {} });
    finishGepaRun(sql, actor, {
      runId, status: 'completed', stopReason: 'metric_budget_exhausted', winnerId: 'cand-1',
      metricCalls: 12, iterations: 3,
    });
    // An aborted run changed nothing.
    const abortedId = startGepaRun(sql, actor, { target: 'scaffold', budget: {} });
    finishGepaRun(sql, actor, {
      runId: abortedId, status: 'aborted', stopReason: 'aborted', winnerId: null,
      metricCalls: 0, iterations: 0,
    });
    void sql`INSERT INTO replay_evals (actor_id, id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
        VALUES (${actor.actorId}, 'rpl-1', ${Date.now()}, 6, 4, 2, 0.75, 0.25, 0, '[]')`;
    recordTurnOutcome(sql, actor, {
      outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'build it', assistantResponse: 'done',
    });
    recordTurnOutcome(sql, actor, {
      outcome: 'corrected', confidence: 0.8, source: 'classifier',
      userMessage: 'fix it', assistantResponse: 'wrong', followup: 'no, the other one',
    });

    const entries = buildChangelog(sql, actor);
    const gepa = entries.filter((e) => e.kind === 'gepa');
    expect(gepa).toHaveLength(1);
    expect(gepa[0].summary).toBe('Tuned my own instructions');
    expect(gepa[0].evidence).toContain('found a better candidate');
    expect(gepa[0].evidence).toContain('3 iterations');
    expect(gepa[0].evidence).toContain('12 metric calls');
    expect(gepa[0].revert).toBeUndefined();

    const replay = present(entries.find((e) => e.kind === 'replay'), 'the replay entry');
    expect(replay.summary).toContain('Self-test score');
    expect(replay.evidence).toContain('loss 0.25');
    expect(replay.evidence).toContain('6 labeled turns');
    expect(replay.revert).toBeUndefined();

    const outcomes = present(entries.find((e) => e.kind === 'outcomes'), 'the outcomes entry');
    expect(outcomes.summary).toContain('Graded 2 turns');
    expect(outcomes.evidence).toContain('1 accepted');
    expect(outcomes.evidence).toContain('1 corrected');
    expect(outcomes.revert).toBeUndefined();
  });

  test('the digest attributes each verdict to the source that produced it', () => {
    const { rt } = setup();
    const sql = rt.storage.sql;
    const actor = rt.actor;
    // `execution` verdicts had no user, so the batch must not claim user follow-ups.
    recordTurnOutcome(sql, actor, {
      outcome: 'accepted', confidence: 1, source: 'execution',
      userMessage: 'ship it', assistantResponse: 'shipped',
    });
    recordTurnOutcome(sql, actor, {
      outcome: 'corrected', confidence: 1, source: 'execution',
      userMessage: 'again', assistantResponse: 'threw',
    });
    recordTurnOutcome(sql, actor, {
      outcome: 'accepted', confidence: 0.9, source: 'classifier',
      userMessage: 'fix it', assistantResponse: 'fixed', followup: 'thanks',
    });

    const outcomes = present(
      buildChangelog(sql, actor).find((e) => e.kind === 'outcomes'),
      'the outcomes entry',
    );

    expect(outcomes.summary).toContain('Graded 3 turns');
    expect(outcomes.summary).toContain('2 by whether their tool calls ran');
    expect(outcomes.summary).toContain('1 from how the user replied');
    expect(outcomes.summary).not.toContain('real user follow-ups');
    // The outcome tally is unchanged by provenance.
    expect(outcomes.evidence).toBe('2 accepted · 1 corrected');
  });

  test('each graded turn expands to the reason behind its verdict', () => {
    const { rt } = setup();
    const sql = rt.storage.sql;
    const actor = rt.actor;
    recordTurnOutcome(sql, actor, {
      outcome: 'corrected', confidence: 0.75, source: 'classifier',
      userMessage: 'add pagination to the chat list', assistantResponse: 'done',
      followup: 'no, the other list',
      evidence: 'the user named a different list than the one that changed', now: 100,
    });
    // No reason on record: the source is the reason.
    recordTurnOutcome(sql, actor, {
      outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'ship it', assistantResponse: 'shipped', now: 200,
    });

    const outcomes = present(
      buildChangelog(sql, actor).find((e) => e.kind === 'outcomes'),
      'the outcomes entry',
    );

    const items = present(outcomes.items, 'the graded-turn items');

    expect(items.map((i) => i.summary)).toEqual([
      'accepted — "ship it"',
      'corrected — "add pagination to the chat list"',
    ]);
    expect(items[1].evidence).toBe(
      "the user's reply read as corrected"
      + ' — the user named a different list than the one that changed · confidence 75%',
    );
    expect(items[0].evidence).toBe('thumbs up from the user');
  });

  test('every ledger present and empty produces an empty digest', () => {
    const { rt } = setup();
    expect(buildChangelog(rt.storage.sql, rt.actor)).toEqual([]);
  });

  test('a refinement that changed nothing is marked at the source, and only the changes-only page drops it', () => {
    // A run that changed nothing is kept but flagged, so no surface parses prose for it.
    const { rt } = setup();
    const store = createRefinementStore(rt.storage.sql, rt.actor);
    const refused = store.open({ trigger: 'explicit', scope: 'workspace', turnIds: ['t-1'] }).request;

    expect(store.advance(refused.id, 'requested', 'refused', {
      detail: 'the refiner proposed no edits',
    })).toBe(true);

    const applied = store.open({ trigger: 'explicit', scope: 'workspace', turnIds: ['t-2'] }).request;

    expect(store.advance(applied.id, 'requested', 'applied', { detail: '1 edit in effect' })).toBe(true);

    const entries = buildChangelog(rt.storage.sql, rt.actor);
    const refusedId = `refinement:${refused.id}:refused`;
    const appliedId = `refinement:${applied.id}:applied`;

    expect(entries.find((entry) => entry.id === refusedId)?.noChange).toBe(true);
    expect(entries.find((entry) => entry.id === appliedId)?.noChange).toBeUndefined();

    const changes = buildChangelog(rt.storage.sql, rt.actor, { changesOnly: true });
    expect(changes.map((entry) => entry.id)).not.toContain(refusedId);
    expect(changes.map((entry) => entry.id)).toContain(appliedId);
  });

  test('orders newest first and respects the limit', () => {
    const { rt, facts } = setup();
    const now = Date.now();
    facts.upsert('older', 'a');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now - 10_000}
      WHERE actor_id = ${rt.actor.actorId} AND key = 'older'`;
    facts.upsert('newer', 'b');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now}
      WHERE actor_id = ${rt.actor.actorId} AND key = 'newer'`;

    const entries = buildChangelog(rt.storage.sql, rt.actor);
    expect(entries).toHaveLength(1);
    expect(entries[0].items?.map((item) => item.summary)).toEqual([
      'Your newer is b',
      'Your older is a',
    ]);
    expect(buildChangelog(rt.storage.sql, rt.actor, { limit: 1 })).toHaveLength(1);
  });

  test('changesOnly selects before the limit, so a page of bookkeeping cannot hide an older change', async () => {
    const { rt } = setup();
    const sql = rt.storage.sql;
    const actor = rt.actor;

    // The real change sits older than eight bookkeeping rows that would push it off the page.
    const version = await seedScaffoldPending(rt);
    const now = Date.now();

    for (let index = 0; index < 7; index += 1) {
      void sql`INSERT INTO replay_evals (actor_id, id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
          VALUES (${actor.actorId}, ${`rpl-${index}`}, ${now + 2 + index}, 6, 4, 2, 0.75, 0.25, ${version}, '[]')`;
    }

    recordTurnOutcome(sql, actor, {
      outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'ship it', assistantResponse: 'shipped', now: now + 1,
    });

    // The default page is bookkeeping only; the change-only page still finds it.
    const page = buildChangelog(sql, actor, { limit: 8 });
    expect(page).toHaveLength(8);
    expect(page.every((entry) => entry.kind === 'outcomes' || entry.kind === 'replay')).toBe(true);

    const changes = buildChangelog(sql, actor, { limit: 8, changesOnly: true });
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe(`scaffold:v${version}:pending`);

    // The unseen marker counts the digest unfiltered.
    expect(countUnseenChangelog(sql, actor, 0)).toBe(9);
  });

  test('humanizes scaffold promotion and replay score direction without losing raw detail', async () => {
    const { rt } = setup();
    const version = await seedScaffoldPending(rt);

    for (const [index, winner] of (['pending', 'pending', 'pending', 'current'] as const).entries()) {
      recordShadowEvaluation(rt.storage.sql, rt.actor, {
        currentVersion: 0, pendingVersion: version, task: `trial-${index}`,
        currentOutput: 'current', pendingOutput: 'pending',
        judgeResult: { winner, rationale: 'evidence', currentScore: 0.5, pendingScore: 0.8 },
      });
    }

    const pending = present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold');

    await applyPromotionDecision(rt, pending, 'promote', new RunEventRecorder(rt.storage.sql, rt.actor));
    const now = Date.now();

    const replayRow = ({ id, at, n, mean, scaffoldVersion }: ReplayRowSeed) => {
      void rt.storage.sql`INSERT INTO replay_evals (actor_id, id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
          VALUES (${rt.actor.actorId}, ${id}, ${at}, ${n}, ${n / 2}, ${n / 2}, ${mean}, ${1 - mean}, ${scaffoldVersion}, '[]')`;
    };

    // 0.50 → 0.75 over 4 instances: overlapping intervals, not a direction.
    replayRow({ id: 'rpl-old', at: now - 1000, n: 4, mean: 0.50, scaffoldVersion: 0 });
    replayRow({ id: 'rpl-new', at: now, n: 4, mean: 0.75, scaffoldVersion: version });
    // 0.30 → 0.95 over 40 instances: the intervals clear each other.
    replayRow({ id: 'rpl-lo', at: now + 1, n: 40, mean: 0.30, scaffoldVersion: version });
    replayRow({ id: 'rpl-hi', at: now + 2, n: 40, mean: 0.95, scaffoldVersion: version });
    replayRow({ id: 'rpl-drop', at: now + 3, n: 40, mean: 0.30, scaffoldVersion: version });

    const entries = buildChangelog(rt.storage.sql, rt.actor);
    const scaffold = present(entries.find((entry) => entry.kind === 'scaffold'), 'the scaffold entry');
    expect(scaffold.summary).toBe('I improved how I work (won 3 of 4 trial runs)');
    expect(scaffold.evidence).toContain(`Promoted scaffold v${version}`);
    expect(scaffold.evidence).toContain(RATIONALE);
    const replay = present(entries.find((entry) => entry.id === 'replay:rpl-new'), 'the rpl-new entry');
    expect(replay.summary).toBe('Self-test score held within noise at 0.75 (95% CI 0.30–0.95)');
    expect(replay.evidence).toContain('loss 0.25 (95% CI 0.05–0.70)');
    expect(replay.evidence).toContain(`scaffold v${version}`);
    expect(present(entries.find((entry) => entry.id === 'replay:rpl-hi'), 'the rpl-hi entry').summary)
      .toBe('Self-test score improved to 0.95 (95% CI 0.83–0.99)');
    expect(present(entries.find((entry) => entry.id === 'replay:rpl-drop'), 'the rpl-drop entry').summary)
      .toBe('Self-test score declined to 0.30 (95% CI 0.18–0.45)');
  });
});

describe('unseen-count logic (the badge)', () => {
  test('counts only entries newer than the seen marker', () => {
    const { rt, facts } = setup();
    const now = Date.now();
    facts.upsert('seen_fact', 'x');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now - 60_000}
      WHERE actor_id = ${rt.actor.actorId} AND key = 'seen_fact'`;
    facts.upsert('fresh_fact', 'y');
    void rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now}
      WHERE actor_id = ${rt.actor.actorId} AND key = 'fresh_fact'`;

    expect(countUnseenChangelog(rt.storage.sql, rt.actor, 0)).toBe(1);
    expect(countUnseenChangelog(rt.storage.sql, rt.actor, now - 30_000)).toBe(1);
    expect(countUnseenChangelog(rt.storage.sql, rt.actor, now)).toBe(0);
  });

  test('the turn-outcome aggregate only counts outcomes inside the window', () => {
    const { rt } = setup();
    const sql = rt.storage.sql;
    const actor = rt.actor;
    const now = Date.now();
    recordTurnOutcome(sql, actor, {
      outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'old', assistantResponse: 'old', now: now - 60_000,
    });
    recordTurnOutcome(sql, actor, {
      outcome: 'corrected', confidence: 1, source: 'explicit',
      userMessage: 'new', assistantResponse: 'new', now,
    });

    const windowed = buildChangelog(sql, actor, { since: now - 30_000 });
    const agg = present(windowed.find((e) => e.kind === 'outcomes'), 'the outcomes entry');
    expect(agg.summary).toContain('Graded 1 turn');
    expect(agg.evidence).toBe('1 corrected');
  });

  /** The needs-you queue must never count what the journal would not show. */
  test('every unseen entry is one the digest itself renders', () => {
    const { rt, facts } = setup();
    const sql = rt.storage.sql;
    const actor = rt.actor;
    recordTurnOutcome(sql, actor, {
      outcome: 'accepted', confidence: 1, source: 'execution',
      userMessage: 'hi', assistantResponse: 'hello',
    });
    facts.upsert('sandbox.node_version', 'v22');

    const unseen = listUnseenChangelog(sql, actor, 0);
    const rendered = new Set(buildChangelog(sql, actor, { limit: 30 }).map((entry) => entry.id));
    expect(unseen.length).toBeGreaterThan(0);
    expect(unseen.filter((entry) => !rendered.has(entry.id))).toEqual([]);
    expect(countUnseenChangelog(sql, actor, 0)).toBe(unseen.length);
  });

  /** A first-turn execution verdict is unseen but carries no revert to decide. */
  test('the first turn of a fresh workspace produces an unseen entry with nothing to decide', () => {
    const { rt } = setup();
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      outcome: 'accepted', confidence: 1, source: 'execution',
      userMessage: 'hi', assistantResponse: 'hello',
    });

    const unseen = listUnseenChangelog(rt.storage.sql, rt.actor, 0);
    expect(unseen.map((entry) => entry.kind)).toEqual(['outcomes']);
    expect(unseen.filter((entry) => entry.revert !== undefined)).toEqual([]);
  });
});

describe('renderChangelogText — the one text form', () => {
  test('numbers entries, shows evidence, marks revertables', () => {
    const { rt, facts } = setup();
    facts.upsert('k', 'v', { confidence: 0.7 });
    void rt.storage.sql`INSERT INTO replay_evals (actor_id, id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
        VALUES (${rt.actor.actorId}, 'rpl-2', ${Date.now() - 1000}, 3, 2, 1, 0.9, 0.1, NULL, '[]')`;

    const entries = buildChangelog(rt.storage.sql, rt.actor);
    const text = renderChangelogText(entries, { unseenCount: 2 });
    expect(text).toContain('2 unseen');
    expect(text).toContain('  1. ');
    expect(text).toContain('  2. ');
    expect(text).toContain('Learned 1 thing about your environment');
    expect(text).toContain('Your k is v');
    expect(text).toContain('revertable');
    const factDetailLine = text.split('\n').find((line) => line.includes('confidence 70%'));
    expect(factDetailLine).toBeDefined();
    expect(factDetailLine).not.toContain('revertable');
    // The replay measurement line is not revertable.
    const replayLine = text.split('\n').find((l) => l.includes('confidence') === false && l.includes('labeled turns'));
    expect(replayLine).toBeDefined();
    expect(replayLine).not.toContain('revertable');
  });

  test('renders the empty state', () => {
    expect(renderChangelogText([])).toContain('empty');
  });
});

describe('reverts — real paths only', () => {
  test('fact forget removes the fact; double-revert errors', async () => {
    const { rt, facts } = setup();
    facts.upsert('volatile', 42);
    const result = await executeChangelogRevert({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, { type: 'fact_forget', target: 'volatile' });
    expect(result.ok).toBe(true);
    expect(facts.recall('volatile')).toBeNull();
    const again = await executeChangelogRevert({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, { type: 'fact_forget', target: 'volatile' });
    expect(again.ok).toBe(false);
  });

  test('stable child fact id resolves against a fresh aggregate digest', async () => {
    const { rt, facts } = setup();
    facts.upsert('sandbox.npm_version', 'npm v10');

    const aggregate = present(
      buildChangelog(rt.storage.sql, rt.actor).find((e) => e.kind === 'fact'),
      'the fact aggregate',
    );

    const id = present(aggregate.items, 'the fact aggregate items')[0].id;

    facts.upsert('sandbox.npm_version', 'npm v10', { confidence: 0.95 });

    const result = await revertChangelogEntryById({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, id);

    expect(result.ok).toBe(true);
    expect(facts.recall('sandbox.npm_version')).toBeNull();
  });

  test('aggregate fact id forgets every constituent fact', async () => {
    const { rt, facts } = setup();
    facts.upsert('editor', 'helix');
    facts.upsert('shell', 'fish');

    const aggregate = present(
      buildChangelog(rt.storage.sql, rt.actor).find((e) => e.kind === 'fact'),
      'the fact aggregate',
    );

    const result = await revertChangelogEntryById({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, aggregate.id);

    expect(result).toEqual({ ok: true, detail: 'forgot 2 facts' });
    expect(facts.all()).toEqual([]);
  });

  test('an applied revert is announced on the audit stream, whichever backend asked', async () => {
    // A refused revert announces nothing: there is no act to audit.
    const { rt, facts } = setup();
    facts.upsert('editor', 'helix');

    const entry = present(
      buildChangelog(rt.storage.sql, rt.actor).find((e) => e.kind === 'fact'),
      'the fact aggregate',
    );

    const audit = () => rt.storage.sql<{ message: string }>`
      SELECT message FROM evolution_events WHERE type = 'reflection' AND message LIKE 'Operator reverted%'`;

    expect(await revertChangelogEntryById({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, 'no-such-entry')).toMatchObject({ ok: false });
    expect(audit()).toEqual([]);
    expect((await revertChangelogEntryById({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, entry.id)).ok).toBe(true);
    expect(audit()).toEqual([{ message: `Operator reverted changelog entry ${entry.id}: forgot 1 fact` }]);
  });

  test('batch fact revert continues and reports partial failures', async () => {
    const { rt, facts } = setup();
    facts.upsert('present', true);

    const result = await executeChangelogRevert({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, {
      type: 'fact_forget_many', targets: ['missing', 'present'],
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('forgot 1 of 2 facts');
    expect(result.error).toContain('missing: fact missing is already forgotten');
    expect(facts.recall('present')).toBeNull();
  });

  test('pending scaffold revert discards the trial through the decision machinery', async () => {
    const { rt, facts } = setup();
    const version = await seedScaffoldPending(rt);

    const result = await executeChangelogRevert({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, {
      type: 'scaffold_rollback', target: String(version),
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain(`discarded pending v${version}`);
    expect(getPendingScaffold(rt.storage.sql, rt.actor)).toBeNull();
    expect(await rt.identity.scaffold.read()).toBe(V0_CODE); // live file untouched

    const status = rt.storage.sql<{ status: string }>`
      SELECT status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} AND version = ${version}`[0];

    expect(status.status).toBe('rolled_back');
  });

  test('promoted scaffold revert round-trips back to the predecessor', async () => {
    const { rt, facts } = setup();
    const version = await seedScaffoldPending(rt);
    const pending = present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold');
    await applyPromotionDecision(rt, pending, 'promote', new RunEventRecorder(rt.storage.sql, rt.actor));
    expect(await rt.identity.scaffold.read()).toBe(V1_CODE);

    // The digest shows the promotion as a revertable entry…
    const entry = present(
      buildChangelog(rt.storage.sql, rt.actor).find((e) => e.kind === 'scaffold'),
      'the scaffold entry',
    );

    expect(entry.summary).toContain('I improved how I work');
    expect(entry.evidence).toContain(`Promoted scaffold v${version}`);
    expect(entry.revert).toBeDefined();

    // …and reverting it by id restores the predecessor end-to-end.
    const result = await revertChangelogEntryById({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, entry.id);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('rolled back to v0');
    expect(await rt.identity.scaffold.read()).toBe(V0_CODE);

    const rows = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions
      WHERE actor_id = ${rt.actor.actorId} ORDER BY version`;

    expect(present(rows.find((r) => r.version === 0), 'the v0 row').status).toBe('current');
    expect(present(rows.find((r) => r.version === version), 'the promoted row').status).toBe('rolled_back');

    // A second revert of the same entry refuses.
    const again = await executeChangelogRevert({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, {
      type: 'scaffold_rollback', target: String(version),
    });

    expect(again.ok).toBe(false);
    expect(again.error).toContain('already rolled_back');
  });

  test('revertChangelogEntryById: unknown ids and informational entries refuse', async () => {
    const { rt, facts } = setup();
    recordTurnOutcome(rt.storage.sql, rt.actor, {
      outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'q', assistantResponse: 'a',
    });
    const missing = await revertChangelogEntryById({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, 'nope:1');
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('not found');

    const info = present(
      buildChangelog(rt.storage.sql, rt.actor).find((e) => e.kind === 'outcomes'),
      'the outcomes entry',
    );

    const refused = await revertChangelogEntryById({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, info.id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('informational');
  });
});

describe('session-end digest — assembled when the window closes', () => {
  test('onSessionComplete emits one changelog_digest covering the window', async () => {
    const { rt, facts, stores } = setup();
    const engine = new EvolutionEngine(rt, stores.history);
    const events: EvolutionEvent[] = [];
    engine.onEvent((e) => events.push(e));

    const startedAt = Date.now() - 5_000;
    facts.upsert('discovered_mid_session', 'yes');
    rt.craftStore.create({ name: 'session_tool', description: 'made this session', code: 'async () => 1', params: null, scope: 'local' });

    await engine.onSessionComplete({
      sessionId: 'sess-1',
      turns: [{
        userMessage: 'do the thing', assistantResponse: 'done', toolCalls: [],
        steps: 1, durationMs: 10, feedback: null, hadError: false, origin: 'user',
      }],
      startedAt,
      endedAt: Date.now(),
    });

    const digest = events.filter((e) => e.type === 'changelog_digest');
    expect(digest).toHaveLength(1);
    expect(digest[0].message).toContain('Self-change digest: 2 entries');
    expect(digest[0].message).toContain('1 tool');
    expect(digest[0].message).toContain('1 fact');
    expect(digest[0].message).toContain('revertable');

    // …and it lands in the durable evolution_events log.
    const rows = rt.storage.sql<{ type: string }>`
      SELECT type FROM evolution_events WHERE type = 'changelog_digest'`;

    expect(rows).toHaveLength(1);
  });

  test('a window that changed nothing emits no digest', async () => {
    const { rt, stores } = setup();
    const engine = new EvolutionEngine(rt, stores.history);
    const events: EvolutionEvent[] = [];
    engine.onEvent((e) => events.push(e));
    await engine.onSessionComplete({
      sessionId: 'sess-2', turns: [], startedAt: Date.now() - 1000, endedAt: Date.now(),
    });
    expect(events.filter((e) => e.type === 'changelog_digest')).toHaveLength(0);
  });
});

// Digest assembly across mixed kinds: ordering, windowing, per-kind timestamps.

/** Seed `n` crafted tools stamped at distinct, controllable times. */
function seedTools(rt: AgentRuntime, names: ReadonlyArray<string>, at: (i: number) => number): void {
  for (const [i, name] of names.entries()) {
    rt.craftStore.create({ name, description: `d-${name}`, code: 'async () => 1', params: null, scope: 'local' });
    void rt.storage.sql`UPDATE crafted_tools SET created_at = ${at(i)}, updated_at = ${at(i)}
                   WHERE name = ${name}`;
  }
}

describe('buildChangelog — ordering, limit, and the since window', () => {
  test('orders strictly newest-first across kinds', () => {
    const { rt } = setup();
    const now = Date.now();
    seedTools(rt, ['t_old', 't_mid', 't_new'], (i) => now - (2 - i) * 10_000);

    const entries = buildChangelog(rt.storage.sql, rt.actor);
    expect(entries.map((e) => e.id.split(':')[1])).toEqual(['t_new', 't_mid', 't_old']);

    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].at).toBeGreaterThan(entries[i].at);
    }
  });

  test('entries sharing a timestamp fall back to a stable id order', () => {
    // Without a deterministic tiebreak the unseen badge flickers.
    const { rt } = setup();
    const at = Date.now();
    seedTools(rt, ['aaa_tool', 'zzz_tool'], () => at);

    const ids = buildChangelog(rt.storage.sql, rt.actor).map((e) => e.id);
    expect(ids).toEqual([`tool:zzz_tool:${at}`, `tool:aaa_tool:${at}`]);
    expect(buildChangelog(rt.storage.sql, rt.actor).map((e) => e.id)).toEqual(ids);
  });

  test('an explicit limit keeps the NEWEST entries, not the first assembled ones', () => {
    // Each source is capped at `limit`, so the assembled list exceeds it before the final slice.
    const { rt } = setup();
    const now = Date.now();
    seedTools(rt, ['t1', 't2', 't3', 't4', 't5', 't6'], (i) => now - (5 - i) * 1000);

    for (let i = 0; i < 6; i++) {
      void rt.storage.sql`INSERT INTO replay_evals
        (actor_id, id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
        VALUES (${rt.actor.actorId}, ${`r${i}`}, ${now - (5 - i) * 1000 - 500}, 8, 4, 4, 0.5, 0.5, 0, '[]')`;
    }

    const entries = buildChangelog(rt.storage.sql, rt.actor, { limit: 3 });
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.id)).toEqual([
      `tool:t6:${now}`, `replay:r5`, `tool:t5:${now - 1000}`,
    ]);
  });

  test('the default limit is 50', () => {
    const { rt } = setup();
    const now = Date.now();
    const names = Array.from({ length: 60 }, (_, i) => `tool_${String(i).padStart(2, '0')}`);
    seedTools(rt, names, (i) => now - (59 - i) * 1000);
    expect(buildChangelog(rt.storage.sql, rt.actor)).toHaveLength(50);
    expect(buildChangelog(rt.storage.sql, rt.actor, { limit: 60 })).toHaveLength(60);
  });

  test('`since` is exclusive — an entry stamped exactly at the marker is already seen', () => {
    const { rt } = setup();
    const at = Date.now() - 5_000;
    seedTools(rt, ['boundary_tool'], () => at);

    expect(buildChangelog(rt.storage.sql, rt.actor, { since: at })).toEqual([]);
    expect(buildChangelog(rt.storage.sql, rt.actor, { since: at - 1 })).toHaveLength(1);
    expect(countUnseenChangelog(rt.storage.sql, rt.actor, at)).toBe(0);
    expect(countUnseenChangelog(rt.storage.sql, rt.actor, at - 1)).toBe(1);
  });
});

describe('buildChangelog — per-kind timestamps and evidence', () => {
  test('a scaffold status flip re-dates its entry, attributed to the right version', async () => {
    // Promotion flips a flag on an existing row, so written_at alone would hide it.
    const { rt } = setup();
    initRunEventTables(rt.storage.execRaw);
    const written = Date.now() - 3_600_000;
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
                   VALUES (${rt.actor.actorId}, 1, ${written}, 'earlier way of working', 'superseded')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
                   VALUES (${rt.actor.actorId}, 2, ${written}, ${RATIONALE}, 'current')`;
    const promotedAt = Date.now() - 1_000;
    void rt.storage.sql`INSERT INTO run_events (actor_id, run_id, event_index, type, payload, ts)
      VALUES (${rt.actor.actorId}, 'run-1', 0, 'scaffold_promotion',
              ${JSON.stringify({ fromVersion: 1, toVersion: 2 })},
              ${new Date(promotedAt).toISOString()})`;

    const byVersion = new Map(
      buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'scaffold')
        .map((e) => [e.scaffoldVersion, e] as const),
    );

    // The promotion belongs to the version promoted into.
    expect(present(byVersion.get(2), 'the v2 scaffold entry').at).toBe(promotedAt);
    expect(present(byVersion.get(1), 'the v1 scaffold entry').at).toBe(written);
  });

  test('only live scaffold versions offer a revert', () => {
    const { rt } = setup();
    const written = Date.now() - 10_000;
    const statuses = ['current', 'pending', 'rolled_back', 'superseded'] as const;

    for (const [i, status] of statuses.entries()) {
      void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
                     VALUES (${rt.actor.actorId}, ${i + 1}, ${written + i}, 'r', ${status})`;
    }

    const revertable = new Map(
      buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'scaffold')
        .map((e) => [e.scaffoldVersion, e.revert !== undefined] as const),
    );

    // Already rolled back or superseded versions are not revertable.
    expect(revertable).toEqual(new Map([[1, true], [2, true], [3, false], [4, false]]));
  });

  test('a crafted tool dates from its newest touch, even with a skewed updated_at', () => {
    const { rt } = setup();
    const created = Date.now();
    rt.craftStore.create({ name: 'skewed', description: 'd', code: 'async () => 1', params: null, scope: 'local' });
    void rt.storage.sql`UPDATE crafted_tools SET created_at = ${created}, updated_at = ${created - 60_000}
                   WHERE name = 'skewed'`;

    const [entry] = buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'tool');
    expect(entry.at).toBe(created);
    expect(entry.id).toBe(`tool:skewed:${created}`);
  });

  test('a brand-new tool shows its neutral prior rather than losing its evidence', () => {
    const { rt } = setup();
    rt.craftStore.create({ name: 'brand_new', description: 'fresh', code: 'async () => 1', params: null, scope: 'local' });

    const [entry] = buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'tool');
    // A fresh tool reads as unexercised, never missing.
    expect(entry.evidence).toContain('EMA 0.50 over 0 uses');
    expect(entry.evidence).not.toContain('undefined');
  });

  test('a dotted, underscored fact key reads as a sentence', () => {
    // Exercises the general separator rewrite.
    const { rt, facts } = setup();
    facts.upsert('project.deploy_target', 'example.workers.dev');

    const [entry] = buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'fact');
    const [item] = present(entry.items, 'the fact aggregate items');

    expect(item.summary).toBe('Your project deploy target is example.workers.dev');
  });

  test('the fact aggregate id is observation-order independent', () => {
    // The id must not depend on which fact was seen last.
    const idFor = (order: ReadonlyArray<readonly [string, number]>): string => {
      const { rt, facts } = setup();

      for (const [key, at] of order) {
        facts.upsert(key, 'v');
        void rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${at}
          WHERE actor_id = ${rt.actor.actorId} AND key = ${key}`;
      }

      return buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'fact')[0].id;
    };

    const now = Date.now();
    expect(idFor([['a.one', now], ['b.two', now - 1000]]))
      .toBe(idFor([['b.two', now], ['a.one', now - 1000]]));
  });

  test('a completed GEPA run is dated by when it ENDED', () => {
    const { rt } = setup();
    const runId = startGepaRun(rt.storage.sql, rt.actor, { target: 'scaffold' });
    const endedAt = Date.now() + 60_000;
    finishGepaRun(rt.storage.sql, rt.actor, {
      runId, status: 'completed', stopReason: 'iterations_exhausted',
      winnerId: 'cand-1', metricCalls: 12, iterations: 3,
    });
    void rt.storage.sql`UPDATE gepa_runs SET ended_at = ${endedAt} WHERE run_id = ${runId}`;

    const [entry] = buildChangelog(rt.storage.sql, rt.actor).filter((e) => e.kind === 'gepa');
    expect(entry.at).toBe(endedAt);
  });

  test('replay direction is computed against the predecessor even at the limit edge', () => {
    // A one-row lookahead gives the oldest entry something to compare against.
    const { rt } = setup();
    const now = Date.now();

    const row = (id: string, at: number, mean: number) => {
      void rt.storage.sql`INSERT INTO replay_evals
        (actor_id, id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
        VALUES (${rt.actor.actorId}, ${id}, ${at}, 40, 20, 20, ${mean}, ${1 - mean}, 0, '[]')`;
    };

    row('rp-1', now - 2000, 0.30);
    row('rp-2', now - 1000, 0.95);
    row('rp-3', now, 0.30);

    const entries = buildChangelog(rt.storage.sql, rt.actor, { limit: 2 });
    expect(entries.map((e) => e.id)).toEqual(['replay:rp-3', 'replay:rp-2']);
    expect(entries[0].summary).toContain('declined');
    expect(entries[1].summary).toContain('improved');
  });
});

describe('renderChangelogText + revert guards', () => {
  test('the header mentions unseen entries only when there are some', () => {
    const { rt } = setup();
    seedTools(rt, ['t_one'], () => Date.now());
    const entries = buildChangelog(rt.storage.sql, rt.actor);

    expect(renderChangelogText(entries)).toContain('Evolution changelog (1 entry)');
    expect(renderChangelogText(entries)).not.toContain('unseen');
    expect(renderChangelogText(entries, { unseenCount: 0 })).not.toContain('unseen');
    expect(renderChangelogText(entries, { unseenCount: 2 })).toContain('· 2 unseen');
  });

  test('scaffold rollback refuses a target that is not a real version number', async () => {
    const { rt, facts } = setup();
    const ctx = { events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts };

    for (const target of ['0', '-1', 'abc', '1.5', '']) {
      const result = await executeChangelogRevert(ctx, { type: 'scaffold_rollback', target });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('invalid scaffold version');
    }
  });

  test('discarding a pending trial refuses when it is no longer THE pending', async () => {
    // Only the newest in-flight proposal is decidable; discarding the stale one would restore the wrong file.
    const { rt, facts } = setup();
    const written = Date.now() - 10_000;
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
                   VALUES (${rt.actor.actorId}, 1, ${written}, 'stale proposal', 'pending')`;
    void rt.storage.sql`INSERT INTO scaffold_versions (actor_id, version, written_at, rationale, status)
                   VALUES (${rt.actor.actorId}, 2, ${written + 1}, 'live proposal', 'pending')`;
    expect(present(getPendingScaffold(rt.storage.sql, rt.actor), 'the pending scaffold').version).toBe(2);

    const result = await executeChangelogRevert({ events: new RunEventRecorder(rt.storage.sql, rt.actor), rt, facts }, { type: 'scaffold_rollback', target: '1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no longer the pending under trial');
  });
});
