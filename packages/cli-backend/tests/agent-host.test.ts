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
  initWorkspaceSchema,
  peerGroupId,
  type HostedAgentRef,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { createWorkspace } from '@kinu.run/core/identity';
import {
  LocalAgentHost,
  type LocalAgentHostOptions,
} from '../src/agent-host';
import { makeSql, makeWorkspaceSchemaSql, type CLIRuntime } from '../src/runtime';
import { openWorkspaceCLI } from '../src/open';
import type { SessionEvent } from '../src/local-session';
import { TestLanguageModelV2 } from './test-language-model';

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

function makeHost(
  state: string,
  model: LanguageModel,
  refs: readonly HostedAgentRef[],
  wakeAt?: (at: number) => void,
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
      return { rt, openConfig, staticModel: model };
    },
  };
  return {
    host: new LocalAgentHost(wakeAt ? { ...options, wakeAt } : options),
    runtimes,
  };
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

    await host.publishEvent('root', {
      descriptor: {
        ingress: 'chat_ws',
        variant: 'chat',
        payload: { text: 'continue while the client is gone' },
        operator_user_id: 'owner-1',
        session_id: 'default',
      },
    });
    await host.tick('root');

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
      role: 'researcher',
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
      .rejects.toThrow('dismissed');

    await team.create({
      name: 'temporary',
      role: 'auditor',
      mission: 'Inspect one isolated case.',
    });
    const temporaryPath = join(dirname(dbPath), 'subordinates', 'temporary', 'agent.db');
    expect(existsSync(temporaryPath)).toBe(true);
    await team.dismiss({ name: 'temporary', requestedBy: 'user', keepHistory: false });
    expect(existsSync(dirname(temporaryPath))).toBe(false);
    await host.close();
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
        name: 'scout', role: 'researcher', mission: 'Read the parser.',
      });
      await (await host.team('beta')).create({
        name: 'auditor', role: 'auditor', mission: 'Check the parser.',
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
        sender_user_id: peerGroupId({ cwd: project, workspaceId: 'other' }),
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
    const { host: first } = makeHost(state, streamingModel('ack'), refs, (at) => armed.push(at));
    const alpha = await first.peers('alpha');
    const queued = await alpha!.deps.send({
      agent: 'beta', topic: 'note', message: 'survive this', mode: 'build',
    });
    expect(queued).toMatchObject({ status: 'queued' });
    // The retry instant reaches the driver, and the tick reports it too, so a
    // sleeping loop cannot sleep past it.
    expect(armed.length).toBeGreaterThan(0);
    const pendingNext = await first.tick('alpha', Date.now());
    expect(pendingNext).not.toBeNull();
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
        name: 'scout', role: 'researcher', mission: 'Read the parser.',
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
