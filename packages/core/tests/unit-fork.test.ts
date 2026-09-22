/**
 * Unit tests for forkWorkspaceStorage — the storage-layer fork helper.
 * Backend-agnostic: drives two bun:sqlite handles in-memory.
 *
 * Schema parity: the canonical initAllTables() DDL from
 * packages/core/src/identity/schema.ts, and the production workspace
 * filesystem — a fork carries FILES, so the test forks real ones. The source
 * conversation is seeded through the production session writers (see
 * `helpers/fork-conversation.ts`), because the rows a fork reads are the rows a
 * turn writes.
 */

import { describe, test, expect } from 'bun:test';
import { forkWorkspaceStorage, readForkLineage, readSoul } from '../src/index';
import { createTestWorkspace as fresh, type TestWorkspace } from './helpers';
import {
  ForkConversation, readChain, readWorkingContext, seedForkSource, seedForkTarget,
  SOURCE_ARTIFACTS, SPILLED_BYTES, TARGET_ARTIFACTS,
} from './helpers/fork-conversation';
import { forkFilePaths, type ForkFilePath } from '../src/identity/fork';
import { SHELL_APPROVAL_AUTHORITY_KEYS } from '../src/config/store';
import type { VFS } from '../src/types/primitives';
import { openWorkspaceMainActor } from '../src/identity/workspace-actors';

function forkInto(src: TestWorkspace, tgt: TestWorkspace, opts: {
  untilMessageId: string; targetWorkspaceId?: string; targetWorkspaceName?: string; now?: number;
}) {
  return forkWorkspaceStorage(src.sql, src.vfs, tgt.sql, tgt.vfs, {
    untilMessageId: opts.untilMessageId,
    targetWorkspaceId: opts.targetWorkspaceId ?? 'TGT',
    targetWorkspaceName: opts.targetWorkspaceName ?? 'my-fork',
    sourceArtifactDirectory: SOURCE_ARTIFACTS,
    targetArtifactDirectory: TARGET_ARTIFACTS,
    now: opts.now ?? Date.now(),
  });
}

/** Ids of everything the fork itself authored, so an assertion about inherited
 *  history does not have to spell the marker's generated id. */
const inherited = (ids: readonly string[]): string[] => ids.filter((id) => !id.startsWith('fork-marker-'));

describe('forkWorkspaceStorage', () => {
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
    // What a fork reports as copied is the PUBLIC chain it carried: two entries,
    // not the three the source holds.
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
    // Read back through the production reader: it resolves each path on the
    // TARGET's plane and refuses a payload whose digest differs.
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
    // The hosted target enforces foreign keys statement by statement, and a
    // streamed fork has no transaction spanning its sections — so the ORDER the
    // writer stages in is the only thing that can satisfy them.
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

    // A redelivery deletes a POPULATED canonical store before staging again, so
    // the clearing order has to release the forward edge — an entry's parent —
    // before the rows it names go.
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
    // A copy the model never reads is not context: the marker is a node of the
    // chain and not a member of the working context.
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

    // B continues its own conversation: the entries land under B's actor, on
    // the leaf the fork left — its marker.
    const inB = new ForkConversation(b, TARGET_ARTIFACTS);
    await inB.say({ id: 'b3', role: 'user', text: 'in B' });
    await inB.say({ id: 'b4', role: 'assistant', text: 'from B' });

    await forkWorkspaceStorage(b.sql, b.vfs, c.sql, c.vfs, {
      untilMessageId: 'b4', targetWorkspaceId: 'C-ID', targetWorkspaceName: 'agent-C', now: 7000,
      sourceArtifactDirectory: TARGET_ARTIFACTS, targetArtifactDirectory: TARGET_ARTIFACTS,
    });

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
    // What the owner said "always" to in THIS workspace, and how much the gate
    // asks here. Both are read live by `ShellApprovalPolicy` before it decides
    // whether to put a command in front of the owner at all.
    chat.actor.config.setShellApprovalMode('allow_all');
    chat.actor.config.set('shell_approval_grants', 'rm -rf *@sandbox,curl *@sandbox');

    await forkInto(src, tgt, { untilMessageId: 'm1' });

    const carried = tgt.sql<{ key: string }>`SELECT key FROM actor_config`.map((row) => row.key);

    // The child asks the owner from scratch, and the preference it may inherit
    // still arrives — this withholds authority, not configuration.
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
  function fakeVfs(files: string[]): VFS {
    const children = new Map<string, string[]>();
    const fileSet = new Set(files);

    for (const path of files) {
      const parts = path.split('/');

      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        const list = children.get(dir) ?? [];

        if (!list.includes(parts[i])) list.push(parts[i]);
        children.set(dir, list);
      }
    }

    const missing = (op: string, path: string) =>
      Object.assign(new Error(`ENOENT: ${op} ${path}`), { code: 'ENOENT' });

    return {
      readFile: async (path) => { throw missing('read', path); },
      writeFile: async () => undefined,
      readdir: async (path) => {
        const list = children.get(path);

        if (list === undefined) throw missing('readdir', path);

        return [...list];
      },
      stat: async (path) => {
        if (fileSet.has(path)) return { size: 1, mtimeMs: 0, isDir: false };

        if (children.has(path)) return { size: 0, mtimeMs: 0, isDir: true };

        return null;
      },
      unlink: async () => undefined,
      mkdir: async () => undefined,
      exists: async (path) => fileSet.has(path) || children.has(path),
    };
  }

  async function collect(vfs: VFS, artifacts: readonly string[] = []): Promise<ForkFilePath[]> {
    const out: ForkFilePath[] = [];

    for await (const file of forkFilePaths(vfs, artifacts)) out.push(file);

    return out;
  }

  test('a memory tree deeper and wider than the shared walk\'s guards is carried whole', async () => {
    // Forty levels under memory/ with one file at the bottom, beside two
    // hundred directories of sixty files: past both of walkRecursive's guard
    // units. A fork that reused the walker's bounds would refuse or truncate
    // here; a fork carries every file and no directory.
    let deep = 'memory';

    for (let i = 0; i < 40; i++) deep += `/d${i}`;
    const files = [`${deep}/note.md`];

    for (let d = 0; d < 200; d++) {
      for (let f = 0; f < 60; f++) files.push(`memory/dir${d}/note${f}.md`);
    }

    const carried = await collect(fakeVfs(files));
    expect(carried.length).toBe(files.length);
    expect(new Set(carried.map((file) => file.path))).toEqual(new Set(files));
    expect(carried.every((file) => !file.artifact)).toBe(true);
  });

  test('payload paths follow the workspace files, once each, flagged as artifacts', async () => {
    const carried = await collect(fakeVfs(['memory/MEMORY.md']), [
      '.kinu/event-content/aaa.json', '.kinu/event-content/aaa.json', '.kinu/event-content/bbb.json',
    ]);

    expect(carried).toEqual([
      { path: 'memory/MEMORY.md', artifact: false },
      { path: '.kinu/event-content/aaa.json', artifact: true },
      { path: '.kinu/event-content/bbb.json', artifact: true },
    ]);
  });

});
