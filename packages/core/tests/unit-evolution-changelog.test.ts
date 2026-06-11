/**
 * Evolution Changelog — the "what I changed about myself" digest.
 *
 * Covers:
 *   - buildChangelog assembles every entry kind from the REAL seeded ledgers
 *     (scaffold archive + shadow record, crafted tools + EMA, facts, GEPA
 *     runs, replay evals, turn-outcome aggregate) with evidence numbers
 *   - since-window filtering + countUnseenChangelog (the badge logic)
 *   - renderChangelogText (the one CLI/TUI text form)
 *   - reverts go through the real machinery: scaffold rollback round-trip
 *     (pending discard AND promoted-version rollback), craft retire,
 *     fact forget; informational entries refuse to revert
 */

import { describe, test, expect } from 'bun:test';
import {
  buildChangelog, countUnseenChangelog, renderChangelogText,
  executeChangelogRevert, revertChangelogEntryById,
  initScaffoldTables, initShadowTables, initTurnOutcomeTables, initReplayTables,
  initCraftScoreTables, initFactsTable, createFactsStore, initGepaTables,
  startGepaRun, finishGepaRun,
  recordTurnOutcome, recordShadowEvaluation,
  modifyScaffold, applyPromotionDecision, getPendingScaffold,
  EvolutionEngine,
  type AgentRuntime, type EvolutionEvent,
} from '../src/index.ts';
import { createTestRuntime } from './helpers.ts';

const V0_CODE = 'async function* run(rt, task) { yield "v0"; }';
const V1_CODE = 'async function* run(rt, task) { yield "v1-pending"; }';
const RATIONALE = 'Session reflection: stream tool results incrementally for long tasks.';

function setup(): { rt: AgentRuntime; facts: ReturnType<typeof createFactsStore> } {
  const { rt } = createTestRuntime();
  const execRaw = rt.storage.execRaw;
  initScaffoldTables(execRaw);
  initShadowTables(execRaw);
  initTurnOutcomeTables(execRaw);
  initReplayTables(execRaw);
  initCraftScoreTables(execRaw);
  initFactsTable(execRaw);
  initGepaTables(execRaw);
  return { rt, facts: createFactsStore(rt.storage.sql) };
}

async function seedScaffoldPending(rt: AgentRuntime): Promise<number> {
  await rt.identity.scaffold.write(V0_CODE);
  rt.storage.sql`INSERT INTO scaffold_versions (version, written_at, rationale, status)
                 VALUES (0, ${Date.now() - 60_000}, ${'bootstrap'}, 'current')`;
  const result = await modifyScaffold(rt, RATIONALE, V1_CODE);
  expect(result.ok).toBe(true);
  return result.version!;
}

describe('buildChangelog — every kind from the seeded ledgers', () => {
  test('scaffold proposal entry carries the shadow record as evidence', async () => {
    const { rt } = setup();
    const version = await seedScaffoldPending(rt);
    recordShadowEvaluation(rt.storage.sql, {
      currentVersion: 0, pendingVersion: version, task: 'task A',
      currentOutput: 'a', pendingOutput: 'b',
      judgeResult: { winner: 'pending', rationale: 'clearer', currentScore: 0.4, pendingScore: 0.8 },
    });
    recordShadowEvaluation(rt.storage.sql, {
      currentVersion: 0, pendingVersion: version, task: 'task B',
      currentOutput: 'a', pendingOutput: 'b',
      judgeResult: { winner: 'current', rationale: 'regressed', currentScore: 0.7, pendingScore: 0.5 },
    });

    const entries = buildChangelog(rt.storage.sql);
    const scaffold = entries.find((e) => e.kind === 'scaffold');
    expect(scaffold).toBeDefined();
    expect(scaffold!.summary).toContain(`Proposed scaffold v${version}`);
    expect(scaffold!.summary).toContain('shadow trial in progress');
    expect(scaffold!.evidence).toContain('1W-1L-0T');
    expect(scaffold!.evidence).toContain('win-rate 50%');
    expect(scaffold!.revert).toEqual({ type: 'scaffold_rollback', target: String(version) });
    expect(scaffold!.scaffoldVersion).toBe(version);
    // The v0 bootstrap is not a self-change — no entry for it.
    expect(entries.filter((e) => e.kind === 'scaffold')).toHaveLength(1);
  });

  test('crafted tool entry shows the EMA score and is revertable', () => {
    const { rt } = setup();
    rt.craftStore.create({
      name: 'fetch_and_summarize', description: 'Fetch a URL and summarize it',
      code: 'async (args) => args.url', scope: 'global',
    });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at)
                   VALUES ('fetch_and_summarize', 0.82, 5, ${Date.now()})`;

    const [entry] = buildChangelog(rt.storage.sql).filter((e) => e.kind === 'tool');
    expect(entry.summary).toContain('Crafted tool fetch_and_summarize');
    expect(entry.summary).toContain('Fetch a URL and summarize it');
    expect(entry.evidence).toBe('EMA 0.82 over 5 uses');
    expect(entry.revert).toEqual({ type: 'craft_retire', target: 'fetch_and_summarize' });
  });

  test('fact entry shows confidence + source and is revertable', () => {
    const { rt, facts } = setup();
    facts.upsert('deploy_target', 'foo.workers.dev', { confidence: 0.9, source: 'sleep_time_compute' });

    const [entry] = buildChangelog(rt.storage.sql).filter((e) => e.kind === 'fact');
    expect(entry.summary).toBe('Learned fact deploy_target = foo.workers.dev');
    expect(entry.evidence).toContain('confidence 90%');
    expect(entry.evidence).toContain('via sleep_time_compute');
    expect(entry.revert).toEqual({ type: 'fact_forget', target: 'deploy_target' });
  });

  test('GEPA, replay, and outcome entries are informational (no revert)', () => {
    const { rt } = setup();
    const sql = rt.storage.sql;
    const runId = startGepaRun(sql, { target: 'scaffold', budget: {} });
    finishGepaRun(sql, {
      runId, status: 'completed', stopReason: 'budget', winnerId: 'cand-1',
      metricCalls: 12, iterations: 3,
    });
    // An aborted run changed nothing — it must not appear.
    const abortedId = startGepaRun(sql, { target: 'scaffold', budget: {} });
    finishGepaRun(sql, {
      runId: abortedId, status: 'aborted', stopReason: 'aborted', winnerId: null,
      metricCalls: 0, iterations: 0,
    });
    sql`INSERT INTO replay_evals (id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
        VALUES ('rpl-1', ${Date.now()}, 6, 4, 2, 0.75, 0.25, 0, '[]')`;
    recordTurnOutcome(sql, {
      outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'build it', assistantResponse: 'done',
    });
    recordTurnOutcome(sql, {
      outcome: 'corrected', confidence: 0.8, source: 'classifier',
      userMessage: 'fix it', assistantResponse: 'wrong', followup: 'no, the other one',
    });

    const entries = buildChangelog(sql);
    const gepa = entries.filter((e) => e.kind === 'gepa');
    expect(gepa).toHaveLength(1);
    expect(gepa[0].summary).toContain('found a better candidate');
    expect(gepa[0].evidence).toContain('3 iterations');
    expect(gepa[0].evidence).toContain('12 metric calls');
    expect(gepa[0].revert).toBeUndefined();

    const replay = entries.find((e) => e.kind === 'replay');
    expect(replay!.summary).toContain('loss 0.25');
    expect(replay!.evidence).toContain('6 labeled turns');
    expect(replay!.revert).toBeUndefined();

    const outcomes = entries.find((e) => e.kind === 'outcomes');
    expect(outcomes!.summary).toContain('Graded 2 turns');
    expect(outcomes!.evidence).toContain('1 accepted');
    expect(outcomes!.evidence).toContain('1 corrected');
    expect(outcomes!.revert).toBeUndefined();
  });

  test('empty ledgers produce an empty digest (missing tables tolerated)', () => {
    const { rt } = createTestRuntime();
    expect(buildChangelog(rt.storage.sql)).toEqual([]);
  });

  test('orders newest first and respects the limit', () => {
    const { rt, facts } = setup();
    const now = Date.now();
    facts.upsert('older', 'a');
    rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now - 10_000} WHERE key = 'older'`;
    facts.upsert('newer', 'b');
    rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now} WHERE key = 'newer'`;

    const entries = buildChangelog(rt.storage.sql);
    expect(entries[0].summary).toContain('newer');
    expect(entries[1].summary).toContain('older');
    expect(buildChangelog(rt.storage.sql, { limit: 1 })).toHaveLength(1);
  });
});

describe('unseen-count logic (the badge)', () => {
  test('counts only entries newer than the seen marker', () => {
    const { rt, facts } = setup();
    const now = Date.now();
    facts.upsert('seen_fact', 'x');
    rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now - 60_000} WHERE key = 'seen_fact'`;
    facts.upsert('fresh_fact', 'y');
    rt.storage.sql`UPDATE agent_facts SET last_observed_at = ${now} WHERE key = 'fresh_fact'`;

    expect(countUnseenChangelog(rt.storage.sql, 0)).toBe(2);
    expect(countUnseenChangelog(rt.storage.sql, now - 30_000)).toBe(1);
    expect(countUnseenChangelog(rt.storage.sql, now)).toBe(0);
  });

  test('the turn-outcome aggregate only counts outcomes inside the window', () => {
    const { rt } = setup();
    const sql = rt.storage.sql;
    const now = Date.now();
    recordTurnOutcome(sql, {
      outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'old', assistantResponse: 'old', now: now - 60_000,
    });
    recordTurnOutcome(sql, {
      outcome: 'corrected', confidence: 1, source: 'explicit',
      userMessage: 'new', assistantResponse: 'new', now,
    });

    const windowed = buildChangelog(sql, { since: now - 30_000 });
    const agg = windowed.find((e) => e.kind === 'outcomes');
    expect(agg!.summary).toContain('Graded 1 turn');
    expect(agg!.evidence).toBe('1 corrected');
  });
});

describe('renderChangelogText — the one text form', () => {
  test('numbers entries, shows evidence, marks revertables', () => {
    const { rt, facts } = setup();
    facts.upsert('k', 'v', { confidence: 0.7 });
    rt.storage.sql`INSERT INTO replay_evals (id, ran_at, sample_size, accepted_n, negative_n, mean_score, loss, scaffold_version, details)
        VALUES ('rpl-2', ${Date.now() - 1000}, 3, 2, 1, 0.9, 0.1, NULL, '[]')`;

    const entries = buildChangelog(rt.storage.sql);
    const text = renderChangelogText(entries, { unseenCount: 2 });
    expect(text).toContain('2 unseen');
    expect(text).toContain('  1. ');
    expect(text).toContain('  2. ');
    expect(text).toContain('Learned fact k = v');
    expect(text).toContain('revertable');
    // The replay measurement line is NOT marked revertable.
    const replayLine = text.split('\n').find((l) => l.includes('confidence') === false && l.includes('labeled turns'));
    expect(replayLine).toBeDefined();
    expect(replayLine).not.toContain('revertable');
  });

  test('renders the empty state', () => {
    expect(renderChangelogText([])).toContain('empty');
  });
});

describe('reverts — real paths only', () => {
  test('craft retire removes the tool and its score; double-revert errors', async () => {
    const { rt, facts } = setup();
    rt.craftStore.create({ name: 'tmp_tool', description: 'temp', code: 'async () => 1', scope: 'local' });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at)
                   VALUES ('tmp_tool', 0.5, 2, ${Date.now()})`;

    const result = await executeChangelogRevert({ rt, facts }, { type: 'craft_retire', target: 'tmp_tool' });
    expect(result.ok).toBe(true);
    expect(rt.craftStore.get('tmp_tool')).toBeFalsy();
    expect(rt.storage.sql`SELECT * FROM craft_scores WHERE tool_name = 'tmp_tool'`).toHaveLength(0);

    const again = await executeChangelogRevert({ rt, facts }, { type: 'craft_retire', target: 'tmp_tool' });
    expect(again.ok).toBe(false);
    expect(again.error).toContain('already retired');
  });

  test('fact forget removes the fact; double-revert errors', async () => {
    const { rt, facts } = setup();
    facts.upsert('volatile', 42);
    const result = await executeChangelogRevert({ rt, facts }, { type: 'fact_forget', target: 'volatile' });
    expect(result.ok).toBe(true);
    expect(facts.recall('volatile')).toBeNull();
    const again = await executeChangelogRevert({ rt, facts }, { type: 'fact_forget', target: 'volatile' });
    expect(again.ok).toBe(false);
  });

  test('pending scaffold revert discards the trial through the decision machinery', async () => {
    const { rt, facts } = setup();
    const version = await seedScaffoldPending(rt);

    const result = await executeChangelogRevert({ rt, facts }, {
      type: 'scaffold_rollback', target: String(version),
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(`discarded pending v${version}`);
    expect(getPendingScaffold(rt.storage.sql)).toBeNull();
    expect(await rt.identity.scaffold.read()).toBe(V0_CODE); // live file untouched
    const status = rt.storage.sql<{ status: string }>`
      SELECT status FROM scaffold_versions WHERE version = ${version}`[0];
    expect(status.status).toBe('rolled_back');
  });

  test('promoted scaffold revert round-trips back to the predecessor', async () => {
    const { rt, facts } = setup();
    const version = await seedScaffoldPending(rt);
    const pending = getPendingScaffold(rt.storage.sql)!;
    await applyPromotionDecision(rt, pending, 'promote');
    expect(await rt.identity.scaffold.read()).toBe(V1_CODE);

    // The digest now shows the promotion as a revertable entry…
    const entry = buildChangelog(rt.storage.sql).find((e) => e.kind === 'scaffold')!;
    expect(entry.summary).toContain(`Promoted scaffold v${version}`);
    expect(entry.revert).toBeDefined();

    // …and reverting it by id restores the predecessor end-to-end.
    const result = await revertChangelogEntryById({ rt, facts }, entry.id);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('rolled back to v0');
    expect(await rt.identity.scaffold.read()).toBe(V0_CODE);
    const rows = rt.storage.sql<{ version: number; status: string }>`
      SELECT version, status FROM scaffold_versions ORDER BY version`;
    expect(rows.find((r) => r.version === 0)!.status).toBe('current');
    expect(rows.find((r) => r.version === version)!.status).toBe('rolled_back');

    // A second revert of the same (now rolled-back) entry refuses.
    const again = await executeChangelogRevert({ rt, facts }, {
      type: 'scaffold_rollback', target: String(version),
    });
    expect(again.ok).toBe(false);
    expect(again.error).toContain('already rolled_back');
  });

  test('revertChangelogEntryById: unknown ids and informational entries refuse', async () => {
    const { rt, facts } = setup();
    recordTurnOutcome(rt.storage.sql, {
      outcome: 'accepted', confidence: 1, source: 'explicit',
      userMessage: 'q', assistantResponse: 'a',
    });
    const missing = await revertChangelogEntryById({ rt, facts }, 'nope:1');
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('not found');

    const info = buildChangelog(rt.storage.sql).find((e) => e.kind === 'outcomes')!;
    const refused = await revertChangelogEntryById({ rt, facts }, info.id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('informational');
  });
});

describe('session-end digest — assembled when the window closes', () => {
  test('onSessionComplete emits one changelog_digest covering the window', async () => {
    const { rt, facts } = setup();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS evolution_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
      type TEXT NOT NULL, message TEXT NOT NULL, data TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
    const engine = new EvolutionEngine(rt);
    const events: EvolutionEvent[] = [];
    engine.onEvent((e) => events.push(e));

    const startedAt = Date.now() - 5_000;
    facts.upsert('discovered_mid_session', 'yes');
    rt.craftStore.create({ name: 'session_tool', description: 'made this session', code: 'async () => 1', scope: 'local' });

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
    // …and it lands in the durable evolution_events log for the timeline.
    const rows = rt.storage.sql<{ type: string }>`
      SELECT type FROM evolution_events WHERE type = 'changelog_digest'`;
    expect(rows).toHaveLength(1);
  });

  test('a window that changed nothing emits no digest', async () => {
    const { rt } = setup();
    const engine = new EvolutionEngine(rt);
    const events: EvolutionEvent[] = [];
    engine.onEvent((e) => events.push(e));
    await engine.onSessionComplete({
      sessionId: 'sess-2', turns: [], startedAt: Date.now() - 1000, endedAt: Date.now(),
    });
    expect(events.filter((e) => e.type === 'changelog_digest')).toHaveLength(0);
  });
});
