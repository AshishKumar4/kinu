import { scratchDir } from '../../test-utils/src/scratch';
import { REAL_CLOCK } from '@kinu.run/core';
import { HIRE_FORK_PARENT, HIRE_FORK_REQUEST, HIRE_FORK_PREFIX, HIRE_FORK_MISSION,
  hireForkModel, hireConversation, hireRetentionModel, HIRE_FORK_FOLLOWUP_REQUEST,
  HIRE_FORK_FOLLOWUP, HIRE_CHILD_CONTEXT } from '../../test-utils/src/hire-fork';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2CallOptions, LanguageModelV2StreamPart, LanguageModelV2Usage } from '@ai-sdk/provider';
import * as v from 'valibot';
import {
  BackgroundJobStore,
  backgroundJobWakeTrigger,
  openWorkspaceMainActor, SubordinateRosterStore,
  createTimerTrigger,
  initWorkspaceSchema,
  initCompletedTurnTable, createCompletedTurnStore,
  DELEGATION_MAX_DEPTH,
  REPORT_TOOL,
  TriggerRegistry,
  delegationExhausted,
  SUBORDINATE_REPORT_STATUSES,
  HeadCapture, runHeadInference, codenameFor,
  bindActorHandle,
  type ActorHandle,
  type HostedAgentRef,
  type LLMProviderConfig,
  type SqlExecutor,
} from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/workspace-birth';
import type { Subprocess } from 'bun';
import {
  LocalAgentHost,
  DriverLeaseHold,
  type DriverKind,
  type DriverLeaseHolder,
  type LocalAgentHostOptions,
  type LocalHostedAgent,
} from '../src/agent-host';
import { makeExecRaw, makeSql, makeSqlExec, makeWorkspaceSchemaSql, type CLIRuntime } from '../src/runtime';
import { createMemoryVfs, present, readTranscriptRows } from '@kinu.run/test-utils';
import { openWorkspaceCLI } from '../src/open';
import { LocalAgentSession, type SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';
import { leaseHolder } from './driver-lease-probe';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake',
  baseURL: 'http://localhost:0',
  headers: {},
  model: 'fake-model',
};

function textStream(answer: string, usage: LanguageModelV2Usage): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: '0' });
      controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
      controller.enqueue({ type: 'text-end', id: '0' });
      controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
      controller.close();
    },
  });
}

function textAnswer(answer: string, usage: LanguageModelV2Usage) {
  return { content: [{ type: 'text' as const, text: answer }], finishReason: 'stop' as const, usage, warnings: [] };
}

function streamingModel(answer: string, onCall?: (options: LanguageModelV2CallOptions) => void): TestLanguageModelV2 {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => textAnswer(answer, usage),
    doStream: async (options) => {
      onCall?.(options);

      return {
        stream: textStream(answer, usage),
        response: { headers: {} },
      };
    },
  });
}

interface GatedModel {
  model: LanguageModel;
  started: Promise<void>;
  release(): void;
  calls(): number;
}

const TeamStatusSchema = v.object({
  roster: v.object({
    status: v.string(),
    currentTask: v.nullable(v.string()),
  }),
});

function gatedFirstModel(): GatedModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let callCount = 0;
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });

  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => {
      callCount += 1;
      const call = callCount;

      if (call === 1) {
        markStarted();
        await gate;
      }

      const answer = call === 1 ? 'child report' : 'parent acknowledged';

      return {
        stream: textStream(answer, usage),
        response: { headers: {} },
      };
    },
  });

  return { model, started, release, calls: () => callCount };
}

/** A subordinate that files a terminal `completed` report; the status must be the child's own word. */
function reportingChildModel(content: string, status: 'completed' | 'failed' = 'completed') {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let calls = 0;
  let reflections = 0;

  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    // The detached review pass calls this; the turn reflection is counted apart as turn-level learning's one call.
    doGenerate: async (options) => {
      if (JSON.stringify(options.prompt).includes('should be done differently')) reflections += 1;

      return {
        content: [{ type: 'text', text: 'acknowledged' }],
        finishReason: 'stop' as const,
        usage,
        warnings: [],
      };
    },
    doStream: async () => {
      calls += 1;
      const reporting = calls === 1;

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (reporting) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'report-1',
                toolName: REPORT_TOOL,
                input: JSON.stringify({ status, content }),
              });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'acknowledged' });
              controller.enqueue({ type: 'text-end', id: '0' });
            }

            controller.enqueue({
              type: 'finish', finishReason: reporting ? 'tool-calls' : 'stop', usage,
            });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });

  return { model, calls: () => calls, reflections: () => reflections };
}

/** A child that finishes with no text: the durable relay withholds it, so a task child must report a non-answer. */
function silentChildModel() {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => ({
      content: [], finishReason: 'stop' as const, usage, warnings: [],
    }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  });
}

function failingChildModel() {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => { throw new Error('provider is down'); },
    doStream: async () => { throw new Error('provider is down'); },
  });
}

/** A child that files a `progress` note, then ends per `then`: the note must not suppress its terminal report. */
function progressThenChildModel(then: 'answer' | 'throw') {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let calls = 0;

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'acknowledged' }],
      finishReason: 'stop' as const, usage, warnings: [],
    }),
    doStream: async () => {
      calls += 1;

      if (calls === 1) {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'report-progress',
                toolName: REPORT_TOOL,
                input: JSON.stringify({ status: 'progress', content: 'reading the export' }),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
              controller.close();
            },
          }),
          response: { headers: {} },
        };
      }

      if (then === 'throw') throw new Error('provider is down');

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'totals reconcile' });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

/** A child that says what each step found and files a progress note, twice, then fails before it answers. */
function narratedThenFailingChildModel(narration: readonly string[]) {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let calls = 0;

  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async () => {
      const said = narration[calls];

      calls += 1;

      if (said === undefined) throw new Error('provider is down');

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'txt-0' });
            controller.enqueue({ type: 'text-delta', id: 'txt-0', delta: said });
            controller.enqueue({ type: 'text-end', id: 'txt-0' });
            controller.enqueue({
              type: 'tool-call', toolCallId: `note-${String(calls)}`, toolName: REPORT_TOOL,
              input: JSON.stringify({ status: 'progress', content: `step ${String(calls)}` }),
            });
            controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

async function seedAgent(state: string, name: string): Promise<string> {
  const dbPath = join(state, name, 'agent.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  try {
    await createWorkspace(db, {
      name,
      purpose: `Test agent ${name}`,
      llm: DUMMY_LLM,
    });
    initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  } finally {
    db.close();
  }

  return dbPath;
}

/** State under `state/`, project under `project/`: state is never inside the agent's working directory. */
function makeRoots() {
  const state = scratchDir('host-state');
  const project = scratchDir('host-project');

  return { state, project };
}

interface TestHost {
  host: LocalAgentHost;
  runtimes: Map<string, CLIRuntime>;
}

interface TestHostExtras {
  wakeAt?: (at: number) => void;
  driverKind?: DriverKind;
  advisor?: boolean;
}

function makeHost(
  state: string,
  model: LanguageModel,
  refs: readonly HostedAgentRef[],
  extras: TestHostExtras = {},
): TestHost {
  const runtimes = new Map<string, CLIRuntime>();

  const options: LocalAgentHostOptions = {
    roster: () => refs,
    dbPath: (name) => join(state, name, 'agent.db'),
    open: async (ref, db, dbPath) => {
      const openConfig = { llm: DUMMY_LLM, cwd: ref.cwd };
      const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);

      if (extras.advisor === true) rt.actor.config.setAdvisorEnabled(true);
      runtimes.set(ref.name, rt);
      const hosted: LocalHostedAgent = { rt, openConfig, staticModel: model };

      return hosted;
    },
  };

  if (extras.wakeAt) options.wakeAt = extras.wakeAt;

  if (extras.driverKind) options.driverKind = extras.driverKind;

  return { host: new LocalAgentHost(options), runtimes };
}

/**
 * Event rows in the agent log. `pending` matches `EventLog.pending()`, not `consumed_at IS NULL`:
 * that column is the recovery lease, which an answered delivery closes while keeping its binding.
 */
function eventCount(dbPath: string, kind: 'peer' | 'pending'): number {
  const db = new Database(dbPath, { readonly: true });

  try {
    const rows = kind === 'peer'
      ? db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM agent_log WHERE kind = 'event' AND variant = 'peer_agent'`)
      : db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM agent_log WHERE kind = 'event' AND turn_id IS NULL`);

    return rows.get()?.n ?? 0;
  } finally {
    db.close();
  }
}

/** Resolves after `count` turns on `agent`: peer mail does not wait for the receiver, so the host must not close mid-turn. */
function awaitTurns(host: LocalAgentHost, agent: string, count: number): Promise<void> {
  const settled = Promise.withResolvers<void>();
  let seen = 0;

  const unsubscribe = host.subscribe((who, event) => {
    if (who !== agent || event.type !== 'turn-end') return;
    seen += 1;

    if (seen < count) return;
    unsubscribe();
    settled.resolve();
  });

  return settled.promise;
}

function pendingOutboxRows(dbPath: string): Array<{ id: string; state: string; attempt_count: number }> {
  const db = new Database(dbPath, { readonly: true });

  try {
    return db.query<{ id: string; state: string; attempt_count: number }, []>(
      'SELECT id, state, attempt_count FROM outbox_peer ORDER BY id',
    ).all();
  } finally {
    db.close();
  }
}

/**
 * Answers a peer ask via the real `agents` tool, citing the event id from the drain's hint in its own prompt.
 * Each id is answered once; the hint stays in history forever.
 */
function replyingModel(answer: string) {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const answered = new Set<string>();

  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    // Without this, every peer turn reports `orchestrator.detached_work_failed`.
    doGenerate: async () => textAnswer(answer, usage),
    doStream: async (options) => {
      const eventId = askedEventId(options.prompt);
      const replyTo = eventId !== null && !answered.has(eventId) ? eventId : null;

      if (replyTo) answered.add(replyTo);

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (replyTo) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: `reply-${answered.size}`,
                toolName: 'agents',
                input: JSON.stringify({ action: 'msg', event_id: replyTo, message: answer }),
              });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
              controller.enqueue({ type: 'text-end', id: '0' });
            }

            controller.enqueue({
              type: 'finish',
              finishReason: replyTo ? 'tool-calls' : 'stop',
              usage,
            });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });

  return { model, replies: () => answered.size };
}

function askedEventId(prompt: LanguageModelV2CallOptions['prompt']): string | null {
  const matches = [...renderPromptText(prompt)
    .matchAll(/the sender awaits your answer[\s\S]*?event_id:'([^']+)'/gu)];

  return matches[matches.length - 1]?.[1] ?? null;
}

describe('LocalAgentHost', () => {
  test('the daemon-owned conversation continues after its client disconnects', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    let calls = 0;

    const { host } = makeHost(state, streamingModel('ack', () => { calls += 1; }), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const delivered: string[] = [];
    const unsubscribe = host.subscribe((agent, event) => delivered.push(`${agent}:${event.type}`));

    const [session, concurrent] = await Promise.all([
      host.acquire('root'),
      host.acquire('root'),
    ]);

    expect(concurrent).toBe(session);
    await session.send('remember this', { id: crypto.randomUUID() });
    const deliveredBeforeDisconnect = delivered.length;
    unsubscribe();

    const fireAt = Date.now() + 60_000;
    await scheduleTimer(dbPath, 'continue while the client is gone', fireAt);
    await host.tick('root', fireAt);

    expect(delivered).toHaveLength(deliveredBeforeDisconnect);
    const db = new Database(dbPath);
    const sql = makeSql(db);
    const main = openWorkspaceMainActor(sql);

    const sessions = sql<{ session_id: string }>`
      SELECT DISTINCT session_id FROM conversation_entries WHERE actor_id = ${main.actorId} ORDER BY session_id`;

    const rows = sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM conversation_entries
      WHERE actor_id = ${main.actorId} AND role IN ('user','assistant')`[0];

    const config = main.config;
    expect(sessions).toEqual([{ session_id: 'default' }]);
    expect(rows?.n).toBe(4);
    expect(config.get('conversation.id')).toBe('default');
    db.close();
    await host.close();
  });

  test('a settled background job wake survives restart and redrive does not duplicate its turn', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const refs: HostedAgentRef[] = [{ name: 'root', cwd: project, workspaceId: 'proj' }];
    const jobId = 'bgjob-restart';
    const db = new Database(dbPath);
    const sql = makeSql(db);
    const main = openWorkspaceMainActor(sql);
    const store = new BackgroundJobStore(sql, main);
    const now = Date.now();
    store.create({ id: jobId, kind: 'agents', workMode: 'build', now, label: 'restart proof' });
    store.settle(jobId, 0, JSON.stringify({ done: true }), now + 1);
    // Seeded under the handle whose lane the recovery sweep reads; another actor id would pass vacuously.
    db.query(
      'INSERT INTO fibers (actor_id, id, name, snapshot, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      main.actorId,
      'orphan-fiber',
      `bg:${jobId}`,
      JSON.stringify({ phase: 'running', jobId, kind: 'agents' }),
      now,
    );
    db.close();

    let calls = 0;
    const model = streamingModel('wake acknowledged', () => { calls += 1; });
    const { host: recovered } = makeHost(state, model, refs);
    await recovered.tick('root');
    await recovered.close();

    const { host: redriven } = makeHost(state, model, refs);
    await redriven.tick('root');
    expect(calls).toBe(1);
    await redriven.close();

    const check = new Database(dbPath);
    const checkSql = makeSql(check);
    const checkActorId = openWorkspaceMainActor(checkSql).actorId;
    const wakeId = `programmatic:${backgroundJobWakeTrigger(jobId)}`;

    const wakeRows = checkSql<{ n: number }>`
      SELECT COUNT(*) AS n FROM conversation_entries WHERE actor_id = ${checkActorId} AND id = ${wakeId}`[0];

    const assistantRows = checkSql<{ n: number }>`
      SELECT COUNT(*) AS n FROM conversation_entries
      WHERE actor_id = ${checkActorId} AND parent_id = ${wakeId} AND role = 'assistant'`[0];

    const orphanRows = check.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM fibers WHERE id = 'orphan-fiber'",
    ).get();

    expect(wakeRows?.n).toBe(1);
    expect(assistantRows?.n).toBe(1);
    expect(orphanRows?.n).toBe(0);
    check.close();
  });

  for (const context of ['inherit', 'fresh', undefined] as const) {
    test(`a cli hire context=${String(context)} starts from its birth-time conversation`, async () => {
      const { state, project } = makeRoots();
      await seedAgent(state, 'root');
      const { model, childRequests } = hireForkModel(context);
      const { host } = makeHost(state, model, [{ name: 'root', cwd: project, workspaceId: 'proj' }]);

      try {
        const session = await host.acquire('root');
        await session.send(HIRE_FORK_PARENT, { id: crypto.randomUUID() });
        const answered = awaitTurns(host, 'root/forked-reader', 1);
        await session.send(HIRE_FORK_REQUEST, { id: crypto.randomUUID() });
        await answered;
        expect(childRequests).toHaveLength(1);
        const first = childRequests[0];

        if (!first) throw new Error('The hired child never reached its model.');
        const conversation = hireConversation(first);

        // The child's driving message is the mission verbatim, never the reactor's `task: …` drain line.
        if (context === 'inherit') {
          expect(conversation.slice(0, 3)).toEqual(HIRE_FORK_PREFIX);
          expect(conversation.findIndex((message) => message.content === HIRE_FORK_MISSION)).toBeGreaterThan(2);
        } else {
          expect(conversation[0]?.content).toBe(HIRE_FORK_MISSION);
          expect(conversation).not.toContainEqual(HIRE_FORK_PREFIX[1]);
        }

        expect(conversation.map((message) => message.content).join('\n'))
          .not.toContain('event arrived while you were');
      } finally {
        await host.close();
      }
    });
  }

  test('a cli durable hire retains its working conversation after a cold restore', async () => {
    const { state, project } = makeRoots();
    await seedAgent(state, 'root');
    const { model, childRequests } = hireRetentionModel();
    const refs = [{ name: 'root', cwd: project, workspaceId: 'proj' }];
    const { host } = makeHost(state, model, refs);

    try {
      const session = await host.acquire('root');
      await session.send(HIRE_FORK_PARENT, { id: crypto.randomUUID() });
      const answered = awaitTurns(host, 'root/forked-reader', 1);
      await session.send(HIRE_FORK_REQUEST, { id: crypto.randomUUID() });
      await answered;
      expect(childRequests).toHaveLength(2);
    } finally {
      await host.close();
    }

    const first = childRequests[1];

    if (!first) throw new Error('The first child turn did not consume its tool response.');
    const tool = first.prompt.find((message) => message.role === 'tool');

    if (!tool) throw new Error('The first child turn has no tool response.');
    expect(tool).toMatchObject({ content: [{ toolName: 'memory', output: {
      type: 'json', value: { ok: true, key: 'child-only-tool-context' },
    } }] });
    const { host: restored } = makeHost(state, model, refs);

    try {
      const session = await restored.acquire('root');
      const answered = awaitTurns(restored, 'root/forked-reader', 1);
      await session.send(HIRE_FORK_FOLLOWUP_REQUEST, { id: crypto.randomUUID() });
      await answered;
      expect(childRequests).toHaveLength(3);
      const followup = childRequests[2];

      if (!followup) throw new Error('The second assignment never reached the child provider.');
      const conversation = hireConversation(followup);
      expect(conversation.slice(0, 3)).toEqual(HIRE_FORK_PREFIX);
      expect(conversation.filter((message) => message.content === HIRE_FORK_MISSION)).toHaveLength(1);
      expect(conversation).toContainEqual({ role: 'assistant', content: HIRE_CHILD_CONTEXT });
      expect(followup.prompt).toContainEqual(tool);
      const next = conversation.findIndex((message) => message.content.includes(HIRE_FORK_FOLLOWUP));
      expect(next).toBeGreaterThan(conversation.findIndex((message) => message.content === HIRE_CHILD_CONTEXT));
      expect(conversation.filter((message) => message.content.includes(HIRE_FORK_FOLLOWUP))).toHaveLength(1);
    } finally {
      await restored.close();
    }
  });

  test('subordinates are durable children with non-blocking assignment, status, reports, and dismissal', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const gated = gatedFirstModel();

    const { host } = makeHost(state, gated.model, [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const events: SessionEvent[] = [];
    const reportDelivered = Promise.withResolvers<void>();
    const parentTurnEnded = Promise.withResolvers<void>();
    host.subscribe((agent, event) => {
      events.push(event);

      if (
        event.type === 'broadcast'
        && event.event.type === 'subordinate_event'
        && event.event.status === 'progress'
      ) reportDelivered.resolve();

      if (agent === 'root' && event.type === 'turn-end') parentTurnEnded.resolve();
    });
    const team = await host.team('root');

    const created = await team.create({
      name: 'researcher',
      role: 'researcher',
      mission: 'Investigate the incident.',
    });

    const childTeam = await host.team('root/researcher');
    expect(childTeam.delegation.depth).toBe(1);
    const reference = created.subordinate.actorReference;

    if (!reference) throw new Error('The created subordinate has no actor reference.');
    expect(created.subordinate.status).toBe('idle');
    // Asserted while the child is live: absence after dismissal could not fail.
    expect(existsSync(join(dirname(dbPath), 'subordinates', reference.actorId, 'agent.db'))).toBe(false);
    expect(existsSync(join(dirname(dbPath), 'subordinates'))).toBe(false);

    const assigned = await team.assign({
      name: 'researcher',
      task: 'Find the root cause and report it.',
      mode: 'build',
    });

    expect(assigned.delivery).toBe('starts_now');
    await gated.started;
    gated.release();
    await reportDelivered.promise;
    await parentTurnEnded.promise;

    const view = new Database(dbPath, { readonly: true });

    const reportCount = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;

    view.close();
    expect(reportCount).toBe(1);
    expect(gated.calls()).toBeGreaterThanOrEqual(2);
    expect(events.some((event) =>
      event.type === 'broadcast' && event.event.type === 'subordinate_event')).toBe(true);

    const status = v.parse(TeamStatusSchema, await team.status({ name: 'researcher' }));
    expect(status.roster.status).toBe('working');
    expect(status.roster.currentTask).toBe('Find the root cause and report it.');

    await team.dismiss({ name: 'researcher', requestedBy: 'user' });
    expect(await team.list()).toEqual([]);
    // A retained dismissal releases the directory row and keeps the actor's own rows.
    expect(actorLifecycle(dbPath, reference.actorId)).toBe('retained');
    expect(await userMessages(dbPath, reference.actorId))
      .toContain('Find the root cause and report it.');
    await expect(team.assign({ name: 'researcher', task: 'again', mode: 'build' }))
      .rejects.toThrow('subordinate "researcher" is dismissed');

    const temporary = await team.create({
      name: 'temporary',
      role: 'auditor',
      mission: 'Inspect one isolated case.',
    });

    const temporaryReference = temporary.subordinate.actorReference;

    if (!temporaryReference) throw new Error('The created temporary-named subordinate has no actor reference.');
    // `keepHistory: false` purges the actor's rows; the directory row stays released either way.
    expect(actorLifecycle(dbPath, temporaryReference.actorId)).toBe('live');
    const temporaryRows = actorRowCount(dbPath, temporaryReference.actorId);
    expect(temporaryRows).toBeGreaterThan(0);
    await team.dismiss({ name: 'temporary', requestedBy: 'user', keepHistory: false });
    expect(actorRowCount(dbPath, temporaryReference.actorId)).toBe(0);
    expect(actorRowCount(dbPath, reference.actorId)).toBeGreaterThan(0);
    await host.close();
  });

  /** B10, local host: one assignment row, one runner, one turn, driven by the brief rather than a reactor digest. */
  test('a hired child runs its brief once, as its own instruction, under the row\'s mode', async () => {
    const brief = 'Reconcile the ledger and report the variance.';
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const childPrompts: LanguageModelV2CallOptions[] = [];
    let calls = 0;

    const model = new TestLanguageModelV2({
      provider: 'fake',
      modelId: 'fake-model',
      doStream: async (options) => {
        calls += 1;

        if (calls === 1) childPrompts.push(options);

        const answer = calls === 1 ? 'variance reconciled' : 'noted';
        const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

        return {
          stream: textStream(answer, usage),
          response: { headers: {} },
        };
      },
    });

    const { host } = makeHost(state, model, [{ name: 'root', cwd: project, workspaceId: 'proj' }]);
    const childTurns: Array<{ kind: string; workMode: string; text: string }> = [];
    const reported = Promise.withResolvers<void>();

    host.subscribe((agent, event) => {
      if (agent === 'root/auditor' && event.type === 'turn-start') {
        childTurns.push({ kind: event.kind, workMode: event.workMode, text: event.text });
      }

      if (
        event.type === 'broadcast' && event.event.type === 'subordinate_event'
        && event.event.status === 'progress'
      ) reported.resolve();
    });

    try {
      const team = await host.team('root');
      const created = await team.create({ name: 'auditor', role: 'researcher', mission: 'Watch the ledger.' });
      const reference = created.subordinate.actorReference;

      if (!reference) throw new Error('The created subordinate has no actor reference.');
      const answered = awaitTurns(host, 'root/auditor', 1);
      await team.assign({ name: 'auditor', task: brief, mode: 'build' });
      await answered;
      await reported.promise;

      // `programmatic` opens the child's `report` surface and is what the relay policy reads.
      expect(childTurns).toEqual([{ kind: 'programmatic', workMode: 'build', text: brief }]);

      // Exactly one user text mentions the brief and equals it; a wrapper would contain it too.

      const prompt = childPrompts[0]?.prompt ?? [];

      const heard = prompt.flatMap((message) => message.role === 'user'
        ? message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])
        : []);

      expect(heard.filter((text) => text.includes(brief))).toEqual([brief]);
      expect(JSON.stringify(prompt)).not.toContain('event arrived while you were');

      // A re-admission loop shows up as a second row quoting the first.
      const view = new Database(dbPath, { readonly: true });

      const assignments = view.query<{ body: string }, [string]>(
        `SELECT json_extract(payload, '$.body') AS body FROM agent_log
         WHERE kind = 'event' AND variant = 'subordinate_task' AND actor_id = ?`,
      ).all(reference.actorId);

      const reports = view.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
      ).get()?.n ?? 0;

      view.close();
      expect(assignments.map((row) => row.body)).toEqual([brief]);
      expect(reports).toBe(1);
    } finally {
      await host.close();
    }
  });

  /** Temporary rung end to end: a role-targeted `ask` births a real local actor, admits its task, and archives it in the same roster. */
  test('a role-targeted ask runs a real local child, answers from the call, and archives it in the one roster', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const ANSWER = 'the callback URL was never registered';
    const child = reportingChildModel(ANSWER);

    const { host } = makeHost(state, child.model, [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const team = await host.team('root');
    const port = present(team.temporary, 'the temporary hire port');

    const outcome = await port.run({
      role: 'researcher',
      roleLabel: 'researcher',
      task: 'Find the root cause and report it.',
      mode: 'build',
    });

    expect(outcome).toMatchObject({
      status: 'completed',
      lifetime: 'task',
      role: 'researcher',
      answer: ANSWER,
      transcript: 'kept',
    });
    const agent = v.parse(v.object({ agent: v.string() }), outcome).agent;
    expect(agent).toStartWith('ask-researcher-');

    // Lifecycle says the name was released; `actorRowCount` (which excludes `workspace_actors`) says the transcript survived.
    const askActorId = childActorId(dbPath, agent);
    expect(actorLifecycle(dbPath, askActorId)).toBe('retained');
    expect(actorRowCount(dbPath, askActorId)).toBeGreaterThan(0);

    expect(await team.list()).toEqual([]);
    const archived = new Database(dbPath, { readonly: true });

    const rows = archived.query<{
      name: string; status: string; lifetime: string; task_event_id: string | null;
    }, []>('SELECT name, status, lifetime, task_event_id FROM actor_subordinates').all();

    archived.close();
    expect(rows).toEqual([
      { name: agent, status: 'dismissed', lifetime: 'task', task_event_id: null },
    ]);

    await host.close();
    // The waiting call consumed the answer, so no `subordinate_report` bills a parent turn.
    const view = new Database(dbPath, { readonly: true });

    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;

    view.close();
    expect(reports).toBe(0);
  });

  test('a hire in the same roster keeps lifetime durable and still reports onto the rail', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const child = reportingChildModel('root cause found');

    const { host } = makeHost(state, child.model, [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const reported = Promise.withResolvers<void>();
    const parentTurnEnded = Promise.withResolvers<void>();
    host.subscribe((agent, event) => {
      if (event.type === 'broadcast' && event.event.type === 'subordinate_event'
        && event.event.status === 'completed') reported.resolve();

      if (agent === 'root' && event.type === 'turn-end') parentTurnEnded.resolve();
    });
    const team = await host.team('root');
    await team.spawn({
      role: 'researcher',
      mission: 'Investigate the incident.',
      mode: 'build',
    });
    const roster = await team.list();
    expect(roster).toHaveLength(1);
    expect(roster[0]?.lifetime).toBe('durable');
    expect(roster[0]?.taskEventId).toBeTruthy();

    await reported.promise;
    await parentTurnEnded.promise;
    await host.close();
    const view = new Database(dbPath, { readonly: true });

    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;

    view.close();
    expect(reports).toBe(1);
  });

  /** No deadline exists in this rung, so `shell` returns only when the child reports: exactly one result for every ending. */
  for (const [label, model] of [
    ['finishes with nothing to say', silentChildModel()],
    ['fails outright', failingChildModel()],
  ] as const) {
    test(`a temporary child that ${label} still answers its caller exactly once`, async () => {
      const { state, project } = makeRoots();
      const dbPath = await seedAgent(state, 'root');

      const { host } = makeHost(state, model, [
        { name: 'root', cwd: project, workspaceId: 'proj' },
      ]);

      const team = await host.team('root');
      const temporary = present(team.temporary, 'the temporary hire port');

      const outcome = await temporary.run({
        role: 'researcher',
        roleLabel: 'researcher',
        task: 'Find the root cause.',
        mode: 'build',
      });

      expect(outcome).toMatchObject({ status: 'failed', lifetime: 'task', transcript: 'kept' });
      const answer = v.parse(v.object({ answer: v.string(), agent: v.string() }), outcome);
      expect(answer.answer.length).toBeGreaterThan(0);

      expect(await team.list()).toEqual([]);
      await host.close();
      const view = new Database(dbPath, { readonly: true });

      const rows = view.query<{ name: string; status: string; lifetime: string }, []>(
        'SELECT name, status, lifetime FROM actor_subordinates',
      ).all();

      const reports = view.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
      ).get()?.n ?? 0;

      view.close();
      expect(rows).toEqual([{ name: answer.agent, status: 'dismissed', lifetime: 'task' }]);
      expect(reports).toBe(0);
    });
  }

  test('a temporary child that fails after two steps answers its caller with both steps\' words', async () => {
    const narration = ['Step 1: the ledger totals match.', 'Step 2: two refunds lack a receipt.'];
    const { state, project } = makeRoots();
    await seedAgent(state, 'root');

    const { host } = makeHost(state, narratedThenFailingChildModel(narration), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const team = await host.team('root');
    const temporary = present(team.temporary, 'the temporary hire port');
    const outcome = await temporary.run({ role: 'researcher', roleLabel: 'researcher', task: 'Audit the ledger.', mode: 'build' });

    expect(outcome).toMatchObject({ status: 'failed', lifetime: 'task' });
    expect(v.parse(v.object({ answer: v.string() }), outcome).answer).toStartWith(`${narration.join('\n\n')}\n\n`);
    await host.close();
  });

  test('a subordinate turn gets advisor feedback while its evolution window stays empty', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const note = 'The probe failed but the reply claimed success. Check its exit status.';
    const requests: string[] = [];

    const model = new TestLanguageModelV2({
      provider: 'fake', modelId: 'fake-model',
      doGenerate: async (options) => ({
        content: [{ type: 'text', text: JSON.stringify(options.prompt).includes('You are reviewing one finished turn')
          ? JSON.stringify({ note, severity: 'concern', class: 'wrong-work' }) : '{}' }],
        finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }, warnings: [],
      }),
      doStream: streamingModel('The probe succeeded.', (options) => { requests.push(JSON.stringify(options.prompt)); }).doStream,
    });

    const { host } = makeHost(state, model, [{ name: 'root', cwd: project, workspaceId: 'proj' }], { advisor: true });
    const ended = Promise.withResolvers<void>();
    let turns = 0;
    host.subscribe((agent, event) => {
      if (agent === 'root' || event.type !== 'turn-end') return;
      turns++;

      if (turns === 2) ended.resolve();
    });
    const team = await host.team('root');
    await team.spawn({ role: 'researcher', mission: 'Check the probe.', mode: 'build' });
    const [child] = await team.list();

    if (child === undefined) throw new Error('The subordinate was not rostered.');
    await ended.promise;
    await host.close();
    const actorId = childActorId(dbPath, child.name);
    expect(requests.some((prompt) => prompt.includes(note))).toBe(true);
    expect((await userMessages(dbPath, actorId)).some((message) => message.includes(note))).toBe(true);
    expect(evolutionRows(dbPath, actorId)).toEqual({ window: 0, outcomes: [], lessons: [] });
    const db = new Database(dbPath, { readonly: true });

    try {
      const notes = db.query<{ message: string }, [string]>(
        "SELECT message FROM evolution_events WHERE actor_id = ? AND type = 'advisor_note'",
      ).all(actorId);

      expect(notes).toEqual([{ message: note }]);
    } finally { db.close(); }
  });

  test('no hosted child records a turn into the evolution window, whatever its lifetime', async () => {
    const ask = makeRoots();
    const askDb = await seedAgent(ask.state, 'root');
    const askChild = reportingChildModel('could not find the root cause', 'failed');

    const asking = makeHost(ask.state, askChild.model, [
      { name: 'root', cwd: ask.project, workspaceId: 'proj' },
    ]);

    const askTeam = await asking.host.team('root');
    const temporary = present(askTeam.temporary, 'the temporary hire port');

    const outcome = await temporary.run({
      role: 'researcher', roleLabel: 'researcher', task: 'Find the root cause.', mode: 'build',
    });

    await asking.host.close();
    const asked = v.parse(v.object({ agent: v.string() }), outcome).agent;
    const askActorId = childActorId(askDb, asked);
    expect(actorLifecycle(askDb, askActorId)).toBe('retained');
    expect(evolutionRows(askDb, askActorId)).toEqual({ window: 0, outcomes: [], lessons: [] });
    expect(askChild.reflections()).toBe(0);

    const hire = makeRoots();
    const hireDb = await seedAgent(hire.state, 'root');
    const hireChild = reportingChildModel('could not find the root cause', 'failed');

    const hiring = makeHost(hire.state, hireChild.model, [
      { name: 'root', cwd: hire.project, workspaceId: 'proj' },
    ]);

    const childTurnEnded = Promise.withResolvers<void>();
    hiring.host.subscribe((agent, event) => {
      if (agent !== 'root' && event.type === 'turn-end') childTurnEnded.resolve();
    });
    const hireTeam = await hiring.host.team('root');
    await hireTeam.spawn({ role: 'researcher', mission: 'Investigate the incident.', mode: 'build' });
    const [hired] = await hireTeam.list();

    if (!hired) throw new Error('The hire was not rostered.');
    await childTurnEnded.promise;
    await hiring.host.close();

    // Matches cf, where a subordinate runs `runHeadInference` and never reaches `recordTurn`.
    expect(evolutionRows(hireDb, childActorId(hireDb, hired.name))).toEqual({ window: 0, outcomes: [], lessons: [] });
    expect(hireChild.reflections()).toBe(0);
  });

  test('a daemon-hosted swarm node keeps its advisor feedback on its own next turn', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');

    const { host } = makeHost(state, streamingModel('The probe succeeded.'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ], { advisor: true });

    const session = await host.acquire('root');
    const seat = await session.hostNode({ nodeId: 'advised-node', rootId: 'swarm-run', depth: 1 });
    const note = 'The probe exit status was not checked. Verify it before relying on the answer.';
    seat.actor.runtime.advisorLlm = {
      async *stream() { yield ''; },
      complete: async () => JSON.stringify({ note, severity: 'concern', class: 'wrong-work' }),
    };
    const requests: string[] = [];

    const report = await runHeadInference({
      id: 'advised-node', rootId: 'swarm-run', parentId: null, depth: 1,
      task: 'Check the probe.', rationale: 'Check the probe.', mode: 'build', inheritedContext: [],
      mergeStrategy: 'synthesize', budget: { maxDepth: 0, spawnedAt: Date.now() }, loop: { kind: 'builtin' },
    }, {
      actor: seat.actor, runId: seat.runId, profile: seat.profile, dynamic: seat.dynamic,
      model: streamingModel('The probe succeeded.', (options) => { requests.push(JSON.stringify(options.prompt)); }),
      clock: REAL_CLOCK, tools: {}, capture: new HeadCapture(), isAborted: () => false, workspaceLayout: 'shared-workspace',
    });

    expect(report).toMatchObject({ status: 'completed', errorMessage: undefined });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain(note);
    expect(evolutionRows(dbPath, seat.actor.handle.actorId)).toEqual({ window: 0, outcomes: [], lessons: [] });
    await host.close();
  });

  /** A progress note sets the durable relay's "spoke this turn" bit, which must not suppress the terminal answer. */
  for (const [then, expected] of [
    ['answer', 'completed'],
    ['throw', 'failed'],
  ] as const) {
    test(`a temporary child that reports progress and then ${then}s still answers its caller`, async () => {
      const { state, project } = makeRoots();
      const dbPath = await seedAgent(state, 'root');

      const { host } = makeHost(state, progressThenChildModel(then), [
        { name: 'root', cwd: project, workspaceId: 'proj' },
      ]);

      const team = await host.team('root');
      const temporary = present(team.temporary, 'the temporary hire port');

      const outcome = await temporary.run({
        role: 'researcher',
        roleLabel: 'researcher',
        task: 'Audit the ledger.',
        mode: 'build',
      });

      const settled = v.parse(v.object({ status: v.string(), agent: v.string() }), outcome);
      expect(settled.status).toBe(expected);
      expect(await team.list()).toEqual([]);
      await host.close();
      const view = new Database(dbPath, { readonly: true });

      const rows = view.query<{ status: string; lifetime: string }, []>(
        'SELECT status, lifetime FROM actor_subordinates',
      ).all();

      // The progress note is not the answer, so it reaches the rail like any mid-work note.
      const reports = view.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
      ).get()?.n ?? 0;

      view.close();
      expect(rows).toEqual([{ status: 'dismissed', lifetime: 'task' }]);
      expect(reports).toBe(1);
    });
  }

  /** Depth cap on the local backend: a child at `DELEGATION_MAX_DEPTH` has no ask port at all, matching cf's `teamProfile()`. */
  test('a local actor at the delegation cap is wired no temporary port at all', async () => {
    const { state, project } = makeRoots();
    await seedAgent(state, 'root');

    const { host } = makeHost(state, streamingModel('ack'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const team = await host.team('root');
    expect(team.temporary).toBeDefined();

    // Depth comes from walking the directory rows, never from the child's config.
    let address = 'root';

    for (let level = 1; level <= DELEGATION_MAX_DEPTH; level++) {
      await (await host.team(address)).create({
        name: `d${level}`, role: 'researcher', mission: `Work at depth ${level}.`,
      });
      address = `${address}/d${level}`;
    }

    await host.close();

    const { host: reopened } = makeHost(state, streamingModel('ack'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const capped = await reopened.team(address);
    expect(capped.delegation.depth).toBe(DELEGATION_MAX_DEPTH);
    expect(delegationExhausted(capped.delegation)).toBe(true);
    expect(capped.temporary).toBeUndefined();
    await reopened.close();
  });

  /** A hosted child's first owner message titles it via `auto_title`, using the child's roster name rather than the workspace slug. */
  test('a message to an unnamed hire titles it through the turn itself, once', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');

    const { host } = makeHost(state, streamingModel('{"title":"Coupon Audit"}'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const titled = Promise.withResolvers<void>();
    host.subscribe((agent, event) => {
      if (agent === 'root/helper' && event.type === 'broadcast'
        && event.event.type === 'workspace_renamed' && event.event.displayName === 'Coupon Audit') {
        titled.resolve();
      }
    });

    const codename = codenameFor('helper');

    try {
      const team = await host.team('root');
      const created = await team.create({ name: 'helper' });

      expect(created.displayName).toBe(codename);

      const first = awaitTurns(host, 'root/helper', 1);
      await team.message({ name: 'helper', content: 'Audit the coupon checkout', mode: 'build' });
      await Promise.all([first, titled.promise]);

      expect(childConfigValue(dbPath, 'helper', 'display_name')).toBe('Coupon Audit');

      const second = awaitTurns(host, 'root/helper', 1);
      await team.message({ name: 'helper', content: 'Name yourself something else entirely', mode: 'build' });
      await second;

      expect(childConfigValue(dbPath, 'helper', 'display_name')).toBe('Coupon Audit');

      await team.rename({ name: 'helper', displayName: 'Coupon Auditor' });

      const third = awaitTurns(host, 'root/helper', 1);
      await team.message({ name: 'helper', content: 'Change your name again', mode: 'build' });
      await third;

      expect(childConfigValue(dbPath, 'helper', 'display_name')).toBe('Coupon Auditor');
      expect(childConfigValue(dbPath, 'helper', 'name_origin')).toBe('user');
    } finally {
      await host.close();
    }
  });

  /** Once the run settles the row is released, so a further report is refused rather than delivered as a second result. */
  test('a settled temporary run refuses a second report for the same child', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');

    const { host } = makeHost(state, failingChildModel(), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const team = await host.team('root');
    const temporary = present(team.temporary, 'the temporary hire port');

    const outcome = await temporary.run({
      role: 'researcher',
      roleLabel: 'researcher',
      task: 'Find the root cause.',
      mode: 'build',
    });

    const agent = v.parse(v.object({ agent: v.string(), status: v.string() }), outcome);
    expect(agent.status).toBe('failed');

    expect(await team.list()).toEqual([]);
    await expect(team.assign({ name: agent.agent, task: 'again', mode: 'build' }))
      .rejects.toThrow(`subordinate "${agent.agent}" is dismissed`);

    await host.close();
    const view = new Database(dbPath, { readonly: true });

    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;

    view.close();
    expect(reports).toBe(0);
  });

  /** Waiter-absent late report takes the ordinary rail, and the roster releases the row. */
  test('a report with no waiter becomes one correlated event and releases the task row', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const CONTENT = 'late but correct';
    const child = reportingChildModel(CONTENT);

    const { host } = makeHost(state, child.model, [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const team = await host.team('root');
    // The state an evicted asking activation leaves; durable verbs refuse a task row, so flip after the handoff.
    await team.spawn({
      name: 'ask-researcher-late',
      role: 'researcher',
      mission: 'Find the root cause.',
      mode: 'build',
    });
    const reported = Promise.withResolvers<void>();
    host.subscribe((_agent, event) => {
      if (event.type === 'broadcast' && event.event.type === 'subordinate_event'
        && event.event.status === 'completed') reported.resolve();
    });
    await team.assign({ name: 'ask-researcher-late', task: 'Report it.', mode: 'build' });
    const roster = new Database(dbPath);
    roster.run("UPDATE actor_subordinates SET lifetime='task' WHERE name='ask-researcher-late'");
    roster.close();
    await reported.promise;
    await host.close();

    const view = new Database(dbPath, { readonly: true });

    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;

    const rows = view.query<{ status: string; lifetime: string }, []>(
      "SELECT status, lifetime FROM actor_subordinates WHERE name='ask-researcher-late'",
    ).all();

    view.close();
    expect(reports).toBe(1);
    expect(rows).toEqual([{ status: 'dismissed', lifetime: 'task' }]);
  });

  test("a subordinate's terminal report moves its parent's roster row off working", async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const CONTENT = 'root cause: the callback URL was never registered';
    const child = reportingChildModel(CONTENT);

    const { host } = makeHost(state, child.model, [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    // Assignment rides the same `subordinate_event` channel under status 'task'; a wrong status fails by name, not by hanging.
    const reported = Promise.withResolvers<{ status: string; text: string }>();
    const childTurnEnded = Promise.withResolvers<void>();
    const parentTurnEnded = Promise.withResolvers<void>();
    host.subscribe((agent, event) => {
      if (
        event.type === 'broadcast'
        && event.event.type === 'subordinate_event'
        && SUBORDINATE_REPORT_STATUSES.some((known) => known === event.event.status)
      ) {
        reported.resolve({ status: event.event.status ?? '', text: event.event.text ?? '' });
      }

      if (event.type === 'turn-end') {
        if (agent === 'root/researcher') childTurnEnded.resolve();

        if (agent === 'root') parentTurnEnded.resolve();
      }
    });

    const team = await host.team('root');
    await team.create({
      name: 'researcher', role: 'researcher', mission: 'Investigate the incident.',
    });

    const assigned = await team.assign({
      name: 'researcher', task: 'Find the root cause and report it.', mode: 'build',
    });

    expect(assigned.delivery).toBe('starts_now');

    expect(await reported.promise).toEqual({ status: 'completed', text: CONTENT });
    await childTurnEnded.promise;
    await parentTurnEnded.promise;

    // `applyReport` takes 'completed' to idle; the turn-end relay's 'progress' would leave the row 'working'.
    const status = v.parse(TeamStatusSchema, await team.status({ name: 'researcher' }));
    expect(status.roster.status).toBe('idle');
    expect(status.roster.currentTask).toBeNull();

    // Counted after close(), which joins in-flight relays. Either guard alone prevents a duplicate:
    // `parentAdmitsSubordinateReport` refuses a parent with no task, and `reportedThisTurn` suppresses the turn-end relay.
    await host.close();
    const view = new Database(dbPath, { readonly: true });

    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;

    view.close();
    expect(reports).toBe(1);
  });
});

describe('LocalAgentHost — peers in one virtual workspace', () => {
  test('two roots sharing a {cwd, workspaceId} are equal peers, and neither is above the other', async () => {
    const { state, project } = makeRoots();
    await seedAgent(state, 'alpha');
    await seedAgent(state, 'beta');

    const refs: HostedAgentRef[] = [
      { name: 'alpha', cwd: project, workspaceId: 'proj', displayName: 'Alpha' },
      { name: 'beta', cwd: project, workspaceId: 'proj', displayName: 'Beta' },
    ];

    const { host } = makeHost(state, streamingModel('ack'), refs);

    try {
      const alpha = present(await host.peers('alpha'), 'the alpha peer surface');
      const beta = present(await host.peers('beta'), 'the beta peer surface');

      expect(await alpha.deps.listPeers()).toEqual([{ name: 'beta', displayName: 'Beta' }]);
      expect(await beta.deps.listPeers()).toEqual([{ name: 'alpha', displayName: 'Alpha' }]);

      expect((await host.team('alpha')).delegation.depth).toBe(0);
      expect((await host.team('beta')).delegation.depth).toBe(0);
    } finally {
      await host.close();
    }
  });

  test('peer mail: a send reaches the peer, and an ask is answered through the real reply action', async () => {
    const { state, project } = makeRoots();
    const alphaDb = await seedAgent(state, 'alpha');
    const betaDb = await seedAgent(state, 'beta');

    const refs: HostedAgentRef[] = [
      { name: 'alpha', cwd: project, workspaceId: 'proj' },
      { name: 'beta', cwd: project, workspaceId: 'proj' },
    ];

    const answering = replyingModel('the parser is the bottleneck');
    const { host } = makeHost(state, answering.model, refs);

    try {
      const alpha = present(await host.peers('alpha'), 'the alpha peer surface');
      const betaSettled = awaitTurns(host, 'beta', 2);

      const sent = await alpha.deps.send({
        agent: 'beta', topic: 'note', message: 'starting on the parser', mode: 'build',
      });

      expect(sent).toMatchObject({ status: 'delivered' });
      expect(eventCount(betaDb, 'peer')).toBe(1);

      const asked = await alpha.deps.ask({
        agent: 'beta', topic: 'research', message: 'what did you find?', mode: 'build',
      });

      expect(asked).toEqual({
        status: 'replied',
        from: 'beta',
        reply: 'the parser is the bottleneck',
      });
      expect(answering.replies()).toBe(1);
      await betaSettled;
      // Beta's post-turn drain is scheduled, not awaited by the reply path.
      await host.tick('beta', Date.now());
      expect(pendingOutboxRows(alphaDb).map((row) => row.state)).toEqual(['sent', 'sent']);
      expect(pendingOutboxRows(betaDb).map((row) => row.state)).toEqual(['sent']);
    } finally {
      await host.close();
    }
  });

  test('each peer hires its own subordinates, and a subordinate cannot reach out of its workspace', async () => {
    const { state, project } = makeRoots();
    const alphaDb = await seedAgent(state, 'alpha');
    const betaDb = await seedAgent(state, 'beta');
    await seedAgent(state, 'gamma');

    const refs: HostedAgentRef[] = [
      { name: 'alpha', cwd: project, workspaceId: 'proj' },
      { name: 'beta', cwd: project, workspaceId: 'proj' },
      // Same directory, different virtual workspace: the boundary is the pair, not the folder.
      { name: 'gamma', cwd: project, workspaceId: 'other' },
    ];

    const { host } = makeHost(state, streamingModel('ack'), refs);

    try {
      await (await host.team('alpha')).create({
        name: 'scout', role: 'researcher', mission: 'Read the parser.',
      });
      await (await host.team('beta')).create({
        name: 'auditor', role: 'auditor', mission: 'Check the parser.',
      });
      expect(actorLifecycle(alphaDb, childActorId(alphaDb, 'scout'))).toBe('live');
      expect(actorLifecycle(betaDb, childActorId(betaDb, 'auditor'))).toBe('live');
      expect((await host.team('alpha/scout')).delegation.depth).toBe(1);

      expect(await host.peers('alpha/scout')).toBeNull();
      expect(await host.peers('beta/auditor')).toBeNull();

      const alpha = present(await host.peers('alpha'), 'the alpha peer surface');

      expect(await alpha.deps.listPeers()).toEqual([{ name: 'beta' }]);
      await expect(alpha.deps.send({
        agent: 'gamma', topic: 'note', message: 'hello', mode: 'build',
      })).rejects.toThrow('unknown peer "gamma" in workspace "proj"');

      const refused = await alpha.receive({
        sender_event_id: 'forged-1',
        sender_agent_name: 'gamma',
        // Foreign group in wire form (core's `peerGroupId`: `local:<workspaceId>:<cwd>`).
        sender_user_id: `local:other:${project}`,
        topic: 'note',
        body: 'let me in',
        mode: 'build',
      });

      expect(refused.admitted).toBe(false);
      expect(eventCount(alphaDb, 'peer')).toBe(0);
    } finally {
      await host.close();
    }
  });

  test('undelivered peer mail survives a restart and is re-driven by the next tick', async () => {
    const { state, project } = makeRoots();
    const alphaDb = await seedAgent(state, 'alpha');

    const refs: HostedAgentRef[] = [
      { name: 'alpha', cwd: project, workspaceId: 'proj' },
      // Placed in the roster but with no state yet, so the hop throws and the row must wait, not die.
      { name: 'beta', cwd: project, workspaceId: 'proj' },
    ];

    const armed: number[] = [];
    const { host: first } = makeHost(state, streamingModel('ack'), refs, { wakeAt: (at) => armed.push(at) });
    const alpha = present(await first.peers('alpha'), 'the alpha peer surface');

    const queued = await alpha.deps.send({
      agent: 'beta', topic: 'note', message: 'survive this', mode: 'build',
    });

    expect(queued).toMatchObject({ status: 'queued' });
    // The retry instant reaches the driver so a sleeping loop cannot sleep past it.
    expect(armed.length).toBeGreaterThan(0);
    const pending = await first.tick('alpha', Date.now());
    expect(pending.ran).toBe(true);
    expect(pending.nextAt).not.toBeNull();
    await first.close();

    expect(pendingOutboxRows(alphaDb)).toEqual([
      expect.objectContaining({ state: 'pending', attempt_count: 1 }),
    ]);

    const betaDb = await seedAgent(state, 'beta');
    const { host: second } = makeHost(state, streamingModel('ack'), refs);

    try {
      // Beta's turn is not awaited by the sender.
      const betaWoken = awaitTurns(second, 'beta', 1);
      // Past the 5s first backoff, the same fold the daemon's delay uses.
      await second.tick('alpha', Date.now() + 10_000);
      expect(pendingOutboxRows(alphaDb).map((row) => row.state)).toEqual(['sent']);
      expect(eventCount(betaDb, 'peer')).toBe(1);
      await betaWoken;
    } finally {
      await second.close();
    }
  });

  test('every actor binds one physical directory while its own state stays private', async () => {
    const { state, project } = makeRoots();
    await seedAgent(state, 'alpha');
    await seedAgent(state, 'beta');

    const refs: HostedAgentRef[] = [
      { name: 'alpha', cwd: project, workspaceId: 'proj' },
      { name: 'beta', cwd: project, workspaceId: 'proj' },
    ];

    const seen: string[] = [];

    const { host, runtimes } = makeHost(state, streamingModel('ack', (options) => {
      seen.push(renderPromptText(options.prompt));
    }), refs);

    try {
      await (await host.team('alpha')).create({
        name: 'scout', role: 'researcher', mission: 'Read the parser.',
      });
      await host.acquire('beta');
      const alphaRt = present(runtimes.get('alpha'), 'the alpha runtime');
      const betaRt = present(runtimes.get('beta'), 'the beta runtime');

      await alphaRt.storage.vfs.writeFile('shared-note.md', 'peers share this file');
      expect(await betaRt.storage.vfs.readFile('shared-note.md', { encoding: 'utf-8' }))
        .toBe('peers share this file');
      expect(readFileSync(join(project, 'shared-note.md'), 'utf-8')).toBe('peers share this file');
      expect(alphaRt.cwd).toBe(project);
      expect(betaRt.cwd).toBe(project);

      // The prompt's runtime context is the only place a turn learns its directory.
      seen.length = 0;
      await (await host.acquire('alpha/scout')).send('where am I working?', { id: crypto.randomUUID() });
      expect(seen.join('\n')).toContain(`Working directory: ${project}`);

      expect(existsSync(join(project, 'SOUL.md'))).toBe(false);
      expect(existsSync(join(project, 'MEMORY.md'))).toBe(false);

      await (await host.acquire('alpha')).send('only alpha said this', { id: crypto.randomUUID() });
      expect(await userMessages(join(state, 'alpha', 'agent.db'))).toContain('only alpha said this');
      expect(await userMessages(join(state, 'beta', 'agent.db'))).not.toContain('only alpha said this');
      expect(await userMessages(
        join(state, 'alpha', 'agent.db'),
        childActorId(join(state, 'alpha', 'agent.db'), 'scout'),
      )).not.toContain('only alpha said this');
    } finally {
      await host.close();
    }
  });
});

function renderPromptText(prompt: LanguageModelV2CallOptions['prompt']): string {
  return prompt.flatMap((message) => (message.role === 'system'
    ? [message.content]
    : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
  )).join('\n');
}

/** The actor id a child was hired under; a subordinate is a row set in its parent's one database. */
function childActorId(parent: string, name: string): string {
  const db = new Database(parent, { readonly: true });

  try {
    const sql = makeSql(db);
    const reference = new SubordinateRosterStore(makeSqlExec(db), openWorkspaceMainActor(sql)).get(name)?.actorReference;

    if (!reference) throw new Error('The child has no recorded actor identity.');

    return reference.actorId;
  } finally { db.close(); }
}

/** One config row for the child's actor_id; the roster carries no display name. */
function childConfigValue(parent: string, name: string, key: string): string | null {
  const db = new Database(parent, { readonly: true });

  try {
    const actorId = childActorId(parent, name);

    const row = db.query<{ value: string }, [string, string]>(
      'SELECT value FROM actor_config WHERE actor_id = ? AND key = ?',
    ).get(actorId, key);

    return row?.value ?? null;
  } finally { db.close(); }
}

/**
 * One actor's directory lifecycle. `deleted_at` marks the name released (every dismissal);
 * only a destroy purges the actor's rows, which `actorRowCount` counts.
 */
function actorLifecycle(parent: string, actorId: string): 'live' | 'retiring' | 'retained' | null {
  const db = new Database(parent, { readonly: true });

  try {
    const row = makeSql(db)<{ retiring_at: number | null; deleted_at: number | null }>`
      SELECT retiring_at, deleted_at FROM workspace_actors WHERE actor_id = ${actorId}`[0];

    if (!row) return null;

    if (row.deleted_at !== null) return 'retained';

    return row.retiring_at === null ? 'live' : 'retiring';
  } finally { db.close(); }
}

/**
 * Rows for one actor across every `actor_id` table, read from the catalogue rather than the product's cleanup pass,
 * so a purge that skips a table is caught. `workspace_actors` is excluded: the directory owns its lifecycle.
 */
function actorRowCount(parent: string, actorId: string): number {
  const db = new Database(parent, { readonly: true });

  try {
    const scoped = db.query<{ name: string }, []>(`
      SELECT m.name AS name FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS c
      WHERE m.type = 'table' AND m.name <> 'workspace_actors' AND c.name = 'actor_id'
      ORDER BY m.name`).all();

    let total = 0;

    for (const table of scoped) {
      total += db.query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM "${table.name.replace(/"/g, '""')}" WHERE actor_id = ?`,
      ).get(actorId)?.c ?? 0;
    }

    return total;
  } finally { db.close(); }
}

function evolutionRows(dbPath: string, actorId: string) {
  const db = new Database(dbPath, { readonly: true });

  try {
    return {
      window: db.query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM completed_turns WHERE actor_id = ?').get(actorId)?.c ?? 0,
      outcomes: db.query<{ outcome: string; source: string }, [string]>(
        'SELECT outcome, source FROM turn_outcomes WHERE actor_id = ? ORDER BY created_at',
      ).all(actorId),
      lessons: db.query<{ source: string; status: string }, [string]>(
        'SELECT source, status FROM lessons WHERE actor_id = ? ORDER BY created_at',
      ).all(actorId),
    };
  } finally { db.close(); }
}

/** Read handle for any actor this database holds; presence is the fence, not lifecycle. */
function readHandle(sql: SqlExecutor, actorId: string): ActorHandle {
  const row = sql<{ workspace_id: string; parent_actor_id: string | null; name: string; storage_key: string }>`
    SELECT workspace_id, parent_actor_id, name, storage_key FROM workspace_actors WHERE actor_id = ${actorId}`[0];

  if (row === undefined) throw new Error('The actor is not in this workspace.');

  return bindActorHandle(sql, {
    actorId, workspaceId: row.workspace_id, parentActorId: row.parent_actor_id, name: row.name, storageKey: row.storage_key,
  }, () => {
    if (sql<{ x: number }>`SELECT 1 AS x FROM workspace_actors WHERE actor_id = ${actorId} LIMIT 1`.length === 0) {
      throw new Error('The actor left this workspace mid-read.');
    }
  });
}

async function userMessages(dbPath: string, actorId?: string): Promise<string[]> {
  const db = new Database(dbPath, { readonly: true });

  try {
    const sql = makeSql(db);
    const actor = actorId === undefined ? openWorkspaceMainActor(sql) : readHandle(sql, actorId);
    // A message this short is inline, so any VFS read is a spill this helper should surface.
    const rows = await readTranscriptRows(sql, actor, createMemoryVfs().vfs);

    return rows.filter((row) => row.role === 'user').map((row) => row.content);
  } finally {
    db.close();
  }
}

/** Schedule a timer from another handle, as `kinu triggers <name> at` does; the host's own pass fires it. */
async function scheduleTimer(dbPath: string, label: string, atMs: number): Promise<void> {
  const db = new Database(dbPath);

  try {
    const registry = new TriggerRegistry(makeSqlExec(db), openWorkspaceMainActor(makeSql(db)), { scheduleAt: async () => {} });
    await createTimerTrigger(registry, { atMs, label, trust: 'owner' }, Date.now());
  } finally {
    db.close();
  }
}

/** The driver lease over a real database; the rival is a real sleeping process, since liveness is only whether its pid exists. */
describe('LocalAgentHost — the driver lease', () => {
  const rivals: Subprocess[] = [];

  afterEach(async () => {
    await retireRivals();
  });

  /** Kill and reap every rival: an unreaped child still answers `kill(pid, 0)`. */
  async function retireRivals(): Promise<void> {
    const going = rivals.splice(0);

    for (const rival of going) rival.kill();
    await Promise.all(going.map((rival) => rival.exited));
  }

  function rivalHolds(dbPath: string, kind: DriverKind): number {
    const rival = Bun.spawn({ cmd: ['sleep', '120'], stdout: 'ignore', stderr: 'ignore' });
    rivals.push(rival);
    const db = new Database(dbPath);

    try {
      const hold = new DriverLeaseHold({
        sql: makeSql(db),
        execRaw: makeExecRaw(db),
        proc: { pid: rival.pid, isAlive: () => true },
      }, kind);

      const refusal = hold.acquire();

      if (refusal) throw new Error(`the rival could not take the lease: ${refusal.refused.error}`);

      return rival.pid;
    } finally {
      db.close();
    }
  }

  function holderAt(dbPath: string): DriverLeaseHolder | null {
    const db = new Database(dbPath);

    try {
      return leaseHolder(db);
    } finally {
      db.close();
    }
  }

  test('a failed first open releases and forgets its lease before a retry', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');

    const { host } = makeHost(state, streamingModel('ack'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);

    const realFlush = present(
      Object.getOwnPropertyDescriptor(LocalAgentSession.prototype, 'flushPendingDrains'),
      'the LocalAgentSession pending-drain flush',
    );

    LocalAgentSession.prototype.flushPendingDrains = async function refuseOnce() {
      Object.defineProperty(LocalAgentSession.prototype, 'flushPendingDrains', realFlush);

      throw new Error('injected first-open drain failure');
    };

    try {
      await expect(host.acquire('root')).rejects.toThrow('injected first-open drain failure');
      expect(holderAt(dbPath)).toBeNull();

      // A memoized hold over the closed handle would throw `Database has closed` here.
      expect(await host.acquire('root')).toBeInstanceOf(LocalAgentSession);
      expect(holderAt(dbPath)?.kind).toBe('interactive');
    } finally {
      Object.defineProperty(LocalAgentSession.prototype, 'flushPendingDrains', realFlush);
      await host.close();
    }
  });

  test('a refused opener preserves the live driver claim and starts no model work', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const db = new Database(dbPath);
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, cwd: project });

    const claim = await rt.stores.claims.admit({
      runId: 'live-run', turnId: 'live-turn', workMode: 'build',
      context: rt.stores.history.context.selected() ?? rt.stores.history.context.initialize(),
      program: { kind: 'builtin', version: 0, digest: null, build: null },
    });

    rivalHolds(dbPath, 'interactive');
    let calls = 0;

    const { host } = makeHost(state, streamingModel('must not run', () => { calls++; }), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ], { driverKind: 'daemon' });

    try {
      await host.acquire('root');
      expect(rt.stores.claims.read(claim.turnId)).toMatchObject({ epoch: claim.epoch, status: 'admitted', outcome: null });
      expect(calls).toBe(0);
    } finally {
      await host.close();
      db.close();
    }
  });

  test('constructing a refused opener cannot reset the live driver review claim', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const db = new Database(dbPath);
    const { rt } = await openWorkspaceCLI(db, dbPath, { llm: DUMMY_LLM, cwd: project });
    initCompletedTurnTable(rt.storage.execRaw);
    const window = createCompletedTurnStore(rt.storage.sql, rt.actor);
    window.enqueueReview({
      userMessage: 'live review', assistantResponse: 'answer', toolCalls: [],
      steps: 1, durationMs: 1, feedback: null, hadError: false, turnId: 'review-held',
    }, null);
    const held = window.takeQueuedReviews(1).reviews[0];

    if (held === undefined) throw new Error('the driver did not claim its review');
    rivalHolds(dbPath, 'interactive');

    const { host } = makeHost(state, streamingModel('must not run'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ], { driverKind: 'daemon' });

    try {
      await host.acquire('root');
      expect(window.countQueuedReviews()).toBe(0);
      await retireRivals();
      window.releaseQueuedReview(held.id);
      expect(window.takeQueuedReviews(1).reviews.map((row) => row.turn.turnId)).toEqual(['review-held']);
    } finally {
      await host.close();
      db.close();
    }
  });

  test('a daemon hands the lease back at the end of every pass, so nothing has to preempt it', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');

    const { host } = makeHost(state, streamingModel('ack'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ], { driverKind: 'daemon' });

    try {
      const first = await host.tick('root');
      expect(first.ran).toBe(true);
      // A host must not keep the conversation between passes, or the daemon becomes un-preemptible.
      expect(holderAt(dbPath)).toBeNull();
      expect((await host.tick('root')).ran).toBe(true);
      expect(holderAt(dbPath)).toBeNull();
    } finally {
      await host.close();
    }
  });

  test('a pass a live interactive driver owns is reported deferred, naming the holder', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const rivalPid = rivalHolds(dbPath, 'interactive');

    const { host } = makeHost(state, streamingModel('ack'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ], { driverKind: 'daemon' });

    try {
      const result = await host.tick('root');

      // The result shape keeps this distinguishable from a pass that ran and found nothing.
      expect(result.ran).toBe(false);
      expect(result.heldBy).toEqual({ pid: rivalPid, kind: 'interactive' });
      expect(holderAt(dbPath)).toEqual({ pid: rivalPid, kind: 'interactive' });
    } finally {
      await host.close();
    }
  });

  test('opening a workspace reclaims and delivers an event a dead process left bound to a turn it never ran', async () => {
    // KINU-020: a row bound to a synthetic drain turn by a dead process is invisible to `pending()`;
    // opening under the driver lease hands it back.
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const refs: HostedAgentRef[] = [{ name: 'root', cwd: project, workspaceId: 'proj' }];
    const before = makeHost(state, streamingModel('handled'), refs, { driverKind: 'daemon' });

    try {
      const fireAt = Date.now() + 60_000;
      await scheduleTimer(dbPath, 'a build finished', fireAt);
      // The drain is a debounced timer; closing first leaves what a process killed in that window leaves.
      const session = await before.host.acquire('root');
      expect((await session.fireDueTriggers(fireAt)).fired).toBe(1);
    } finally {
      await before.host.close();
    }

    const db = new Database(dbPath);

    try {
      db.query(`UPDATE agent_log SET turn_id = 'evt-dead', step_idx = 0, consumed_at = 5 WHERE kind = 'event'`).run();
    } finally {
      db.close();
    }

    expect(eventCount(dbPath, 'pending')).toBe(0);

    const after = makeHost(state, streamingModel('handled after recovery'), refs, { driverKind: 'daemon' });
    let turns = 0;

    const unsubscribe = after.host.subscribe((_agent, event) => {
      if (event.type === 'turn-start') turns += 1;
    });

    try {
      await after.host.acquire('root');
      expect(turns).toBe(1);
      expect(eventCount(dbPath, 'pending')).toBe(0);
      expect((await userMessages(dbPath)).join('\n')).toContain('a build finished');
    } finally {
      unsubscribe();
      await after.host.close();
    }
  });

  test('a drained event whose turn is refused goes back to pending and is delivered once', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const refs: HostedAgentRef[] = [{ name: 'root', cwd: project, workspaceId: 'proj' }];
    const { host } = makeHost(state, streamingModel('handled'), refs, { driverKind: 'daemon' });
    let turns = 0;
    // The drain binds rows, announces, then queues the turn; a rival arriving in that window is the queue-item contract's case.
    let stolenBy: number | null = null;

    const unsubscribe = host.subscribe((_agent, event) => {
      if (event.type === 'turn-start') turns += 1;

      if (event.type !== 'broadcast' || event.event.type !== 'signal_card') return;

      stolenBy ??= rivalHolds(dbPath, 'interactive');
    });

    try {
      const fireAt = Date.now() + 60_000;
      await scheduleTimer(dbPath, 'a build finished', fireAt);
      expect((await (await host.acquire('root')).fireDueTriggers(fireAt)).fired).toBe(1);
      expect(eventCount(dbPath, 'pending')).toBe(1);

      await host.tick('root');

      expect(stolenBy).not.toBeNull();
      expect(holderAt(dbPath)).toEqual({ pid: stolenBy ?? -1, kind: 'interactive' });
      // Bound-and-abandoned is invisible to `pending()`; this fails if a refused turn is settled as queued.
      expect(eventCount(dbPath, 'pending')).toBe(1);
      expect(turns).toBe(0);

      await retireRivals();

      const ran = await host.tick('root');
      expect(ran.ran).toBe(true);
      expect(turns).toBe(1);
      expect(eventCount(dbPath, 'pending')).toBe(0);
    } finally {
      unsubscribe();
      await host.close();
    }
  });
});
