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
import { createTestSql, testActorHandle } from '@kinu.run/test-utils';
import { ActorClaimStore, initActorClaimTables } from '../src/orchestrator/actor-claims';
import { createActorContextPlane, type ContextEditEvent } from '../src/orchestrator/context-plane';
import { contextMount, decodeWorkingFile, encodeWorkingFile } from '../src/vfs/context-plane';
import { withMountTable } from '../src/vfs/mounts';
import { makeVfsError } from '../src/vfs/errno';
import { composePrepareStep } from '../src/prompting/prepare-step';
import { DynamicContextLedger } from '../src/prompting/volatile-context';
import { createFileDispatcher } from '../src/tools/file-tool';
import { TurnFileLedger } from '../src/tools/file-ledger';
import { TurnContextBudget } from '../src/context-budget';
import type { ActorContextStores, ChildContextResolver } from '../src/vfs/context-plane';
import type { VFS } from '../src/types/primitives';
import type { ActorHandle } from '../src/state/actor-handle';
import type { JsonValue } from '../src/utils/json';

const PROGRAM = { kind: 'builtin' as const, version: 0, digest: null, build: null };

interface Bound {
  readonly handle: ActorHandle;
  readonly claims: ActorClaimStore;
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
  readonly close: () => void;
}

function workspace(): Workspace {
  const { sql, execRaw, close } = createTestSql();
  initActorClaimTables(execRaw);
  const transactionSync = <T>(write: () => T): T => write();
  return {
    bind: (actorId) => {
      const handle = testActorHandle(sql, { actorId });
      const claims = new ActorClaimStore(sql, handle, transactionSync);
      // `events: null` here: the emission contract has its own test with a
      // capture port, and every OTHER test in this file is about the bytes and
      // the rows, which are the durable record either way.
      return { handle, claims, stores: { actorId, claims, events: null } };
    },
    close,
  };
}

function planeFor(bound: Bound, children?: ChildContextResolver): VFS {
  return withMountTable(emptyTree(), [contextMount({ stores: () => bound.stores, children })]);
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

test('a fresh actor serves an empty working history at revision 0, and an edit of it becomes revision 1', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-fresh');
  const vfs = planeFor(actor);

  // Before ANY turn: the path exists, reads, and names a revision. This is the
  // arm that used to be unreachable — a claims getter with no claim.
  const before = await readText(vfs, '/context/working.jsonl');
  const parsedBefore = decodeWorkingFile(before);
  expect(parsedBefore.header).toMatchObject({ actor: 'actor-fresh', revision: 0 });
  expect(parsedBefore.messages).toEqual([]);

  const edited: ModelMessage[] = [{ role: 'user', content: 'seeded before the first turn' }];
  await vfs.writeFile('/context/working.jsonl', encodeWorkingFile(
    { ...parsedBefore.header, status: 'empty', effectiveAt: 'turn', turn: null }, edited,
  ));

  const after = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));
  expect(after.header.revision).toBe(1);
  expect(after.messages).toEqual(edited);
  // Staged, not active: nothing has consumed it yet, and the plane says so
  // rather than claiming the edit is in effect.
  const state = createActorContextPlane({ claims: actor.claims }).read();
  expect(state.staged?.revision).toBe(1);
  expect(state.active).toBeNull();
  expect(state.effectiveAt).toBe('turn');
  ws.close();
});

test('two edits from the same read: the second is refused stale and the first survives', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-cas');
  const vfs = planeFor(actor);
  const plane = createActorContextPlane({ claims: actor.claims });
  plane.hydrate([{ role: 'user', content: 'original' }]);

  const observed = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));
  const header = { ...observed.header, status: 'active' as const, effectiveAt: 'turn' as const, turn: null };
  await vfs.writeFile('/context/working.jsonl', encodeWorkingFile(header, [{ role: 'user', content: 'first edit' }]));

  // The same header again — a second editor that read before the first wrote.
  await expect(vfs.writeFile('/context/working.jsonl', encodeWorkingFile(
    header, [{ role: 'user', content: 'second edit' }],
  ))).rejects.toMatchObject({ verdict: 'stale' });

  const head = plane.read().head;
  expect(head?.messages).toEqual([{ role: 'user', content: 'first edit' }]);
  expect(head?.revision).toBe(2);
  ws.close();
});

test('a header naming another actor is refused, and the caller cannot retarget by writing one', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-self');
  const other = ws.bind('actor-other');
  const vfs = planeFor(actor);
  createActorContextPlane({ claims: actor.claims }).hydrate([{ role: 'user', content: 'mine' }]);
  createActorContextPlane({ claims: other.claims }).hydrate([{ role: 'user', content: 'theirs' }]);

  const observed = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));
  await expect(vfs.writeFile('/context/working.jsonl', encodeWorkingFile(
    { ...observed.header, actor: 'actor-other' }, [{ role: 'user', content: 'written through the wrong plane' }],
  ))).rejects.toMatchObject({ code: 'EACCES' });

  // Neither actor's history moved.
  expect(createActorContextPlane({ claims: actor.claims }).read().head?.messages)
    .toEqual([{ role: 'user', content: 'mine' }]);
  expect(createActorContextPlane({ claims: other.claims }).read().head?.messages)
    .toEqual([{ role: 'user', content: 'theirs' }]);
  ws.close();
});

test('a working history that severs a tool call from its result is refused before anything is staged', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-pairing');
  const vfs = planeFor(actor);
  const plane = createActorContextPlane({ claims: actor.claims });
  plane.hydrate([{ role: 'user', content: 'ask' }]);
  const observed = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));

  await expect(vfs.writeFile('/context/working.jsonl', encodeWorkingFile(observed.header, [
    { role: 'user', content: 'ask' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c9', toolName: 'probe', input: {} }] },
  ]))).rejects.toMatchObject({ code: 'bad_input' });

  expect(plane.read().staged).toBeNull();
  expect(plane.read().head?.revision).toBe(1);
  ws.close();
});

test('evidence under /context is readable and not writable, and the plane invents no filesystem', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-evidence');
  const vfs = planeFor(actor);
  const plane = createActorContextPlane({ claims: actor.claims });
  const admitted = plane.startTurn({ turnId: 'turn-1', history: [{ role: 'user', content: 'q' }] });
  const claim = actor.claims.admit({
    runId: 'run-1', turnId: 'turn-1', workMode: 'build', program: PROGRAM,
    context: admitted.messages, workingRevision: admitted.workingRevision,
  });
  plane.steps(claim).consume({
    stepNumber: 0, messages: admitted.messages, base: null, deferred: null,
  });

  const listing = await vfs.readdir('/context');
  expect(listing).toContain('working.jsonl');
  expect(listing).toContain('claim.json');
  expect(listing).toContain('requests');

  expect(await vfs.readdir('/context/requests')).toEqual(['turn-1']);
  expect(await vfs.readdir('/context/requests/turn-1')).toEqual(['0.json', '1.json']);
  const request = JSON.parse(await readText(vfs, '/context/requests/turn-1/1.json'));
  expect(request).toMatchObject({ turnId: 'turn-1', stepIndex: 0, workingRevision: admitted.workingRevision });

  await expect(vfs.writeFile('/context/claim.json', '{}')).rejects.toMatchObject({ code: 'EACCES' });
  await expect(vfs.writeFile('/context/requests/turn-1/1.json', '{}')).rejects.toMatchObject({ code: 'EACCES' });
  await expect(vfs.unlink('/context/working.jsonl')).rejects.toMatchObject({ code: 'EACCES' });
  await expect(vfs.mkdir('/context/whatever')).rejects.toMatchObject({ code: 'EACCES' });
  expect(await vfs.exists('/context/nothing-here.json')).toBe(false);
  ws.close();
});

test('a rollback is a new revision written from a retained one, and the audit it came from is unchanged', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-rollback');
  const vfs = planeFor(actor);
  const plane = createActorContextPlane({ claims: actor.claims });
  plane.hydrate([{ role: 'user', content: 'the good history' }]);
  const first = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));

  await vfs.writeFile('/context/working.jsonl', encodeWorkingFile(
    first.header, [{ role: 'user', content: 'a regrettable edit' }],
  ));
  const regret = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));
  expect(regret.messages).toEqual([{ role: 'user', content: 'a regrettable edit' }]);

  // Roll back BY WRITING the validated prior revision's OWN retained bytes
  // back, read out of its revision file rather than retyped: that is what
  // makes a rollback a real path rather than an assertion about one.
  const prior = JSON.parse(await readText(vfs, `/context/revisions/${first.header.revision}.json`));
  expect(prior).toMatchObject({ revision: first.header.revision, source: 'hydrate' });
  const priorMessages = v.parse(v.array(v.unknown()), prior.messages);
  await vfs.writeFile('/context/working.jsonl', [
    JSON.stringify({ $context: regret.header }),
    ...priorMessages.map((message) => JSON.stringify(message)),
  ].join('\n') + '\n');

  const rolled = plane.read().head;
  expect(rolled?.revision).toBe(3);
  expect(rolled?.messages).toEqual([{ role: 'user', content: 'the good history' }]);
  // The regretted revision is still there, with its own author and base — a
  // rollback does not erase what it rolled back.
  const history = actor.claims.working.history();
  expect(history.map((row) => row.revision)).toEqual([3, 2, 1]);
  expect(history.find((row) => row.revision === 2)).toMatchObject({
    source: 'edit', via: 'file', author: 'actor-rollback', baseRevision: 1,
  });
  expect(JSON.parse(await readText(vfs, '/context/revisions/2.json')))
    .toMatchObject({ messageCount: 1, status: 'superseded' });
  ws.close();
});

test('an authorized parent edits a child through the child\'s own store; a sibling key is not addressable', async () => {
  const ws = workspace();
  const parent = ws.bind('actor-parent');
  const child = ws.bind('actor-child');
  const stranger = ws.bind('actor-stranger');
  createActorContextPlane({ claims: child.claims }).hydrate([{ role: 'user', content: 'child history' }]);
  createActorContextPlane({ claims: stranger.claims }).hydrate([{ role: 'user', content: 'stranger history' }]);

  const resolver: ChildContextResolver = {
    list: () => ['agent:child'],
    resolve: (key) => (key === 'agent:child' ? child.stores : null),
  };
  const vfs = planeFor(parent, resolver);

  expect(await vfs.readdir('/context/agents')).toEqual(['agent:child']);
  const seen = decodeWorkingFile(await readText(vfs, '/context/agents/agent:child/working.jsonl'));
  expect(seen.header.actor).toBe('actor-child');
  expect(seen.messages).toEqual([{ role: 'user', content: 'child history' }]);

  await vfs.writeFile('/context/agents/agent:child/working.jsonl', encodeWorkingFile(
    seen.header, [{ role: 'user', content: 'parent corrected this' }],
  ));
  const staged = child.claims.working.staged();
  // The child's row, authored by the PARENT, through the child's own handle.
  expect(staged).toMatchObject({ author: 'actor-parent', via: 'owner', messageCount: 1 });
  expect(staged?.messages).toEqual([{ role: 'user', content: 'parent corrected this' }]);

  // A key the resolver does not own is absent, whatever the caller writes.
  await expect(readText(vfs, '/context/agents/agent:stranger/working.jsonl'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(vfs.writeFile('/context/agents/agent:stranger/working.jsonl', 'x'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  expect(stranger.claims.working.staged()).toBeNull();
  ws.close();
});

test('a retired actor stops authorising context reads and writes at its own handle', async () => {
  const { sql, execRaw, close } = createTestSql();
  initActorClaimTables(execRaw);
  let live = true;
  const handle = testActorHandle(sql, { actorId: 'actor-retired', live: () => live });
  const claims = new ActorClaimStore(sql, handle, (write) => write());
  const vfs = withMountTable(emptyTree(), [contextMount({
    stores: () => ({ actorId: 'actor-retired', claims, events: null }),
  })]);
  createActorContextPlane({ claims }).hydrate([{ role: 'user', content: 'while live' }]);
  const observed = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));

  live = false;
  await expect(readText(vfs, '/context/working.jsonl')).rejects.toThrow();
  await expect(vfs.writeFile('/context/working.jsonl', encodeWorkingFile(
    observed.header, [{ role: 'user', content: 'after retirement' }],
  ))).rejects.toThrow();

  live = true;
  expect(claims.working.staged()).toBeNull();
  close();
});

test('the native file tool reads, edits and re-reads the working history over the same plane', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-native');
  const vfs = planeFor(actor);
  const plane = createActorContextPlane({ claims: actor.claims });
  plane.hydrate([
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

  const staged = plane.read().staged;
  expect(staged?.messages[0]).toEqual({ role: 'user', content: 'remember the RIGHT fact' });
  // The assistant turn the edit did not touch is still there, and still typed.
  expect(staged?.messages[1]).toEqual({ role: 'assistant', content: 'noted' });
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
  const plane = createActorContextPlane({ claims: actor.claims });
  const attachment = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  plane.hydrate([
    { role: 'user', content: [
      { type: 'text', text: 'look at this' },
      { type: 'file', data: attachment, mediaType: 'image/png' },
    ] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'probe', input: { path: 'a' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'json', value: { ok: true } } }] },
  ]);

  const text = await readText(vfs, '/context/working.jsonl');
  // Not a lossy JSON dump of the bytes: `{"0":137,…}` is exactly what the codec
  // exists to avoid, and it would not decode back to a Uint8Array.
  expect(text).not.toContain('"0":137');
  const observed = decodeWorkingFile(text);

  // Write the array straight back and read it again: the attachment and the
  // tool pairing must be byte-identical, or an edit would quietly corrupt the
  // context it claims to preserve.
  await vfs.writeFile('/context/working.jsonl', encodeWorkingFile(observed.header, observed.messages));
  const roundTripped = plane.read().head?.messages ?? [];
  const parts = Array.isArray(roundTripped[0]?.content) ? roundTripped[0].content : [];
  const attached = parts.find((part) => part.type === 'file');
  const data = attached && 'data' in attached ? attached.data : undefined;
  if (!(data instanceof Uint8Array)) throw new Error('the attachment must decode to its own bytes');
  expect([...data]).toEqual([...attachment]);
  expect(roundTripped[2]).toEqual({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'json', value: { ok: true } } }],
  });
  ws.close();
});

test('the owner UI path gets a real conditional write, and a conflicting revision is refused', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-ui');
  const vfs = planeFor(actor);
  createActorContextPlane({ claims: actor.claims }).hydrate([{ role: 'user', content: 'from the browser' }]);

  const stat = await vfs.stat('/context/working.jsonl');
  expect(stat?.revision).toBe(1);
  const observed = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));
  const conditional = vfs.writeFileIfRevision;
  if (conditional === undefined) throw new Error('the context plane must offer a conditional write');

  const saved = await conditional.call(vfs, '/context/working.jsonl',
    new TextEncoder().encode(encodeWorkingFile(observed.header, [{ role: 'user', content: 'edited in the browser' }])),
    1);
  expect(saved).toMatchObject({ ok: true, revision: 2 });

  await expect(conditional.call(vfs, '/context/working.jsonl',
    new TextEncoder().encode(encodeWorkingFile(observed.header, [{ role: 'user', content: 'from a stale tab' }])),
    1)).rejects.toMatchObject({ verdict: 'stale' });
  ws.close();
});

/**
 * THE DEFECT, at the seam it lived in.
 *
 * The step pipeline holds two arrays: the live RAW one the SDK rebuilds each
 * step, and the FINAL rendered one a provider receives. A landed edit's
 * protected tail is a slice of the raw array, and the count it slices at used
 * to be read off a RENDERED revision — so one woven `<dynamic_context>` block
 * moved the boundary by one message and the tail lost its head. With an
 * assistant tool call as the first tail message, that is a tool result with no
 * call in front of it: the shape a provider rejects outright.
 */
test('a landed edit preserves the raw tail exactly, with a woven block and a pruned tool output in play', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-coordinates');
  const plane = createActorContextPlane({ claims: actor.claims });
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
  const admitted = plane.startTurn({ turnId: 'turn-coord', history: older });
  expect(admitted.messages).toHaveLength(3);
  const claim = actor.claims.admit({
    runId: 'run-coord', turnId: 'turn-coord', workMode: 'build', program: PROGRAM,
    context: admitted.messages, workingRevision: admitted.workingRevision,
  });
  const steps = plane.steps(claim);

  // STEP 0 — the array the turn was admitted with. The rendered request is
  // LONGER than the raw array, because the ledger froze a block: that gap
  // between the two counts is the whole premise of the defect.
  const first = composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 0, messages: [...admitted.messages], steps: [] });
  if (first instanceof Promise) throw new Error('this pipeline is synchronous');
  expect(first?.messages).toHaveLength(4);
  const renderedFirst = actor.claims.consumedContext('turn-coord');
  expect(renderedFirst?.messageCount).toBe(4);
  // The rendered row points at the RAW revision it came from, and that
  // revision's own count is 3: two spaces, one pointer, no arithmetic between.
  expect(renderedFirst?.workingRevision).toBe(admitted.workingRevision);
  expect(actor.claims.working.revision(admitted.workingRevision)?.messageCount).toBe(3);

  // The model called a tool; its result came back. This is the protected tail.
  const live: ModelMessage[] = [
    ...older,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'probe', input: { path: 'a' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'probe', output: { type: 'text', value: 'fresh output' } }] },
  ];
  // The edit keeps the old exchange (it is real work that happened) and
  // rewrites only the question that framed it.
  plane.edit({
    base: 1,
    messages: [{ role: 'user', content: 'corrected question' }, ...older.slice(1)],
    author: 'actor-coordinates', via: 'file',
  });

  // STEP 1 — the edit lands here.
  const second = composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 1, messages: [...live], steps: [] });
  if (second instanceof Promise) throw new Error('this pipeline is synchronous');
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

  // The edit is now the working history, activated at the step that took it.
  const active = actor.claims.working.active();
  expect(active).toMatchObject({ revision: 2, status: 'active', activatedStep: 1, activatedTurnId: 'turn-coord' });
  expect(actor.claims.consumedContext('turn-coord')?.workingRevision).toBe(2);

  // STEP 2 — nothing new is staged, and the edit must STILL be applied: a
  // prepareStep override shapes one request and never becomes the SDK's next
  // input, so an edit that landed once has to keep landing.
  const third = composePrepareStep({ prune, dynamic, context: steps },
    { stepNumber: 2, messages: [...live], steps: [] });
  if (third instanceof Promise) throw new Error('this pipeline is synchronous');
  expect(third?.messages?.[0]).toEqual({ role: 'user', content: 'corrected question' });
  ws.close();
});

test('an edit mid-exchange is deferred with its reason, then lands at the next safe boundary', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-defer');
  const plane = createActorContextPlane({ claims: actor.claims });
  const admitted = plane.startTurn({ turnId: 'turn-defer', history: [{ role: 'user', content: 'ask' }] });
  const claim = actor.claims.admit({
    runId: 'run-defer', turnId: 'turn-defer', workMode: 'build', program: PROGRAM,
    context: admitted.messages, workingRevision: admitted.workingRevision,
  });
  const steps = plane.steps(claim);
  plane.edit({ base: 1, messages: [{ role: 'user', content: 'edited ask' }], author: 'actor-defer', via: 'session' });

  // A tool call whose result has not arrived: substituting history under a
  // half-finished exchange is what this defers.
  const midExchange: ModelMessage[] = [
    { role: 'user', content: 'ask' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'probe', input: {} }] },
  ];
  const deferred = composePrepareStep({ context: steps }, { stepNumber: 1, messages: [...midExchange], steps: [] });
  if (deferred instanceof Promise) throw new Error('this pipeline is synchronous');
  // The request went out on the UNEDITED history — the pipeline changed
  // nothing, so it returns no override at all — and the edit is still staged
  // with the reason recorded: reported, not dropped, and not half-applied.
  expect(deferred).toBeUndefined();
  const rendered = actor.claims.consumedContext('turn-defer');
  expect(rendered?.messages).toEqual(midExchange);
  const staged = actor.claims.working.staged();
  expect(staged).toMatchObject({ revision: 2, status: 'staged', deferredReason: 'unpaired_tool_call' });
  expect(actor.claims.consumedContext('turn-defer')?.workingRevision).toBe(claim.workingRevision);

  // The result arrives; the very next boundary takes the edit.
  const settled: ModelMessage[] = [...midExchange, {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'c2', toolName: 'probe', output: { type: 'json', value: { ok: true } } }],
  }];
  const landed = composePrepareStep({ context: steps }, { stepNumber: 2, messages: [...settled], steps: [] });
  if (landed instanceof Promise) throw new Error('this pipeline is synchronous');
  expect(landed?.messages?.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  expect(landed?.messages?.[0]).toEqual({ role: 'user', content: 'edited ask' });
  expect(actor.claims.working.active()).toMatchObject({ revision: 2, activatedStep: 2, deferredReason: null });
  ws.close();
});

test('an edit authored between turns is consumed by the next turn with the new input preserved once', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-between');
  const vfs = planeFor(actor);
  const plane = createActorContextPlane({ claims: actor.claims });

  // A settled turn leaves the working history it produced.
  const first = plane.startTurn({ turnId: 'turn-one', history: [{ role: 'user', content: 'first question' }] });
  const claim = actor.claims.admit({
    runId: 'run-one', turnId: 'turn-one', workMode: 'build', program: PROGRAM,
    context: first.messages, workingRevision: first.workingRevision,
  });
  actor.claims.settle(claim, 'completed');
  const settled = plane.endTurn({ turnId: 'turn-one', history: [
    { role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' },
  ] });
  expect(settled.messages).toHaveLength(2);

  // Between turns: the file serves the settled history, and an edit of it says
  // it becomes effective at the next TURN rather than the next step.
  const observed = decodeWorkingFile(await readText(vfs, '/context/working.jsonl'));
  expect(observed.header.effectiveAt).toBe('turn');
  expect(observed.messages).toHaveLength(2);
  await vfs.writeFile('/context/working.jsonl', encodeWorkingFile(observed.header, [
    { role: 'user', content: 'first question, corrected' },
    { role: 'assistant', content: 'first answer' },
  ]));

  // The next turn's input arrives after the edit was authored.
  const next = plane.startTurn({ turnId: 'turn-two', history: [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ] });
  expect(next.messages).toEqual([
    { role: 'user', content: 'first question, corrected' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
  ]);
  // Exactly once: the new input is neither dropped nor duplicated, and the
  // admitted revision is a NEW one that re-anchors the offset to this array.
  expect(next.messages.filter((message) => message.content === 'second question')).toHaveLength(1);
  const admittedRevision = actor.claims.working.revision(next.workingRevision);
  expect(admittedRevision).toMatchObject({ source: 'turn', messageCount: 3, baseMessageCount: 3 });
  // The edit is recorded as effective at that turn boundary, not at a step.
  expect(actor.claims.working.revision(3)).toMatchObject({
    source: 'edit', activatedTurnId: 'turn-two', activatedStep: null,
  });
  ws.close();
});

test('a cold reader with no live turn can read and edit the working history it will resume on', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-cold');
  const plane = createActorContextPlane({ claims: actor.claims });
  const admitted = plane.startTurn({ turnId: 'turn-crash', history: [{ role: 'user', content: 'before the crash' }] });
  actor.claims.admit({
    runId: 'run-crash', turnId: 'turn-crash', workMode: 'build', program: PROGRAM,
    context: admitted.messages, workingRevision: admitted.workingRevision,
  });

  // A SECOND store bundle over the same database, bound to the same issued
  // actor: what an activation that did not run the turn can see.
  const cold = ws.bind('actor-cold');
  const coldVfs = planeFor(cold);
  const seen = decodeWorkingFile(await readText(coldVfs, '/context/working.jsonl'));
  expect(seen.messages).toEqual([{ role: 'user', content: 'before the crash' }]);
  expect(seen.header.revision).toBe(1);
  // The recovered activation may edit it, and the edit is staged against the
  // revision it read — no live turn required, and no getter that throws.
  await coldVfs.writeFile('/context/working.jsonl', encodeWorkingFile(
    seen.header, [{ role: 'user', content: 'recovered and corrected' }],
  ));
  expect(cold.claims.working.staged()).toMatchObject({ revision: 2, via: 'file' });
  ws.close();
});

test('an edit emits its authoring and its activation, and a refused edit emits nothing', async () => {
  const ws = workspace();
  const actor = ws.bind('actor-events');
  const emitted: Array<{ runId: string; event: ContextEditEvent }> = [];
  const plane = createActorContextPlane({
    claims: actor.claims,
    events: { emit: (runId, event) => { emitted.push({ runId, event }); } },
  });

  const admitted = plane.startTurn({ turnId: 'turn-ev', history: [{ role: 'user', content: 'ask' }] });
  const claim = actor.claims.admit({
    runId: 'run-ev', turnId: 'turn-ev', workMode: 'build', program: PROGRAM,
    context: admitted.messages, workingRevision: admitted.workingRevision,
  });
  // Authoring: one event, naming the author, both revisions and where it lands.
  plane.edit({ base: 1, messages: [{ role: 'user', content: 'edited ask' }], author: 'actor-events', via: 'file' });
  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({ runId: 'run-ev', event: {
    type: 'context_edit', revision: 2, baseRevision: 1, messageCount: 1,
    author: 'actor-events', via: 'file', status: 'staged', effectiveAt: 'step',
    turnId: 'turn-ev', stepIndex: null,
  } });

  // A refused edit — stale base — adds nothing: there is no activation to
  // report, and reporting one would record something that did not happen.
  expect(() => plane.edit({
    base: 1, messages: [{ role: 'user', content: 'from a stale read' }], author: 'actor-events', via: 'file',
  })).toThrow();
  expect(emitted).toHaveLength(1);

  // Activation: the boundary that took it says which turn and step.
  const steps = plane.steps(claim);
  const base = steps.base();
  steps.consume({ stepNumber: 3, messages: admitted.messages, base, deferred: null });
  expect(emitted).toHaveLength(2);
  expect(emitted[1]?.event).toMatchObject({
    type: 'context_edit', revision: 2, status: 'activated', turnId: 'turn-ev', stepIndex: 3, effectiveAt: 'step',
  });
  ws.close();
});
