// Resuming a workspace a previous process left mid-fork settles stale `running` head rows and tells the agent.
// Core pins the read and wake (core/tests/integration-cancelled-fork-visibility.test.ts); this pins `recoverBackgroundJobs`.
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { TestLanguageModelV2 } from './test-language-model';
import { HeadJournal, defaultLoopOrigin, initHeadsTables, initBackgroundJobsTable } from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import type { LLMProviderConfig } from '@kinu.run/core';
import { createCLIRuntime , makeWorkspaceSchemaSql } from '../src/runtime';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { makeExecRaw, makeSql } from '../src/runtime';
import { scratchPath } from '@kinu.run/test-utils';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

/** Minimal streaming stub: inference is never reached, but a session is not constructible without a model. */
function fakeModel(): TestLanguageModelV2 {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: 'ok' });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  });
}

const HEADS = 4;

const ROOT = 'root-research';

const RATIONALE = 'four angles on the research question';

/** Four head rows still `running` while the fork's job is already `cancelled by operator`, as `kinu stop` leaves it. */
function interruptedWorkspace() {
  // A file, not `:memory:`: `createCLIRuntime` refuses a mismatched `dbPath` (actor-identity.ts `requireLocalDatabasePath`).
  const db = new Database(scratchPath('local-session-fork-resume', 'agent.db'), { create: true });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });
  const execRaw = makeExecRaw(db);
  initHeadsTables(execRaw);
  initBackgroundJobsTable(execRaw);
  const journal = new HeadJournal(makeSql(db), rt.actor);
  const now = Date.now();
  journal.recordSplit(ROOT, RATIONALE, now);

  for (let i = 1; i <= HEADS; i++) {
    journal.insertSpawn({
      id: `h${i}`, parentId: null, rootId: ROOT, depth: 1,
      task: `angle ${i}`, rationale: 'why', mode: 'build',
      inheritedContext: [], mergeStrategy: 'synthesize', loop: defaultLoopOrigin('head'),
      budget: { maxDepth: 2, maxWallClockMs: 60_000, spawnedAt: now },
    });
  }

  db.exec(
    `INSERT INTO background_jobs (actor_id, id, kind, work_mode, status, error, settled_at, created_at)
     VALUES ('${rt.actor.actorId}', 'bgjob-fork', 'agents', 'build', 'cancelled', 'cancelled by operator', ${now + 1000}, ${now})`,
  );

  return { db, rt, journal };
}

describe('resuming a workspace whose fork was interrupted', () => {
  test('the journal is settled and the agent is told, on the one signal seam', async () => {
    const { db, rt, journal } = interruptedWorkspace();
    const events: SessionEvent[] = [];

    const session = new LocalAgentSession({
      rt, db, model: fakeModel(), onEvent: (e) => events.push(e), noAutoEvolve: true,
    });

    expect(journal.listLive()).toEqual({
      items: [{ rootId: ROOT, rationale: RATIONALE, running: HEADS, total: HEADS }],
      total: 1,
    });

    await session.recoverBackgroundJobs();

    expect(journal.listLive()).toEqual({ items: [], total: 0 });

    for (const head of journal.readTree(ROOT)) {
      expect(head.status).toBe('aborted');
      expect(head.error_message).toContain('no executor');
    }

    // The turn is queued rather than spliced because no turn is running.
    const abandoned = events.filter(
      (e): e is { type: 'evolution'; event: string; message: string } =>
        e.type === 'background' && e.event === 'fork_runs_abandoned',
    );

    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].message).toContain(ROOT);
    expect(abandoned[0].message).toContain(`${HEADS}/${HEADS}`);

    await session.end();
  });

  test('a clean workspace resumes silently', async () => {
    const db = new Database(scratchPath('local-session-fork-clean', 'agent.db'), { create: true });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
    const rt = createCLIRuntime(db, { dbPath: db.filename, llm: DUMMY_LLM });
    const events: SessionEvent[] = [];

    const session = new LocalAgentSession({
      rt, db, model: fakeModel(), onEvent: (e) => events.push(e), noAutoEvolve: true,
    });

    await session.recoverBackgroundJobs();

    expect(events.filter((e) => e.type === 'background' && e.event === 'fork_runs_abandoned')).toEqual([]);
    await session.end();
  });
});
