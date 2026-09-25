// Admission contract against the real runner: claim, per-step context revision, and stale/foreign refusals.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { jsonSchema, tool } from 'ai';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import * as v from 'valibot';
import { scriptedTurnModel, unobservedSpend } from '@kinu.run/test-utils';
import {
  ActorSession, EvolutionEngine, WorkspaceActorDirectory, createAgentStores, profileCatalogDigest,
  resolveTurnProfile, verifyClaimedProgram, readVersionedScaffoldSource, sha256Hex,
  contextMount, withMountTable, createFileDispatcher, TurnContextBudget,
} from '@kinu.run/core';
import type {
  ActorHandle, AgentRuntime, AgentStores, ChatEvent, FileToolInput, ProfileAuthorityInputs,
  StoredActorClaim, WorkMode,
} from '@kinu.run/core';
import { KinuError } from '@kinu.run/core/obs';
import { TurnFileLedger } from '../../core/src/vfs/file-ledger';
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
    const stores = createAgentStores(() => runtime.storage.sql, () => handle, runtime.storage.transactionSync, async () => ({ vfs: runtime.storage.vfs, artifactDirectory: '/actors/' + handle.actorId }));

    const actor: ActorSession = new ActorSession({ history: stores.history, runtime, claims: stores.claims, installedBuild: null,
    orchestration: {
      engine: new EvolutionEngine(runtime, stores.history, { reportModelCall: unobservedSpend, enabled: false }), eventLog: new EventLog(eventSql, handle),
      host: {
        broadcast: () => {},
        enqueueTurn: async () => { throw new Error('this fixture must not enqueue another turn'); },
        turnInFlight: () => actor.inFlight,
        setTimer: () => { throw new Error('this fixture must not schedule background work'); },
      },
    }, });

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
    ...profiles, roleId: 'task', workMode: mode, availableTools: Object.keys(opts.tools ?? {}), activeSkills: [],
  }), profiles);
  await bound.actor.openTurnInput(lease, { item: {}, message: opts.input, birthContext: async () => [] });

  const result = await bound.actor.execute(lease, {
    task: 'go', loopVersion: opts.loopVersion,
    chat: { model: opts.model, system: 'sys', tools: opts.tools ?? {} },
    extensions: [], dynamic: () => ({}),
  }, (event) => opts.onEvent?.(event));

  // Settle order: name the claim outcome, then release; a bare release settles `indeterminate`.
  bound.actor.settleTurnClaim(lease, result.failure === null ? 'completed' : 'error');
  bound.actor.finishTurn(lease);

  return { lease, result };
}

async function selectedInput(bound: Bound, messages: readonly ModelMessage[]) {
  return (await bound.stores.history.replaceHistory(messages, {
    author: bound.handle.actorId, via: 'session', turnId: null, stage: false,
    assertOwner: () => bound.handle.assertCurrent(),
  })).selection;
}

test('the claim and its admitted context are durable before the first model call', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  let claimAtFirstCall: StoredActorClaim | null = null;

  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => {
    // Read from SQLite inside the provider call: what was durable before the first model effect.
    claimAtFirstCall = left.stores.claims.read('turn-a');

    return { content: [{ type: 'text', text: 'answered' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
  } });

  // Builtin loop: a promoted program may never call a model, so only this arm's first effect is the provider call.
  const { result } = await runTurn(left, {
    turnId: 'turn-a', loopVersion: 0, model,
    input: { role: 'user', content: 'admitted input' },
  });

  expect(result.failure).toBeNull();
  expect(claimAtFirstCall).toMatchObject({
    turnId: 'turn-a', runId: 'run-turn-a', epoch: 1, workMode: 'build', status: 'admitted',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
  });
  expect(result.claim).toMatchObject({ turnId: 'turn-a', runId: 'run-turn-a', epoch: 1 });
  const admitted = await left.stores.claims.admittedContext('turn-a');
  expect(admitted?.messages).toEqual([{ role: 'user', content: 'admitted input' }]);
});

test('a source change after admission cannot alter the bytes the turn consumed', async () => {
  const { bind, rt } = await workspace();
  const left = bind('left');
  const files = rt.agentStateVfs ?? rt.storage.vfs;
  let aliasReads = 0;
  rt.identity.scaffold.read = async () => {
    aliasReads++;

    return V2;
  };

  const { result } = await runTurn(left, {
    turnId: 'turn-src', loopVersion: 1, model: answerOnce('unused'),
    input: { role: 'user', content: 'run v1' },
  });

  expect(result.failure).toBeNull();
  expect(result.text).toBe('v1 answer');
  await files.writeFile(rt.identity.scaffold.path + '.v1', V2);
  const claim = left.stores.claims.read('turn-src');
  expect(claim?.program.digest).toBe(createHash('sha256').update(V1).digest('hex'));

  if (claim === null) throw new Error('the turn must have left a claim to verify');

  const recovery = await verifyClaimedProgram(
    claim,
    (version) => readVersionedScaffoldSource(left.runtime, version),
    sha256Hex,
    await left.stores.claims.consumedContext('turn-src'),
  );

  // Recovery refuses rewritten bytes and reports the digest it found.
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

  const cold = createAgentStores(() => left.runtime.storage.sql, () => left.handle, left.runtime.storage.transactionSync, async () => ({ vfs: left.runtime.storage.vfs, artifactDirectory: '/actors/' + left.handle.actorId }));

  const claim = cold.claims.read('turn-cold');
  expect(claim).toMatchObject({ turnId: 'turn-cold', epoch: 1, status: 'settled', outcome: 'completed' });
  expect(claim?.program).toEqual({ kind: 'builtin', version: 0, digest: null, build: null });

  if (claim === null) throw new Error('the turn must have left a claim to verify');

  const recovery = await verifyClaimedProgram(
    claim,
    (version) => readVersionedScaffoldSource(left.runtime, version),
    sha256Hex,
    await cold.claims.consumedContext('turn-cold'),
  );

  expect(recovery.kind).toBe('build_unknown');
  const consumed = await cold.claims.consumedContext('turn-cold');
  expect(consumed?.stepIndex).toBe(0);
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
  // Second step's revision carries the tool call and result; a provider rejects a lost half.
  const second = await left.stores.claims.consumedContext('turn-tools', 1);
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

  const stale = await claims.admit({
    runId: 'run-old', turnId: 'turn-fence', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: await selectedInput(left, [{ role: 'user', content: 'first activation' }]),
  });

  expect(stale.epoch).toBe(1);

  const live = await claims.admit({
    runId: 'run-new', turnId: 'turn-fence', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: await selectedInput(left, [{ role: 'user', content: 'second activation' }]),
  });

  expect(live.epoch).toBe(2);
  await expect(claims.consume(stale, { index: 0, messages: [{ role: 'user', content: 'stale step' }] })).rejects.toThrow(KinuError);
  expect(() => claims.settle(stale, 'completed')).toThrow(KinuError);
  await claims.consume(live, { index: 0, messages: [{ role: 'user', content: 'live step' }] });
  expect(claims.read('turn-fence')).toMatchObject({ epoch: 2, runId: 'run-new', consumedRevision: 1 });
  claims.settle(live, 'completed');
  await expect(claims.consume(live, { index: 1, messages: [{ role: 'user', content: 'after settle' }] })).rejects.toThrow(KinuError);
});

test('one actor cannot write another actor\'s claim, and their revisions never mix', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const right = bind('right');

  const leftClaim = await left.stores.claims.admit({
    runId: 'run-l', turnId: 'shared-turn-id', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: await selectedInput(left, [{ role: 'user', content: 'left context' }]),
  });

  const rightClaim = await right.stores.claims.admit({
    runId: 'run-r', turnId: 'shared-turn-id', workMode: 'plan',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: await selectedInput(right, [{ role: 'user', content: 'right context' }]),
  });

  expect(leftClaim.epoch).toBe(1);
  expect(rightClaim.epoch).toBe(1);
  await expect(right.stores.claims.consume(leftClaim, {
    index: 0, messages: [{ role: 'user', content: 'cross-actor step' }],
  })).rejects.toThrow(KinuError);
  expect((await left.stores.claims.admittedContext('shared-turn-id'))?.messages)
    .toEqual([{ role: 'user', content: 'left context' }]);
  expect((await right.stores.claims.admittedContext('shared-turn-id'))?.messages)
    .toEqual([{ role: 'user', content: 'right context' }]);
  expect(right.stores.claims.read('shared-turn-id')?.workMode).toBe('plan');
});

test('a context edit written through the native file tool reaches the NEXT model request', async () => {
  const { bind } = await workspace();
  const left = bind('left');

  const vfs = withMountTable(left.runtime.storage.vfs, [contextMount({
    stores: () => ({ actorId: left.handle.actorId, claims: left.stores.claims, events: null }),
  })]);

  const file = createFileDispatcher({
    vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget(),
  });

  const requests: string[] = [];
  let step = 0;
  const edits: string[] = [];
  const fileErrors: string[] = [];

  // Three steps: the read-before-write gate requires read, edit, answer.
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
    execute: async (args: FileToolInput) => {
      let output: Awaited<ReturnType<typeof file>>;

      try {
        output = await file(args);
      } catch (cause) {
        fileErrors.push(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }

      if (args.action === 'edit') edits.push(JSON.stringify(output));

      return output;
    },
  }) };

  await runTurn(left, {
    turnId: 'turn-edit', loopVersion: 0, model, tools,
    input: { role: 'user', content: 'reason from the WRONG premise' },
  });

  expect(fileErrors).toEqual([]);
  expect(edits).toHaveLength(1);
  expect(JSON.parse(edits[0] ?? 'null')).toMatchObject({ ok: true });

  expect(requests[0]).toContain('the WRONG premise');
  expect(requests[1]).toContain('the WRONG premise');
  const third = v.parse(v.array(v.object({ role: v.string() })), JSON.parse(requests[2] ?? '[]'));
  expect(third.map((row) => row.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);

  // Asserted on the user message: the read's tool result legitimately quotes pre-edit bytes.
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

  const settled = await left.stores.history.materialize();
  expect(settled.messages[0]).toEqual({ role: 'user', content: 'reason from the RIGHT premise' });
  expect(JSON.stringify((await left.stores.claims.consumedContext('turn-edit', 0))?.messages))
    .toContain('the WRONG premise');
  expect(left.actor.history[0]).toEqual({ role: 'user', content: 'reason from the RIGHT premise' });
});

test('a versioned context edit refuses a replaced target and preserves its historical bytes', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  await selectedInput(left, [{ role: 'user', content: 'original premise' }]);

  const files = withMountTable(left.runtime.storage.vfs, [contextMount({
    stores: () => ({ claims: left.stores.claims, events: null }),
  })]);

  const file = createFileDispatcher({ vfs: files, ledger: new TurnFileLedger(), budget: new TurnContextBudget() });
  const path = '/context/working.jsonl';
  await file({ action: 'read', path });
  const revision = (await files.stat(path))?.revision;

  if (revision === undefined || files.readFileAtRevision === undefined) throw new Error('context must expose immutable revisions');
  const original = await files.readFileAtRevision(path, revision);

  await selectedInput(left, [{ role: 'user', content: 'peer replacement' }]);

  expect(await files.readFileAtRevision(path, revision)).toBe(original);
  await expect(file({ action: 'edit', path, edits: [{ old_text: 'original premise', new_text: 'lost update' }] }))
    .rejects.toMatchObject({ verdict: 'stale' });
  expect((await left.stores.history.materialize()).messages).toEqual([{ role: 'user', content: 'peer replacement' }]);
});

test('pending context edits can be read and revised but cannot overwrite another pending edit', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  await selectedInput(left, [{ role: 'user', content: 'original premise' }]);

  const files = withMountTable(left.runtime.storage.vfs, [contextMount({
    stores: () => ({ claims: left.stores.claims, events: null }),
  })]);

  const first = createFileDispatcher({ vfs: files, ledger: new TurnFileLedger(), budget: new TurnContextBudget() });
  const second = createFileDispatcher({ vfs: files, ledger: new TurnFileLedger(), budget: new TurnContextBudget() });
  const path = '/context/working.jsonl';
  await first({ action: 'read', path });
  await second({ action: 'read', path });
  await first({ action: 'edit', path, edits: [{ old_text: 'original premise', new_text: 'first proposal' }] });
  await expect(second({ action: 'edit', path, edits: [{ old_text: 'original premise', new_text: 'stale proposal' }] }))
    .rejects.toMatchObject({ verdict: 'stale' });
  await first({ action: 'read', path });
  await first({ action: 'edit', path, edits: [{ old_text: 'first proposal', new_text: 'revised proposal' }] });
  const next = await left.stores.history.stepBase(() => left.handle.assertCurrent());
  expect(next.messages).toEqual([{ role: 'user', content: 'revised proposal' }]);
});

test('historical context reads preserve byte ranges and cannot cross actor boundaries', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const right = bind('right');
  await selectedInput(left, [{ role: 'user', content: 'café boundary' }]);

  const files = withMountTable(left.runtime.storage.vfs, [contextMount({
    stores: () => ({ claims: left.stores.claims, events: null }),
    children: { list: () => ['right'], resolve: name => name === 'right' ? { claims: right.stores.claims, events: null } : null },
  })]);

  const path = '/context/working.jsonl';
  const revision = (await files.stat(path))?.revision;

  if (revision === undefined || files.readFileAtRevision === undefined) throw new Error('context must expose immutable revisions');
  const original = v.parse(v.string(), await files.readFileAtRevision(path, revision));
  const bytes = new TextEncoder().encode(original);
  expect(await files.readFileAtRevision(path, revision, { offset: bytes.length - 12, length: 9 })).toEqual(bytes.slice(-12, -3));
  await expect(files.readFileAtRevision('/context/agents/right/working.jsonl', revision)).rejects.toMatchObject({ code: 'denied' });
});

test('a mid-turn host edit stages a revision instead of rewriting a running turn', async () => {
  const { bind } = await workspace();
  const left = bind('left');

  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: async () => {
    await left.actor.restoreHistory([{ role: 'user', content: 'replaced by the host' }]);

    return { content: [{ type: 'text', text: 'answered' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
  } });

  await runTurn(left, {
    turnId: 'turn-hydrate', loopVersion: 0, model,
    input: { role: 'user', content: 'original' },
  });
  const first = await left.stores.claims.consumedContext('turn-hydrate', 0);
  expect(first?.messages).toEqual([{ role: 'user', content: 'original' }]);

  await runTurn(left, {
    turnId: 'turn-after', loopVersion: 0, model: answerOnce('second answer'),
    input: { role: 'user', content: 'follow-up' },
  });
  const admitted = (await left.stores.claims.consumedContext('turn-after', 0))?.messages ?? [];
  expect(admitted[0]).toEqual({ role: 'user', content: 'replaced by the host' });
  expect(admitted.filter((message) => message.content === 'follow-up')).toHaveLength(1);

  await left.actor.restoreHistory([{ role: 'user', content: 'cold hydration' }]);
  expect(left.actor.history).toEqual([{ role: 'user', content: 'cold hydration' }]);
});

test('claim recovery preserves native binary and URL attachment carriers', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const claims = left.stores.claims;

  const claim = await claims.admit({
    runId: 'run-codec', turnId: 'turn-codec', workMode: 'build',
    program: { kind: 'builtin', version: 0, digest: null, build: null },
    context: await selectedInput(left, [{ role: 'user', content: [
      { type: 'text', text: 'binary and a url' },
      { type: 'file', data: new Uint8Array([0, 1, 254, 255]), mediaType: 'application/octet-stream' },
      { type: 'file', data: new URL('https://example.invalid/a.pdf'), mediaType: 'application/pdf' },
    ] }]),
  });

  const admitted = await claims.admittedContext(claim.turnId);
  const decoded = admitted?.messages ?? [];
  const parts = Array.isArray(decoded[0]?.content) ? decoded[0].content : [];
  const bytes = parts.find((part) => part.type === 'file' && part.mediaType === 'application/octet-stream');
  const url = parts.find((part) => part.type === 'file' && part.mediaType === 'application/pdf');
  const decodedBytes = bytes && 'data' in bytes ? bytes.data : undefined;
  const decodedUrl = url && 'data' in url ? url.data : undefined;

  if (!(decodedBytes instanceof Uint8Array)) throw new Error('the binary part must decode to bytes');
  expect([...decodedBytes]).toEqual([0, 1, 254, 255]);

  if (!(decodedUrl instanceof URL)) throw new Error('the url part must decode to a URL');
  expect(decodedUrl.href).toBe('https://example.invalid/a.pdf');
});

test('a consumer failure preserves text already emitted by the actor', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  const cause = new Error('consumer rejected partial output');

  const { result } = await runTurn(left, {
    turnId: 'partial-output', loopVersion: 0, model: answerOnce('partial answer'),
    input: { role: 'user', content: 'answer' },
    onEvent: event => {

      if (event.type === 'text-delta') throw cause;
    },
  });

  expect(result.text).toBe('partial answer');
  expect(result.failure).toBe(cause);
  expect(left.stores.claims.read('partial-output')).toMatchObject({ status: 'settled', outcome: 'error' });
});

test('a consumer failure after the turn finished does not replay a landed steer', async () => {
  const { bind } = await workspace();
  const left = bind('left');
  let step = 0;

  const model = scriptedTurnModel({ provider: 'fake', modelId: 'actor-model', doGenerate: () => {
    const first = step++ === 0;

    if (first) left.actor.send({ id: 'land-once', text: 'keep this instruction' }).catch(() => { throw new Error('the steer was refused'); });

    return { content: first
      ? [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'file', input: '{"path":"a"}' }]
      : [{ type: 'text', text: 'complete answer' }],
    finishReason: { unified: first ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
  } });

  const tools = { file: tool({
    inputSchema: jsonSchema<{ path: string }>({ type: 'object', properties: { path: { type: 'string' } } }),
    execute: async () => 'read',
  }) };

  const thrown = new Error('consumer rejected the completion frame');

  const { result } = await runTurn(left, {
    turnId: 'emit-after-done', loopVersion: 0, model, tools,
    input: { role: 'user', content: 'go' },
    // Done frame emits after completion: a throwing consumer must not undo the landed steer.
    onEvent: event => {

      if (event.type === 'done') throw thrown;
    },
  });

  expect(result.text).toBe('complete answer');
  expect(result.failure).toBe(thrown);
  expect(left.actor.landedSteers.filter((row) => row.id === 'land-once')).toHaveLength(1);
  expect(left.actor.history.filter((m) => m.role === 'user'
    && JSON.stringify(m).includes('keep this instruction'))).toHaveLength(1);
  expect(left.stores.claims.read('emit-after-done')).toMatchObject({ status: 'settled', outcome: 'error' });
});
