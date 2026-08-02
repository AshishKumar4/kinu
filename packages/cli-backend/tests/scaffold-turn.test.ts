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
// Driven by the authentic createCLIRuntime (real SqliteFS + in-process
// executor) with fake models, so the whole path — transform, codemode host
// bridge, shadow eval, promotion gate — runs for real without a network LLM.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { AgentRuntime, LLM, LLMProviderConfig } from '@proteus/core';
import {
  initScaffoldTables, createAgentConfigStore, initAgentConfigTable,
  getPendingScaffold, getCurrentScaffoldVersion, listScaffoldArchive,
} from '@proteus/core';
import { createCLIRuntime } from '../src/runtime.js';
import { LocalAgentSession, type SessionEvent } from '../src/local-session.js';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** A streaming LanguageModel stub — the DEFAULT loop's answer. */
function fakeModel(answer: string): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
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
  } as unknown as LanguageModel;
}

function setup(defaultAnswer: string) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db as never, {
    dbPath: `/tmp/proteus-scaffold-test-${Math.floor(performance.now())}.db`, llm: DUMMY_LLM,
  });
  // What `proteus create` provisions. The shadow-rollout ledger is
  // deliberately NOT created here — LocalAgentSession must provision it, the
  // way the DO does, or no trial can ever be recorded.
  initScaffoldTables(rt.storage.execRaw);
  initAgentConfigTable(rt.storage.execRaw);
  const events: SessionEvent[] = [];
  const session = new LocalAgentSession({
    rt, db, model: fakeModel(defaultAnswer), onEvent: (e) => events.push(e), noAutoEvolve: true,
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
  rt.storage.sql`
    INSERT INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (${opts.version}, ${Date.now()}, ${`v${opts.version}`}, ${opts.status})`;
}

const streamed = (events: SessionEvent[]) =>
  events.filter((e) => e.type === 'text-delta').map((e) => (e as { delta: string }).delta).join('');

describe('a promoted scaffold drives a local turn', () => {
  // Fails before the fix: processTurn drove runChat directly, so this streamed
  // "the default loop answered" no matter what the scaffold said.
  test('the scaffold answers, not the default loop', async () => {
    const { db, rt, session, events } = setup('the default loop answered');
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
    const rows = db.query(`SELECT role, content FROM messages ORDER BY created_at`)
      .all() as Array<{ role: string; content: string }>;
    expect(rows.map((r) => r.content)).toEqual(['who answers?', 'the scaffold answered: who answers?']);
  });

  test('a delegating scaffold still runs the default loop, faithfully', async () => {
    const { rt, session, events } = setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function run({ task }) { await host.defaultInference(); }`,
    });

    await session.send('who answers?');

    expect(streamed(events)).toBe('the default loop answered');
  });

  test('an un-evolved agent (bootstrap v0) is untouched by the seam', async () => {
    const { rt, session, events } = setup('the default loop answered');
    await installScaffold(rt, {
      version: 0, status: 'current',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'v0 must not run' }; }`,
    });

    await session.send('who answers?');

    expect(streamed(events)).toBe('the default loop answered');
  });

  test('a scaffold can reach the agent tool surface through host.callTool', async () => {
    const { rt, session, events } = setup('unused');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function run({ task }) {
        const result = await host.callTool('memory', { action: 'read', path: 'memory/MEMORY.md' });
        await host.emit({ type: 'text_delta', text: 'tool returned ' + typeof result });
      }`,
    });

    await session.send('use a tool');

    // The args reached the tool: a dispatch that dropped them would have
    // errored on the missing action rather than returning a value.
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
    const { rt, session, events } = setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'CURRENT-SCAFFOLD' }; }`,
    });
    await installScaffold(rt, {
      version: 2, status: 'pending',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'PENDING-SCAFFOLD' }; }`,
    });
    (rt as { judgeModel?: LLM }).judgeModel = markerJudge('PENDING-SCAFFOLD');

    const config = createAgentConfigStore(rt.storage.sql);
    config.setShadowSampleRate(1);      // evaluate every turn — no flaky sampling
    config.setAutoPromoteScaffold(true);

    expect(getPendingScaffold(rt.storage.sql)?.version).toBe(2);

    // DEFAULT_SHADOW_CONFIG needs 5 decisive trials before it will promote.
    for (let i = 0; i < 6; i++) await session.send(`turn ${i}`);
    // The eval is detached so it never blocks a turn; end() joins it, which is
    // exactly what keeps `proteus exec` from killing it on the way out.
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
    const { rt, session } = setup('the default loop answered');
    await installScaffold(rt, {
      version: 1, status: 'current',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'CURRENT-SCAFFOLD' }; }`,
    });
    await installScaffold(rt, {
      version: 2, status: 'pending',
      code: `async function* run(rt, task) { yield { type: 'chunk', data: 'PENDING-SCAFFOLD' }; }`,
    });
    // The judge prefers whatever the LIVE turn produced.
    (rt as { judgeModel?: LLM }).judgeModel = markerJudge('CURRENT-SCAFFOLD');

    const config = createAgentConfigStore(rt.storage.sql);
    config.setShadowSampleRate(1);
    config.setAutoPromoteScaffold(true);

    for (let i = 0; i < 6; i++) await session.send(`turn ${i}`);
    await session.end();

    expect(getPendingScaffold(rt.storage.sql)).toBeNull();
    expect(getCurrentScaffoldVersion(rt.storage.sql)).toBe(1);
    expect(listScaffoldArchive(rt.storage.sql, 10).find((e) => e.version === 2)?.status).toBe('rolled_back');
  }, 30_000);

  test('applyScaffoldDecision resolves a pending by hand', async () => {
    const { rt, session } = setup('unused');
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
});
