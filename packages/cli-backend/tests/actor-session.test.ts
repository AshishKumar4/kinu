import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import type { ModelMessage, ToolSet } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import {
  ActorSession, EvolutionEngine, WorkspaceActorDirectory, profileCatalogDigest,
  resolveTurnProfile, requireBuild, createAgentStores,
} from '@kinu.run/core';
import type {
  AgentRuntime, BroadcastEvent, ChatEvent, ProfileAuthorityInputs, ProgrammaticTurn, WorkMode,
} from '@kinu.run/core';
import { initEventsHubTables, EventLog } from '../../core/src/events/hub/index';
import { createTestRuntime, makeSqlExec } from '../../core/tests/helpers';
import { KinuError } from '@kinu.run/core/obs';

const catalog = { roles: {}, tiers: { default: { model: 'fake/actor-model' } } };

const profiles: ProfileAuthorityInputs = {
  envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
  provider: { revision: 'actor-fixture', availableModels: ['fake/actor-model'] },
};

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function sessions() {
  const { rt, db } = createTestRuntime();
  const owner = rt.storage.sql<{ owner_user_id: string }>`SELECT owner_user_id FROM workspace_identity WHERE id = ${rt.actor.workspaceId}`[0];

  if (owner === undefined) throw new Error('the real runtime fixture must have a workspace owner');

  const directory = new WorkspaceActorDirectory(rt.storage.sql, {
    workspaceId: rt.actor.workspaceId, ownerUserId: owner.owner_user_id,
  });

  const parent = directory.main();
  const eventSql = makeSqlExec(db);
  initEventsHubTables(eventSql);

  const create = (name: string) => {
    const handle = directory.create({ parent, name, kind: 'subordinate', lifetime: 'durable', creationId: 'admitted-' + name });
    const runtime: AgentRuntime = { ...rt, actor: handle, identity: { ...rt.identity, id: handle.actorId, name: handle.name } };
    const broadcasts: BroadcastEvent[] = [];
    const enqueued: ProgrammaticTurn[] = [];
    // The REAL store bundle, so a turn's claim is written through the same
    // memoized ledger production uses rather than a fixture beside it.
    const stores = createAgentStores(() => runtime.storage.sql, () => handle, runtime.storage.transactionSync, async () => ({ vfs: runtime.storage.vfs, artifactDirectory: '/actors/' + handle.actorId }));

    const actor: ActorSession = new ActorSession({ history: stores.history, runtime, claims: stores.claims, installedBuild: null, orchestration: {
      engine: new EvolutionEngine(runtime, stores.history, { enabled: false }), eventLog: new EventLog(eventSql, handle),
      host: {
        broadcast: event => { broadcasts.push(event); },
    
        // Captured rather than thrown: what the seam hands a steer back as —
        // the user-origin rerun turn — is the assertion.
        enqueueTurn: async (turn) => {
          enqueued.push(turn);
    
          return { status: 'queued' as const };
        },
        turnInFlight: () => actor.inFlight,
        setTimer: () => { throw new Error('this bounded actor fixture must not schedule background work'); },
      },
    } });

    return { actor, broadcasts, claims: stores.claims, handle, enqueued };
  };

  return { left: create('left'), right: create('right'), db };
}

async function bind(actor: ActorSession, turnId: string, mode: WorkMode, message: ModelMessage, tools: ToolSet = {}) {
  const lease = actor.beginTurn({ runId: `run-${turnId}`, turnId }, mode, Date.now());
  actor.bindProfile(lease, resolveTurnProfile({ ...profiles, roleId: 'task', workMode: mode,
    availableTools: Object.keys(tools), activeSkills: [] }), profiles);
  await actor.openTurnInput(lease, { item: {}, message, birthContext: async () => [] });

  return lease;
}

test('logical actors in one store keep live context, mode and structured tool data separate', async () => {
  const { left, right, db } = sessions();
  const release = Promise.withResolvers<void>();
  const rightStarted = Promise.withResolvers<void>();
  const leftStarted = Promise.withResolvers<void>();
  const releaseLeft = Promise.withResolvers<void>();
  let step = 0;
  const data = { error: 'ordinary successful data', owner: 'left' };

  const leftModel = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => {
    const first = step++ === 0;

    return { content: first
      ? [{ type: 'tool-call', toolCallId: 'left-data', toolName: 'data', input: '{}' }]
      : [{ type: 'text', text: 'left finished' }],
    finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
  } });

  const rightModel = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: async () => {
    rightStarted.resolve();
    await release.promise;

    return { content: [{ type: 'text', text: 'right finished' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
  } });

  const tools = { data: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: async () => {
      leftStarted.resolve();
      requireBuild('actor fixture write');
      await releaseLeft.promise;

      return data;
    },
  }) };

  const leftInput: ModelMessage = { role: 'user', content: [
    { type: 'text', text: 'left private input' },
    { type: 'file', data: new Uint8Array([1, 2, 3]), mediaType: 'application/pdf' },
  ] };

  const leftLease = await bind(left.actor, 'left-turn', 'build', leftInput, tools);
  const rightLease = await bind(right.actor, 'right-turn', 'plan', { role: 'user', content: 'right private input' });
  const events: ChatEvent[] = [];

  const leftRun = left.actor.execute(leftLease, { task: 'left', loopVersion: 0,
    chat: { model: leftModel, system: 'sys', tools }, extensions: [], dynamic: () => ({ memoryTail: 'left dynamic context' }),
  }, event => { events.push(event); });

  const rightRun = right.actor.execute(rightLease, { task: 'right', loopVersion: 0,
    chat: { model: rightModel, system: 'sys', tools: {} }, extensions: [], dynamic: () => ({ memoryTail: 'right dynamic context' }),
  }, event => { events.push(event); });

  try {
    await Promise.all([leftStarted.promise, rightStarted.promise]);
    expect(await right.actor.send({ id: 'right-steer', text: 'right-only steer' })).toBe('mid-turn');
    releaseLeft.resolve();
    expect(await leftRun).toMatchObject({ text: 'left finished', failure: null, interrupted: false });
    expect(right.actor.inFlight).toBe(true);
    release.resolve();
    expect(await rightRun).toMatchObject({ text: 'right finished', failure: null, interrupted: false });
    expect(left.actor.history[0]).toEqual(leftInput);
    const toolMessages = left.actor.history.flatMap(message => message.role === 'tool' ? message.content : []);
    expect(toolMessages).toContainEqual(expect.objectContaining({ type: 'tool-result', toolCallId: 'left-data',
      output: { type: 'json', value: data } }));
    const leftRequests = JSON.stringify(leftModel.doStreamCalls);
    const rightRequests = JSON.stringify(rightModel.doStreamCalls);
    expect(leftRequests).not.toContain('right private input');
    expect(leftRequests).not.toContain('right dynamic context');
    expect(leftRequests).not.toContain('right-only steer');
    expect(rightRequests).not.toContain('left private input');
    expect(rightRequests).not.toContain('left dynamic context');
    // The steer that never saw a step boundary reruns as a user-origin turn —
    // what the seam hands the host when the turn settles, observed here the
    // way the session's own pump would.
    right.actor.orchestrator.inbox.settle({ completed: true });
    await Promise.resolve();
    expect(right.enqueued).toEqual([expect.objectContaining({
      origin: 'user', text: 'right-only steer', steerIds: ['right-steer'],
    })]);
    expect(left.enqueued).toEqual([]);
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ success: true });
    expect(left.actor.workMode).toBe('build');
    expect(right.actor.workMode).toBe('plan');
  } finally {
    release.resolve();
    releaseLeft.resolve();
    await Promise.allSettled([leftRun, rightRun]);
    left.actor.finishTurn(leftLease);
    right.actor.finishTurn(rightLease);
    db.close();
  }
});

test('a released lease cannot mutate or execute a newer turn of the same actor', async () => {
  const { left: { actor, enqueued }, db } = sessions();
  const old = actor.beginTurn({ runId: 'run-old', turnId: 'old-turn' }, 'plan', Date.now());
  actor.finishTurn(old);
  const current = actor.beginTurn({ runId: 'run-new', turnId: 'new-turn' }, 'build', Date.now());
  const profile = resolveTurnProfile({ ...profiles, roleId: 'task', workMode: 'build', availableTools: [], activeSkills: [] });

  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => ({
    content: [{ type: 'text', text: 'new answer' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [],
  }) });

  const input = { task: 'new', loopVersion: 0, chat: { model, system: 'sys', tools: {} }, extensions: [], dynamic: () => ({}) };
  const events: ChatEvent[] = [];

  try {
    expect(() => actor.bindProfile(old, profile, profiles)).toThrow(KinuError);
    await expect(actor.openTurnInput(old, { item: {}, message: { role: 'user', content: 'stale private input' }, birthContext: async () => [] })).rejects.toThrow(KinuError);
    await expect(actor.execute(old, input, event => { events.push(event); })).rejects.toMatchObject({ code: 'denied' });
    actor.bindProfile(current, profile, profiles);
    await actor.openTurnInput(current, { item: {}, message: { role: 'user', content: 'new input' }, birthContext: async () => [] });
    expect(await actor.execute(current, input, event => { events.push(event); })).toMatchObject({ text: 'new answer', failure: null });
    expect(actor.inFlight).toBe(false);
    // A refused steer — no turn in flight — is never queued into the seam, so
    // settling reruns nothing.
    actor.orchestrator.inbox.settle({ completed: true });
    await Promise.resolve();
    expect(enqueued).toEqual([]);
    expect(JSON.stringify(model.doStreamCalls)).not.toContain('stale private input');
    expect(model.doStreamCalls).toHaveLength(1);
  } finally {
    actor.finishTurn(current);
    db.close();
  }
});

test.each(['dispatch', 'published'])('interrupting one actor at %s preserves its tool history and lets its sibling finish', async boundary => {
  const { left, right, db } = sessions();
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<string>();
  const callSeen = Promise.withResolvers<void>();
  const releaseRight = Promise.withResolvers<void>();

  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: options => ({
    content: options.prompt.some(message => message.role === 'tool')
      ? [{ type: 'text', text: 'after tool' }]
      : [{ type: 'tool-call', toolCallId: 'held-call', toolName: 'hold', input: '{}' }],
    finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
  }) });

  const otherModel = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: async () => {
    await releaseRight.promise;

    return { content: [{ type: 'text', text: 'sibling completed' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
  } });

  const tools = { hold: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: (_args, { abortSignal }) => {
      if (abortSignal === undefined) throw new Error('actor tool was not cancellable');
      abortSignal.addEventListener('abort', () => held.reject(abortSignal.reason), { once: true });
      started.resolve();

      return held.promise;
    },
  }) };

  const first = await bind(left.actor, 'cancelled-turn', 'build', { role: 'user', content: 'hold this tool' }, tools);
  const second = await bind(right.actor, 'sibling-turn', 'build', { role: 'user', content: 'finish your work' });
  const events: ChatEvent[] = [];

  const running = left.actor.execute(first, { task: 'hold', loopVersion: 0, chat: { model, system: 'sys', tools }, extensions: [], dynamic: () => ({}) }, event => {
    events.push(event);

    if (event.type === 'tool-call') callSeen.resolve();
  });

  const sibling = right.actor.execute(second, { task: 'finish', loopVersion: 0, chat: { model: otherModel, system: 'sys', tools: {} }, extensions: [], dynamic: () => ({}) }, event => { events.push(event); });

  try {
    await started.promise;

    if (boundary === 'published') await callSeen.promise;
    expect(() => left.actor.beginTurn({ runId: 'run-overlap', turnId: 'overlap' }, 'build', Date.now())).toThrow(KinuError);
    expect(() => left.actor.finishTurn(first)).toThrow(KinuError);
    left.actor.interrupt();
    releaseRight.resolve();
    expect(await running).toMatchObject({ interrupted: true });
    expect(await sibling).toMatchObject({ text: 'sibling completed', interrupted: false, failure: null });
    const toolMessages = left.actor.history.flatMap(message => message.role === 'tool' ? message.content : []);
    expect(toolMessages).toContainEqual(expect.objectContaining({ type: 'tool-result', toolCallId: 'held-call' }));
    expect(right.actor.history.flatMap(message => message.role === 'tool' ? message.content : [])).toEqual([]);
  } finally {
    held.resolve('released');
    releaseRight.resolve();
    await Promise.allSettled([running, sibling]);
    left.actor.finishTurn(first);
    right.actor.finishTurn(second);
    db.close();
  }
});

test('bound steer persistence reserves on accept and lands rows at the drain', async () => {
  // The seam's two halves, observed in order: a send reaching a busy actor
  // calls onAccept BEFORE its 'queued' broadcast (the row precedes the
  // acknowledgement), and the step boundary calls onDrain with the described
  // rows — the two moments a durable backend keys its reservation table on.
  const { left: { actor }, db } = sessions();
  const accepted: string[] = [];
  const drained: string[][] = [];
  actor.bindSteerPersistence({
    onAccept: (steer) => { accepted.push(steer.id); },
    prepareDrain: async rows => () => { drained.push(rows.map(row => row.id)); },
  });

  // Gating the tool's execution holds the turn open past the tool call's own
  // step boundary: the send lands while the step is in flight, and the drain
  // (the onDrain call) is what the second model request's prompt proves.
  const toolGate = Promise.withResolvers<void>();
  const firstCall = Promise.withResolvers<void>();
  const secondCall = Promise.withResolvers<void>();
  const prompts: ModelMessage[][] = [];

  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: async (options) => {
    prompts.push(options.prompt);
    (prompts.length === 1 ? firstCall : secondCall).resolve();
    const first = !options.prompt.some((message) => message.role === 'tool');

    if (first) return {
      content: [{ type: 'tool-call', toolCallId: 'hold', toolName: 'hold', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
    };

    return { content: [{ type: 'text', text: 'done' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
  } });

  const tools = { hold: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
    execute: async () => {
      await toolGate.promise;

      return 'held';
    } }) };

  const lease = await bind(actor, 'steer-turn', 'build', { role: 'user', content: 'hold on' }, tools);

  const run = actor.execute(lease, {
    task: 'hold', loopVersion: 0,
    chat: { model, system: 'sys', tools }, extensions: [], dynamic: () => ({}),
  }, () => {});

  try {
    // The tool call is issued; the tool is held. The send buffers now.
    await firstCall.promise;
    const sent = actor.send({ id: 'steer-1', text: 'reserved before acknowledged' });
    expect(accepted).toEqual(['steer-1']);
    expect(await sent).toBe('mid-turn');
    expect(drained).toEqual([]);

    // Releasing the tool crosses the step boundary: the drain writes its rows
    // and the next model request already carries the landed message.
    toolGate.resolve();
    await secondCall.promise;
    expect(drained).toEqual([['steer-1']]);

    const texts = prompts[1]!
      .filter((m): m is Extract<ModelMessage, { role: 'user' }> => m.role === 'user')
      .flatMap((m) => (Array.isArray(m.content)
        ? m.content.filter((p) => p.type === 'text').map((p) => p.text)
        : [m.content]));

    expect(texts.some((t) => t.includes('reserved before acknowledged'))).toBe(true);

    expect(await run).toMatchObject({ text: 'done', failure: null });
    expect(actor.landedSteers.map((row) => row.id)).toEqual(['steer-1']);
  } finally {
    toolGate.resolve();
    await Promise.allSettled([run]);
    actor.finishTurn(lease);
    db.close();
  }
});
