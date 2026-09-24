/** A fork over two in-memory bun:sqlite handles, seeded through the production schema, filesystem and
 *  session writers, and carried by the production frame stream into the production receiver. */

import { describe, test, expect } from 'bun:test';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';
import { forkTransferFrames, readForkLineage, readSoul } from '../src/index';
import { createTestWorkspace as fresh, type TestWorkspace } from './helpers';
import {
  ForkConversation, readChain, readWorkingContext, seedForkSource, seedForkTarget,
  SOURCE_ARTIFACTS, SPILLED_BYTES, TARGET_ARTIFACTS,
} from './helpers/fork-conversation';
import { streamFork } from './helpers/fork-stream';
import { snapshotForkFiles } from '../src/identity/fork';
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../src/config/store';
import { openWorkspaceMainActor } from '../src/identity/workspace-actors';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';

function forkInto(src: TestWorkspace, tgt: TestWorkspace, opts: {
  untilMessageId: string; targetWorkspaceId?: string; targetWorkspaceName?: string; now?: number; frameBytes?: number;
}) {
  return streamFork(src, tgt, {
    workspaceId: opts.targetWorkspaceId ?? 'TGT',
    workspaceName: opts.targetWorkspaceName ?? 'my-fork',
    artifactDirectory: TARGET_ARTIFACTS,
    now: opts.now ?? Date.now(),
  }, { untilMessageId: opts.untilMessageId, artifactDirectory: SOURCE_ARTIFACTS, frameBytes: opts.frameBytes });
}

/** The workspace's own synchronous plane, as the session user: modes, symlinks and mtimes. */
async function plane(ws: TestWorkspace) {
  return (await ws.bundle.session()).vfs.as(CRED_SESSION_USER);
}

/** Ids of everything the fork authored, so assertions need not spell the marker's generated id. */
const inherited = (ids: readonly string[]): string[] => ids.filter((id) => !id.startsWith('fork-marker-'));

describe('a workspace fork', () => {
  test('carries the cut point\'s ancestry and nothing past it', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt, { workspaceId: 'TGT' });
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    await chat.say({ id: 'm2', role: 'assistant', text: 'hello' });
    await chat.say({ id: 'm3', role: 'user', text: 'second' });

    const result = await forkInto(src, tgt, { untilMessageId: 'm2' });

    expect(result.forkPointMs).toBeGreaterThan(0);
    // A fork reports the public chain it carried: two entries, not the source's three.
    expect(result.messagesCopied).toBe(2);
    const chain = await readChain(tgt);
    expect(inherited(chain.ids)).toEqual(['m1', 'm2']);
    expect(chain.text.slice(0, 2)).toEqual(['hi', 'hello']);
    expect(await readSoul(tgt.vfs)).toBe('help with testing');
  });

  test('a sibling branch of the cut is not inherited', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'root', parentId: null });
    await chat.say({ id: 'm2', role: 'assistant', text: 'first child' });
    // A second child of the same parent: a prefix cut cannot express this, and
    // an ancestry cut must not carry it.
    await chat.say({ id: 'sib', role: 'assistant', text: 'second child', parentId: 'm1' });

    await forkInto(src, tgt, { untilMessageId: 'm2' });

    expect(inherited((await readChain(tgt)).ids)).toEqual(['m1', 'm2']);
  });

  test('restores the working context the cut entry recorded, not the live one', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'keep me', parentId: null });
    await chat.say({ id: 'm2', role: 'assistant', text: 'prune me' });
    chat.prune('m2');
    await chat.say({ id: 'm3', role: 'user', text: 'after the prune' });

    await forkInto(src, tgt, { untilMessageId: 'm3' });

    // The public chain keeps the pruned turn; the model's context does not.
    expect(inherited((await readChain(tgt)).ids)).toEqual(['m1', 'm2', 'm3']);
    const working = await readWorkingContext(tgt, TARGET_ARTIFACTS);
    expect(working.entryIds).toEqual(['m1', 'm3']);
    expect(working.messages).toEqual([
      { role: 'user', content: 'keep me' },
      { role: 'user', content: 'after the prune' },
    ]);
  });

  test('carries a context-only tool exchange that the public chain never held', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'run the probe', parentId: null });
    // A step's call and result: the model reads them, the transcript does not
    // show them as entries of its own.
    await chat.toolExchange({
      callId: 'call', resultId: 'result', toolName: 'probe', toolCallId: 'tc-1',
      output: { ok: true }, chain: false,
    });
    await chat.say({ id: 'm2', role: 'assistant', text: 'the probe passed' });

    const before = await readWorkingContext(src, SOURCE_ARTIFACTS);

    await forkInto(src, tgt, { untilMessageId: 'm2' });

    expect(inherited((await readChain(tgt)).ids)).toEqual(['m1', 'm2']);
    const working = await readWorkingContext(tgt, TARGET_ARTIFACTS);
    expect(working.entryIds).toEqual(['m1', 'call', 'result', 'm2']);
    expect(working.messages).toEqual(before.messages);
    expect(working.messages[2]).toMatchObject({ role: 'tool' });
  });

  test('a message still open in the source refuses the fork', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    // An answer mid-stream: its row is open and its parts live in stream_parts.
    chat.atomic(() => chat.messages.open('assistant', 'm2', 'output'));
    chat.messages.streamOpenPart('m2', { partNo: 0, kind: 'text', streamOrder: 0, descriptor: { json: '{"type":"text"}', path: null, digest: null }, text: 'partial' });
    chat.transcript.record({ id: 'm2', parentId: 'm1', role: 'assistant', turnId: null, runId: null, metadata: null, parts: [{ messageId: 'm2', partNo: 0 }] });

    await expect(forkInto(src, tgt, { untilMessageId: 'm2' })).rejects.toThrow(/still open in the source/);
  });

  test('re-roots carried payload files under the target\'s artifact directory', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    const spilled = 'p'.repeat(SPILLED_BYTES);
    await chat.say({ id: 'm1', role: 'user', text: spilled, parentId: null, metadata: { note: 'q'.repeat(SPILLED_BYTES) } });

    const stored = src.sql<{ content_path: string | null }>`
      SELECT content_path FROM session_messages WHERE content_path IS NOT NULL`;

    expect(stored.length).toBeGreaterThan(0);

    await forkInto(src, tgt, { untilMessageId: 'm1' });

    const landed = tgt.sql<{ content_path: string }>`
      SELECT content_path FROM session_messages WHERE content_path IS NOT NULL`;

    expect(landed.length).toBe(stored.length);
    expect(landed.every((row) => row.content_path.startsWith(`${TARGET_ARTIFACTS}/`))).toBe(true);
    // The production reader resolves each path on the target's plane and refuses a digest mismatch.
    expect((await readChain(tgt)).text[0]).toBe(spilled);

    const metadata = tgt.sql<{ metadata_path: string }>`
      SELECT metadata_path FROM conversation_entries WHERE metadata_path IS NOT NULL`;

    expect(metadata.length).toBe(1);
    expect(metadata[0]?.metadata_path.startsWith(`${TARGET_ARTIFACTS}/`)).toBe(true);
  });

  test('a payload reference outside the source artifact directory is refused by path', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'p'.repeat(SPILLED_BYTES), parentId: null });
    void src.sql`UPDATE session_messages SET content_path = ${'/elsewhere/leaked.json'} WHERE content_path IS NOT NULL`;

    await expect(forkInto(src, tgt, { untilMessageId: 'm1' }))
      .rejects.toThrow(/\/elsewhere\/leaked\.json/);
  });

  test('the staged rows satisfy the canonical foreign keys under enforcement', async () => {
    const src = fresh();
    const tgt = fresh();
    // The hosted target checks foreign keys per statement and a streamed fork has no spanning transaction,
    // so staging order alone must satisfy them.
    src.db.exec('PRAGMA foreign_keys = ON');
    tgt.db.exec('PRAGMA foreign_keys = ON');
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    await chat.toolExchange({
      callId: 'call', resultId: 'result', toolName: 'probe', toolCallId: 'tc-1', output: { ok: true }, chain: false,
    });
    await chat.say({ id: 'm2', role: 'assistant', text: 'done' });

    await forkInto(src, tgt, { untilMessageId: 'm2' });

    expect(readForkLineage(tgt.sql)?.sourceMessageId).toBe('m2');
    expect(tgt.sql<{ table: string; rowid: number }>`PRAGMA foreign_key_check`).toEqual([]);

    // A redelivery clears a populated store first, so clearing must release an entry's parent edge first.
    await forkInto(src, tgt, { untilMessageId: 'm2' });

    expect(tgt.sql<{ table: string; rowid: number }>`PRAGMA foreign_key_check`).toEqual([]);
    expect(inherited((await readChain(tgt)).ids)).toEqual(['m1', 'm2']);
  });

  test('the fork marker is a public entry parented on the cut, readable as a message', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src, { workspaceName: 'alpha' });
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    await chat.say({ id: 'm2', role: 'assistant', text: 'hi back' });

    await forkInto(src, tgt, { untilMessageId: 'm2', now: 5000 });

    const chain = await readChain(tgt);
    const markerId = chain.ids[chain.ids.length - 1];
    expect(markerId?.startsWith('fork-marker-')).toBe(true);

    const marker = tgt.sql<{ parent_id: string | null; role: string }>`
      SELECT parent_id, role FROM conversation_entries WHERE id = ${markerId ?? ''}`[0];

    expect(marker).toEqual({ parent_id: 'm2', role: 'system' });
    expect(chain.text[chain.text.length - 1]).toContain('forked from workspace');
    expect(chain.text[chain.text.length - 1]).toContain('alpha');
    // The marker is a node of the chain, not a member of the working context.
    expect((await readWorkingContext(tgt, TARGET_ARTIFACTS)).entryIds).not.toContain(markerId);
  });

  test('copies crafted_tools verbatim but not their earned quality', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);

    const chat = await seedForkSource(src, {
      craftedTools: [{ name: 'doubleIt', description: 'doubles', code: 'async (n) => n * 2' }],
    });

    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    void src.sql`UPDATE crafted_tools SET score = ${0.9}, uses = ${12} WHERE name = ${'doubleIt'}`;

    const result = await forkInto(src, tgt, { untilMessageId: 'm1' });

    expect(result.craftedToolsCopied).toBe(1);

    expect(tgt.sql<{ name: string; code: string; score: number; uses: number }>`
      SELECT name, code, score, uses FROM crafted_tools`).toEqual([
      { name: 'doubleIt', code: 'async (n) => n * 2', score: 0.5, uses: 0 },
    ]);
  });

  test('resets search and evolution state', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    const srcActor = openWorkspaceMainActor(src.sql).actorId;
    void src.sql`INSERT INTO search_nodes (actor_id, id, root_id, task, action, visits, value) VALUES (${srcActor}, ${'n1'}, ${'n1'}, ${'t'}, ${'a'}, ${3}, ${0.8})`;
    void src.sql`INSERT INTO evolution_events (actor_id, type, message) VALUES (${srcActor}, ${'reflection'}, ${'done'})`;

    await forkInto(src, tgt, { untilMessageId: 'm1' });

    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`[0]?.c).toBe(0);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) as c FROM evolution_events`[0]?.c).toBe(0);
  });

  test('copies memory files but not the scaffold', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src, { memory: [{ path: 'memory/MEMORY.md', text: 'remembered' }] });
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    await src.vfs.mkdir('scaffold', { recursive: true });
    await src.vfs.writeFile('scaffold/agent.js', '// scaffold source');

    await forkInto(src, tgt, { untilMessageId: 'm1' });

    expect(await tgt.vfs.readFile('memory/MEMORY.md', { encoding: 'utf8' })).toBe('remembered');
    expect(await tgt.vfs.exists('scaffold/agent.js')).toBe(false);
  });

  test('carries the project tree as it stands: files, directories, modes, mtimes and symlinks', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    const at = (path: string) => `${WORKSPACE_ROOT}/${path}`;
    const mtime = Date.parse('2026-01-02T03:04:05.000Z');
    const binary = Uint8Array.from({ length: 300 }, (_, index) => index % 256);
    const source = await plane(src);
    source.mkdir(at('app/src'), { recursive: true });
    source.writeFile(at('app/src/main.ts'), 'export const answer = 42;\n');
    source.utimes(at('app/src/main.ts'), mtime, mtime);
    source.writeFile(at('app/run.sh'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
    // Larger than a frame here, so it crosses as ranges rather than whole.
    source.writeFile(at('app/data.bin'), binary);
    source.symlink('src/main.ts', at('app/entry.ts'));
    source.mkdir(at('app/empty'));
    source.mkdir(at('.nimbus/runtimes'), { recursive: true });
    source.writeFile(at('.nimbus/runtimes/installed'), 'platform state');

    await forkInto(src, tgt, { untilMessageId: 'm1', frameBytes: 128 });

    const target = await plane(tgt);
    expect(target.readFileString(at('app/src/main.ts'))).toBe('export const answer = 42;\n');
    expect(target.stat(at('app/src/main.ts')).mtime).toBe(mtime);
    expect(target.readFileString(at('app/run.sh'))).toBe('#!/bin/sh\necho ran\n');
    expect(target.stat(at('app/run.sh')).mode & 0o777).toBe(0o755);
    expect(target.readFile(at('app/data.bin'))).toEqual(binary);
    expect(target.readlink(at('app/entry.ts'))).toBe('src/main.ts');
    expect(target.isDirectory(at('app/empty'))).toBe(true);
    expect(target.exists(at('.nimbus/runtimes/installed'))).toBe(false);
  });

  test('a file written while the fork copies it refuses the fork and names the file', async () => {
    const src = fresh();
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    await src.vfs.writeFile('notes.md', 'as the fork began');

    const frames = forkTransferFrames({
      sql: src.sql, actor: chat.actor, vfs: src.forkSource, artifactDirectory: SOURCE_ARTIFACTS,
      untilMessageId: 'm1', transferId: 'tx-moving', frameBytes: 1024,
    });

    // The first frame is produced after the snapshot, so this write lands between snapshot and copy.
    expect((await frames.next()).value?.kind).toBe('begin');
    await src.vfs.writeFile('notes.md', 'written while the fork copied');

    await expect(Array.fromAsync(frames)).rejects.toThrow(/"notes\.md" changed while the fork was copying/);
  });

  test('writes one fork_lineage row naming the source and the cut', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src, { workspaceId: 'SRC-UUID-123', workspaceName: 'source-alpha' });
    await chat.say({ id: 'msgX', role: 'user', text: 'hi', parentId: null });

    await forkInto(src, tgt, { untilMessageId: 'msgX', targetWorkspaceName: 'fork-beta', now: 9999 });

    const lineage = readForkLineage(tgt.sql);
    expect(lineage?.sourceWorkspaceId).toBe('SRC-UUID-123');
    expect(lineage?.sourceWorkspaceName).toBe('source-alpha');
    expect(lineage?.sourceMessageId).toBe('msgX');
    expect(lineage?.forkedAt).toBe(9999);
  });

  test('a fork of a fork inherits the continuation and names its immediate parent', async () => {
    const a = fresh();
    const b = fresh();
    const c = fresh();
    await seedForkTarget(b, { workspaceId: 'B-ID' });
    await seedForkTarget(c, { workspaceId: 'C-ID' });
    const chat = await seedForkSource(a, { workspaceId: 'A-ID', workspaceName: 'agent-A' });
    await chat.say({ id: 'a1', role: 'user', text: 'in A', parentId: null });
    await chat.say({ id: 'a2', role: 'assistant', text: 'from A' });

    await forkInto(a, b, { untilMessageId: 'a2', targetWorkspaceId: 'B-ID', targetWorkspaceName: 'agent-B', now: 5000 });

    // B's entries land under B's actor, on the leaf the fork left: its marker.
    const inB = new ForkConversation(b, TARGET_ARTIFACTS);
    await inB.say({ id: 'b3', role: 'user', text: 'in B' });
    await inB.say({ id: 'b4', role: 'assistant', text: 'from B' });

    await streamFork(b, c, {
      workspaceId: 'C-ID', workspaceName: 'agent-C', artifactDirectory: TARGET_ARTIFACTS, now: 7000,
    }, { untilMessageId: 'b4', artifactDirectory: TARGET_ARTIFACTS });

    expect(inherited((await readChain(c)).ids)).toEqual(['a1', 'a2', 'b3', 'b4']);
    const lineage = readForkLineage(c.sql);
    expect(lineage?.sourceWorkspaceId).toBe('B-ID');
    expect(lineage?.sourceWorkspaceName).toBe('agent-B');
    expect(lineage?.sourceMessageId).toBe('b4');
  });

  test('an unknown cut point is refused before the target is touched', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });

    await expect(forkInto(src, tgt, { untilMessageId: 'nope' }))
      .rejects.toThrow('fork point not found: message id "nope" does not exist in source');

    expect(readForkLineage(tgt.sql)).toBeNull();
  });

  test('rewrites workspace_identity with the fork\'s id, name and clock', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt, { workspaceId: 'NEW-UUID' });
    const chat = await seedForkSource(src, { workspaceId: 'SRC-UUID' });
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });

    await forkInto(src, tgt, {
      untilMessageId: 'm1', targetWorkspaceId: 'NEW-UUID', targetWorkspaceName: 'fork-name', now: 7777,
    });

    expect(tgt.sql<{ id: string; name: string; created_at: number }>`
      SELECT id, name, created_at FROM workspace_identity`).toEqual([
      { id: 'NEW-UUID', name: 'fork-name', created_at: 7777 },
    ]);
  });

  test('copies actor_config but overwrites display_name', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    chat.actor.config.setDisplayName('src');
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });

    await forkInto(src, tgt, { untilMessageId: 'm1', targetWorkspaceName: 'forked-display' });

    const config = new Map(tgt.sql<{ key: string; value: string }>`
      SELECT key, value FROM actor_config`.map((row) => [row.key, row.value]));

    expect(config.get('model')).toBe('@cf/moonshotai/kimi-k2.6');
    expect(config.get('display_name')).toBe('forked-display');
  });

  test('a fork inherits preferences but never the shell-approval authority', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    // Read live by `ShellApprovalPolicy` before it decides whether to ask the owner.
    chat.actor.config.setShellApprovalMode('allow_all');
    chat.actor.config.set('shell_approval_grants', 'rm -rf *@sandbox,curl *@sandbox');

    await forkInto(src, tgt, { untilMessageId: 'm1' });

    const carried = tgt.sql<{ key: string }>`SELECT key FROM actor_config`.map((row) => row.key);

    // The child asks from scratch yet inherits the preference: this withholds authority, not configuration.
    for (const key of SHELL_APPROVAL_AUTHORITY_KEYS) expect(carried).not.toContain(key);
    expect(carried).toContain('model');
  });

  test('a target that cannot take the memory index fails instead of dropping it', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    tgt.execRaw('DROP TABLE memory_chunks_fts');
    tgt.execRaw('DROP TABLE memory_chunks');
    tgt.execRaw('CREATE TABLE memory_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, content TEXT NOT NULL)');

    await expect(forkInto(src, tgt, { untilMessageId: 'm1' })).rejects.toThrow(/memory_chunks/);
  });

  test('a target that cannot take actor_config fails instead of keeping its bootstrap name', async () => {
    const src = fresh();
    const tgt = fresh();
    await seedForkTarget(tgt);
    const chat = await seedForkSource(src);
    await chat.say({ id: 'm1', role: 'user', text: 'hi', parentId: null });
    tgt.execRaw('DROP TABLE actor_config');

    await expect(forkInto(src, tgt, { untilMessageId: 'm1' })).rejects.toThrow(/actor_config/);
  });

  test('readForkLineage answers null for a workspace that is not a fork', () => {
    expect(readForkLineage(fresh().sql)).toBeNull();
  });
});

describe('the files a fork carries', () => {
  test('SOUL.md first, the tree with each directory after its contents, then payloads once each', async () => {
    const ws = fresh();
    await seedForkSource(ws);
    await ws.vfs.writeFile('b/inner.md', 'inner');
    await ws.vfs.writeFile('a.md', 'top');
    await ws.vfs.writeFile(`${SOURCE_ARTIFACTS}/aaa.json`, '{}');
    await ws.vfs.writeFile(`${SOURCE_ARTIFACTS}/bbb.json`, '{}');
    const payload = (relative: string) => ({ relative, path: `${SOURCE_ARTIFACTS}/${relative}` });

    const snapshot = snapshotForkFiles(await ws.forkSource.open(), [payload('aaa.json'), payload('aaa.json'), payload('bbb.json')]);
    const carried = snapshot.entries.map((entry) => `${entry.kind}:${entry.path}${'artifact' in entry && entry.artifact ? ' (payload)' : ''}`);

    const written = ['file:SOUL.md', 'file:a.md', 'file:b/inner.md', 'directory:b'];

    expect(carried.filter((entry) => written.includes(entry) || entry.endsWith('(payload)'))).toEqual([
      'file:SOUL.md', 'file:a.md', 'file:b/inner.md', 'directory:b', 'file:aaa.json (payload)', 'file:bbb.json (payload)',
    ]);
  });
});
