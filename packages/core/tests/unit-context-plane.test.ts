/** `/context` through the real composite plane, stores, and `file` dispatcher; assertions are on observed bytes and rows. */

import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { createTestSql, createTestActors, testActorHandle, createMemoryVfs } from '@kinu.run/test-utils';
import { ActorClaimStore, initActorClaimTables, type ActorTurnClaim } from '../src/orchestrator/actor-claims';
import { SessionHistory } from '../src/session/history';
import type { ContextSelection } from '../src/session/context';
import type { PendingContextProposal } from '../src/session/proposals';
import { contextMount } from '../src/vfs/context-plane';
import { withMountTable } from '../src/vfs/mounts';
import { makeVfsError } from '../src/vfs/errno';
import { decodeModelMessageValues, encodeModelMessageValues } from '../src/session/message-codec';
import { composePrepareStep, type StepContextPlane } from '../src/prompting/prepare-step';
import type { StepPruneBudget } from '../src/prompting/step-prune';
import { DynamicContextLedger } from '../src/prompting/volatile-context';
import { createFileDispatcher } from '../src/tools/file-tool';
import { TurnFileLedger } from '../src/tools/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import type { ActorContextStores, ChildContextResolver, ContextFileHeader } from '../src/vfs/context-plane';
import type { ContextEditEvent } from '../src/types/context-plane';
import type { SqlExecutor, SqlValue, VFS } from '../src/types/primitives';
import type { ActorHandle } from '../src/identity/actor-handle';
import { JsonValueSchema, type JsonValue } from '../src/utils/json';

const PROGRAM = { kind: 'builtin' as const, version: 0, digest: null, build: null };

interface Bound {
  readonly handle: ActorHandle;
  readonly claims: ActorClaimStore;
  readonly history: SessionHistory;
  readonly stores: ActorContextStores;
}

/** Empty base tree, so anything under /context came from the mount. */
function emptyTree(): VFS {
  const files = new Map<string, string>();

  return {
    async readFile(path, opts) {
      const text = files.get(path);

      if (text === undefined) throw makeVfsError('ENOENT', 'no such file', path);

      return opts?.encoding === undefined ? new TextEncoder().encode(text) : text;
    },
    async writeFile(path, data) {
      const asText = v.safeParse(v.string(), data);
      files.set(path, asText.success ? asText.output : new TextDecoder().decode(v.parse(v.instance(Uint8Array), data)));
    },
    async readdir() { return [...files.keys()]; },
    async stat(path) {
      const text = files.get(path);

      return text === undefined ? null : { size: text.length, mtimeMs: 1, isDir: false };
    },
    async unlink(path) { files.delete(path); },
    async mkdir() { /* the workspace tree accepts directories */ },
    async exists(path) { return files.has(path); },
  };
}

interface Workspace {
  readonly bind: (actorId: string) => Bound;
  readonly files: VFS;
  /** Every row of every table. */
  readonly rows: () => number;
  /** SQL statements the stores ran so far. */
  readonly statements: () => number;
  readonly close: () => void;
}

function workspace(): Workspace {
  const testSql = createTestSql();
  const { execRaw } = testSql;
  let statements = 0;

  const sql: SqlExecutor = <T,>(query: TemplateStringsArray, ...values: SqlValue[]): T[] => {
    statements += 1;

    return testSql.sql<T>(query, ...values);
  };

  const actors = createTestActors(sql, execRaw);
  initActorClaimTables(execRaw);
  const transactionSync = <T>(write: () => T): T => write();
  const { vfs } = createMemoryVfs();

  return {
    bind: (actorId) => {
      const handle = actorId === actors.main.actorId ? actors.main : actors.sibling(actorId);

      const history = new SessionHistory({ sql, actor: handle, transactionSync,
        files: async () => ({ vfs, artifactDirectory: `/actors/${actorId}/.kinu/context` }) });

      const claims = new ActorClaimStore(sql, handle, transactionSync, history);

      // `events: null`: emission has its own test.
      return { handle, claims, history, stores: { claims, events: null } };
    },
    files: vfs,
    rows: () => testSql.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all()
      .reduce((sum, { name }) => sum + (testSql.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${name}"`).get()?.n ?? 0), 0),
    statements: () => statements,
    close: () => { testSql.close(); },
  };
}

function planeFor(bound: Bound, children?: ChildContextResolver): VFS {
  return withMountTable(emptyTree(), [contextMount({ stores: () => bound.stores, children })]);
}

/** Settled history committed straight through the session store. */
async function hydrate(bound: Bound, messages: readonly ModelMessage[]): Promise<void> {
  await bound.history.replaceHistory(messages, {
    author: bound.handle.actorId, via: 'session', turnId: null, stage: false,
    assertOwner: () => { bound.handle.assertCurrent(); },
  });
}

async function committed(bound: Bound): Promise<readonly ModelMessage[]> {
  return (await bound.history.materialize()).messages;
}

function selectionOf(bound: Bound): ContextSelection {
  return bound.history.context.selected() ?? bound.history.context.initialize();
}

function staged(bound: Bound): PendingContextProposal | null {
  const selection = bound.history.context.selected();

  return selection === null ? null : bound.history.proposals.pending(selection.contextId).at(-1) ?? null;
}

async function stagedMessages(bound: Bound): Promise<readonly ModelMessage[]> {
  const pending = staged(bound);

  if (pending === null) throw new Error('no context edit is staged');
  const messages: ModelMessage[] = [];

  for (const entry of bound.history.proposals.preview(pending.proposal_id)) {
    messages.push(await bound.history.messages.materialize(entry));
  }

  return messages;
}

function revisions(bound: Bound) {
  const selection = bound.history.context.selected();

  return selection === null ? [] : bound.history.context.revisions(selection.contextId);
}

async function admitOn(bound: Bound, ids: { readonly runId: string; readonly turnId: string }): Promise<ActorTurnClaim> {
  return bound.claims.admit({ ...ids, workMode: 'build', program: PROGRAM, context: selectionOf(bound) });
}

/** Wired as `ActorSession` wires it: staged edits land in `base()`, requests recorded in `consume()`. */
function stepsOf(bound: Bound, claim: ActorTurnClaim): StepContextPlane {
  return {
    base: () => bound.history.stepBase(
      () => { bound.history.assertEpoch(claim.turnId, claim.epoch); }, claim.turnId, bound.stores.events,
    ),
    consume: async ({ stepNumber, messages }) => { await bound.claims.consume(claim, { index: stepNumber, messages }); },
  };
}

function fileTool(vfs: VFS): (input: {
  action: 'read' | 'write' | 'edit' | 'list' | 'stat';
  path: string;
  content?: string;
  edits?: Array<{ old_text: string; new_text: string }>;
}) => Promise<JsonValue> {
  return createFileDispatcher({ vfs, ledger: new TurnFileLedger(), budget: new TurnContextBudget() });
}

async function readText(vfs: VFS, path: string): Promise<string> {
  const raw = await vfs.readFile(path, { encoding: 'utf8' });
  const text = v.safeParse(v.string(), raw);

  return text.success ? text.output : new TextDecoder().decode(v.parse(v.instance(Uint8Array), raw));
}

type ServedHeader = Pick<ContextFileHeader, 'actor' | 'revision' | 'effectiveAt' | 'status' | 'proposalId'>;

const ServedLine = v.object({
  $context: v.object({
    actor: v.string(),
    revision: v.number(),
    effectiveAt: v.picklist(['step', 'turn']),
    status: v.picklist(['active', 'staged', 'empty']),
    proposalId: v.nullable(v.string()),
  }),
});

function servedHeader(text: string): ServedHeader {
  return v.parse(ServedLine, JSON.parse(text.split('\n', 1)[0] ?? '')).$context;
}

function servedMessages(text: string): ModelMessage[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const entries = lines.slice(1).map((line) => v.parse(v.object({ message: JsonValueSchema }), JSON.parse(line)).message);

  return decodeModelMessageValues(entries);
}

function appended(text: string, extra: readonly ModelMessage[]): string {
  const encoded = encodeModelMessageValues(extra);
  const head = text.endsWith('\n') ? text : `${text}\n`;

  return head + encoded.map((message) => `${JSON.stringify({ new: true, message })}\n`).join('');
}

test('a fresh actor serves an empty working history at revision 0, and an edit of it is staged, not in effect', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-fresh');
  const vfs = planeFor(actor);

  // Before any turn: the path exists and names a revision.
  const before = await readText(vfs, '/context/working.jsonl');
  expect(servedHeader(before)).toMatchObject({ actor: actor.handle.actorId, revision: 0, status: 'empty', proposalId: null });
  expect(servedMessages(before)).toEqual([]);

  const edited: ModelMessage[] = [{ role: 'user', content: 'seeded before the first turn' }];
  await vfs.writeFile('/context/working.jsonl', appended(before, edited));

  const after = await readText(vfs, '/context/working.jsonl');
  expect(servedMessages(after)).toEqual(edited);
  expect(servedHeader(after)).toMatchObject({ status: 'staged', revision: 0, effectiveAt: 'turn' });
  expect(servedHeader(after).proposalId).not.toBeNull();
  expect(await committed(actor)).toEqual([]);
  ws.close();
});

test('two edits from the same read: the second is refused stale and the first survives', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-cas');
  const vfs = planeFor(actor);
  await hydrate(actor, [{ role: 'user', content: 'original' }]);

  const served = await readText(vfs, '/context/working.jsonl');
  await vfs.writeFile('/context/working.jsonl', served.replace('original', 'first edit'));

  // A second editor that read before the first wrote.
  await expect(vfs.writeFile('/context/working.jsonl', served.replace('original', 'second edit')))
    .rejects.toMatchObject({ verdict: 'stale' });

  expect(await stagedMessages(actor)).toEqual([{ role: 'user', content: 'first edit' }]);
  expect(staged(actor)?.base_revision).toBe(1);
  expect(await committed(actor)).toEqual([{ role: 'user', content: 'original' }]);
  ws.close();
});

test('a header naming another actor is refused, and the caller cannot retarget by writing one', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-self');
  const other = ws.bind('actor-other');
  const vfs = planeFor(actor);
  await hydrate(actor, [{ role: 'user', content: 'mine' }]);
  await hydrate(other, [{ role: 'user', content: 'theirs' }]);

  const retargeted = (await readText(vfs, '/context/working.jsonl'))
    .replace(actor.handle.actorId, other.handle.actorId)
    .replace('mine', 'written through the wrong plane');

  await expect(vfs.writeFile('/context/working.jsonl', retargeted))
    .rejects.toMatchObject({ code: 'denied' });

  expect(await committed(actor)).toEqual([{ role: 'user', content: 'mine' }]);
  expect(await committed(other)).toEqual([{ role: 'user', content: 'theirs' }]);
  expect(staged(actor)).toBeNull();
  expect(staged(other)).toBeNull();
  ws.close();
});

test('a working history that severs a tool call from its result is refused before anything is staged', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-pairing');
  const vfs = planeFor(actor);
  await hydrate(actor, [{ role: 'user', content: 'ask' }]);
  const served = await readText(vfs, '/context/working.jsonl');

  // A severed tool call is the only new line.
  await expect(vfs.writeFile('/context/working.jsonl', appended(served, [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c9', toolName: 'probe', input: {} }] },
  ]))).rejects.toMatchObject({ code: 'bad_input' });

  expect(staged(actor)).toBeNull();
  expect(selectionOf(actor).revision).toBe(1);
  ws.close();
});

test('evidence under /context is readable and not writable, and the plane invents no filesystem', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-evidence');
  const vfs = planeFor(actor);
  await hydrate(actor, [{ role: 'user', content: 'q' }]);
  const claim = await admitOn(actor, { runId: 'run-1', turnId: 'turn-1' });
  await actor.claims.consume(claim, { index: 0, messages: [{ role: 'user', content: 'q' }] });

  const listing = await vfs.readdir('/context');
  expect(listing).toContain('working.jsonl');
  expect(listing).toContain('claim.json');
  expect(listing).toContain('requests');

  expect(await vfs.readdir('/context/requests')).toEqual(['turn-1']);
  expect(await vfs.readdir('/context/requests/turn-1')).toEqual(['1-0.json', '1-1.json']);
  const request = JSON.parse(await readText(vfs, '/context/requests/turn-1/1-1.json'));
  expect(request).toMatchObject({ request: { turnId: 'turn-1', step: 0, source: { revision: claim.workingRevision } } });

  await expect(vfs.writeFile('/context/claim.json', '{}')).rejects.toMatchObject({ code: 'EACCES' });
  await expect(vfs.writeFile('/context/requests/turn-1/1-1.json', '{}')).rejects.toMatchObject({ code: 'EACCES' });
  await expect(vfs.unlink('/context/working.jsonl')).rejects.toMatchObject({ code: 'EACCES' });
  await expect(vfs.mkdir('/context/whatever')).rejects.toMatchObject({ code: 'EACCES' });
  expect(await vfs.exists('/context/nothing-here.json')).toBe(false);
  ws.close();
});

test('a rollback is a new revision written from a retained one, and the audit it came from is unchanged', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-rollback');
  const vfs = planeFor(actor);
  await hydrate(actor, [{ role: 'user', content: 'the good history' }]);
  const good = selectionOf(actor).revision;
  const first = await readText(vfs, '/context/working.jsonl');

  // Activated, so the regret is a committed revision.
  await vfs.writeFile('/context/working.jsonl', first.replace('the good history', 'a regrettable edit'));
  await actor.history.stepBase(() => { actor.handle.assertCurrent(); });
  expect(await committed(actor)).toEqual([{ role: 'user', content: 'a regrettable edit' }]);

  // Roll back by writing the prior revision's own retained payloads.
  const prior = v.parse(v.object({ context: v.object({ revision: v.number(), cause: v.string() }), entries: v.array(v.object({ message: v.unknown() })) }),
    JSON.parse(await readText(vfs, `/context/revisions/${good}.json`)));

  expect(prior.context).toMatchObject({ revision: good, cause: 'edit' });
  const regret = await readText(vfs, '/context/working.jsonl');

  await vfs.writeFile('/context/working.jsonl', [
    regret.split('\n', 1)[0] ?? '',
    ...prior.entries.map((entry) => JSON.stringify({ new: true, message: entry.message })),
  ].join('\n') + '\n');

  await actor.history.stepBase(() => { actor.handle.assertCurrent(); });
  expect(await committed(actor)).toEqual([{ role: 'user', content: 'the good history' }]);
  // A rollback does not erase what it rolled back.
  const log = revisions(actor);
  expect(log.map((row) => row.revision)).toEqual([3, 2, 1, 0]);
  expect(log.find((row) => row.revision === 2)).toMatchObject({ cause: 'edit', author: actor.handle.actorId });
  expect(JSON.parse(await readText(vfs, '/context/revisions/2.json')))
    .toMatchObject({ context: { revision: 2 }, entries: [{ message: { content: 'a regrettable edit' } }] });
  ws.close();
});

test('an authorized parent edits a child through the child\'s own store; a sibling key is not addressable', async () => {
  const ws = workspace();
  const parent = ws.bind('actor-parent');
  const child = ws.bind('actor-child');
  const stranger = ws.bind('actor-stranger');
  await hydrate(child, [{ role: 'user', content: 'child history' }]);
  await hydrate(stranger, [{ role: 'user', content: 'stranger history' }]);

  const resolver: ChildContextResolver = {
    list: () => ['agent:child'],
    resolve: (key) => (key === 'agent:child' ? child.stores : null),
  };

  const vfs = planeFor(parent, resolver);

  expect(await vfs.readdir('/context/agents')).toEqual(['agent:child']);
  const seen = await readText(vfs, '/context/agents/agent:child/working.jsonl');
  expect(servedHeader(seen).actor).toBe(child.handle.actorId);
  expect(servedMessages(seen)).toEqual([{ role: 'user', content: 'child history' }]);

  await vfs.writeFile('/context/agents/agent:child/working.jsonl',
    seen.replace('child history', 'parent corrected this'));
  expect(staged(child)).toMatchObject({ author: parent.handle.actorId, via: 'owner' });
  expect(await stagedMessages(child)).toEqual([{ role: 'user', content: 'parent corrected this' }]);

  await expect(readText(vfs, '/context/agents/agent:stranger/working.jsonl'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(vfs.writeFile('/context/agents/agent:stranger/working.jsonl', 'x'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  expect(staged(stranger)).toBeNull();
  ws.close();
});

test('a retired actor stops authorising context reads and writes at its own handle', async () => {
  const testSql = createTestSql();
  const { sql, execRaw } = testSql;
  const actors = createTestActors(sql, execRaw);
  initActorClaimTables(execRaw);
  const { vfs: files } = createMemoryVfs();
  let live = true;
  const handle = testActorHandle(sql, { actorId: actors.main.actorId, live: () => live });

  const history = new SessionHistory({ sql, actor: handle, transactionSync: (write) => write(),
    files: async () => ({ vfs: files, artifactDirectory: '/actors/actor-retired/.kinu/context' }) });

  const claims = new ActorClaimStore(sql, handle, (write) => write(), history);
  const bound: Bound = { handle, claims, history, stores: { claims, events: null } };

  const vfs = withMountTable(emptyTree(), [contextMount({ stores: () => bound.stores })]);

  await hydrate(bound, [{ role: 'user', content: 'while live' }]);
  const served = await readText(vfs, '/context/working.jsonl');

  live = false;
  await expect(readText(vfs, '/context/working.jsonl')).rejects.toThrow();
  await expect(vfs.writeFile('/context/working.jsonl', served.replace('while live', 'after retirement')))
    .rejects.toThrow();

  live = true;
  expect(staged(bound)).toBeNull();
  testSql.close();
});

test('the native file tool reads, edits and re-reads the working history over the same plane', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-native');
  const vfs = planeFor(actor);
  await hydrate(actor, [
    { role: 'user', content: 'remember the wrong fact' },
    { role: 'assistant', content: 'noted' },
  ]);
  const file = fileTool(vfs);

  const shown = v.parse(v.string(), await file({ action: 'read', path: '/context/working.jsonl' }));
  expect(shown).toContain('remember the wrong fact');

  const applied = await file({
    action: 'edit',
    path: '/context/working.jsonl',
    edits: [{ old_text: 'remember the wrong fact', new_text: 'remember the RIGHT fact' }],
  });

  expect(applied).toMatchObject({ ok: true });

  const pending = await stagedMessages(actor);
  expect(pending[0]).toEqual({ role: 'user', content: 'remember the RIGHT fact' });
  expect(pending[1]).toEqual({ role: 'assistant', content: 'noted' });
  // The tool's own ledger refuses a second edit from the same read.
  await expect(file({
    action: 'edit',
    path: '/context/working.jsonl',
    edits: [{ old_text: 'remember the RIGHT fact', new_text: 'again' }],
  })).rejects.toMatchObject({ verdict: 'stale' });
  ws.close();
});

test('binary and tool-result parts survive a read/write round trip through the file bytes', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-codec');
  const vfs = planeFor(actor);
  const attachment = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await hydrate(actor, [
    { role: 'user', content: [
      { type: 'text', text: 'look at this' },
      { type: 'file', data: attachment, mediaType: 'image/png' },
    ] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'probe', input: { path: 'a' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'json', value: { ok: true } } }] },
  ]);

  const text = await readText(vfs, '/context/working.jsonl');
  // The served line carries the attachment reference, never the bytes.
  expect(text).not.toContain('"0":137');
  const served = JSON.parse(text.split('\n')[1] ?? '');
  const reference = v.parse(v.object({ message: v.object({ content: v.tuple([v.unknown(), v.object({ type: v.literal('file'), data: v.object({ $sessionAttachment: v.object({ path: v.string(), digest: v.string() }) }) })]) }) }), served);
  const stored = reference.message.content[1].data.$sessionAttachment;
  expect(v.parse(v.instance(Uint8Array), await ws.files.readFile(stored.path))).toEqual(attachment);

  await vfs.writeFile('/context/working.jsonl', `${text}${JSON.stringify({ new: true, message: { role: 'user', content: 'and then' } })}\n`);
  const roundTripped = await stagedMessages(actor);
  const parts = Array.isArray(roundTripped[0]?.content) ? roundTripped[0].content : [];
  const attached = parts.find((part) => part.type === 'file');
  const data = attached && 'data' in attached ? attached.data : undefined;

  if (!(data instanceof Uint8Array)) throw new Error('the attachment must materialize to its own bytes');
  expect([...data]).toEqual([...attachment]);
  expect(roundTripped[2]).toEqual({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'json', value: { ok: true } } }],
  });
  expect(roundTripped[3]).toEqual({ role: 'user', content: 'and then' });
  ws.close();
});

test('the owner UI path gets a real conditional write, and a conflicting revision is refused', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-ui');
  const vfs = planeFor(actor);
  await hydrate(actor, [{ role: 'user', content: 'from the browser' }]);

  const stat = await vfs.stat('/context/working.jsonl');
  const revision = stat?.revision;

  if (revision === undefined) throw new Error('the context plane must publish a revision token');
  const served = await readText(vfs, '/context/working.jsonl');

  if (vfs.writeFileIfRevision === undefined) throw new Error('the context plane must offer a conditional write');

  const saved = await vfs.writeFileIfRevision('/context/working.jsonl',
    new TextEncoder().encode(served.replace('from the browser', 'edited in the browser')), revision);

  expect(saved).toMatchObject({ ok: true });
  expect(await stagedMessages(actor)).toEqual([{ role: 'user', content: 'edited in the browser' }]);

  await expect(vfs.writeFileIfRevision('/context/working.jsonl',
    new TextEncoder().encode(served.replace('from the browser', 'from a stale tab')), revision))
    .rejects.toMatchObject({ verdict: 'stale' });
  ws.close();
});

/** Head replacement keeps the recorded tail even when the rendered array is longer than the raw one. */
test('a landed edit preserves the recorded tail exactly, with a woven block and a pruned tool output in play', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-coordinates');
  const vfs = planeFor(actor);
  const ledger = new DynamicContextLedger();
  // Live state renders a block, so the rendered array is longer than the raw one.
  const dynamic = { ledger, snapshot: () => ({ recoveries: ['a finding proven by execution'] }) };
  const prune = { contextWindow: 4_000, modelOutputLimit: 1_000 };
  const bulky = 'x'.repeat(200_000);

  // The older tool result is prunable; the newest is protected.
  const older: ModelMessage[] = [
    { role: 'user', content: 'original question' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'probe', input: { path: 'old' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old', toolName: 'probe', output: { type: 'text', value: bulky } }] },
  ];

  await hydrate(actor, older);
  const claim = await admitOn(actor, { runId: 'run-coord', turnId: 'turn-coord' });
  const admitted = (await actor.claims.admittedContext(claim.turnId))?.messages ?? [];
  expect(admitted).toHaveLength(3);

  const steps = stepsOf(actor, claim);

  const first = await composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 0, messages: [...admitted], steps: [] });

  expect(first?.messages).toHaveLength(4);
  const renderedFirst = await actor.claims.consumedContext('turn-coord');
  expect(renderedFirst?.messages).toHaveLength(4);
  expect(renderedFirst?.workingRevision).toBe(claim.workingRevision);
  expect(actor.history.context.entries({ contextId: claim.workingContextId, revision: claim.workingRevision })).toHaveLength(3);

  const assertOwner = () => { actor.handle.assertCurrent(); };

  const tail: ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'probe', input: { path: 'a' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'text', value: 'fresh output' } }] },
  ];

  // Authored before the tail is recorded, so the landing carries a tail its author never saw.
  const served = await readText(vfs, '/context/working.jsonl');
  await vfs.writeFile('/context/working.jsonl', served.replace('original question', 'corrected question'));

  for (const [index, message] of tail.entries()) {
    await actor.history.append({ id: `tail-${index}`, message, origin: 'output', turnId: 'turn-coord', assertOwner });
  }

  const second = await composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 1, messages: [], steps: [] });

  const request = second?.messages ?? [];
  expect(request[0]).toEqual({ role: 'user', content: 'corrected question' });
  expect(request[3]?.role).toBe('assistant');
  expect(request[4]?.role).toBe('tool');
  const call = Array.isArray(request[3]?.content) ? request[3].content[0] : undefined;
  const result = Array.isArray(request[4]?.content) ? request[4].content[0] : undefined;
  expect(call).toMatchObject({ type: 'tool-call', toolCallId: 'c1' });
  expect(result).toMatchObject({ type: 'tool-result', toolCallId: 'c1', output: { type: 'text', value: 'fresh output' } });
  const oldResult = Array.isArray(request[2]?.content) ? request[2].content[0] : undefined;
  expect(JSON.stringify(oldResult).length).toBeLessThan(bulky.length);
  expect(oldResult).toMatchObject({ type: 'tool-result', toolCallId: 'old' });
  // The landing reset the ledger; the block index is in this array.
  expect(request).toHaveLength(6);
  expect(request[5]?.role).toBe('user');
  expect(v.parse(v.string(), request[5]?.content)).toContain('a finding proven by execution');

  expect(await committed(actor)).toEqual([{ role: 'user', content: 'corrected question' }, ...older.slice(1), ...tail]);
  expect(staged(actor)).toBeNull();
  expect((await actor.claims.consumedContext('turn-coord'))?.workingRevision).toBe(selectionOf(actor).revision);

  // prepareStep overrides one request only, so a landed edit must keep landing.
  const third = await composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 2, messages: [], steps: [] });

  expect(third?.messages?.[0]).toEqual({ role: 'user', content: 'corrected question' });
  ws.close();
});

/** Turns of four messages (ask, tool call, tool result, answer) through the production step pipeline: a woven block,
 *  replayed tool ids rewritten, cache markers on the tail. Answers what each turn wrote and ran. */
async function twoStepTurns(prune: StepPruneBudget, output: (turn: number) => string): Promise<{ rows: number; statements: number }[]> {
  const ws = workspace();
  const actor = ws.bind('actor-growth');
  const assertOwner = () => { actor.handle.assertCurrent(); };

  const pipeline = {
    prune,
    dynamic: { ledger: new DynamicContextLedger(), snapshot: () => ({ recoveries: ['a finding proven by execution'] }) },
    destinationProviderId: 'anthropic',
    cache: { strategy: { kind: 'anthropic' as const } },
  };

  const added: { rows: number; statements: number }[] = [];

  for (let turn = 0; turn < 24; turn++) {
    const turnId = `turn-${String(turn)}`;
    const before = { rows: ws.rows(), statements: ws.statements() };
    await actor.history.append({ id: `ask-${String(turn)}`, message: { role: 'user', content: `question ${String(turn)}` }, origin: 'input', turnId, assertOwner });
    const claim = await admitOn(actor, { runId: `run-${String(turn)}`, turnId });
    const context = stepsOf(actor, claim);
    const sent = [await composePrepareStep({ ...pipeline, context }, { stepNumber: 0, messages: [], steps: [] })];
    await actor.history.append({ id: `call-${String(turn)}`, origin: 'output', turnId, assertOwner,
      message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${String(turn)}`, toolName: 'probe', input: { turn } }] } });
    await actor.history.append({ id: `result-${String(turn)}`, origin: 'output', turnId, assertOwner,
      message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${String(turn)}`, toolName: 'probe', output: { type: 'text', value: output(turn) } }] } });
    sent.push(await composePrepareStep({ ...pipeline, context }, { stepNumber: 1, messages: [], steps: [] }));
    await actor.history.append({ id: `answer-${String(turn)}`, origin: 'output', turnId, assertOwner,
      message: { role: 'assistant', content: [{ type: 'text', text: `answer ${String(turn)}` }] } });
    actor.claims.settle(claim, 'completed');
    added.push({ rows: ws.rows() - before.rows, statements: ws.statements() - before.statements });

    // Byte for byte: the replay and cache checks read this list, not a copy of the step pipeline's inputs.
    for (const [step, request] of sent.entries()) expect(JSON.stringify((await actor.claims.consumedContext(turnId, step))?.messages)).toBe(JSON.stringify(request?.messages));
  }

  ws.close();

  return added;
}

/** 2026-09-23, 300 two-step turns through the CLI: every request stored a copy of every tool exchange and one row per
 *  prompt message, so turn 2 added 77 rows and turn 300 added 4,845, and turn time grew with them. */
test('a turn stores and runs only what it added, and every request reads back as the messages it sent', async () => {
  const added = await twoStepTurns({ contextWindow: 200_000, modelOutputLimit: 8_000 }, (turn) => `output ${String(turn)}`);

  // Each turn adds the same four messages, so after the first it writes the same rows and runs the same statements,
  // however long the history: a statement per carried message is latency the clock would show later.
  expect(added.slice(1)).toEqual(added.slice(1).map(() => added[1]));
});

/** Review 2026-09-24: pruning rebuilt each pruned result every step, so every request encoded and looked up all of them. */
test('a pruned tool result keeps its identity, so a turn runs the same statements however many are pruned', async () => {
  // Every result outgrows the window's prune batch, so each step prunes all but the newest: one more a turn.
  const added = await twoStepTurns({ contextWindow: 8_000, modelOutputLimit: 2_000 }, (turn) => `${String(turn).padStart(3, '0')}${'x'.repeat(19_997)}`);

  expect(added.slice(1)).toEqual(added.slice(1).map(() => added[1]));
});

test('an edit mid-exchange is deferred with its reason, then lands at the next safe boundary', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-defer');
  const vfs = planeFor(actor);
  await hydrate(actor, [{ role: 'user', content: 'ask' }]);
  const claim = await admitOn(actor, { runId: 'run-defer', turnId: 'turn-defer' });
  const steps = stepsOf(actor, claim);
  const assertOwner = () => { actor.handle.assertCurrent(); };

  const served = await readText(vfs, '/context/working.jsonl');
  await vfs.writeFile('/context/working.jsonl', served.replace('"ask"', '"edited ask"'));

  // A pending tool call defers the edit.
  const call: ModelMessage = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'probe', input: {} }] };
  await actor.history.append({ id: 'call', message: call, origin: 'output', turnId: 'turn-defer', assertOwner });
  const midExchange: ModelMessage[] = [{ role: 'user', content: 'ask' }, call];

  const deferred = await composePrepareStep({ context: steps }, { stepNumber: 1, messages: [], steps: [] });

  expect(deferred?.messages).toEqual(midExchange);
  expect((await actor.claims.consumedContext('turn-defer'))?.messages).toEqual(midExchange);
  expect(staged(actor)).toMatchObject({ base_revision: 1, deferred_reason: 'unpaired_tool_call' });
  expect(await committed(actor)).toEqual(midExchange);

  const result: ModelMessage = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'probe', output: { type: 'json', value: { ok: true } } }],
  };

  await actor.history.append({ id: 'result', message: result, origin: 'output', turnId: 'turn-defer', assertOwner });
  const landed = await composePrepareStep({ context: steps }, { stepNumber: 2, messages: [], steps: [] });

  expect(landed?.messages?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  expect(landed?.messages?.[0]).toEqual({ role: 'user', content: 'edited ask' });
  expect(staged(actor)).toBeNull();
  ws.close();
});

test('an edit authored between turns is consumed by the next turn with the new input preserved once', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-between');
  const vfs = planeFor(actor);

  await hydrate(actor, [{ role: 'user', content: 'first question' }]);
  const claim = await admitOn(actor, { runId: 'run-one', turnId: 'turn-one' });
  actor.claims.settle(claim, 'completed');

  const assertOwner = () => { actor.handle.assertCurrent(); };

  await actor.history.append({ id: 'answer-one', message: { role: 'assistant', content: 'first answer' }, origin: 'output', turnId: 'turn-one', assertOwner });
  expect(await committed(actor)).toHaveLength(2);

  const served = await readText(vfs, '/context/working.jsonl');
  expect(servedHeader(served).effectiveAt).toBe('turn');
  expect(servedMessages(served)).toHaveLength(2);
  await vfs.writeFile('/context/working.jsonl',
    served.replace('first question', 'first question, corrected'));

  const landed = await actor.history.stepBase(assertOwner, null, null);
  expect(landed.changed).toBe(true);
  await actor.history.append({ id: 'input-two', message: { role: 'user', content: 'second question' }, origin: 'input', turnId: 'turn-two', assertOwner });

  const next = await committed(actor);
  expect(next).toEqual([
    { role: 'user', content: 'first question, corrected' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ]);
  expect(next.filter((message) => message.content === 'second question')).toHaveLength(1);
  const log = revisions(actor);
  expect(log[0]).toMatchObject({ revision: selectionOf(actor).revision, cause: 'input' });
  expect(log[1]).toMatchObject({ cause: 'edit', turn_id: null });
  expect(log[1]?.proposal_id).not.toBeNull();
  ws.close();
});

test('a cold reader with no live turn can read and edit the working history it will resume on', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-cold');
  await hydrate(actor, [{ role: 'user', content: 'before the crash' }]);
  await admitOn(actor, { runId: 'run-crash', turnId: 'turn-crash' });

  // A second store bundle: an activation that did not run the turn.
  const cold = ws.bind('actor-cold');
  const coldVfs = planeFor(cold);
  const seen = await readText(coldVfs, '/context/working.jsonl');
  expect(servedMessages(seen)).toEqual([{ role: 'user', content: 'before the crash' }]);
  expect(servedHeader(seen).revision).toBe(1);
  await coldVfs.writeFile('/context/working.jsonl',
    seen.replace('before the crash', 'recovered and corrected'));
  expect(staged(cold)).toMatchObject({ base_revision: 1, via: 'file' });
  ws.close();
});

test('an edit emits its authoring and its activation, and a refused edit emits nothing', async () => {
  const ws = workspace();
  const base = ws.bind('actor-events');
  const emitted: Array<{ runId: string; event: ContextEditEvent }> = [];

  const actor: Bound = {
    ...base,
    stores: {
      claims: base.claims,
      events: {
        emit: (runId, event) => { emitted.push({ runId, event }); },
        emitDeferred: (runId, event) => ({ publish: () => { emitted.push({ runId, event }); } }),
      },
    },
  };

  const vfs = planeFor(actor);
  await hydrate(actor, [{ role: 'user', content: 'ask' }]);
  const claim = await admitOn(actor, { runId: 'run-ev', turnId: 'turn-ev' });

  const served = await readText(vfs, '/context/working.jsonl');
  await vfs.writeFile('/context/working.jsonl', served.replace('"ask"', '"edited ask"'));
  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({ runId: 'run-ev', event: {
    type: 'context_edit', revision: 1, baseRevision: 1, messageCount: 1,
    author: actor.handle.actorId, via: 'file', status: 'staged', effectiveAt: 'step',
    turnId: 'turn-ev', stepIndex: null,
  } });

  await expect(vfs.writeFile('/context/working.jsonl', served.replace('"ask"', '"from a stale read"')))
    .rejects.toMatchObject({ verdict: 'stale' });
  expect(emitted).toHaveLength(1);

  await stepsOf(actor, claim).base();
  expect(emitted).toHaveLength(2);
  expect(emitted[1]?.event).toMatchObject({
    type: 'context_edit', revision: 2, status: 'activated', turnId: 'turn-ev', effectiveAt: 'step',
  });
  ws.close();
});
