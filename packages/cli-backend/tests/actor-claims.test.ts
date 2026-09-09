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
import * as v from 'valibot';
import { scriptedTurnModel } from '@kinu.run/test-utils';
import {
  ActorSession, EvolutionEngine, WorkspaceActorDirectory, createAgentStores, profileCatalogDigest,
  resolveTurnProfile, verifyClaimedProgram, readVersionedScaffoldSource, sha256Hex,
  decodeModelMessages, contextMount, withMountTable, createFileDispatcher, TurnContextBudget,
} from '@kinu.run/core';
import type {
  ActorHandle, AgentRuntime, AgentStores, ChatEvent, FileToolInput, ProfileAuthorityInputs,
  StoredActorClaim, WorkMode,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { TurnFileLedger } from '../../core/src/tools/file-ledger';
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
        engine: new EvolutionEngine(runtime, { enabled: false }), eventLog: new EventLog(eventSql, handle),
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
    context: [{ role: 'user', content: 'first activation' }], workingRevision: 0,
  });
  expect(stale.epoch).toBe(1);
  // The activation that replaces it re-admits the SAME turn and takes the next
  // epoch — the case the single-row handoff could not represent.
  const live = claims.admit({
    runId: 'run-new', turnId: 'turn-fence', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: [{ role: 'user', content: 'second activation' }], workingRevision: 0,
  });
  expect(live.epoch).toBe(2);
  expect(() => claims.consume(stale, { index: 0, messages: [{ role: 'user', content: 'stale step' }], workingRevision: 0 }))
    .toThrow(KinuError);
  expect(() => claims.settle(stale, 'completed')).toThrow(KinuError);
  // The live claim is untouched by the refusals.
  claims.consume(live, { index: 0, messages: [{ role: 'user', content: 'live step' }], workingRevision: 0 });
  expect(claims.read('turn-fence')).toMatchObject({ epoch: 2, runId: 'run-new', consumedRevision: 1 });
  // A settled claim takes no further work either.
  claims.settle(live, 'completed');
  expect(() => claims.consume(live, { index: 1, messages: [{ role: 'user', content: 'after settle' }], workingRevision: 0 }))
    .toThrow(KinuError);
});

test('one actor cannot write another actor\'s claim, and their revisions never mix', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const right = bind('right');
  const leftClaim = left.stores.claims.admit({
    runId: 'run-l', turnId: 'shared-turn-id', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: [{ role: 'user', content: 'left context' }], workingRevision: 0,
  });
  const rightClaim = right.stores.claims.admit({
    runId: 'run-r', turnId: 'shared-turn-id', workMode: 'plan',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: [{ role: 'user', content: 'right context' }], workingRevision: 0,
  });
  // The same turn id on two issued actors is two claims, each at epoch 1.
  expect(leftClaim.epoch).toBe(1);
  expect(rightClaim.epoch).toBe(1);
  expect(() => right.stores.claims.consume(leftClaim, {
    index: 0, messages: [{ role: 'user', content: 'cross-actor step' }], workingRevision: 0,
  })).toThrow(KinuError);
  expect(left.stores.claims.admittedContext('shared-turn-id')?.messages)
    .toEqual([{ role: 'user', content: 'left context' }]);
  expect(right.stores.claims.admittedContext('shared-turn-id')?.messages)
    .toEqual([{ role: 'user', content: 'right context' }]);
  expect(right.stores.claims.read('shared-turn-id')?.workMode).toBe('plan');
});

test('a context edit written through the native file tool reaches the NEXT model request', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  // The actor's own file plane, with /context composed exactly as a backend
  // composes it: the edit below goes through the same dispatcher, ledger and
  // store a model's `file` call goes through.
  const vfs = withMountTable(left.runtime.storage.vfs, [contextMount({
    stores: () => ({ actorId: left.handle.actorId, claims: left.stores.claims, events: null }),
  })]);
  const file = createFileDispatcher({
    vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget(),
  });
  // The provider's OWN prompt, as JSON: this is the wire-facing message list,
  // not our `ModelMessage` shape, and reading it back through a schema keeps
  // that distinction honest instead of asserting one is the other.
  const requests: string[] = [];
  let step = 0;
  // THREE steps, because that is what the product actually requires of a model
  // editing a file: read it, then edit against what the read returned, then
  // answer. The read-before-write gate is real on this plane.
  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: (options) => {
    requests.push(JSON.stringify(options.prompt));
    const at = step++;
    const call = at === 0
      ? { action: 'read', path: '/context/working.jsonl' }
      : { action: 'edit', path: '/context/working.jsonl',
          edits: [{ old_text: 'the WRONG premise', new_text: 'the RIGHT premise' }] };
    return { content: at < 2
      ? [{ type: 'tool-call', toolCallId: `file-${String(at)}`, toolName: 'file', input: JSON.stringify(call) }]
      : [{ type: 'text', text: 'done' }],
    finishReason: { unified: at < 2 ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
  } });
  const tools = { file: tool({
    inputSchema: jsonSchema<FileToolInput>({
      type: 'object',
      properties: {
        action: { type: 'string' },
        path: { type: 'string' },
        edits: { type: 'array', items: { type: 'object' } },
      },
      required: ['action', 'path'],
    }),
    execute: async (args: FileToolInput) => file(args),
  }) };

  await runTurn(left, {
    turnId: 'turn-edit', loopVersion: 0, model, tools,
    input: { role: 'user', content: 'reason from the WRONG premise' },
  });

  // The first two requests ran on the original premise: an in-flight request
  // keeps the versions it started with, and the edit was not even authored
  // until the second one's tool call executed.
  expect(requests[0]).toContain('the WRONG premise');
  expect(requests[1]).toContain('the WRONG premise');
  // THE THIRD request — what the provider actually received after the edit —
  // is built from the edited history, and still carries both tool exchanges
  // that happened in between.
  const third = v.parse(v.array(v.object({ role: v.string() })), JSON.parse(requests[2] ?? '[]'));
  expect(third.map((row) => row.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
  // The premise the model is now reasoning from. Asserted on the USER message
  // rather than the whole prompt, because the tool result of the read
  // legitimately quotes the pre-edit bytes — that is what the model read.
  const PromptText = v.array(v.object({
    role: v.string(),
    content: v.union([v.string(), v.array(v.object({ text: v.optional(v.string()) }))]),
  }));
  const parsed = v.parse(PromptText, JSON.parse(requests[2] ?? '[]'));
  const userMessage = parsed.find((row) => row.role === 'user');
  const flat = v.safeParse(v.string(), userMessage?.content);
  const premise = flat.success
    ? flat.output
    : v.parse(v.array(v.object({ text: v.optional(v.string()) })), userMessage?.content ?? [])
      .map((part) => part.text ?? '').join('');
  expect(premise).toBe('reason from the RIGHT premise');

  // The durable record agrees. The edit is its own revision, authored through
  // the file surface by this actor and activated at the step that took it; the
  // rendered request of that step points at it; and the working history the
  // finished turn left behind carries the edited message.
  const edit = left.stores.claims.working.history().find((row) => row.source === 'edit');
  expect(edit).toMatchObject({
    via: 'file', author: left.handle.actorId, activatedStep: 2, activatedTurnId: 'turn-edit',
  });
  expect(left.stores.claims.consumedContext('turn-edit')?.workingRevision).toBe(edit?.revision);
  const settled = left.stores.claims.working.active();
  expect(settled?.messages[0]).toEqual({ role: 'user', content: 'reason from the RIGHT premise' });
  // And the FIRST step's evidence is untouched — an edit does not rewrite what
  // a past request was.
  expect(JSON.stringify(left.stores.claims.consumedContext('turn-edit', 1)?.messages))
    .toContain('the WRONG premise');
  // The next turn starts from the edited history, not from the pre-edit array.
  expect(left.actor.history[0]).toEqual({ role: 'user', content: 'reason from the RIGHT premise' });
});

test('a mid-turn host edit stages a revision instead of rewriting a running turn', async () => {
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
  // The turn boundary IS a safe boundary, so the edit landed there rather than
  // waiting: the tail (the assistant's answer) was complete, and the working
  // history the next turn builds on is the edited one.
  expect(left.stores.claims.working.staged()).toBeNull();
  expect(left.stores.claims.working.revision(stagedRevision ?? 0))
    .toMatchObject({ via: 'session', activatedStep: null, activatedTurnId: 'turn-hydrate' });

  // The NEXT turn is the next safe boundary: it admits the edited history with
  // the newly delivered input preserved after it exactly once.
  await runTurn(left, {
    turnId: 'turn-after', loopVersion: 0, model: answerOnce('second answer'),
    input: { role: 'user', content: 'follow-up' },
  });
  const admitted = left.stores.claims.admittedContext('turn-after')?.messages ?? [];
  expect(admitted[0]).toEqual({ role: 'user', content: 'replaced by the host' });
  expect(admitted.filter((message) => message.content === 'follow-up')).toHaveLength(1);
  expect(left.stores.claims.working.active()).toMatchObject({ source: 'turn' });

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
    ] }], workingRevision: 0,
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
