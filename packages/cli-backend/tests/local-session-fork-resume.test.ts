// Resuming a repaired workspace tells the agent its fork is gone.
//
// The owner's report: after resuming a repaired workspace the agent still
// believed a 4-head research fork was running, while the journal said
// `cancelled by operator`. The runtime was not silent — it was WRONG.
// `head_journal.status` had one writer that cleared 'running' (the happy-path
// report), so a fork interrupted by a process exit or an operator cancel left
// its head rows 'running' permanently, `HeadJournal.listLive()` kept returning
// the run, and the dynamic-context block asserted "4 of 4 heads running" into
// every model step for the life of the workspace.
//
// Core pins the read and the wake behaviourally
// (core/tests/integration-cancelled-fork-visibility.test.ts). This pins the
// CLI's actual startup path: `recoverBackgroundJobs`, over real stores, on the
// same database a previous process left behind.
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

/** The minimum streaming stub the session constructor needs. This test never
 *  reaches inference — `recoverBackgroundJobs` settles the journal and hands the
 *  wake to the signal seam — but a session is not constructible without one. */
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

/** A workspace a previous process left mid-fork: four head rows still marked
 *  `running`, and the fork's background job already `cancelled by operator` —
 *  exactly what `kinu stop` / the repair path writes, from another process,
 *  with nothing left to settle the heads. */
function interruptedWorkspace() {
  // A FILE, not `:memory:`: `createCLIRuntime` binds this actor by reading the
  // database's own filename back, and refuses a runtime whose declared `dbPath`
  // is not that one (actor-identity.ts `requireLocalDatabasePath`) — which an
  // in-memory handle can never satisfy.
  const db = new Database(scratchPath('local-session-fork-resume', 'agent.db'), { create: true });
  // THE PRODUCTION INITIALIZER, not a copy of its DDL. A fixture that
  // re-declared `messages` won the CREATE TABLE IF NOT EXISTS race and
  // silently pinned a schema nothing else maintains.
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

    // Before: the roster the per-step dynamic context reads is lying.
    expect(journal.listLive()).toEqual({
      items: [{ rootId: ROOT, rationale: RATIONALE, running: HEADS, total: HEADS }],
      total: 1,
    });

    await session.recoverBackgroundJobs();

    // After: nothing claims to be running, and every head carries why.
    expect(journal.listLive()).toEqual({ items: [], total: 0 });
    for (const head of journal.readTree(ROOT)) {
      expect(head.status).toBe('aborted');
      expect(head.error_message).toContain('no executor');
    }

    // And the agent learns it, rather than inferring it from a roster that went
    // quiet. Two records, both of them the runtime's own: the activity line the
    // reconciler logs, and the turn the signal seam queued — queued rather than
    // spliced because no turn is running, which is what "at its next step"
    // means for an idle agent.
    const abandoned = events.filter(
      (e): e is { type: 'evolution'; event: string; message: string } =>
        e.type === 'background' && e.event === 'fork_runs_abandoned',
    );
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.message).toContain(ROOT);
    expect(abandoned[0]!.message).toContain(`${HEADS}/${HEADS}`);

    await session.end();
  });

  test('a clean workspace resumes silently', async () => {
    const db = new Database(scratchPath('local-session-fork-clean', 'agent.db'), { create: true });
    // THE PRODUCTION INITIALIZER, not a copy of its DDL. A fixture that
  // re-declared `messages` won the CREATE TABLE IF NOT EXISTS race and
  // silently pinned a schema nothing else maintains.
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
