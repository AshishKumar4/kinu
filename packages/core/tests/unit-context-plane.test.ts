/**
 * `/context` — the editable working history, through the file surface a model
 * and an owner actually use.
 *
 * Every test here drives the REAL composite plane (`withMountTable` +
 * `contextMount`) over REAL stores bound to REAL `ActorHandle`s, and the edits
 * go through the same `file` dispatcher the native tool and codemode's
 * `workspace.*` share. Nothing asserts on source text: what is checked is what
 * a caller observes — the bytes served, the revision a write is compared
 * against, the refusal a stale or foreign write earns, and which rows moved.
 */

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
import { decodeModelMessages, encodeModelMessages } from '../src/session/message-codec';
import { composePrepareStep, type StepContextPlane } from '../src/prompting/prepare-step';
import { DynamicContextLedger } from '../src/prompting/volatile-context';
import { createFileDispatcher } from '../src/tools/file-tool';
import { TurnFileLedger } from '../src/tools/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import type { ActorContextStores, ChildContextResolver, ContextFileHeader } from '../src/vfs/context-plane';
import type { ContextEditEvent } from '../src/types/context-plane';
import type { VFS } from '../src/types/primitives';
import type { ActorHandle } from '../src/identity/actor-handle';
import type { JsonValue } from '../src/utils/json';

const PROGRAM = { kind: 'builtin' as const, version: 0, digest: null, build: null };

interface Bound {
  readonly handle: ActorHandle;
  readonly claims: ActorClaimStore;
  readonly history: SessionHistory;
  readonly stores: ActorContextStores;
}

/** An empty base tree, so anything the composite plane serves under /context
 *  provably came from the mount rather than from a workspace file. */
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
  readonly close: () => void;
}

function workspace(): Workspace {
  const { sql, execRaw, close } = createTestSql();
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

      // `events: null` here: the emission contract has its own test with a
      // capture port, and every OTHER test in this file is about the bytes and
      // the rows, which are the durable record either way.
      return { handle, claims, history, stores: { claims, events: null } };
    },
    files: vfs,
    close,
  };
}

function planeFor(bound: Bound, children?: ChildContextResolver): VFS {
  return withMountTable(emptyTree(), [contextMount({ stores: () => bound.stores, children })]);
}

/** The settled working history, committed straight through the session store —
 *  what a session-authored replacement (`ActorSession.restoreHistory` with no
 *  live turn) leaves behind. */
async function hydrate(bound: Bound, messages: readonly ModelMessage[]): Promise<void> {
  await bound.history.replaceHistory(messages, {
    author: bound.handle.actorId, via: 'session', turnId: null, stage: false,
    assertOwner: () => { bound.handle.assertCurrent(); },
  });
}

/** The COMMITTED working history — what the next request is built from. */
async function committed(bound: Bound): Promise<readonly ModelMessage[]> {
  return (await bound.history.materialize()).messages;
}

function selectionOf(bound: Bound): ContextSelection {
  return bound.history.context.selected() ?? bound.history.context.initialize();
}

/** The pending proposal, if one is staged against the selected context. */
function staged(bound: Bound): PendingContextProposal | null {
  const selection = bound.history.context.selected();

  return selection === null ? null : bound.history.proposals.pending(selection.contextId).at(-1) ?? null;
}

/** What a staged proposal WOULD make the working history, materialized through
 *  the same store the activation would read. */
async function stagedMessages(bound: Bound): Promise<readonly ModelMessage[]> {
  const pending = staged(bound);

  if (pending === null) throw new Error('no context edit is staged');
  const messages: ModelMessage[] = [];

  for (const entry of bound.history.proposals.preview(pending.proposal_id)) {
    messages.push(await bound.history.messages.materialize(entry));
  }

  return messages;
}

/** The committed revision log, newest first. */
function revisions(bound: Bound) {
  const selection = bound.history.context.selected();

  return selection === null ? [] : bound.history.context.revisions(selection.contextId);
}

/** Admit one turn against this actor's selected working context — the
 *  production admission, through the production store. */
async function admitOn(bound: Bound, ids: { readonly runId: string; readonly turnId: string }): Promise<ActorTurnClaim> {
  return bound.claims.admit({ ...ids, workMode: 'build', program: PROGRAM, context: selectionOf(bound) });
}

/** The step plane a claimed turn runs under, wired exactly as `ActorSession`
 *  wires it: the staged edit lands in `base()`, the request is recorded in
 *  `consume()`. */
function stepsOf(bound: Bound, claim: ActorTurnClaim): StepContextPlane {
  return {
    base: () => bound.history.stepBase(
      () => { bound.history.assertEpoch(claim.turnId, claim.epoch); }, claim.turnId, bound.stores.events,
    ),
    consume: async ({ stepNumber, messages }) => { await bound.claims.consume(claim, { index: stepNumber, messages }); },
  };
}

/** The `file` tool's own dispatcher over a plane, with the read ledger the
 *  read-before-write gate uses. */
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

/** The header fields these tests observe, named by the plane's OWN published
 *  header type. The projection is checked by the compiler, so what is read out
 *  of line 1 below cannot drift from the contract the plane serves. */
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

/** What a client of `/context/working.jsonl` reads out of line 1: the
 *  `$context` object the plane put there. What each field must SAY is the
 *  assertion at the call site, not this accessor. */
function servedHeader(text: string): ServedHeader {
  return v.parse(ServedLine, JSON.parse(text.split('\n', 1)[0] ?? '')).$context;
}

/** The message lines, through the durable codec the file states it carries them
 *  in. Each line is an ENTRY; the message it references is the payload. */
function servedMessages(text: string): ModelMessage[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const entries = lines.slice(1).map((line) => v.parse(v.object({ message: v.unknown() }), JSON.parse(line)).message);

  return decodeModelMessages(JSON.stringify(entries));
}

/** The served bytes with more messages after them: every line the read produced
 *  left exactly as it arrived, then one new entry per new message — the append
 *  half of a real read-modify-write. */
function appended(text: string, extra: readonly ModelMessage[]): string {
  const encoded = v.parse(v.array(v.unknown()), JSON.parse(encodeModelMessages(extra)));
  const head = text.endsWith('\n') ? text : `${text}\n`;

  return head + encoded.map((message) => `${JSON.stringify({ new: true, message })}\n`).join('');
}

test('a fresh actor serves an empty working history at revision 0, and an edit of it is staged, not in effect', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-fresh');
  const vfs = planeFor(actor);

  // Before ANY turn: the path exists, reads, and names a revision. This is the
  // arm a claims getter with no claim lands in.
  const before = await readText(vfs, '/context/working.jsonl');
  expect(servedHeader(before)).toMatchObject({ actor: actor.handle.actorId, revision: 0, status: 'empty', proposalId: null });
  expect(servedMessages(before)).toEqual([]);

  const edited: ModelMessage[] = [{ role: 'user', content: 'seeded before the first turn' }];
  // A fresh file has no message lines yet, so the edit IS the served header
  // line with the new entries written under it.
  await vfs.writeFile('/context/working.jsonl', appended(before, edited));

  const after = await readText(vfs, '/context/working.jsonl');
  expect(servedMessages(after)).toEqual(edited);
  // Staged, not active: nothing has consumed it yet, and the plane says so
  // rather than claiming the edit is in effect.
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

  // One read, two edits of the bytes it served — a literal replacement in the
  // text, which is the change an editor of this file actually makes.
  const served = await readText(vfs, '/context/working.jsonl');
  await vfs.writeFile('/context/working.jsonl', served.replace('original', 'first edit'));

  // The same served text again — a second editor that read before the first
  // wrote, and so carries the same header line.
  await expect(vfs.writeFile('/context/working.jsonl', served.replace('original', 'second edit')))
    .rejects.toMatchObject({ verdict: 'stale' });

  expect(await stagedMessages(actor)).toEqual([{ role: 'user', content: 'first edit' }]);
  expect(staged(actor)?.base_revision).toBe(1);
  // Nothing activated it, so the committed history is still what it was.
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

  // The actor name rewritten in place in the served header line, carrying new
  // content: the whole retarget an editor of this file can attempt.
  const retargeted = (await readText(vfs, '/context/working.jsonl'))
    .replace(actor.handle.actorId, other.handle.actorId)
    .replace('mine', 'written through the wrong plane');

  await expect(vfs.writeFile('/context/working.jsonl', retargeted))
    .rejects.toMatchObject({ code: 'denied' });

  // Neither actor's history moved, and neither has an edit waiting.
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

  // The served history with a tool call appended and no result behind it. Every
  // line the read produced is untouched, so the severed call is the only new
  // thing in the file.
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
  // Two requests under the turn's ONE epoch: the admission at revision 0 and
  // the step that consumed it at revision 1.
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

  // An edit, activated the way a boundary activates one, so the regret is a
  // committed revision rather than a proposal still waiting.
  await vfs.writeFile('/context/working.jsonl', first.replace('the good history', 'a regrettable edit'));
  await actor.history.stepBase(() => { actor.handle.assertCurrent(); });
  expect(await committed(actor)).toEqual([{ role: 'user', content: 'a regrettable edit' }]);

  // Roll back BY WRITING the validated prior revision's OWN retained payloads
  // back, read out of its revision file rather than retyped: that is what
  // makes a rollback a real path rather than an assertion about one.
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
  // The regretted revision is still there, with its own author and cause — a
  // rollback does not erase what it rolled back.
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
  // The child's row, authored by the PARENT, through the child's own handle.
  expect(staged(child)).toMatchObject({ author: parent.handle.actorId, via: 'owner' });
  expect(await stagedMessages(child)).toEqual([{ role: 'user', content: 'parent corrected this' }]);

  // A key the resolver does not own is absent, whatever the caller writes.
  await expect(readText(vfs, '/context/agents/agent:stranger/working.jsonl'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(vfs.writeFile('/context/agents/agent:stranger/working.jsonl', 'x'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  expect(staged(stranger)).toBeNull();
  ws.close();
});

test('a retired actor stops authorising context reads and writes at its own handle', async () => {
  const { sql, execRaw, close } = createTestSql();
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
  close();
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

  // An `edit`, matched literally against what the read returned — the ordinary
  // way a model changes a file, on the context plane.
  const applied = await file({
    action: 'edit',
    path: '/context/working.jsonl',
    edits: [{ old_text: 'remember the wrong fact', new_text: 'remember the RIGHT fact' }],
  });

  expect(applied).toMatchObject({ ok: true });

  const pending = await stagedMessages(actor);
  expect(pending[0]).toEqual({ role: 'user', content: 'remember the RIGHT fact' });
  // The assistant turn the edit did not touch is still there, and still typed.
  expect(pending[1]).toEqual({ role: 'assistant', content: 'noted' });
  // A second edit from the SAME read is refused: the tool's own ledger sees the
  // header move, before the store is even asked.
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
  // The bytes live in the workspace, not in the file: the served line carries
  // the attachment reference, never a JSON dump of the bytes.
  expect(text).not.toContain('"0":137');
  const served = JSON.parse(text.split('\n')[1] ?? '');
  const reference = v.parse(v.object({ message: v.object({ content: v.tuple([v.unknown(), v.object({ type: v.literal('file'), data: v.object({ $sessionAttachment: v.object({ path: v.string(), digest: v.string() }) }) })]) }) }), served);
  const stored = reference.message.content[1].data.$sessionAttachment;
  expect(v.parse(v.instance(Uint8Array), await ws.files.readFile(stored.path))).toEqual(attachment);

  // Write the SERVED BYTES straight back with one new line: the attachment
  // reference and the tool pairing survive the plane decoding its own text.
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
  const conditional = vfs.writeFileIfRevision;

  if (conditional === undefined) throw new Error('the context plane must offer a conditional write');

  const saved = await conditional.call(vfs, '/context/working.jsonl',
    new TextEncoder().encode(served.replace('from the browser', 'edited in the browser')), revision);

  expect(saved).toMatchObject({ ok: true });
  expect(await stagedMessages(actor)).toEqual([{ role: 'user', content: 'edited in the browser' }]);

  // The token the first write consumed no longer describes the file, and a
  // second tab still holding it cannot overwrite what landed.
  await expect(conditional.call(vfs, '/context/working.jsonl',
    new TextEncoder().encode(served.replace('from the browser', 'from a stale tab')), revision))
    .rejects.toMatchObject({ verdict: 'stale' });
  ws.close();
});

/**
 * THE DEFECT, at the seam it lived in.
 *
 * The step pipeline holds two arrays: the durable one the store owns, and the
 * FINAL rendered one a provider receives. A landed edit's tail is what the
 * turn has already recorded, and an edit that replaces the head must leave
 * that tail alone. Move the boundary by one — one woven `<dynamic_context>`
 * block was enough — and the tail loses its head. With an assistant tool call
 * as the first tail message, that is a tool result with no call in front of
 * it: the shape a provider rejects outright.
 */
test('a landed edit preserves the recorded tail exactly, with a woven block and a pruned tool output in play', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-coordinates');
  const vfs = planeFor(actor);
  const ledger = new DynamicContextLedger();
  // Live state that renders a block, so the rendered array is LONGER than the
  // raw one — the whole premise of the bug.
  const dynamic = { ledger, snapshot: () => ({ recoveries: ['a finding proven by execution'] }) };
  // A window tight enough that the step pruner really runs on the tool output.
  const prune = { contextWindow: 4_000, modelOutputLimit: 1_000 };
  const bulky = 'x'.repeat(200_000);

  // The admitted history already holds one bulky tool exchange, so the step
  // pruner has something it is ALLOWED to shrink: the newest result is
  // protected by the recent-tool budget, an older one is not.
  const older: ModelMessage[] = [
    { role: 'user', content: 'original question' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'old', toolName: 'probe', input: { path: 'old' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'old', toolName: 'probe', output: { type: 'text', value: bulky } }] },
  ];

  await hydrate(actor, older);
  const claim = await admitOn(actor, { runId: 'run-coord', turnId: 'turn-coord' });
  const admitted = await actor.claims.admittedFor(claim);
  expect(admitted.messages).toHaveLength(3);

  const steps = stepsOf(actor, claim);

  // STEP 0 — the array the turn was admitted with. The rendered request is
  // LONGER than the raw array, because the ledger froze a block: that gap
  // between the two counts is the whole premise of the defect.
  const first = await composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 0, messages: [...admitted.messages], steps: [] });

  expect(first?.messages).toHaveLength(4);
  const renderedFirst = await actor.claims.consumedContext('turn-coord');
  expect(renderedFirst?.messages).toHaveLength(4);
  // The rendered row points at the RAW revision it came from, and that
  // revision's own count is 3: two spaces, one pointer, no arithmetic between.
  expect(renderedFirst?.workingRevision).toBe(claim.workingRevision);
  expect(actor.history.context.entries({ contextId: claim.workingContextId, revision: claim.workingRevision })).toHaveLength(3);

  // The model called a tool; its result came back, and the turn recorded both
  // the way a streaming turn records its output. This is the protected tail.
  const assertOwner = () => { actor.handle.assertCurrent(); };

  const tail: ModelMessage[] = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'probe', input: { path: 'a' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'text', value: 'fresh output' } }] },
  ];

  // The edit keeps the old exchange (it is real work that happened) and
  // rewrites only the question that framed it, through the file the author
  // actually edits. Authored BEFORE the tail is recorded, so the landing has
  // to carry a tail its author never saw.
  const served = await readText(vfs, '/context/working.jsonl');
  await vfs.writeFile('/context/working.jsonl', served.replace('original question', 'corrected question'));

  for (const [index, message] of tail.entries()) {
    await actor.history.append({ id: `tail-${index}`, message, origin: 'output', turnId: 'turn-coord', assertOwner });
  }

  // STEP 1 — the edit lands here.
  const second = await composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 1, messages: [], steps: [] });

  const request = second?.messages ?? [];
  // The edited message replaced the original, and BOTH tail messages rode
  // after it, in order: the assistant call and its result are still a pair.
  expect(request[0]).toEqual({ role: 'user', content: 'corrected question' });
  expect(request[3]?.role).toBe('assistant');
  expect(request[4]?.role).toBe('tool');
  const call = Array.isArray(request[3]?.content) ? request[3].content[0] : undefined;
  const result = Array.isArray(request[4]?.content) ? request[4].content[0] : undefined;
  expect(call).toMatchObject({ type: 'tool-call', toolCallId: 'c1' });
  expect(result).toMatchObject({ type: 'tool-result', toolCallId: 'c1', output: { type: 'text', value: 'fresh output' } });
  // The pruner really ran: the OLDER output is not re-sent verbatim, while the
  // pair that produced it is still a pair.
  const oldResult = Array.isArray(request[2]?.content) ? request[2].content[0] : undefined;
  expect(JSON.stringify(oldResult).length).toBeLessThan(bulky.length);
  expect(oldResult).toMatchObject({ type: 'tool-result', toolCallId: 'old' });
  // The landing reset the ledger, so the block is at the TAIL — its index is a
  // coordinate in THIS array, not in the one the edit replaced.
  expect(request).toHaveLength(6);
  expect(request[5]?.role).toBe('user');
  expect(String(request[5]?.content)).toContain('a finding proven by execution');

  // The edit is now the working history, activated at the step that took it,
  // with the tail the turn recorded after it still behind it.
  expect(await committed(actor)).toEqual([{ role: 'user', content: 'corrected question' }, ...older.slice(1), ...tail]);
  expect(staged(actor)).toBeNull();
  expect((await actor.claims.consumedContext('turn-coord'))?.workingRevision).toBe(selectionOf(actor).revision);

  // STEP 2 — nothing new is staged, and the edit is still in effect: a
  // prepareStep override shapes one request and never becomes the SDK's next
  // input, so an edit that landed once has to keep landing.
  const third = await composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 2, messages: [], steps: [] });

  expect(third?.messages?.[0]).toEqual({ role: 'user', content: 'corrected question' });
  ws.close();
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

  // A tool call whose result has not arrived: substituting history under a
  // half-finished exchange is what this defers.
  const call: ModelMessage = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'probe', input: {} }] };
  await actor.history.append({ id: 'call', message: call, origin: 'output', turnId: 'turn-defer', assertOwner });
  const midExchange: ModelMessage[] = [{ role: 'user', content: 'ask' }, call];

  const deferred = await composePrepareStep({ context: steps }, { stepNumber: 1, messages: [], steps: [] });

  // The request went out on the UNEDITED history, and the edit is still staged
  // with the reason recorded: reported, not dropped, and not half-applied.
  expect(deferred?.messages).toEqual(midExchange);
  expect((await actor.claims.consumedContext('turn-defer'))?.messages).toEqual(midExchange);
  expect(staged(actor)).toMatchObject({ base_revision: 1, deferred_reason: 'unpaired_tool_call' });
  // Not half-applied either: the working history the next reader sees is the
  // one the request ran on, with the edit still waiting behind it.
  expect(await committed(actor)).toEqual(midExchange);

  // The result arrives; the very next boundary takes the edit.
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

  // A settled turn leaves the working history it produced.
  await hydrate(actor, [{ role: 'user', content: 'first question' }]);
  const claim = await admitOn(actor, { runId: 'run-one', turnId: 'turn-one' });
  actor.claims.settle(claim, 'completed');

  const assertOwner = () => { actor.handle.assertCurrent(); };

  await actor.history.append({ id: 'answer-one', message: { role: 'assistant', content: 'first answer' }, origin: 'output', turnId: 'turn-one', assertOwner });
  expect(await committed(actor)).toHaveLength(2);

  // Between turns: the file serves the settled history, and an edit of it says
  // it becomes effective at the next TURN rather than the next step.
  const served = await readText(vfs, '/context/working.jsonl');
  expect(servedHeader(served).effectiveAt).toBe('turn');
  expect(servedMessages(served)).toHaveLength(2);
  await vfs.writeFile('/context/working.jsonl',
    served.replace('first question', 'first question, corrected'));

  // The next turn's input arrives after the edit was authored: the boundary
  // takes the edit first, then the input lands on top of it.
  const landed = await actor.history.stepBase(assertOwner, null, null);
  expect(landed.changed).toBe(true);
  await actor.history.append({ id: 'input-two', message: { role: 'user', content: 'second question' }, origin: 'input', turnId: 'turn-two', assertOwner });

  const next = await committed(actor);
  expect(next).toEqual([
    { role: 'user', content: 'first question, corrected' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ]);
  // Exactly once: the new input is neither dropped nor duplicated.
  expect(next.filter((message) => message.content === 'second question')).toHaveLength(1);
  // The edit is recorded as its own committed revision, with the author and
  // route that made it, ahead of the revision the new input added.
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

  // A SECOND store bundle over the same database, bound to the same issued
  // actor: what an activation that did not run the turn can see.
  const cold = ws.bind('actor-cold');
  const coldVfs = planeFor(cold);
  const seen = await readText(coldVfs, '/context/working.jsonl');
  expect(servedMessages(seen)).toEqual([{ role: 'user', content: 'before the crash' }]);
  expect(servedHeader(seen).revision).toBe(1);
  // The recovered activation may edit it, and the edit is staged against the
  // revision it read — no live turn required, and no getter that throws.
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

  // Authoring: one event, naming the author, both revisions and where it lands.
  const served = await readText(vfs, '/context/working.jsonl');
  await vfs.writeFile('/context/working.jsonl', served.replace('"ask"', '"edited ask"'));
  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({ runId: 'run-ev', event: {
    type: 'context_edit', revision: 1, baseRevision: 1, messageCount: 1,
    author: actor.handle.actorId, via: 'file', status: 'staged', effectiveAt: 'step',
    turnId: 'turn-ev', stepIndex: null,
  } });

  // A refused edit — stale base — adds nothing: there is no activation to
  // report, and reporting one would record something that did not happen.
  await expect(vfs.writeFile('/context/working.jsonl', served.replace('"ask"', '"from a stale read"')))
    .rejects.toMatchObject({ verdict: 'stale' });
  expect(emitted).toHaveLength(1);

  // Activation: the boundary that took it says which turn it landed on.
  await stepsOf(actor, claim).base();
  expect(emitted).toHaveLength(2);
  expect(emitted[1]?.event).toMatchObject({
    type: 'context_edit', revision: 2, status: 'activated', turnId: 'turn-ev', effectiveAt: 'step',
  });
  ws.close();
});
