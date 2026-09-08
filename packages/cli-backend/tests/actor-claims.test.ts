// The durable admission contract, against the REAL runner: an actor turn's
// claim, the exact context revision every step consumes, and the refusals that
// keep a stale activation or a neighbouring actor out of a live claim.
//
// Every turn here runs through `ActorSession.execute` with the real store
// bundle, so the claim rows are the ones production writes. The model is
// scripted and the program is a real versioned scaffold source on the runtime's
// own VFS — nothing here asserts against a mock of the thing under test.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { jsonSchema, tool } from 'ai';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import {
  ActorSession, EvolutionEngine, WorkspaceActorDirectory, createAgentStores, profileCatalogDigest,
  resolveTurnProfile, verifyClaimedProgram, readVersionedScaffoldSource, sha256Hex,
  decodeModelMessages, applyStagedContext,
} from '@kinu.run/core';
import type {
  ActorHandle, AgentRuntime, AgentStores, ChatEvent, ProfileAuthorityInputs, StoredActorClaim, WorkMode,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { initEventsHubTables, EventLog } from '../../core/src/events/hub/index';
import { createTestRuntime, makeSqlExec } from '../../core/tests/helpers';
import { createSandboxedExecutor } from '../src/executor';

const catalog = { roles: {}, tiers: { default: { model: 'fake/actor-model' } } };
const profiles: ProfileAuthorityInputs = {
  envelope: { authority: { kind: 'local' }, version: 1, digest: profileCatalogDigest(catalog), catalog },
  provider: { revision: 'claim-fixture', availableModels: ['fake/actor-model'] },
};
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const V1 = 'async function run() { await host.emit({ type: "text_delta", text: "v1 answer" }); }';
const V2 = 'async function run() { await host.emit({ type: "text_delta", text: "v2 answer" }); }';

interface Bound {
  readonly actor: ActorSession;
  readonly runtime: AgentRuntime;
  readonly stores: AgentStores;
  readonly handle: ActorHandle;
}

async function workspace(): Promise<{ bind: (name: string) => Bound; rt: AgentRuntime }> {
  const { rt, db } = createTestRuntime();
  rt.executor = createSandboxedExecutor();
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  await files.mkdir('scaffold', { recursive: true });
  await files.writeFile(rt.identity.scaffold.path + '.v1', V1);
  await files.writeFile(rt.identity.scaffold.path + '.v2', V2);
  const owner = rt.storage.sql<{ owner_user_id: string }>`
    SELECT owner_user_id FROM workspace_identity WHERE id = ${rt.actor.workspaceId}`[0];
  if (owner === undefined) throw new Error('the real runtime fixture must have a workspace owner');
  const directory = new WorkspaceActorDirectory(rt.storage.sql, {
    workspaceId: rt.actor.workspaceId, ownerUserId: owner.owner_user_id,
  });
  const parent = directory.main();
  const eventSql = makeSqlExec(db);
  initEventsHubTables(eventSql);
  const bind = (name: string): Bound => {
    const handle = directory.create({
      parent, name, kind: 'subordinate', lifetime: 'durable', creationId: 'claimed-' + name,
    });
    const runtime: AgentRuntime = { ...rt, actor: handle, identity: { ...rt.identity, id: handle.actorId, name: handle.name } };
    const stores = createAgentStores(() => runtime.storage.sql, () => handle, runtime.storage.transactionSync);
    const actor: ActorSession = new ActorSession({
      runtime, claims: stores.claims, installedBuild: null,
      orchestration: {
        engine: new EvolutionEngine(runtime, { enabled: false }), eventLog: new EventLog(eventSql),
        host: {
          broadcast: () => {},
          enqueueTurn: async () => { throw new Error('this fixture must not enqueue another turn'); },
          turnInFlight: () => actor.inFlight,
          setTimer: () => { throw new Error('this fixture must not schedule background work'); },
        },
      },
    });
    return { actor, runtime, stores, handle };
  };
  return { bind, rt };
}

function answerOnce(text: string): LanguageModel {
  return scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => ({
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [],
  }) });
}

async function runTurn(bound: Bound, opts: {
  readonly turnId: string;
  readonly runId?: string;
  readonly mode?: WorkMode;
  readonly loopVersion: number;
  readonly input: ModelMessage;
  readonly model: LanguageModel;
  readonly tools?: ToolSet;
  readonly onEvent?: (event: ChatEvent) => void;
}) {
  const mode = opts.mode ?? 'build';
  const lease = bound.actor.beginTurn(
    { runId: opts.runId ?? `run-${opts.turnId}`, turnId: opts.turnId }, mode, Date.now(),
  );
  bound.actor.bindProfile(lease, resolveTurnProfile({
    ...profiles, roleId: 'general', workMode: mode, availableTools: [], activeSkills: [],
  }), profiles);
  bound.actor.appendInput(lease, opts.input);
  const result = await bound.actor.execute(lease, {
    task: 'go', loopVersion: opts.loopVersion,
    chat: { model: opts.model, system: 'sys', tools: opts.tools ?? {} },
    extensions: [], dynamic: () => ({}),
  }, (event) => opts.onEvent?.(event));
  // What the host does with a settled turn, in the order it does it: name the
  // claim's outcome from what the run did, then release the lease. A lease
  // released without a named outcome settles `indeterminate` instead, which is
  // what the run-close path exists to avoid.
  bound.actor.settleTurnClaim(lease, result.failure === null ? 'completed' : 'error');
  bound.actor.finishTurn(lease);
  return { lease, result };
}

test('the claim and its admitted context are durable before the first model call', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  let claimAtFirstCall: StoredActorClaim | null = null;
  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => {
    // Read straight out of SQLite from inside the provider call: whatever this
    // sees is what was durable BEFORE the first model effect existed.
    claimAtFirstCall = left.stores.claims.read('turn-a');
    return { content: [{ type: 'text', text: 'answered' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
  } });
  // The BUILTIN loop, deliberately: a promoted program answers from its own
  // source and may never call a model at all, so the builtin arm is the one
  // whose first side effect IS the provider call this probe reads from.
  const { result } = await runTurn(left, {
    turnId: 'turn-a', loopVersion: 0, model,
    input: { role: 'user', content: 'admitted input' },
  });
  expect(result.failure).toBeNull();
  expect(claimAtFirstCall).toMatchObject({
    turnId: 'turn-a', runId: 'run-turn-a', epoch: 1, workMode: 'build', status: 'admitted',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
  });
  // The claim the execution returned is the row that was already durable.
  expect(result.claim).toMatchObject({ turnId: 'turn-a', runId: 'run-turn-a', epoch: 1 });
  // Revision 0 exists in the same transaction as the claim, and it is the
  // context the turn was admitted against — not a placeholder.
  const admitted = left.stores.claims.admittedContext('turn-a');
  expect(admitted?.messages).toEqual([{ role: 'user', content: 'admitted input' }]);
});

test('a source change after admission cannot alter the bytes the turn consumed', async () => {
  const { bind, rt } = await workspace();
  const left = bind('left');
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  let aliasReads = 0;
  rt.identity.scaffold.read = async () => { aliasReads++; return V2; };
  const { result } = await runTurn(left, {
    turnId: 'turn-src', loopVersion: 1, model: answerOnce('unused'),
    input: { role: 'user', content: 'run v1' },
  });
  expect(result.failure).toBeNull();
  expect(result.text).toBe('v1 answer');
  // The version's file is rewritten AFTER the turn consumed it, exactly as a
  // promotion or a revert racing a live turn would.
  await files.writeFile(rt.identity.scaffold.path + '.v1', V2);
  const claim = left.stores.claims.read('turn-src');
  expect(claim?.program.digest).toBe(createHash('sha256').update(V1).digest('hex'));
  if (claim === null) throw new Error('the turn must have left a claim to verify');
  const recovery = await verifyClaimedProgram(
    claim,
    (version) => readVersionedScaffoldSource(left.runtime, version),
    sha256Hex,
    () => left.stores.claims.consumedContext('turn-src'),
  );
  // Recovery REFUSES to read the new bytes as the claimed ones, and says which
  // digest it found rather than resuming on whatever is there now.
  expect(recovery.kind).toBe('source_changed');
  expect(recovery.kind === 'source_changed' && recovery.found)
    .toBe(createHash('sha256').update(V2).digest('hex'));
  expect(aliasReads).toBe(0);
});

test('a cold reader recovers the claimed program identity and the exact context a step consumed', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const attachment = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await runTurn(left, {
    turnId: 'turn-cold', loopVersion: 0, model: answerOnce('cold answer'),
    input: { role: 'user', content: [
      { type: 'text', text: 'read this file' },
      { type: 'file', data: attachment, mediaType: 'image/png' },
    ] },
  });
  // A SECOND store bundle over the same database, bound to the same issued
  // actor: this is what an activation that did not run the turn can see.
  const cold = createAgentStores(
    () => left.runtime.storage.sql, () => left.handle, left.runtime.storage.transactionSync,
  );
  const claim = cold.claims.read('turn-cold');
  expect(claim).toMatchObject({ turnId: 'turn-cold', epoch: 1, status: 'settled', outcome: 'completed' });
  // A BUILTIN turn carries no source digest and — on this host — no build
  // identity. Neither is invented: the descriptor that names the arm is not
  // hashed into something that reads like retained code.
  expect(claim?.program).toEqual({ kind: 'builtin', version: 0, digest: null, build: null });
  if (claim === null) throw new Error('the turn must have left a claim to verify');
  const recovery = await verifyClaimedProgram(
    claim,
    (version) => readVersionedScaffoldSource(left.runtime, version),
    sha256Hex,
    () => cold.claims.consumedContext('turn-cold'),
  );
  expect(recovery.kind).toBe('build_unknown');
  const consumed = cold.claims.consumedContext('turn-cold');
  expect(consumed?.stepIndex).toBe(0);
  // The step's own input, byte-for-byte, with its typed attachment intact —
  // not display prose, and not a JSON round trip of the bytes.
  const first = consumed?.messages[0];
  expect(first?.role).toBe('user');
  const parts = Array.isArray(first?.content) ? first?.content : [];
  const file = parts.find((part) => part.type === 'file');
  expect(file).toMatchObject({ type: 'file', mediaType: 'image/png' });
  const data = file && 'data' in file ? file.data : undefined;
  if (!(data instanceof Uint8Array)) throw new Error('the stored attachment must decode to its own bytes');
  expect([...data]).toEqual([...attachment]);
});

test('a rich tool exchange survives the revision round trip as native messages', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  let step = 0;
  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => {
    const first = step++ === 0;
    return { content: first
      ? [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'probe', input: '{"path":"a.png"}' }]
      : [{ type: 'text', text: 'done' }],
    finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
  } });
  const tools = { probe: tool({
    inputSchema: jsonSchema<{ path: string }>({ type: 'object', properties: { path: { type: 'string' } } }),
    execute: async () => ({ bytes: 6, sample: 'AQIDBAUG' }),
  }) };
  await runTurn(left, {
    turnId: 'turn-tools', loopVersion: 0, model, tools,
    input: { role: 'user', content: 'probe it' },
  });
  // The SECOND step's revision is the one that carries the assistant tool call
  // and its result: the pairing a provider rejects if either half is lost.
  const second = left.stores.claims.consumedContext('turn-tools', 2);
  expect(second?.stepIndex).toBe(1);
  const roles = (second?.messages ?? []).map((message) => message.role);
  expect(roles).toContain('assistant');
  expect(roles).toContain('tool');
  const toolMessage = second?.messages.find((message) => message.role === 'tool');
  const resultPart = Array.isArray(toolMessage?.content) ? toolMessage?.content[0] : undefined;
  expect(resultPart).toMatchObject({ type: 'tool-result', toolCallId: 'call-1', toolName: 'probe' });
});

test('a stale execution epoch cannot write to the claim a newer one owns', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const claims = left.stores.claims;
  const stale = claims.admit({
    runId: 'run-old', turnId: 'turn-fence', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: [{ role: 'user', content: 'first activation' }],
  });
  expect(stale.epoch).toBe(1);
  // The activation that replaces it re-admits the SAME turn and takes the next
  // epoch — the case the single-row handoff could not represent.
  const live = claims.admit({
    runId: 'run-new', turnId: 'turn-fence', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: [{ role: 'user', content: 'second activation' }],
  });
  expect(live.epoch).toBe(2);
  expect(() => claims.consume(stale, { index: 0, messages: [{ role: 'user', content: 'stale step' }] }))
    .toThrow(KinuError);
  expect(() => claims.settle(stale, 'completed')).toThrow(KinuError);
  // The live claim is untouched by the refusals.
  claims.consume(live, { index: 0, messages: [{ role: 'user', content: 'live step' }] });
  expect(claims.read('turn-fence')).toMatchObject({ epoch: 2, runId: 'run-new', consumedRevision: 1 });
  // A settled claim takes no further work either.
  claims.settle(live, 'completed');
  expect(() => claims.consume(live, { index: 1, messages: [{ role: 'user', content: 'after settle' }] }))
    .toThrow(KinuError);
});

test('one actor cannot write another actor\'s claim, and their revisions never mix', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const right = bind('right');
  const leftClaim = left.stores.claims.admit({
    runId: 'run-l', turnId: 'shared-turn-id', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: [{ role: 'user', content: 'left context' }],
  });
  const rightClaim = right.stores.claims.admit({
    runId: 'run-r', turnId: 'shared-turn-id', workMode: 'plan',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: [{ role: 'user', content: 'right context' }],
  });
  // The same turn id on two issued actors is two claims, each at epoch 1.
  expect(leftClaim.epoch).toBe(1);
  expect(rightClaim.epoch).toBe(1);
  expect(() => right.stores.claims.consume(leftClaim, {
    index: 0, messages: [{ role: 'user', content: 'cross-actor step' }],
  })).toThrow(KinuError);
  expect(left.stores.claims.admittedContext('shared-turn-id')?.messages)
    .toEqual([{ role: 'user', content: 'left context' }]);
  expect(right.stores.claims.admittedContext('shared-turn-id')?.messages)
    .toEqual([{ role: 'user', content: 'right context' }]);
  expect(right.stores.claims.read('shared-turn-id')?.workMode).toBe('plan');
});

test('a staged context edit is compare-and-set and lands only at a safe step boundary', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const claims = left.stores.claims;
  const base: ModelMessage[] = [{ role: 'user', content: 'original question' }];
  const claim = claims.admit({
    runId: 'run-stage', turnId: 'turn-stage', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: base,
  });
  claims.consume(claim, { index: 0, messages: base });
  const edited: ModelMessage[] = [{ role: 'user', content: 'edited question' }];
  expect(claims.stage(claim, { base: 1, messages: edited })).toBe(2);
  // A second edit written against the revision the first one superseded is
  // refused rather than silently replacing it.
  expect(() => claims.stage(claim, { base: 1, messages: edited })).toThrow(KinuError);
  const staged = claims.stagedContext(claim);
  expect(staged).toMatchObject({ revision: 2, baseRevision: 1, stepIndex: null });
  // MID-EXCHANGE: the live tail holds a tool call whose result has not arrived,
  // so this is not a boundary and the edit stays staged.
  const midExchange: ModelMessage[] = [...base, {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'probe', input: {} }],
  }];
  expect(applyStagedContext(midExchange, { messages: edited, baseMessageCount: 1 })).toBeNull();
  // SETTLED: the pair is complete, so the edit replaces the history and the
  // protected tail — the issued call, its result, and the steer that landed —
  // rides after it untouched.
  const settledTail: ModelMessage[] = [...midExchange, {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'json', value: { ok: true } } }],
  }, { role: 'user', content: 'steer that landed mid-turn' }];
  const landed = applyStagedContext(settledTail, { messages: edited, baseMessageCount: 1 });
  expect(landed?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
  expect(landed?.[0]).toEqual({ role: 'user', content: 'edited question' });
  expect(landed?.at(-1)).toEqual({ role: 'user', content: 'steer that landed mid-turn' });
  expect(landed).not.toBeNull();
  // Consuming the staged revision records the REQUEST, not the proposal.
  if (landed === null) throw new Error('a settled tail must be a safe boundary for a staged edit');
  const consumed = claims.consumeStaged(claim, 2, { index: 1, messages: landed });
  expect(consumed.revision).toBe(2);
  expect(claims.consumedContext('turn-stage', 2)?.messageCount).toBe(4);
  expect(claims.stagedContext(claim)).toBeNull();
});

test('a mid-turn hydration stages a revision instead of rewriting a running turn', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  let stagedRevision: number | null = null;
  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => {
    // A host edit arriving while the turn is admitted and running.
    stagedRevision = left.actor.restoreHistory([{ role: 'user', content: 'replaced by the host' }]);
    return { content: [{ type: 'text', text: 'answered' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
  } });
  await runTurn(left, {
    turnId: 'turn-hydrate', loopVersion: 0, model,
    input: { role: 'user', content: 'original' },
  });
  expect(stagedRevision).toBeGreaterThan(0);
  // The step that was already issued kept the context it was issued with.
  const first = left.stores.claims.consumedContext('turn-hydrate', 1);
  expect(first?.messages).toEqual([{ role: 'user', content: 'original' }]);
  // Outside a turn the same call hydrates rather than staging.
  expect(left.actor.restoreHistory([{ role: 'user', content: 'cold hydration' }])).toBeNull();
  expect(left.actor.history).toEqual([{ role: 'user', content: 'cold hydration' }]);
});

test('the stored revision decodes through the codec the recorder validates with', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const claims = left.stores.claims;
  const claim = claims.admit({
    runId: 'run-codec', turnId: 'turn-codec', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: [{ role: 'user', content: [
      { type: 'text', text: 'binary and a url' },
      { type: 'file', data: new Uint8Array([0, 1, 254, 255]), mediaType: 'application/octet-stream' },
      { type: 'file', data: new URL('https://example.invalid/a.pdf'), mediaType: 'application/pdf' },
    ] }],
  });
  const row = left.runtime.storage.sql<{ messages: string; digest: string }>`
    SELECT messages, digest FROM actor_context_revisions
    WHERE actor_id = ${left.handle.actorId} AND turn_id = ${claim.turnId} AND revision = 0`[0];
  if (row === undefined) throw new Error('the admitting transaction must write revision 0');
  // The stored payload is not a JSON dump of the byte array: the object index
  // shape `{"0":0,"1":1}` is exactly the lossy round trip this codec avoids.
  expect(row.messages).not.toContain('"0":0');
  const decoded = decodeModelMessages(row.messages);
  const parts = Array.isArray(decoded[0]?.content) ? decoded[0].content : [];
  const bytes = parts.find((part) => part.type === 'file' && part.mediaType === 'application/octet-stream');
  const url = parts.find((part) => part.type === 'file' && part.mediaType === 'application/pdf');
  const decodedBytes = bytes && 'data' in bytes ? bytes.data : undefined;
  if (!(decodedBytes instanceof Uint8Array)) throw new Error('the binary part must decode to bytes');
  expect([...decodedBytes]).toEqual([0, 1, 254, 255]);
  expect(url && 'data' in url ? String(url.data) : null).toBe('https://example.invalid/a.pdf');
});
