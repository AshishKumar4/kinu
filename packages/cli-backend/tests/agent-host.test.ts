import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { LanguageModel } from 'ai';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import * as v from 'valibot';
import {
  BackgroundJobStore,
  backgroundJobWakeTrigger,
  createAgentConfigStore,
  createTimerTrigger,
  initWorkspaceSchema,
  DELEGATION_MAX_DEPTH,
  REPORT_TOOL,
  TriggerRegistry,
  delegationExhausted,
  SUBORDINATE_REPORT_STATUSES,
  type HostedAgentRef,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/identity';
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

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function streamingModel(answer: string, onCall?: (options: LanguageModelV2CallOptions) => void): LanguageModel {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => ({
      content: [{ type: 'text', text: answer }],
      finishReason: 'stop' as const,
      usage,
      warnings: [],
    }),
    doStream: async (options) => {
      onCall?.(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
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
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
  return { model, started, release, calls: () => callCount };
}

/** A subordinate that answers its assignment with a TERMINAL report: one
 *  `report` tool call declaring `completed`, then its closing text.
 *
 *  The status is the child's own word, which is the whole point. `relayToParent`
 *  used to hardcode `'progress'`, so every local subordinate stayed permanently
 *  `working` in its parent's eyes whatever it said, and the tool the cloud
 *  backend gives a child was not wired here at all. */
function reportingChildModel(content: string) {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  let calls = 0;
  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    // The detached review pass calls this one; without it every turn reports a
    // failure that belongs to the fixture rather than to the product.
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'acknowledged' }],
      finishReason: 'stop' as const,
      usage,
      warnings: [],
    }),
    doStream: async () => {
      calls += 1;
      // Call 1 is the child's assigned turn; 2 is its continuation past the
      // tool result; the rest are the parent's wake turn.
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
                input: JSON.stringify({ status: 'completed', content }),
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
  return { model, calls: () => calls };
}

/** A child that finishes its assigned turn with NO TEXT AT ALL.
 *
 *  The durable relay withholds this (`subordinateRelaysTurnEnd` requires
 *  non-empty text), which for a temporary agent meant the caller's `ask` never
 *  returned. A task child must report it as a non-answer instead. */
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

/** A child whose turn FAILS outright: the provider throws. */
function failingChildModel() {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => { throw new Error('provider is down'); },
    doStream: async () => { throw new Error('provider is down'); },
  });
}

/** A child that files a mid-task `progress` note through the report tool and
 *  THEN reaches a terminal state.
 *
 *  This is the shape that hung an ask: the progress note sets "spoke this turn",
 *  which is the DURABLE relay's suppression bit, while `temporaryRunSettles`
 *  correctly refuses to treat it as the answer. A task child that filed one and
 *  then answered had its terminal report suppressed and its caller waited
 *  forever. `then` decides what happens after the note. */
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

/** A throwaway pair: agent state under `state/`, the physical project under
 *  `project/`. Separate because that is the shape the product has — state is
 *  never inside the directory the agent works in. */
function makeRoots() {
  const state = mkdtempSync(join(tmpdir(), 'kinu-host-state-'));
  const project = mkdtempSync(join(tmpdir(), 'kinu-host-project-'));
  tempRoots.push(state, project);
  return { state, project };
}

interface TestHost {
  host: LocalAgentHost;
  /** Each ROOT's runtime, captured where the host asks for it. */
  runtimes: Map<string, CLIRuntime>;
}

/** Whatever a scenario needs beyond the roster: the retry hook, and — for the
 *  lease scenarios — what kind of driver this host says it is. */
interface TestHostExtras {
  wakeAt?: (at: number) => void;
  driverKind?: DriverKind;
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
    childDbPath: (parentDbPath, child) =>
      join(dirname(parentDbPath), 'subordinates', child, 'agent.db'),
    open: async (ref, db, dbPath) => {
      const openConfig = { llm: DUMMY_LLM, cwd: ref.cwd };
      const { rt } = await openWorkspaceCLI(db, dbPath, openConfig);
      runtimes.set(ref.name, rt);
      const hosted: LocalHostedAgent = { rt, openConfig, staticModel: model };
      return hosted;
    },
  };
  if (extras.wakeAt) options.wakeAt = extras.wakeAt;
  if (extras.driverKind) options.driverKind = extras.driverKind;
  return { host: new LocalAgentHost(options), runtimes };
}


function peerEventCount(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM agent_log WHERE kind = 'event' AND variant = 'peer_agent'`,
    ).get()?.n ?? 0;
  } finally {
    db.close();
  }
}

/**
 * A promise for `count` completed turns on `agent`.
 *
 * Peer mail wakes the receiver's loop without waiting for it — the sender is
 * not blocked on the receiver's turn, by design — so a test that stops at the
 * assertion would tear the host down mid-turn. This is the same synchronisation
 * the subordinate-report test uses, for the same reason.
 */
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
 * A model that ANSWERS a peer ask the way the product does: it finds the event
 * id the drain told it to cite, calls the real `agents` tool with
 * `action:'reply'`, and then closes the turn.
 *
 * Reading the id out of its own prompt is the point rather than a shortcut —
 * that hint is the only way a real model learns which event to answer, so a
 * test that supplied the id some other way would not prove the loop closes.
 *
 * Each id is answered ONCE. The hint stays in the conversation forever, so a
 * model that re-answered on sight would keep re-reading its own history and
 * never finish a turn.
 */
function replyingModel(answer: string) {
  const usage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const answered = new Set<string>();
  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    // The detached turn-review pass calls this one; without it every peer turn
    // reports `orchestrator.detached_work_failed` for a reason that is the
    // fixture's, not the product's.
    doGenerate: async () => ({
      content: [{ type: 'text', text: answer }],
      finishReason: 'stop' as const,
      usage,
      warnings: [],
    }),
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
                input: JSON.stringify({ action: 'reply', event_id: replyTo, message: answer }),
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

/** The unanswered ask in this prompt, from the drain's own reply hint. */
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
    await session.send('remember this');
    const deliveredBeforeDisconnect = delivered.length;
    unsubscribe();

    const fireAt = Date.now() + 60_000;
    await scheduleTimer(dbPath, 'continue while the client is gone', fireAt);
    await host.tick('root', fireAt);

    expect(delivered).toHaveLength(deliveredBeforeDisconnect);
    const db = new Database(dbPath);
    const sessions = db.query<{ session_id: string }, []>(
      'SELECT DISTINCT session_id FROM messages ORDER BY session_id',
    ).all();
    const rows = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM messages WHERE role IN ('user','assistant')",
    ).get();
    const config = createAgentConfigStore(makeSql(db));
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
    const store = new BackgroundJobStore(sql);
    const now = Date.now();
    store.create({ id: jobId, kind: 'agents', workMode: 'build', now, label: 'restart proof' });
    store.settle(jobId, 0, JSON.stringify({ done: true }), now + 1);
    db.query(
      'INSERT INTO fibers (id, name, snapshot, created_at) VALUES (?, ?, ?, ?)',
    ).run(
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
    const wakeId = `programmatic:${backgroundJobWakeTrigger(jobId)}`;
    const wakeRows = check.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM messages WHERE id = ?',
    ).get(wakeId);
    const assistantRows = check.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM messages WHERE parent_id = ? AND role = 'assistant'",
    ).get(wakeId);
    const orphanRows = check.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM fibers WHERE id = 'orphan-fiber'",
    ).get();
    expect(wakeRows?.n).toBe(1);
    expect(assistantRows?.n).toBe(1);
    expect(orphanRows?.n).toBe(0);
    check.close();
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
      role: { kind: 'catalog', roleId: 'researcher' },
      mission: 'Investigate the incident.',
    });
    const childTeam = await host.team('root/researcher');
    expect(childTeam.delegation.depth).toBe(1);
    const childPath = join(dirname(dbPath), 'subordinates', 'researcher', 'agent.db');
    expect(created.subordinate.status).toBe('idle');
    expect(existsSync(childPath)).toBe(true);

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
    expect(existsSync(childPath)).toBe(true);
    await expect(team.assign({ name: 'researcher', task: 'again', mode: 'build' }))
      .rejects.toThrow('subordinate "researcher" is dismissed');

    await team.create({
      name: 'temporary',
      role: { kind: 'catalog', roleId: 'auditor' },
      mission: 'Inspect one isolated case.',
    });
    const temporaryPath = join(dirname(dbPath), 'subordinates', 'temporary', 'agent.db');
    expect(existsSync(temporaryPath)).toBe(true);
    await team.dismiss({ name: 'temporary', requestedBy: 'user', keepHistory: false });
    expect(existsSync(dirname(temporaryPath))).toBe(false);
    await host.close();
  });


  /**
   * THE TEMPORARY RUNG, END TO END ON THE REAL LOCAL SUBSTRATE.
   *
   * A role-targeted `ask` is not a bare model call and not a second execution
   * path: it births a real local actor with its own SQLite database, its own
   * `LocalAgentSession` and its own tool loop, drives it through the same
   * `subordinate_task` admission a hire uses, takes its report through the same
   * ingress, and then archives it in the SAME roster. Everything asserted here
   * is a fact on disk or in that one roster.
   */
  test('a role-targeted ask runs a real local child, answers from the call, and archives it in the one roster', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const ANSWER = 'the callback URL was never registered';
    const child = reportingChildModel(ANSWER);
    const { host } = makeHost(state, child.model, [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);
    const team = await host.team('root');
    const port = team.temporary;
    // The port is wired wherever a local agent holds a roster — the rung is
    // structural, not a per-session option.
    expect(port).toBeDefined();

    const outcome = await port!.run({
      role: { kind: 'catalog', roleId: 'researcher' },
      roleLabel: 'researcher',
      task: 'Find the root cause and report it.',
      mode: 'build',
    });

    // ONE stable shape, and the answer came back from THIS call rather than as
    // an event on a later turn.
    expect(outcome).toMatchObject({
      status: 'completed',
      lifetime: 'task',
      role: 'researcher',
      answer: ANSWER,
      transcript: 'kept',
    });
    const agent = v.parse(v.object({ agent: v.string() }), outcome).agent;
    expect(agent).toStartWith('ask-researcher-');

    // It was a REAL actor: its own database exists under this root's children,
    // and a release keeps it — that file IS the transcript the outcome claims.
    const childDb = join(dirname(dbPath), 'subordinates', agent, 'agent.db');
    expect(existsSync(childDb)).toBe(true);

    // ONE roster. Released from the working set...
    expect(await team.list()).toEqual([]);
    // ...and archived in that same roster, carrying the lifetime that says which
    // rung created it. No second table was consulted to learn any of this.
    const archived = new Database(dbPath, { readonly: true });
    const rows = archived.query<{
      name: string; status: string; lifetime: string; task_event_id: string | null;
    }, []>('SELECT name, status, lifetime, task_event_id FROM workspace_subordinates').all();
    archived.close();
    expect(rows).toEqual([
      { name: agent, status: 'dismissed', lifetime: 'task', task_event_id: null },
    ]);

    await host.close();
    // The child's answer was consumed by the waiting call, so it never became a
    // `subordinate_report` event on the parent's rail — publishing it too would
    // have billed a turn to read an answer already in hand.
    const view = new Database(dbPath, { readonly: true });
    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;
    view.close();
    expect(reports).toBe(0);
  });

  /** A hire is untouched by the rung above: it stays DURABLE in the same roster,
   *  and its report still travels the event rail that wakes its parent. */
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
      role: { kind: 'catalog', roleId: 'researcher' },
      mission: 'Investigate the incident.',
      mode: 'build',
    });
    const roster = await team.list();
    expect(roster).toHaveLength(1);
    expect(roster[0]?.lifetime).toBe('durable');
    // The row names the assignment its report will cite — one correlation for
    // both lifetimes.
    expect(roster[0]?.taskEventId).toBeTruthy();

    await reported.promise;
    await parentTurnEnded.promise;
    await host.close();
    const view = new Database(dbPath, { readonly: true });
    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;
    view.close();
    // A durable subordinate's answer IS its parent's event: exactly one, on the
    // rail, unchanged by the temporary rung's existence.
    expect(reports).toBe(1);
  });

  /**
   * NO HANG, EXACTLY ONE RESULT — for every way a temporary child's turn can end.
   *
   * There is no deadline anywhere in this rung by ruling, so the ONLY thing that
   * makes `run` return is the child reporting. These drive the two endings the
   * durable relay policy withholds — a finished turn with nothing to say, and a
   * turn that failed — on the real local substrate, and assert the call returns
   * with exactly one report and no duplicate.
   */
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
      const outcome = await team.temporary!.run({
        role: { kind: 'catalog', roleId: 'researcher' },
        roleLabel: 'researcher',
        task: 'Find the root cause.',
        mode: 'build',
      });

      // It RETURNED — that is the guarantee. Classified, with the child's own
      // account rather than a bare timeout.
      expect(outcome).toMatchObject({ status: 'failed', lifetime: 'task', transcript: 'kept' });
      const answer = v.parse(v.object({ answer: v.string(), agent: v.string() }), outcome);
      expect(answer.answer.length).toBeGreaterThan(0);

      // Released from the working set, archived in the SAME roster.
      expect(await team.list()).toEqual([]);
      await host.close();
      const view = new Database(dbPath, { readonly: true });
      const rows = view.query<{ name: string; status: string; lifetime: string }, []>(
        'SELECT name, status, lifetime FROM workspace_subordinates',
      ).all();
      // EXACTLY ONE result: the waiting call consumed the report, so it never
      // also became an event that would wake the parent for a second reading.
      const reports = view.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
      ).get()?.n ?? 0;
      view.close();
      expect(rows).toEqual([{ name: answer.agent, status: 'dismissed', lifetime: 'task' }]);
      expect(reports).toBe(0);
    });
  }

  /**
   * A PROGRESS NOTE MUST NOT CANCEL THE ANSWER.
   *
   * The mid-task `progress` report is invited behaviour, and it sets the DURABLE
   * relay's "spoke this turn" bit — which is not the same question as "already
   * answered". Suppressing the terminal report on it left the caller parked with
   * no deadline to rescue it. Both endings after a note are covered: the child
   * answers, and the child fails.
   */
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
      const outcome = await team.temporary!.run({
        role: { kind: 'catalog', roleId: 'researcher' },
        roleLabel: 'researcher',
        task: 'Audit the ledger.',
        mode: 'build',
      });

      // It RETURNED. Before the settling bit existed this call never resolved.
      const settled = v.parse(v.object({ status: v.string(), agent: v.string() }), outcome);
      expect(settled.status).toBe(expected);
      // Released, in the one roster.
      expect(await team.list()).toEqual([]);
      await host.close();
      const view = new Database(dbPath, { readonly: true });
      const rows = view.query<{ status: string; lifetime: string }, []>(
        'SELECT status, lifetime FROM workspace_subordinates',
      ).all();
      // The PROGRESS note is the one thing that legitimately reaches the rail:
      // it is not the answer, so it wakes the parent like any mid-work note.
      const reports = view.query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
      ).get()?.n ?? 0;
      view.close();
      expect(rows).toEqual([{ status: 'dismissed', lifetime: 'task' }]);
      expect(reports).toBe(1);
    });
  }

  /**
   * THE DEPTH CAP, STRUCTURALLY, ON THE LOCAL BACKEND.
   *
   * A role-targeted ask births a child through the same runtime a hire does, so
   * it adds a level. The port was wired for every entry, so a depth-4 local actor
   * advertised and ran it, seeded a depth-5 child, and that child got a port of
   * its own — one call per level without bound, which is the failure
   * `DELEGATION_MAX_DEPTH` exists to prevent. Absence is the containment, which
   * is what the cloud backend's `teamProfile()` already did.
   */
  test('a local actor at the delegation cap is wired no temporary port at all', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const { host } = makeHost(state, streamingModel('ack'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);
    const team = await host.team('root');
    // A root has the whole cap below it, so it HAS the rung.
    expect(team.temporary).toBeDefined();

    await team.create({
      name: 'deep',
      role: { kind: 'catalog', roleId: 'researcher' },
      mission: 'Work at the cap.',
    });
    // Put the child AT the cap, the way its parent's seed would at depth 4.
    const childPath = join(dirname(dbPath), 'subordinates', 'deep', 'agent.db');
    const childDb = new Database(childPath);
    childDb.run(
      "INSERT INTO agent_config (key, value) VALUES ('subordinate.depth', ?)"
      + ' ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [String(DELEGATION_MAX_DEPTH)],
    );
    childDb.close();
    await host.close();

    const { host: reopened } = makeHost(state, streamingModel('ack'), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);
    const capped = await reopened.team('root/deep');
    expect(capped.delegation.depth).toBe(DELEGATION_MAX_DEPTH);
    expect(delegationExhausted(capped.delegation)).toBe(true);
    // ABSENT, not present-and-refusing: the rung is gone from this actor's
    // schema, sandbox namespace and prompt because the port was never wired.
    expect(capped.temporary).toBeUndefined();
    await reopened.close();
  });


  /**
   * EXACTLY ONE RESULT, AND ONLY ONE.
   *
   * A failing turn fires an `error` event and a `turn-end` event, and both are
   * terminal endings a task child owes a report for — so the relay records that
   * it spoke (`detachRelay`). What is observable from outside is the other half
   * of the same guarantee: once the run has settled, the row is released, and a
   * further report for that child is REFUSED rather than delivered as a second
   * result for one question.
   */
  test('a settled temporary run refuses a second report for the same child', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const { host } = makeHost(state, failingChildModel(), [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);
    const team = await host.team('root');
    const outcome = await team.temporary!.run({
      role: { kind: 'catalog', roleId: 'researcher' },
      roleLabel: 'researcher',
      task: 'Find the root cause.',
      mode: 'build',
    });
    const agent = v.parse(v.object({ agent: v.string(), status: v.string() }), outcome);
    expect(agent.status).toBe('failed');

    // Released, so the child is no longer an addressable member of the roster —
    // which is what makes a second report impossible rather than merely unwanted.
    expect(await team.list()).toEqual([]);
    await expect(team.assign({ name: agent.agent, task: 'again', mode: 'build' }))
      .rejects.toThrow(`subordinate "${agent.agent}" is dismissed`);

    await host.close();
    const view = new Database(dbPath, { readonly: true });
    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;
    view.close();
    // The one result went to the waiting call and never also to the rail.
    expect(reports).toBe(0);
  });

  /**
   * THE WAITER-ABSENT LATE EVENT. A child that answers after its caller is gone
   * must not be lost and must not leave a row behind: with no waiter the report
   * takes the ordinary rail, and the roster releases the row on its way past.
   */
  test('a report with no waiter becomes one correlated event and releases the task row', async () => {
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const CONTENT = 'late but correct';
    const child = reportingChildModel(CONTENT);
    const { host } = makeHost(state, child.model, [
      { name: 'root', cwd: project, workspaceId: 'proj' },
    ]);
    const team = await host.team('root');
    // Hand a child work, then mark its row task-lifetime with no waiter parked,
    // which is exactly the state an evicted asking activation leaves. The
    // durable verbs refuse a task row, so the row flips after the handoff.
    await team.spawn({
      name: 'ask-researcher-late',
      role: { kind: 'catalog', roleId: 'researcher' },
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
    roster.run("UPDATE workspace_subordinates SET lifetime='task' WHERE name='ask-researcher-late'");
    roster.close();
    await reported.promise;
    await host.close();

    const view = new Database(dbPath, { readonly: true });
    const reports = view.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE kind='event' AND variant='subordinate_report'",
    ).get()?.n ?? 0;
    const rows = view.query<{ status: string; lifetime: string }, []>(
      "SELECT status, lifetime FROM workspace_subordinates WHERE name='ask-researcher-late'",
    ).all();
    view.close();
    // ONE event — not zero (it would be lost) and not two (a duplicate report).
    expect(reports).toBe(1);
    // And released by the roster's own report policy, not left listed forever.
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
    // Resolved on the first REPORT — the assignment rides the same
    // `subordinate_event` channel under status 'task' — and then asserted, so a
    // host that published the wrong status fails by naming it rather than by
    // hanging on a status-filtered wait that never arrives.
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
      name: 'researcher', role: { kind: 'catalog', roleId: 'researcher' }, mission: 'Investigate the incident.',
    });
    const assigned = await team.assign({
      name: 'researcher', task: 'Find the root cause and report it.', mode: 'build',
    });
    expect(assigned.delivery).toBe('starts_now');

    // The child's own word — and its body — cross into the parent's rail.
    // `relayToParent` hardcoded 'progress' here, so a child could say
    // `completed` and its parent would still be told it was mid-work.
    expect(await reported.promise).toEqual({ status: 'completed', text: CONTENT });
    // Both turns are over, so the child's turn-end relay has had its chance to
    // fire and the roster below is the settled state rather than a mid-flight one.
    await childTurnEnded.promise;
    await parentTurnEnded.promise;

    // `applyReport` takes 'completed' to idle and clears the task. The automatic
    // turn-end relay passes 'progress', which leaves the row 'working' with its
    // task intact — the state the sibling test above pins, and the only state
    // this backend could reach before the report tool existed here.
    const status = v.parse(TeamStatusSchema, await team.status({ name: 'researcher' }));
    expect(status.roster.status).toBe('idle');
    expect(status.roster.currentTask).toBeNull();

    // ONE report, not two — counted after close(), which joins every relay still
    // in flight; counting before it races the child's own turn-end.
    //
    // TWO guards hold this, and measurably either one alone is enough: a
    // terminal report clears `current_task`, and `parentAdmitsSubordinateReport`
    // refuses a relay to a parent with no outstanding task, because a parent
    // that asked for nothing is not the audience for unsolicited work; the
    // report dep also sets `reportedThisTurn`, which suppresses the turn-end
    // relay within the same turn whatever the status was. Defeating both — a
    // report published as 'progress' that does not record that it spoke — is
    // what produces the duplicate, and a duplicate would push the row this
    // report just cleared straight back to 'working'.
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
      const alpha = await host.peers('alpha');
      const beta = await host.peers('beta');
      expect(alpha).not.toBeNull();
      expect(beta).not.toBeNull();

      // Symmetry IS equality here: each sees exactly the other, so there is no
      // root that owns the workspace and no root that hangs off another.
      expect(await alpha!.deps.listPeers()).toEqual([{ name: 'beta', displayName: 'Beta' }]);
      expect(await beta!.deps.listPeers()).toEqual([{ name: 'alpha', displayName: 'Alpha' }]);

      // And each is a root in its own right: both hold the subordinate surface
      // at depth 0, which is what "equal root" means to the delegation budget.
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
      const alpha = await host.peers('alpha');
      // Two turns on beta: the note it is woken by, and the ask it answers.
      const betaSettled = awaitTurns(host, 'beta', 2);
      const sent = await alpha!.deps.send({
        agent: 'beta', topic: 'note', message: 'starting on the parser', mode: 'build',
      });
      expect(sent).toMatchObject({ status: 'delivered' });
      expect(peerEventCount(betaDb)).toBe(1);

      const asked = await alpha!.deps.ask({
        agent: 'beta', topic: 'research', message: 'what did you find?', mode: 'build',
      });
      expect(asked).toEqual({
        status: 'replied',
        from: 'beta',
        reply: 'the parser is the bottleneck',
      });
      // The answer came out of beta's own turn calling the tool, not from the
      // transport inventing one.
      expect(answering.replies()).toBe(1);
      await betaSettled;
      // Beta's post-turn drain is scheduled rather than awaited by the reply
      // path; run it out so nothing is mid-flight when the host closes.
      await host.tick('beta', Date.now());
      // Both legs are durable rows, and both were delivered rather than retried.
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
      // Same directory, different virtual workspace — the case that proves the
      // boundary is the PAIR and not the folder.
      { name: 'gamma', cwd: project, workspaceId: 'other' },
    ];
    const { host } = makeHost(state, streamingModel('ack'), refs);
    try {
      await (await host.team('alpha')).create({
        name: 'scout', role: { kind: 'catalog', roleId: 'researcher' }, mission: 'Read the parser.',
      });
      await (await host.team('beta')).create({
        name: 'auditor', role: { kind: 'catalog', roleId: 'auditor' }, mission: 'Check the parser.',
      });
      expect(existsSync(join(dirname(alphaDb), 'subordinates', 'scout', 'agent.db'))).toBe(true);
      expect(existsSync(join(dirname(betaDb), 'subordinates', 'auditor', 'agent.db'))).toBe(true);
      expect((await host.team('alpha/scout')).delegation.depth).toBe(1);

      // A subordinate holds no peer transport at all, so there is no action for
      // it to reach a peer with — structural, not a runtime check it could miss.
      expect(await host.peers('alpha/scout')).toBeNull();
      expect(await host.peers('beta/auditor')).toBeNull();

      // A root cannot address the other workspace either: gamma shares the
      // directory and is still not a peer.
      const alpha = await host.peers('alpha');
      expect(await alpha!.deps.listPeers()).toEqual([{ name: 'beta' }]);
      await expect(alpha!.deps.send({
        agent: 'gamma', topic: 'note', message: 'hello', mode: 'build',
      })).rejects.toThrow('unknown peer "gamma" in workspace "proj"');

      // And the receiving side refuses it too, so a message that somehow
      // reached the hop is still not admitted. This is the enforcement half.
      const refused = await alpha!.receive({
        sender_event_id: 'forged-1',
        sender_agent_name: 'gamma',
        // A foreign group, spelled the way the transport puts it on the wire
        // (core's `peerGroupId`: `local:<workspaceId>:<cwd>`). The property is
        // that an id which is not THIS group's is refused, so stating one is
        // the whole arrangement.
        sender_user_id: `local:other:${project}`,
        topic: 'note',
        body: 'let me in',
        mode: 'build',
      });
      expect(refused.admitted).toBe(false);
      expect(peerEventCount(alphaDb)).toBe(0);
    } finally {
      await host.close();
    }
  });

  test('undelivered peer mail survives a restart and is re-driven by the next tick', async () => {
    const { state, project } = makeRoots();
    const alphaDb = await seedAgent(state, 'alpha');
    const refs: HostedAgentRef[] = [
      { name: 'alpha', cwd: project, workspaceId: 'proj' },
      // Placed in the roster, so it is a legitimate peer — but its state does
      // not exist yet, so the hop throws and the row must WAIT rather than die.
      { name: 'beta', cwd: project, workspaceId: 'proj' },
    ];
    const armed: number[] = [];
    const { host: first } = makeHost(state, streamingModel('ack'), refs, { wakeAt: (at) => armed.push(at) });
    const alpha = await first.peers('alpha');
    const queued = await alpha!.deps.send({
      agent: 'beta', topic: 'note', message: 'survive this', mode: 'build',
    });
    expect(queued).toMatchObject({ status: 'queued' });
    // The retry instant reaches the driver, and the tick reports it too, so a
    // sleeping loop cannot sleep past it.
    expect(armed.length).toBeGreaterThan(0);
    const pending = await first.tick('alpha', Date.now());
    expect(pending.ran).toBe(true);
    expect(pending.nextAt).not.toBeNull();
    await first.close();

    // The queue is a row, not memory: it is still there with the process gone.
    expect(pendingOutboxRows(alphaDb)).toEqual([
      expect.objectContaining({ state: 'pending', attempt_count: 1 }),
    ]);

    const betaDb = await seedAgent(state, 'beta');
    const { host: second } = makeHost(state, streamingModel('ack'), refs);
    try {
      // The re-driven delivery wakes beta, whose turn is deliberately not
      // awaited by the sender — so wait for it here rather than tear the host
      // down underneath it.
      const betaWoken = awaitTurns(second, 'beta', 1);
      // Past the 5s first backoff — the same fold the daemon's delay uses.
      await second.tick('alpha', Date.now() + 10_000);
      expect(pendingOutboxRows(alphaDb).map((row) => row.state)).toEqual(['sent']);
      expect(peerEventCount(betaDb)).toBe(1);
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
        name: 'scout', role: { kind: 'catalog', roleId: 'researcher' }, mission: 'Read the parser.',
      });
      // Both peers opened, so both runtimes exist to compare.
      await host.acquire('beta');
      const alphaRt = runtimes.get('alpha')!;
      const betaRt = runtimes.get('beta')!;

      // The bytes: one directory, written by one peer and read by the other,
      // and really on disk where the developer's own tools would see it.
      await alphaRt.storage.vfs.writeFile('shared-note.md', 'peers share this file');
      expect(await betaRt.storage.vfs.readFile('shared-note.md', { encoding: 'utf-8' }))
        .toBe('peers share this file');
      expect(readFileSync(join(project, 'shared-note.md'), 'utf-8')).toBe('peers share this file');
      expect(alphaRt.cwd).toBe(project);
      expect(betaRt.cwd).toBe(project);

      // The subordinate is on it too, and it was told so — the prompt's own
      // runtime context is the only place a turn learns its directory, and
      // this capture holds nothing but that turn.
      seen.length = 0;
      await (await host.acquire('alpha/scout')).send('where am I working?');
      expect(seen.join('\n')).toContain(`Working directory: ${project}`);

      // Nothing private leaked into the shared directory: SOUL, memory and
      // scaffold belong to each agent's own state tree.
      expect(existsSync(join(project, 'SOUL.md'))).toBe(false);
      expect(existsSync(join(project, 'MEMORY.md'))).toBe(false);

      // The state: three separate SQLite files, so a turn on one is invisible
      // in the others' conversations.
      await (await host.acquire('alpha')).send('only alpha said this');
      expect(userMessages(join(state, 'alpha', 'agent.db'))).toContain('only alpha said this');
      expect(userMessages(join(state, 'beta', 'agent.db'))).not.toContain('only alpha said this');
      expect(userMessages(join(state, 'alpha', 'subordinates', 'scout', 'agent.db')))
        .not.toContain('only alpha said this');
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

function userMessages(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ content: string }, []>(
      "SELECT content FROM messages WHERE role = 'user'",
    ).all().map((row) => row.content);
  } finally {
    db.close();
  }
}

/** Schedule a timer on the workspace from ANOTHER handle, as `kinu triggers
 *  <name> at` does from the operator's process. The host's own pass fires it,
 *  which is the one external ingress a local workspace has. */
async function scheduleTimer(dbPath: string, label: string, atMs: number): Promise<void> {
  const db = new Database(dbPath);
  try {
    const registry = new TriggerRegistry(makeSqlExec(db), { scheduleAt: async () => {} });
    await createTimerTrigger(registry, { atMs, label, trust: 'owner' }, Date.now());
  } finally {
    db.close();
  }
}

/**
 * The driver lease as a REAL host uses it, over a real workspace database.
 *
 * The competing driver is a real sleeping OS process whose pid is written into
 * the lease by the lease's own API. That is a genuine cross-process condition:
 * the only fact the lease asks about a holder is whether its pid still exists,
 * and a `sleep` child answers that for real, so the host under test runs
 * against `OS_LEASE_PROCESS` with no substitution of any kind.
 */
describe('LocalAgentHost — the driver lease', () => {
  const rivals: Subprocess[] = [];

  afterEach(async () => {
    await retireRivals();
  });

  /** Stop every rival and WAIT for it to be reaped, so its pid genuinely stops
   *  existing before anything asks. A killed-but-unreaped child still answers
   *  `kill(pid, 0)`, which is the lease's whole liveness question. */
  async function retireRivals(): Promise<void> {
    const going = rivals.splice(0);
    for (const rival of going) rival.kill();
    await Promise.all(going.map((rival) => rival.exited));
  }

  /** Give the lease to another live process, as that process would take it. */
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

  /** Who is driving, by the file rather than by any hold this process keeps. */
  function holderAt(dbPath: string): DriverLeaseHolder | null {
    const db = new Database(dbPath);
    try {
      return leaseHolder(db);
    } finally {
      db.close();
    }
  }

  /** Pending means: an event row nothing has bound to a turn yet — the exact
   *  condition `EventLog.pending()` selects on. Deliberately NOT
   *  `consumed_at IS NULL`: that column is the recovery LEASE, and a turn that
   *  answers a delivery closes its lease while keeping the binding, so reading
   *  it here would count an answered event as pending again. */
  function pendingEventCount(dbPath: string): number {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM agent_log WHERE kind = 'event' AND turn_id IS NULL`,
      ).get()?.n ?? 0;
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
    const flush = LocalAgentSession.prototype.flushPendingDrains;
    let refuseFirst = true;
    LocalAgentSession.prototype.flushPendingDrains = async function flushOnce() {
      if (refuseFirst) {
        refuseFirst = false;
        throw new Error('injected first-open drain failure');
      }
      return flush.call(this);
    };
    try {
      await expect(host.acquire('root')).rejects.toThrow('injected first-open drain failure');
      // The failed entry acquired an interactive hold before recovery. It no
      // longer exists, so nothing owns its conversation.
      expect(holderAt(dbPath)).toBeNull();

      // The same host retries against a fresh Database. Before the fix it
      // reused the memoized hold over the handle the failed open closed and
      // threw `Database has closed` here.
      expect(await host.acquire('root')).toBeInstanceOf(LocalAgentSession);
      expect(holderAt(dbPath)?.kind).toBe('interactive');
    } finally {
      LocalAgentSession.prototype.flushPendingDrains = flush;
      await host.close();
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
      // Nobody owns the conversation between passes. A host that called itself
      // interactive kept the row until the process exited, which is what made
      // the resident daemon un-preemptible for its whole lifetime.
      expect(holderAt(dbPath)).toBeNull();
      // And it takes it again for the next pass rather than believing it still has it.
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

      // The whole point of the result shape: a caller cannot mistake this for a
      // pass that ran and found nothing to do.
      expect(result.ran).toBe(false);
      expect(result.heldBy).toEqual({ pid: rivalPid, kind: 'interactive' });
      // A daemon never takes the conversation from a live person.
      expect(holderAt(dbPath)).toEqual({ pid: rivalPid, kind: 'interactive' });
    } finally {
      await host.close();
    }
  });

  test('opening a workspace reclaims and delivers an event a dead process left bound to a turn it never ran', async () => {
    // KINU-020, end to end: the previous process bound this event's row to a
    // synthetic drain turn, acknowledged the delivery, and died before running
    // it. The row is invisible to `pending()`, so nothing else can ever find it
    // — opening the workspace under the driver lease is what hands it back.
    const { state, project } = makeRoots();
    const dbPath = await seedAgent(state, 'root');
    const refs: HostedAgentRef[] = [{ name: 'root', cwd: project, workspaceId: 'proj' }];
    const before = makeHost(state, streamingModel('handled'), refs, { driverKind: 'daemon' });
    try {
      const fireAt = Date.now() + 60_000;
      await scheduleTimer(dbPath, 'a build finished', fireAt);
      // Fired but not drained: the drain is a debounced timer, and closing the
      // host before it runs is what a process killed in that window leaves.
      const session = await before.host.acquire('root');
      expect((await session.fireDueTriggers(fireAt)).fired).toBe(1);
    } finally {
      await before.host.close();
    }
    // What the dead process left: bound to its turn, lease still open.
    const db = new Database(dbPath);
    try {
      db.query(`UPDATE agent_log SET turn_id = 'evt-dead', step_idx = 0, consumed_at = 5 WHERE kind = 'event'`).run();
    } finally {
      db.close();
    }
    expect(pendingEventCount(dbPath)).toBe(0);

    const after = makeHost(state, streamingModel('handled after recovery'), refs, { driverKind: 'daemon' });
    let turns = 0;
    const unsubscribe = after.host.subscribe((_agent, event) => {
      if (event.type === 'turn-start') turns += 1;
    });
    try {
      // Opening it is the whole recovery: buildEntry reclaims under the lease
      // and drains in the same bracket.
      await after.host.acquire('root');
      expect(turns).toBe(1);
      expect(pendingEventCount(dbPath)).toBe(0);
      expect(userMessages(dbPath).join('\n')).toContain('a build finished');
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
    // The drain BINDS its rows, then announces the signal, then queues the turn.
    // A rival that arrives in that window is the case the queue-item contract
    // exists for: the pass held the lease when it bound the rows and does not
    // hold it when the turn is about to run. The announcement is the seam that
    // makes it exact — no clock, no guessed window.
    let stolenBy: number | null = null;
    const unsubscribe = host.subscribe((_agent, event) => {
      if (event.type === 'turn-start') turns += 1;
      if (event.type !== 'broadcast' || event.event.type !== 'signal_card') return;
      if (stolenBy === null) stolenBy = rivalHolds(dbPath, 'interactive');
    });
    try {
      // Admission is not conversion: the row lands whoever is driving.
      const fireAt = Date.now() + 60_000;
      await scheduleTimer(dbPath, 'a build finished', fireAt);
      expect((await (await host.acquire('root')).fireDueTriggers(fireAt)).fired).toBe(1);
      expect(pendingEventCount(dbPath)).toBe(1);

      await host.tick('root');

      expect(stolenBy).not.toBeNull();
      expect(holderAt(dbPath)).toEqual({ pid: stolenBy ?? -1, kind: 'interactive' });
      // The event is exactly where it was. Bound-and-abandoned is invisible to
      // `pending()`, so this assertion is the one that fails when a refused turn
      // is settled as a queued one: the row stays consumed and nothing ever
      // delivers it.
      expect(pendingEventCount(dbPath)).toBe(1);
      expect(turns).toBe(0);

      // The rival goes away. Nothing expired — the pid simply stopped existing.
      await retireRivals();

      const ran = await host.tick('root');
      expect(ran.ran).toBe(true);
      // Delivered exactly once: one turn, and the row is now bound to it.
      expect(turns).toBe(1);
      expect(pendingEventCount(dbPath)).toBe(0);
    } finally {
      unsubscribe();
      await host.close();
    }
  });
});
