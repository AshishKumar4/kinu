import { expect, test } from 'bun:test';
import { jsonSchema, tool } from 'ai';
import type { ModelMessage, ToolSet } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import {
  ActorSession, EvolutionEngine, WorkspaceActorDirectory, profileCatalogDigest,
  resolveTurnProfile, requireBuild, createAgentStores,
} from '@kinu.run/core';
import type { AgentRuntime, BroadcastEvent, ChatEvent, ProfileAuthorityInputs, WorkMode } from '@kinu.run/core';
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
    // The REAL store bundle, so a turn's claim is written through the same
    // memoized ledger production uses rather than a fixture beside it.
    const stores = createAgentStores(() => runtime.storage.sql, () => handle, runtime.storage.transactionSync);
    const actor: ActorSession = new ActorSession({ runtime, claims: stores.claims, installedBuild: null, orchestration: {
      engine: new EvolutionEngine(runtime, { enabled: false }), eventLog: new EventLog(eventSql),
      host: {
        broadcast: event => { broadcasts.push(event); },
        enqueueTurn: async () => { throw new Error('this bounded actor fixture must not enqueue another turn'); },
        turnInFlight: () => actor.inFlight,
        setTimer: () => { throw new Error('this bounded actor fixture must not schedule background work'); },
      },
    } });
    return { actor, broadcasts, claims: stores.claims, handle };
  };
  return { left: create('left'), right: create('right'), db };
}

function bind(actor: ActorSession, turnId: string, mode: WorkMode, message: ModelMessage, tools: ToolSet = {}) {
  const lease = actor.beginTurn({ runId: `run-${turnId}`, turnId }, mode, Date.now());
  actor.bindProfile(lease, resolveTurnProfile({ ...profiles, roleId: 'general', workMode: mode,
    availableTools: Object.keys(tools), activeSkills: [] }), profiles);
  actor.appendInput(lease, message);
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
  const leftLease = bind(left.actor, 'left-turn', 'build', leftInput, tools);
  const rightLease = bind(right.actor, 'right-turn', 'plan', { role: 'user', content: 'right private input' });
  const events: ChatEvent[] = [];
  const leftRun = left.actor.execute(leftLease, { task: 'left', loopVersion: 0,
    chat: { model: leftModel, system: 'sys', tools }, extensions: [], dynamic: () => ({ memoryTail: 'left dynamic context' }),
  }, event => { events.push(event); });
  const rightRun = right.actor.execute(rightLease, { task: 'right', loopVersion: 0,
    chat: { model: rightModel, system: 'sys', tools: {} }, extensions: [], dynamic: () => ({ memoryTail: 'right dynamic context' }),
  }, event => { events.push(event); });
  try {
    await Promise.all([leftStarted.promise, rightStarted.promise]);
    expect(right.actor.steer({ id: 'right-steer', text: 'right-only steer' })).toBe(true);
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
    expect(right.actor.takeLeftoverSteers()).toEqual([{ id: 'right-steer', text: 'right-only steer' }]);
    expect(left.actor.takeLeftoverSteers()).toEqual([]);
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
  const { left: { actor }, db } = sessions();
  const old = actor.beginTurn({ runId: 'run-old', turnId: 'old-turn' }, 'plan', Date.now());
  actor.finishTurn(old);
  const current = actor.beginTurn({ runId: 'run-new', turnId: 'new-turn' }, 'build', Date.now());
  const profile = resolveTurnProfile({ ...profiles, roleId: 'general', workMode: 'build', availableTools: [], activeSkills: [] });
  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => ({
    content: [{ type: 'text', text: 'new answer' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [],
  }) });
  const input = { task: 'new', loopVersion: 0, chat: { model, system: 'sys', tools: {} }, extensions: [], dynamic: () => ({}) };
  const events: ChatEvent[] = [];
  try {
    expect(() => actor.bindProfile(old, profile, profiles)).toThrow(KinuError);
    expect(() => actor.appendInput(old, { role: 'user', content: 'stale private input' })).toThrow(KinuError);
    await expect(actor.execute(old, input, event => { events.push(event); })).rejects.toMatchObject({ code: 'denied' });
    actor.bindProfile(current, profile, profiles);
    actor.appendInput(current, { role: 'user', content: 'new input' });
    expect(await actor.execute(current, input, event => { events.push(event); })).toMatchObject({ text: 'new answer', failure: null });
    expect(actor.inFlight).toBe(false);
    expect(actor.steer({ id: 'after-last-step', text: 'late steer' })).toBe(false);
    expect(actor.takeLeftoverSteers()).toEqual([]);
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
  const first = bind(left.actor, 'cancelled-turn', 'build', { role: 'user', content: 'hold this tool' }, tools);
  const second = bind(right.actor, 'sibling-turn', 'build', { role: 'user', content: 'finish your work' });
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
