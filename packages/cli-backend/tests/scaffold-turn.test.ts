// The mutable scaffold on a LOCAL workspace, end to end through
// LocalAgentSession — the two properties that were broken:
//
//   1. A promoted scaffold actually drives the turn. processTurn used to call
//      runChat directly, so a promoted local scaffold had no effect on any
//      turn at all — the flagship self-evolution feature was write-only
//      outside the cloud.
//   2. A proposal can be resolved, so the loop cannot deadlock. Nothing local
//      ran shadow evaluation, and EvolutionEngine.maybeEvolveScaffold refuses
//      to propose while a pending version exists — so a local agent proposed
//      exactly one scaffold ever and then blocked forever.
//
// Driven by the authentic createCLIRuntime (real workspace filesystem + in-process
// executor) with fake models, so the whole path — transform, codemode host
// bridge, shadow eval, promotion gate — runs for real without a network LLM.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import { TestLanguageModelV2 } from './test-language-model';
import type { AgentRuntime, LLM, LLMProviderConfig } from '@kinu.run/core';
import {
  initScaffoldTables, createAgentConfigStore, initAgentConfigTable,
  getPendingScaffold, getCurrentScaffoldVersion, listScaffoldArchive,
  INITIAL_SCAFFOLD_SOURCE,
} from '@kinu.run/core';
import { createCLIRuntime } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { scratchPath } from '@kinu.run/test-utils';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** A streaming LanguageModel stub — the DEFAULT loop's answer. */
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
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db, {
    dbPath: scratchPath('scaffold-turn', 'agent.db'), llm: DUMMY_LLM,
  });
  // What `kinu create` provisions (identity/create.ts): the scaffold
  // tables, agent_config, and the v0 scaffold file + archive row — so the
  // session's cold-start heal is a deterministic no-op here. The
  // shadow-rollout ledger is deliberately NOT created — LocalAgentSession
  // must provision it, the way the DO does, or no trial can ever be recorded.
  initScaffoldTables(rt.storage.execRaw);
  initAgentConfigTable(rt.storage.execRaw);
  if (opts.provisionScaffold !== false) {
    await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);
    void rt.storage.sql`INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale)
      VALUES (0, ${Date.now()}, ${'initial bootstrap'})`;
  }
  const events: SessionEvent[] = [];
  // Auto-evolution ON, exactly as a real session has it. The promotion gate IS
  // auto-evolution: a `--no-auto-evolve` session queues no trial and runs none,
  // so turning it off here to quieten the classifier would leave the deadlock
  // tests below proving nothing.
  const session = new LocalAgentSession({
    rt, db, model: fakeModel(defaultAnswer), onEvent: (e) => events.push(e),
  });
  return { db, rt, session, events };
}

/** Install a scaffold version: its code on disk plus the archive row. */
async function installScaffold(
  rt: AgentRuntime,
  opts: { version: number; status: 'current' | 'pending'; code: string },
): Promise<void> {
  await rt.storage.vfs.writeFile(`scaffold/agent.js.v${opts.version}`, opts.code);
  if (opts.status === 'current') await rt.identity.scaffold.write(opts.code);
  void rt.storage.sql`
    INSERT OR REPLACE INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (${opts.version}, ${Date.now()}, ${`v${opts.version}`}, ${opts.status})`;
}

const streamed = (events: SessionEvent[]) =>
  events
    .filter((event): event is Extract<SessionEvent, { type: 'text-delta' }> => event.type === 'text-delta')
    .map((event) => event.delta)
    .join('');

describe('a promoted scaffold drives a local turn', () => {
  // Fails before the fix: processTurn drove runChat directly, so this streamed
  // "the default loop answered" no matter what the scaffold said.
  test('the scaffold answers, not the default loop', async () => {
    const { db, rt, session, events } = await setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function* run(rt, task) {
        yield { type: 'chunk', data: 'the scaffold answered: ' + task };
      }`,
    });

    await session.send('who answers?');

    expect(streamed(events)).toBe('the scaffold answered: who answers?');
    expect(streamed(events)).not.toContain('default loop');
    // The reply the user saw is what the durable history keeps.
    const rows = db.query<{ role: string; content: string }, []>(
      `SELECT role, content FROM messages ORDER BY created_at`,
    ).all();
    expect(rows.map((r) => r.content)).toEqual(['who answers?', 'the scaffold answered: who answers?']);
  });

  test('a delegating scaffold still runs the default loop, faithfully', async () => {
    const { rt, session, events } = await setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function run({ task }) { await host.defaultInference(); }`,
    });

    await session.send('who answers?');

    expect(streamed(events)).toBe('the default loop answered');
  });

  test('an un-evolved agent (bootstrap v0) is untouched by the seam', async () => {
    const { rt, session, events } = await setup('the default loop answered');
    await installScaffold(rt, {
      version: 0, status: 'current',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'v0 must not run' }; }`,
    });

    await session.send('who answers?');

    expect(streamed(events)).toBe('the default loop answered');
  });

  test('a scaffold can reach the agent tool surface through host.callTool', async () => {
    const { rt, session, events } = await setup('unused');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function run({ task }) {
        const result = await host.callTool('memory', { action: 'search', query: 'anything' });
        await host.emit({ type: 'text_delta', text: 'tool returned ' + typeof result });
      }`,
    });

    await session.send('use a tool');

    // The args reached the tool: a dispatch that dropped them would have left
    // the action undefined, which answers with an error OBJECT, not a string.
    expect(events.some((e) => e.type === 'tool-call' && e.toolName === 'memory')).toBe(true);
    expect(streamed(events)).toBe('tool returned string');
  });
});

/**
 * The judge the shadow eval drives. Neutral by construction (see
 * judgeTrialOrderSwapped): each call presents the two outputs in a random
 * order, so this identifies the pending by its marker rather than by slot —
 * a fake that always answered "a" would flip and score every trial a tie.
 */
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
  // Fails before the fix: no local code path ran shadow evaluation, so the
  // pending stayed pending forever and maybeEvolveScaffold's
  // "skip while a pending exists" guard blocked every future proposal.
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

    const config = createAgentConfigStore(rt.storage.sql);
    config.setShadowSampleRate(1);      // evaluate every turn — no flaky sampling
    config.setAutoPromoteScaffold(true);

    expect(getPendingScaffold(rt.storage.sql)?.version).toBe(2);

    // DEFAULT_SHADOW_CONFIG needs 5 decisive trials before it will promote.
    // Each turn only QUEUES one — the rollout is cadence-lane work, so no turn
    // here pays for a candidate run. runDueEvolution is that lane's entry (the
    // scheduler daemon's tick), and end() never joins it: the queue is durable,
    // so a host that exits mid-drain loses time and nothing else.
    for (let i = 0; i < 6; i++) await session.send(`turn ${i}`);
    await session.runDueEvolution();
    await session.end();

    // Resolved: nothing is pending, so maybeEvolveScaffold's guard
    // (evolution/engine.ts — "skip while a pending is in flight") is clear and
    // the agent can propose again.
    expect(getPendingScaffold(rt.storage.sql)).toBeNull();
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(2);
    expect(listScaffoldArchive(rt.storage.sql, 10).find((e) => e.version === 2)?.status).toBe('current');
    expect(events.some((e) => e.type === 'evolution' && e.event === 'scaffold_promotion')).toBe(true);
  }, 30_000);

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
    // The judge prefers whatever the LIVE turn produced.
    rt.judgeModel = markerJudge('CURRENT-SCAFFOLD');

    const config = createAgentConfigStore(rt.storage.sql);
    config.setShadowSampleRate(1);
    config.setAutoPromoteScaffold(true);

    for (let i = 0; i < 6; i++) await session.send(`turn ${i}`);
    await session.runDueEvolution();
    await session.end();

    expect(getPendingScaffold(rt.storage.sql)).toBeNull();
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(1);
    expect(listScaffoldArchive(rt.storage.sql, 10).find((e) => e.version === 2)?.status).toBe('rolled_back');
  }, 30_000);

  test('opening a session heals a scaffold-less workspace (DO onStart parity)', async () => {
    // A workspace created before scaffold bootstrap landed has no
    // scaffold/agent.js — engine.maybeEvolveScaffold returns early when it is
    // absent, silently disabling the whole scaffold-evolution loop. The DO
    // heals in onStart; the local session must heal identically.
    const { rt, session } = await setup('unused', { provisionScaffold: false });
    expect(await rt.identity.scaffold.exists()).toBe(false);

    // end() joins the tracked bootstrap (orch.settleEvolution).
    await session.end();

    expect(await rt.identity.scaffold.exists()).toBe(true);
    expect((await rt.identity.scaffold.read()).length).toBeGreaterThan(0);
    // The v0 archive row exists, and the agent is still un-evolved: the live
    // version is 0, so the turn seam stays a pass-through.
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(0);
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
    // 'auto' refuses to guess on no evidence — the gate is still inconclusive.
    expect(await session.applyScaffoldDecision('auto')).toMatchObject({ ok: false });

    expect(await session.applyScaffoldDecision('promote')).toMatchObject({ ok: true, newCurrentVersion: 2 });
    expect(getPendingScaffold(rt.storage.sql)).toBeNull();
    expect(session.getShadowStatus().hasPending).toBe(false);
  });

  test('a queued trial claims its tool calls under the TRIAL, not the ambient turn', async () => {
    const { rt, session } = await setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'CURRENT-SCAFFOLD' }; }`,
    });
    // The candidate reaches the REAL tool surface, which is the whole risk: a
    // rollout that is re-driven after an interruption runs these calls again.
    await installScaffold(rt, {
      version: 2, status: 'pending',
      code: `async function run({ task }) {
        await host.callTool('memory', { action: 'search', query: 'anything' });
        await host.emit({ type: 'text_delta', text: 'PENDING-SCAFFOLD' });
      }`,
    });
    rt.judgeModel = markerJudge('PENDING-SCAFFOLD');
    createAgentConfigStore(rt.storage.sql).setShadowSampleRate(1);

    await session.send('queue one trial');
    const queued = rt.storage.sql<{ id: string }>`SELECT id FROM scaffold_trial_queue`;
    expect(queued).toHaveLength(1);
    const trialId = queued[0]?.id ?? '';

    await session.runDueEvolution();
    await session.end();

    // Keyed on the TRIAL, both halves of it: the call id is `<trial>#n` in
    // dispatch order and the claim's turn id is the trial itself. Under the
    // ambient id the same call was claimed against the last chat turn on a live
    // drain and against the workspace run id on a replay — two claims for one
    // call, so an interrupted trial ran the tool a second time.
    const claims = rt.storage.sql<{ turn_id: string; normalized_call_id: string }>`
      SELECT turn_id, normalized_call_id FROM tool_effect_claims
      WHERE turn_id = ${trialId}`;
    expect(claims).toHaveLength(1);
    expect(claims[0]?.normalized_call_id).toBe(`${trialId}#0`);
  }, 30_000);
});
