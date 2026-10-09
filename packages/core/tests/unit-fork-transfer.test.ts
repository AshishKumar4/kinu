import { exists, readText, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Fork transfer receiver, driven with hand-built frames, including ones no correct sender makes.
 * Every refusal also asserts no half-fork is left behind.
 */

import { describe, test, expect } from 'bun:test';
import {
  readForkLineage, SOUL_PATH, createWorkspaceForkSink, workspaceSoul,
  ForkStagingState, ForkTransferReceiver, forkTransferFrames, sealForkFrame,
  FORK_TRANSFER_VERSION, FORK_STREAM_SEED, foldForkStream,
  type ForkFileSink, type ForkFileSource, type ForkFrameReply,
  type ForkSectionCounts, type ForkFrame, type ForkRowSection, type UnsealedForkFrame,
  corroborateLessonsForTurn, createFactsStore, listLessons, recordLesson,
} from '../src/index';
import { perSection } from '../src/identity/fork-sections';
import { applyStruggleLesson, listToolLessons } from '../src/evolution/struggles';
import type { AppDataStore, AppTableSpec } from '../src/tools/db-codemode';
import type { VfsExportChunk, VfsExportPage } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { createTestWorkspace as fresh, type TestWorkspace } from './helpers';
import {
  seedForkSource, SOURCE_ARTIFACTS, SPILLED_BYTES, TARGET_ARTIFACTS,
} from './helpers/fork-conversation';
import {
  appDataOf, deliver, reassemble, receiverFor as streamReceiverFor, sourceFrames, transfer, writerFor,
  type ForkContent, type ForkTargetOptions,
} from './helpers/fork-stream';
import { openWorkspaceMainActor, WorkspaceActorDirectory } from '../src/identity/workspace-actors';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { CRED_SESSION_USER } from '@nimbus-sh/core/runtime/os-contracts.js';

const OWNER: ForkTargetOptions = {
  workspaceId: 'FORK-ID', workspaceName: 'my-fork', artifactDirectory: TARGET_ARTIFACTS, now: 4242,
};

/** No rows and no files. */
const EMPTY_COUNTS: ForkSectionCounts = {
  agentConfig: 0, craftedTools: 0,
  sessionMessages: 0, conversationEntries: 0, conversationEntryParts: 0, contextMembers: 0,
  lessons: 0, toolLessons: 0, facts: 0, ownerQuestions: 0, appTables: 0, appRows: 0,
  files: 0,
};

type FrameBody = UnsealedForkFrame extends infer Frame
  ? Frame extends { version: number; transferId: string; seq: number }
    ? Omit<Frame, 'version' | 'transferId' | 'seq'>
    : never
  : never;

type RowSections = Pick<ForkContent, ForkRowSection>;

/** A source workspace with a three-turn conversation, seeded through the production writers. */
async function source(opts: { files?: Array<{ path: string; content: string }>; spill?: boolean } = {}) {
  const src = fresh();

  const chat = await seedForkSource(src, {
    purpose: 'help with testing',
    craftedTools: [{ name: 'helper', description: 'utility', code: 'async (x) => x' }],
  });

  await chat.say({ id: 'm1', role: 'user', text: 'first' });
  await chat.say({ id: 'm2', role: 'assistant', text: opts.spill ? 'p'.repeat(SPILLED_BYTES) : 'second' });
  await chat.say({ id: 'm3', role: 'user', text: 'third' });

  for (const file of opts.files ?? []) await writeText(src.vfs, file.path, file.content);

  return src;
}

/**
 * Hand-build a stream from the frames the source's own stream crossed with: rows re-cut by count, so "drop frame 4"
 * and "reorder two sections" stay expressible, and each page preceded by the chunks it names that no earlier frame
 * carried, so every frame is taken the first time. `rows` replaces sections, their declared counts with them.
 */
function framesFor(recorded: readonly ForkFrame[], opts: {
  transferId?: string; rowsPerFrame?: number; rows?: Partial<RowSections>;
} = {}): ForkFrame[] {
  const transferId = opts.transferId ?? 'tx-1';
  const rowsPerFrame = opts.rowsPerFrame ?? 2;
  const begin = recorded[0];

  if (begin?.kind !== 'begin') throw new Error('the recorded stream has no begin frame');
  const rows: RowSections = { ...reassemble(recorded), ...opts.rows };
  const out: ForkFrame[] = [];
  let seq = 0;
  let stream = FORK_STREAM_SEED;

  const push = (body: FrameBody): void => {
    const frame = sealForkFrame({ version: FORK_TRANSFER_VERSION, transferId, seq, ...body });
    out.push(frame);
    seq += 1;
    stream = foldForkStream(stream, frame.digest);
  };

  push({
    kind: 'begin',
    head: begin.head,
    counts: { ...begin.counts, ...perSection((kind) => rows[kind].length) },
  });

  const batches = <Row,>(all: readonly Row[]): Row[][] => {
    const cut: Row[][] = [];

    for (let at = 0; at < all.length; at += rowsPerFrame) cut.push(all.slice(at, at + rowsPerFrame));

    return cut;
  };

  // FORK_ROW_SECTIONS order, which the canonical store's foreign keys require.
  for (const batch of batches(rows.agentConfig)) push({ kind: 'agentConfig', rows: batch });

  for (const batch of batches(rows.craftedTools)) push({ kind: 'craftedTools', rows: batch });

  for (const batch of batches(rows.sessionMessages)) push({ kind: 'sessionMessages', rows: batch });

  for (const batch of batches(rows.conversationEntries)) push({ kind: 'conversationEntries', rows: batch });

  for (const batch of batches(rows.conversationEntryParts)) push({ kind: 'conversationEntryParts', rows: batch });

  for (const batch of batches(rows.contextMembers)) push({ kind: 'contextMembers', rows: batch });

  for (const batch of batches(rows.lessons)) push({ kind: 'lessons', rows: batch });

  for (const batch of batches(rows.toolLessons)) push({ kind: 'toolLessons', rows: batch });

  for (const batch of batches(rows.facts)) push({ kind: 'facts', rows: batch });

  for (const batch of batches(rows.appTables)) push({ kind: 'appTables', rows: batch });

  for (const batch of batches(rows.appRows)) push({ kind: 'appRows', rows: batch });

  const chunks = new Map<string, Uint8Array>();

  for (const frame of recorded) {
    if (frame.kind === 'chunks') for (const chunk of frame.chunks) chunks.set(chunk.hash, chunk.data);
  }

  const carried = new Set<string>();
  const pages = new Set<string>();

  for (const frame of recorded) {
    if (frame.kind !== 'page') continue;
    const key = `${JSON.stringify(frame.target)}|${frame.page.after ?? ''}`;

    // A page the source's target first wanted chunks for crossed twice; here it crosses once, after them.
    if (pages.has(key)) continue;
    pages.add(key);
    const named = [...new Set(frame.page.rows.flatMap((row) => row.pieces.map(([hash]) => hash)))].filter((hash) => !carried.has(hash));

    if (named.length > 0) {
      push({ kind: 'chunks', target: frame.target, chunks: named.map((hash) => ({ hash, data: chunks.get(hash) ?? new Uint8Array(0) })) });

      for (const hash of named) carried.add(hash);
    }

    push({ kind: 'page', target: frame.target, page: frame.page });
  }

  push({ kind: 'commit', stream });

  return out;
}

function receiverFor(tgt: TestWorkspace, opts: Partial<ForkTargetOptions> = {}): ForkTransferReceiver {
  return streamReceiverFor(tgt, { ...OWNER, ...opts });
}

/** Everything that exists only once a transfer has published; all "no" means staged, not forked. */
function isFork(tgt: TestWorkspace): boolean {
  const lineage = readForkLineage(tgt.sql);

  const named = tgt.sql<{ value: string }>`
    SELECT value FROM actor_config WHERE key = 'display_name'`[0]?.value;

  return lineage !== null || named === OWNER.workspaceName;
}

async function drain(receiver: ForkTransferReceiver, frames: readonly ForkFrame[]) {
  const outcomes = [];

  for (const frame of frames) outcomes.push(await receiver.accept(frame));

  return outcomes;
}

/** Where in `frames` the first page of the import of `name` under the home is, and the frame after it. */
function firstPageOf(frames: readonly ForkFrame[], name: string) {
  const at = frames.findIndex((frame) => frame.kind === 'page' && frame.target.in === 'home' && frame.target.name === name);
  const next = frames[at + 1];

  if (at < 0 || next === undefined) throw new Error(`expected a page of ${name} and a frame after it`);

  return { at, next };
}

/** `frames` resealed in order from 0, and the rolling digest a commit after them would carry. */
function renumber(frames: readonly ForkFrame[]) {
  let stream = FORK_STREAM_SEED;

  const resealed = frames.map((frame, index) => {
    const sealed = sealForkFrame({ ...frame, seq: index });
    stream = foldForkStream(stream, sealed.digest);

    return sealed;
  });

  return { frames: resealed, stream };
}

/** A source whose `memory` directory is two export pages (Nimbus pages 250 rows), and one more import after it. */
async function twoPageSource() {
  const src = await source();

  for (let index = 0; index < 260; index += 1) await writeText(src.vfs, `memory/n${String(index).padStart(3, '0')}.md`, `note ${index}\n`);
  await writeText(src.vfs, 'notes/after.md', 'after');

  return src;
}

describe('fork transfer receiver', () => {
  test('how frames are batched never changes what lands', async () => {
    const src = await source();
    const rebatched = fresh();
    const native = fresh();
    const recorded = await sourceFrames(src, 'm2');

    const outcomes = await drain(receiverFor(rebatched), framesFor(recorded));
    const final = outcomes[outcomes.length - 1];

    if (final?.status !== 'published') throw new Error(`expected published, got ${final?.status ?? 'nothing'}`);
    expect(outcomes.slice(0, -1).every((outcome) => outcome.status === 'staged')).toBe(true);

    await deliver(receiverFor(native), recorded);

    const rowsOf = (ws: TestWorkspace) => ({
      entries: ws.sql<{ id: string; position: number; role: string }>`
        SELECT id, position, role FROM conversation_entries ORDER BY rowid`,
      entryParts: ws.sql<{ entry_id: string; message_id: string; part_no: number }>`
        SELECT entry_id, message_id, part_no FROM conversation_entry_parts ORDER BY entry_id, position`,
      messages: ws.sql<{ message_id: string; role: string; origin: string; sealed_at: number; envelope_json: string; content_json: string | null; content_digest: string | null }>`
        SELECT message_id, role, origin, sealed_at, envelope_json, content_json, content_digest FROM session_messages ORDER BY rowid`,
      members: ws.sql<{ entry_id: string; position: number; message_id: string }>`
        SELECT entry_id, position, message_id FROM context_memberships WHERE to_revision IS NULL ORDER BY position`,
      tools: ws.sql<{ name: string }>`SELECT name FROM crafted_tools ORDER BY name`,
      config: ws.sql<{ key: string; value: string }>`SELECT key, value FROM actor_config ORDER BY key`,
      lineage: readForkLineage(ws.sql),
    });

    expect(rowsOf(rebatched)).toEqual(rowsOf(native));
    expect(await readText(rebatched.vfs, 'memory/MEMORY.md')).toBe('key insight');
    expect(rowsOf(rebatched).entries.map((row) => row.id)).not.toContain('m3');
  });

  test('the counts the source declared are the counts the target staged', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'), { rowsPerFrame: 1 });
    const begin = frames[0];

    if (begin?.kind !== 'begin') throw new Error('expected a begin frame');
    const writer = writerFor(tgt, OWNER);
    const receiver = new ForkTransferReceiver(writer, createWorkspaceForkSink(tgt.bundle));
    await drain(receiver, frames.slice(0, -1));

    expect(frames.at(-1)?.kind).toBe('commit');
    expect(writer.staging.read()?.staged).toEqual(begin.counts);
    await drain(receiver, frames.slice(-1));
    expect(isFork(tgt)).toBe(true);
  });

  test('a target mid-transfer holds staged rows and is still not a fork', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));

    await drain(receiverFor(tgt), frames.slice(0, -1));

    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM conversation_entries`[0]?.c).toBe(3);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM context_memberships`[0]?.c).toBe(3);
    expect(await readText(tgt.vfs, 'memory/MEMORY.md')).toBe('key insight');
    expect(isFork(tgt)).toBe(false);
    expect(readForkLineage(tgt.sql)).toBeNull();
  });

  test('a carried payload file lands under the target\'s artifact directory', async () => {
    const src = await source({ spill: true });
    const tgt = fresh();
    const recorded = await sourceFrames(src, 'm2');
    const snapshot = reassemble(recorded);

    expect(snapshot.artifacts.length).toBeGreaterThan(0);
    expect(snapshot.artifacts.every((file) => !file.path.startsWith('/'))).toBe(true);

    await drain(receiverFor(tgt), framesFor(recorded));

    for (const artifact of snapshot.artifacts) {
      expect(await readText(tgt.vfs, `${TARGET_ARTIFACTS}/${artifact.path}`))
        .toBe(artifact.content);
      // The path the SOURCE used is not the path the fork reads.
      expect(await exists(tgt.vfs, `${SOURCE_ARTIFACTS}/${artifact.path}`)).toBe(false);
    }

    expect(tgt.sql<{ content_path: string }>`
      SELECT content_path FROM session_messages WHERE content_path IS NOT NULL`
      .every((row) => row.content_path.startsWith(`${TARGET_ARTIFACTS}/`))).toBe(true);
  });

  test('a file the target was born with is replaced by the source\'s copy', async () => {
    const src = await source();
    const tgt = fresh();
    await writeText(src.vfs, '.nimbusrc', 'the source\'s own settings\n');
    const born = await readText(tgt.vfs, '.nimbusrc');

    expect(born).not.toBe('the source\'s own settings\n');
    await drain(receiverFor(tgt), framesFor(await sourceFrames(src, 'm3')));
    expect(await readText(tgt.vfs, '.nimbusrc')).toBe('the source\'s own settings\n');
  });

  // SOUL.md is a file of main's home, carried as every other one, and left editable by the fork's agents.
  test("SOUL.md crosses as a file of the home, and the fork's agents may edit it", async () => {
    const src = await source();
    const tgt = fresh();
    const sourceSoul = await workspaceSoul(src.bundle);
    await drain(receiverFor(tgt), framesFor(await sourceFrames(src, 'm3')));

    const kernel = (await tgt.bundle.session()).vfs.as(CRED_SESSION_USER);
    const stat = kernel.lstat(`${WORKSPACE_ROOT}/${SOUL_PATH}`);
    expect({ uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 }).toEqual({ uid: 1000, gid: 1000, mode: 0o664 });
    expect(await workspaceSoul(tgt.bundle)).toBe(sourceSoul);
  });

  test('an import of a name under the home the fork does not carry is refused, and nothing lands', async () => {
    const src = await source();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const page = frames.find((frame) => frame.kind === 'page' && frame.target.in === 'home');

    if (page?.kind !== 'page') throw new Error('expected a page under the home');

    for (const name of ['scaffold', '.kinu', '.nimbus']) {
      const tgt = fresh();
      const receiver = receiverFor(tgt);
      const at = frames.indexOf(page);
      await drain(receiver, frames.slice(0, at));
      const before = await exists(tgt.vfs, name);

      await expect(receiver.accept(sealForkFrame({ ...page, target: { in: 'home', name } })))
        .rejects.toThrow(/does not carry/);
      expect(await exists(tgt.vfs, name)).toBe(before);
      expect(isFork(tgt)).toBe(false);
    }
  });

  // A fork lands only in the target's own artifacts and home: a frame naming anywhere else is no frame of this protocol.
  test("an import naming a path outside the target's artifacts or home is refused before it opens anything", async () => {
    const src = await source({ spill: true });
    const frames = framesFor(await sourceFrames(src, 'm2'));
    const page = frames.find((frame) => frame.kind === 'page' && frame.target.in === 'artifacts');

    if (page?.kind !== 'page') throw new Error('expected a page of a carried payload');

    const elsewhere = [
      { in: 'artifacts', path: '../other-workspace/artifacts/m1.json' },
      { in: 'artifacts', path: 'm1/../../../other-workspace/m1.json' },
      { in: 'artifacts', path: '/home/other-workspace/m1.json' },
      { in: 'home', name: '..' },
      { in: 'home', name: 'notes/../../other-workspace' },
    ] as const;

    for (const target of elsewhere) {
      const tgt = fresh();
      const receiver = receiverFor(tgt);

      await drain(receiver, frames.slice(0, frames.indexOf(page)));
      const before = new ForkStagingState(tgt.sql).read();

      await expect(receiver.accept({ ...page, target })).rejects.toThrow();
      // Refused on arrival: the transfer stands where it stood, the target is not a fork, and nothing reached elsewhere.
      expect([target, new ForkStagingState(tgt.sql).read(), isFork(tgt)]).toEqual([target, before, false]);
      expect(await exists(tgt.vfs, '/home/other-workspace')).toBe(false);
    }
  });

  test('a page the target lacks chunks for is answered with them, taking nothing until they arrive', async () => {
    const src = await source({ files: [{ path: 'notes/a.md', content: 'alpha' }] });
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const chunks = frames.findIndex((frame) => frame.kind === 'chunks');
    const page = frames[chunks + 1];
    const carried = frames[chunks];

    if (carried?.kind !== 'chunks' || page?.kind !== 'page') throw new Error('expected chunks then their page');
    const receiver = receiverFor(tgt);
    await drain(receiver, frames.slice(0, chunks));

    // Out of turn, at the chunks' own position: the page is answered, not taken.
    const early = await receiver.accept(sealForkFrame({ ...page, seq: carried.seq }));
    expect(early).toEqual({ status: 'want', hashes: expect.arrayContaining(carried.chunks.map((chunk) => chunk.hash)) });

    // The sequence did not move: the chunks and the page are still next.
    expect(await drain(receiver, frames.slice(chunks))).toContainEqual(expect.objectContaining({ status: 'published' }));
  });

  test('a target that keeps none of the chunks it is sent is refused, never sent them forever', async () => {
    const src = await source({ files: [{ path: 'notes/a.md', content: 'alpha' }] });
    const tgt = fresh();
    const production = createWorkspaceForkSink(tgt.bundle);
    const sent: string[][] = [];

    // A target whose every reset collects what it staged: each page wants its chunks again.
    const forgetful: ForkFileSink = {
      ...production,
      async importChunks(_dst, chunks) {
        sent.push(chunks.map((chunk) => chunk.hash));

        // A stream that would send them forever fails here, not by hanging the suite.
        if (sent.length > 2) throw new Error('the stream sent the same chunks a third time');
      },
      async importPage(_dst, page) {
        const want = [...new Set(page.rows.flatMap((row) => row.pieces.map(([hash]) => hash)))];

        return { want, done: want.length === 0 };
      },
    };

    const receiver = new ForkTransferReceiver(writerFor(tgt, OWNER), forgetful);

    await expect(transfer(src, receiver, { untilMessageId: 'm3' })).rejects.toThrow(/wants the same 1 chunk\(s\) of .* it was just sent/);
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(isFork(tgt)).toBe(false);
  });

  test('a chunk whose bytes do not hash to its name is refused, and nothing lands', async () => {
    const src = await source({ files: [{ path: 'notes/a.md', content: 'alpha' }] });
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const receiver = receiverFor(tgt);
    const at = frames.findIndex((frame) => frame.kind === 'chunks' && frame.target.in === 'home' && frame.target.name === 'notes');
    const carried = frames[at];

    if (carried?.kind !== 'chunks') throw new Error('expected the chunks of notes');
    await drain(receiver, frames.slice(0, at));
    // Its digest names the chunks by hash, so a corrupt byte reaches Nimbus, which re-hashes before storing.
    const corrupt = { ...carried, chunks: carried.chunks.map((chunk) => ({ hash: chunk.hash, data: chunk.data.map((byte) => byte ^ 0xff) })) };

    const page = frames[at + 1];

    if (page === undefined) throw new Error('expected the page after the chunks');
    await expect(receiver.accept(corrupt)).rejects.toThrow(/does not hash to its name/);
    await expect(receiver.accept(page)).rejects.toThrow(/arrived where frame \d+ was expected/);
    expect(await exists(tgt.vfs, 'notes/a.md')).toBe(false);
    expect(isFork(tgt)).toBe(false);
  });

  test('an import begun while another is incomplete is refused', async () => {
    const src = await twoPageSource();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const memory = frames.filter((frame) => frame.kind === 'page' && frame.target.in === 'home' && frame.target.name === 'memory');
    const first = firstPageOf(frames, 'memory');
    const notes = frames[firstPageOf(frames, 'notes').at];

    expect(memory).toHaveLength(2);
    const receiver = receiverFor(tgt);
    await drain(receiver, frames.slice(0, first.at + 1));

    if (notes?.kind !== 'page') throw new Error('expected the page of notes');
    await expect(receiver.accept(sealForkFrame({ ...notes, seq: first.next.seq }))).rejects.toThrow();
    expect(isFork(tgt)).toBe(false);
    const completed = await drain(receiver, frames.slice(first.at + 1));
    expect(completed.at(-1)?.status).toBe('published');
    expect(await readText(tgt.vfs, 'notes/after.md')).toBe('after');
  });

  test('a commit while an import is incomplete is refused', async () => {
    const src = await twoPageSource();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const receiver = receiverFor(tgt);
    const first = firstPageOf(frames, 'memory');
    const prefix = frames.slice(0, first.at + 1);
    const [begin, ...rest] = prefix;

    if (begin?.kind !== 'begin') throw new Error('expected a begin frame');
    // Counts and digest agree with this shortened stream: only the incomplete import can prevent publication.
    const imports = new Set(prefix.flatMap(frame => frame.kind === 'page' || frame.kind === 'chunks' ? [JSON.stringify(frame.target)] : []));
    const files = imports.size;
    const prepared = renumber([{ ...begin, counts: { ...begin.counts, files } }, ...rest]);
    await drain(receiver, prepared.frames);
    expect(await exists(tgt.vfs, 'memory/n000.md')).toBe(true);
    expect(await exists(tgt.vfs, 'memory/n259.md')).toBe(false);

    await expect(receiver.accept(sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-1', seq: prepared.frames.length, kind: 'commit', stream: prepared.stream,
    }))).rejects.toThrow();
    expect(isFork(tgt)).toBe(false);
  });

  test('a new receiver continues an import the last one left between its pages', async () => {
    const src = await twoPageSource();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const first = firstPageOf(frames, 'memory');

    // SQLite and the store persist; receiver, writer and sink do not: a Durable Object reset.
    await drain(receiverFor(tgt), frames.slice(0, first.at + 1));
    const outcomes = await drain(receiverFor(tgt), frames.slice(first.at + 1));

    expect(outcomes.at(-1)?.status).toBe('published');
    expect(((await tgt.vfs.readdir('memory')).map(({ name }) => name)).length).toBe(261);
    expect(await readText(tgt.vfs, 'memory/n259.md')).toBe('note 259\n');
  });

  test('a chain that never carried the cut entry the head names is refused at publication', async () => {
    const tgt = fresh();
    const transferId = 'tx-no-cut';

    const begin = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId, seq: 0, kind: 'begin',
      head: { source: { workspaceId: 'S', workspaceName: 's' }, cut: { messageId: 'm1', createdAtMs: 1 } },
      counts: EMPTY_COUNTS,
    });

    const commit = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId, seq: 1, kind: 'commit',
      stream: foldForkStream(FORK_STREAM_SEED, begin.digest),
    });

    const receiver = receiverFor(tgt);

    await receiver.accept(begin);
    await expect(receiver.accept(commit)).rejects.toThrow(/no cut entry "m1"/);
    expect(isFork(tgt)).toBe(false);
    expect(readForkLineage(tgt.sql)).toBeNull();
  });

  test('a gap is refused and leaves no fork', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const receiver = receiverFor(tgt);
    const [begin, , third] = frames;

    if (begin === undefined || third === undefined) throw new Error('expected at least three frames');
    await receiver.accept(begin);
    await expect(receiver.accept(third)).rejects.toThrow(/frame 2 arrived where frame 1 was expected/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a frame delivered twice is refused rather than silently re-staged', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const receiver = receiverFor(tgt);
    const [begin, second] = frames;

    if (begin === undefined || second === undefined) throw new Error('expected at least two frames');
    await receiver.accept(begin);
    await receiver.accept(second);
    await expect(receiver.accept(second)).rejects.toThrow(/arrived where frame 2 was expected/);
    expect(isFork(tgt)).toBe(false);
  });

  test('sections out of the order the protocol fixes are refused', async () => {
    const src = await source();
    const tgt = fresh();
    const recorded = await sourceFrames(src, 'm3');
    const snapshot = reassemble(recorded);
    // Foreign-key order: a part references a message that must already be staged.
    const begin = framesFor(recorded)[0];

    if (begin === undefined) throw new Error('expected a begin frame');
    const receiver = receiverFor(tgt);
    await receiver.accept(begin);

    await receiver.accept(sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-1', seq: 1,
      kind: 'sessionMessages', rows: snapshot.sessionMessages,
    }));

    const configAfter = sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-1', seq: 2,
      kind: 'agentConfig', rows: snapshot.agentConfig,
    });

    await expect(receiver.accept(configAfter)).rejects.toThrow(/out of the order the protocol fixes/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a foreign transfer id mid-stream is refused', async () => {
    const src = await source();
    const tgt = fresh();
    const recorded = await sourceFrames(src, 'm3');
    const mine = framesFor(recorded, { transferId: 'tx-mine' });
    const theirs = framesFor(recorded, { transferId: 'tx-theirs' });
    const receiver = receiverFor(tgt);
    const opening = mine[0];
    const foreign = theirs[1];

    if (opening === undefined || foreign === undefined) throw new Error('expected two streams of frames');
    await receiver.accept(opening);
    await expect(receiver.accept(foreign))
      .rejects.toThrow(/belongs to transfer tx-theirs, and tx-mine is the transfer open here/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a reset removes what the abandoned transfer imported before taking the replacement', async () => {
    const firstSource = await source({ files: [{ path: 'memory/abandoned.md', content: 'old bytes' }] });
    const secondSource = await source({ files: [{ path: 'memory/replacement.md', content: 'new bytes' }] });
    const tgt = fresh();
    const first = framesFor(await sourceFrames(firstSource, 'm3'), { transferId: 'tx-first' });
    const second = framesFor(await sourceFrames(secondSource, 'm1'), { transferId: 'tx-second' });
    const receiver = receiverFor(tgt);
    const memory = first.findIndex((frame) => frame.kind === 'page' && frame.target.in === 'home' && frame.target.name === 'memory');
    await drain(receiver, first.slice(0, memory + 1));
    expect(await readText(tgt.vfs, 'memory/abandoned.md')).toBe('old bytes');

    // Frame 0 is the reset: it clears unpublished paths so a failed first transfer cannot donate a
    // file to the fork that later wins this target.
    await drain(receiver, second);
    expect(await exists(tgt.vfs, 'memory/abandoned.md')).toBe(false);
    expect(await readText(tgt.vfs, 'memory/replacement.md')).toBe('new bytes');
    expect(readForkLineage(tgt.sql)?.sourceMessageId).toBe('m1');
  });

  test('a reset removes the directories and symlinks an abandoned transfer placed', async () => {
    const abandoned = await source();
    await writeText(abandoned.vfs, 'app/src/main.ts', 'export {};');
    (await abandoned.bundle.session()).vfs.as(CRED_SESSION_USER).symlink('src/main.ts', `${WORKSPACE_ROOT}/app/entry.ts`);
    const replacement = await source();
    const tgt = fresh();
    const receiver = receiverFor(tgt);
    const first = await sourceFrames(abandoned, 'm3', { transferId: 'tx-first' });
    await drain(receiver, first.slice(0, first.findIndex((frame) => frame.kind === 'commit')));
    expect(await exists(tgt.vfs, 'app/src/main.ts')).toBe(true);

    await drain(receiver, await sourceFrames(replacement, 'm1', { transferId: 'tx-second' }));

    const target = (await tgt.bundle.session()).vfs.as(CRED_SESSION_USER);
    expect(target.exists(`${WORKSPACE_ROOT}/app`)).toBe(false);
    expect(target.isSymlink(`${WORKSPACE_ROOT}/app/entry.ts`)).toBe(false);
    expect(readForkLineage(tgt.sql)?.sourceMessageId).toBe('m1');
  });

  test('a concurrent transfer takes the target and the abandoned one is refused', async () => {
    const src = await source();
    const tgt = fresh();
    const a = framesFor(await sourceFrames(src, 'm3'), { transferId: 'tx-a' });
    const b = framesFor(await sourceFrames(src, 'm1'), { transferId: 'tx-b' });
    const receiver = receiverFor(tgt);

    await drain(receiver, a.slice(0, 3));
    // A second source's begin clears whatever the abandoned transfer staged.
    const outcomes = await drain(receiver, b);
    expect(outcomes[outcomes.length - 1]?.status).toBe('published');
    const stale = a[3];

    if (stale === undefined) throw new Error('expected a fourth frame in the abandoned stream');
    await expect(receiver.accept(stale)).rejects.toThrow(/belongs to transfer tx-a/);

    const landed = tgt.sql<{ id: string }>`
      SELECT id FROM conversation_entries WHERE role != 'system' ORDER BY rowid`;

    expect(landed.map((row) => row.id)).toEqual(['m1']);
    expect(readForkLineage(tgt.sql)?.sourceMessageId).toBe('m1');
  });

  test('a dropped row batch is refused at commit by the declared counts', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'), { rowsPerFrame: 1 });
    // Renumbered so the sequence stays consistent and only the counts can catch it.
    const dropAt = frames.findIndex((frame) => frame.kind === 'conversationEntries');
    const kept = renumber(frames.filter((frame, index) => index !== dropAt && frame.kind !== 'commit'));

    const receiver = receiverFor(tgt);
    await drain(receiver, kept.frames);
    await expect(receiver.accept(sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-1', seq: kept.frames.length,
      kind: 'commit', stream: kept.stream,
    }))).rejects.toThrow(/declared 3 conversationEntries and staged 2; refusing to publish an incomplete fork/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a dropped import is refused at commit by the declared files', async () => {
    const src = await source({ files: [{ path: 'notes/a.md', content: 'alpha' }] });
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const isNotes = (frame: ForkFrame): boolean => (frame.kind === 'page' || frame.kind === 'chunks') && frame.target.in === 'home' && frame.target.name === 'notes';
    const kept = renumber(frames.filter((frame) => !isNotes(frame) && frame.kind !== 'commit'));

    const receiver = receiverFor(tgt);
    await drain(receiver, kept.frames);
    await expect(receiver.accept(sealForkFrame({
      version: FORK_TRANSFER_VERSION, transferId: 'tx-1', seq: kept.frames.length, kind: 'commit', stream: kept.stream,
    }))).rejects.toThrow(/declared \d+ files and staged \d+; refusing to publish an incomplete fork/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a stream whose frames were substituted is refused at commit by the rolling digest', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));

    // Same counts and sequence, content changed and resealed: only the rolling digest can see it.
    const forged = frames.map((frame) => {
      if (frame.kind !== 'agentConfig') return frame;

      return sealForkFrame({ ...frame, rows: [{ key: 'model', value: 'substituted' }] });
    });

    const receiver = receiverFor(tgt);
    await drain(receiver, forged.slice(0, -1));
    const commit = forged[forged.length - 1];

    if (commit === undefined) throw new Error('expected a commit frame');
    await expect(receiver.accept(commit))
      .rejects.toThrow(/does not match the sequence of frames that arrived/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a frame re-delivered after publication answers with the fork that landed', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const receiver = receiverFor(tgt);
    const outcomes = await drain(receiver, frames);
    const published = outcomes[outcomes.length - 1];

    if (published?.status !== 'published') throw new Error('expected published');
    const commit = frames[frames.length - 1];

    if (commit === undefined) throw new Error('expected a commit frame');
    const again = await receiver.accept(commit);

    if (again.status !== 'settled') throw new Error('expected settled');
    expect(again.result).toEqual(published.result);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM fork_lineage`[0]?.c).toBe(1);
  });

  test('a 90 MiB transcript and a large file land whole', async () => {
    const src = fresh();
    const chat = await seedForkSource(src, { workspaceId: 'BIG', workspaceName: 'big', memory: [] });
    // Just under the payload store's inline ceiling: each turn's text is one oversized row, not a file.
    const chunk = 'x'.repeat(900 * 1024);

    for (let index = 0; index < 100; index += 1) {
      await chat.say({ id: `m${index}`, role: 'user', text: chunk });
    }

    await src.vfs.mkdir('memory', { recursive: true });
    await writeText(src.vfs, 'memory/large.md', 'f'.repeat(8 * 1024 * 1024));

    const tgt = fresh();
    const { frames, result } = await transfer(src, receiverFor(tgt), { untilMessageId: 'm99', transferId: 'tx-long', frameBytes: 1024 * 1024 });

    expect(result).not.toBeNull();
    expect(frames.length).toBeGreaterThan(100);
    expect(tgt.sql<{ c: number }>`
      SELECT COUNT(*) AS c FROM conversation_entries WHERE role != 'system'`[0]?.c).toBe(100);
    expect(await readText(tgt.vfs, 'memory/large.md')).toHaveLength(8 * 1024 * 1024);
  });

  test('a frame whose content and digest disagree is refused before staging', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const frame = frames.find((candidate) => candidate.kind === 'agentConfig');

    if (frame?.kind !== 'agentConfig') throw new Error('expected agent config frame');
    await expect(receiverFor(tgt).accept({ ...frame, rows: [{ key: 'model', value: 'tampered' }] }))
      .rejects.toThrow(/digest does not match its content/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a version this tree does not implement is refused', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const receiver = receiverFor(tgt);
    const begin = frames[0];

    if (begin === undefined) throw new Error('expected a begin frame');
    await expect(receiver.accept({ ...begin, version: FORK_TRANSFER_VERSION + 1 }))
      .rejects.toThrow(new RegExp(`not valid for protocol version ${String(FORK_TRANSFER_VERSION)}`));
    expect(isFork(tgt)).toBe(false);
  });

  test('a continuation with no open transfer is refused', async () => {
    const src = await source();
    const tgt = fresh();
    const frames = framesFor(await sourceFrames(src, 'm3'));
    const second = frames[1];

    if (second === undefined) throw new Error('expected a second frame');
    await expect(receiverFor(tgt).accept(second)).rejects.toThrow(/has no open transfer to continue/);
    expect(isFork(tgt)).toBe(false);
  });
});

/**
 * One 256 MiB file crossing end to end, measured two ways: the largest frame of bytes and a GC-forced retained-heap
 * delta (`Bun.gc(true)` before each sample). The buffering control proves both turn red.
 */
describe('a fork holds one frame, never a whole file', () => {
  const HUGE_ROOT = `${WORKSPACE_ROOT}/memory`;
  const HUGE_SIZE = 256 * 1024 * 1024;
  const CHUNK = 64 * 1024;
  const FRAME = 1024 * 1024;

  /** The chunk at `index`, computed by position so the fixture never holds the file; its index makes it unique. */
  function chunkAt(index: number): Uint8Array {
    const out = new Uint8Array(CHUNK);

    for (let at = 0; at < CHUNK; at += 1) out[at] = (index * CHUNK + at) % 251;
    new DataView(out.buffer).setUint32(0, index);

    return out;
  }

  const hashes = Array.from({ length: HUGE_SIZE / CHUNK }, (_, index) => new Bun.CryptoHasher('sha256').update(chunkAt(index)).digest('hex'));
  const byHash = new Map(hashes.map((hash, index) => [hash, index]));

  /** A pinned source of one directory holding one 256 MiB file: one page, whose pieces name every chunk. */
  const plane: ForkFileSource = {
    async pin() {
      const page: VfsExportPage = {
        schema: 3, source: 'huge:1', root: HUGE_ROOT, nextIno: 3, after: null, next: null,
        rows: [
          { path: '', ino: 1, kind: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000, defaultAcl: null, atime: 1, mtime: 1, contentKey: null, pieceOffset: 0, manifest: false, pieces: [] },
          { path: 'huge.bin', ino: 2, kind: 'file', size: HUGE_SIZE, mode: 0o100644, uid: 1000, gid: 1000, defaultAcl: null, atime: 1, mtime: 1, contentKey: '0'.repeat(64), pieceOffset: 0, manifest: true, pieces: hashes.map((hash): [string, number] => [hash, CHUNK]) },
        ],
      };

      return {
        readdir: (path) => (path === WORKSPACE_ROOT ? ['memory'] : []),
        kind: (path) => (path === HUGE_ROOT ? 'directory' : null),
        readFile: () => { throw new Error('the fixture reads no whole file'); },
        exportPage: () => page,
        exportChunks: (wanted, maxBytes) => {
          const count = Math.max(1, Math.floor(maxBytes / CHUNK));

          return {
            chunks: wanted.slice(0, count).map((hash) => ({ hash, data: chunkAt(byHash.get(hash) ?? 0) })),
            rest: wanted.slice(count),
          };
        },
        release: async () => {},
      };
    },
  };

  async function streamHugeFork(sink: ForkFileSink): Promise<{ peakFrameBytes: number; peakRetainedHeapDelta: number; published: boolean }> {
    const src = fresh();
    const chat = await seedForkSource(src, { workspaceId: 'BIG', workspaceName: 'big', memory: [] });
    await chat.say({ id: 'm1', role: 'user', text: 'only' });
    const tgt = fresh();
    const receiver = new ForkTransferReceiver(writerFor(tgt, OWNER), sink);

    let peakFrameBytes = 0;
    let published = false;
    let crossed = 0;
    Bun.gc(true);

    // heapUsed + external covers both places a runtime may account ArrayBuffer backing stores.
    const retainedBytesNow = () => {
      const usage = process.memoryUsage();

      return usage.heapUsed + usage.external;
    };

    const baselineRetained = retainedBytesNow();
    let peakRetainedHeapDelta = 0;

    const stream = forkTransferFrames({
      sql: src.sql, actor: chat.actor, vfs: plane, artifactDirectory: SOURCE_ARTIFACTS, appData: appDataOf(src).fork,
      untilMessageId: 'm1', transferId: 'tx-256m', frameBytes: FRAME,
    });

    let reply: ForkFrameReply | undefined;

    for (let next = await stream.next(); !next.done; next = await stream.next(reply)) {
      const frame = next.value;

      if (frame.kind === 'chunks') {
        const bytes = frame.chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
        peakFrameBytes = Math.max(peakFrameBytes, bytes);
        crossed += bytes;

        // Sample while earlier frames would still be reachable if anything kept them.
        if (crossed === HUGE_SIZE / 2 || crossed === HUGE_SIZE) {
          Bun.gc(true);
          peakRetainedHeapDelta = Math.max(peakRetainedHeapDelta, retainedBytesNow() - baselineRetained);
        }
      }

      const outcome = await receiver.accept(frame);
      reply = outcome.status === 'want' ? { want: outcome.hashes } : undefined;
      published = outcome.status === 'published';
    }

    return { peakFrameBytes, peakRetainedHeapDelta, published };
  }

  /** A sink over counters: chunks are hashed and dropped, as a store keeps them and the isolate does not. */
  function countingSink(kept?: Uint8Array[]): ForkFileSink & { readonly stored: () => number } {
    const stored = new Set<string>();

    return {
      async importChunks(_dst, chunks: readonly VfsExportChunk[]) {
        for (const chunk of chunks) {
          if (new Bun.CryptoHasher('sha256').update(chunk.data).digest('hex') !== chunk.hash) throw new Error('a chunk does not hash to its name');
          stored.add(chunk.hash);
          kept?.push(chunk.data);
        }
      },
      async importPage(_dst, page) {
        const want = [...new Set(page.rows.flatMap((row) => row.pieces.map(([hash]) => hash)))].filter((hash) => !stored.has(hash));

        return { want, done: want.length === 0 };
      },
      async remove() {},
      stored: () => stored.size,
    };
  }

  test('a 256 MiB file crosses a frame of chunks at a time, and neither side keeps them', async () => {
    const sink = countingSink();
    const run = await streamHugeFork(sink);

    expect(run.published).toBe(true);
    expect(sink.stored()).toBe(HUGE_SIZE / CHUNK);
    expect(run.peakFrameBytes).toBe(FRAME);
    // The buffering control drives this measurement past 192 MiB, so this bound can fail.
    expect(run.peakRetainedHeapDelta).toBeLessThan(64 * 1024 * 1024);
  });

  test('the bound is measured, not assumed: a sink that keeps the chunks blows it', async () => {
    const kept: Uint8Array[] = [];
    const run = await streamHugeFork(countingSink(kept));

    expect(run.published).toBe(true);
    expect(kept.reduce((total, part) => total + part.byteLength, 0)).toBe(HUGE_SIZE);
    expect(run.peakRetainedHeapDelta).toBeGreaterThanOrEqual(192 * 1024 * 1024);
  });
});

/** The writer's own preconditions: a publication needs a head, and a target its identity. */
describe('fork target writer', () => {
  test('a publication before any head is refused', async () => {
    const tgt = fresh();
    const writer = writerFor(tgt, OWNER);

    await expect(writer.publish()).rejects.toThrow(/before the transfer declared its head/);
    expect(isFork(tgt)).toBe(false);
  });

  test('a target whose durable identity is another workspace is refused', async () => {
    const tgt = fresh();
    void tgt.sql`INSERT INTO workspace_identity (id, name, created_at) VALUES (${'SOMEONE-ELSE'}, ${'other'}, ${1})`;
    new WorkspaceActorDirectory(tgt.sql, { workspaceId: 'SOMEONE-ELSE', ownerUserId: '' }).createMain({ name: 'other' });
    const writer = writerFor(tgt, OWNER);

    expect(() => writer.begin({
      source: { workspaceId: 'S', workspaceName: 's' }, cut: { messageId: 'm1', createdAtMs: 1 },
    })).toThrow(/does not match its durable workspace identity/);
  });

  test('a cut that recorded no context still lands one empty working context', async () => {
    const src = await source();
    const tgt = fresh();
    await drain(receiverFor(tgt), framesFor(await sourceFrames(src, 'm1'), { rows: { contextMembers: [] } }));

    const selected = tgt.sql<{ context_id: string }>`SELECT context_id FROM actor_context_selection`;
    expect(selected).toHaveLength(1);
    expect(tgt.sql<{ c: number }>`SELECT COUNT(*) AS c FROM context_memberships`[0]?.c).toBe(0);
    expect(tgt.sql<{ revision: number }>`SELECT revision FROM context_revisions`).toEqual([{ revision: 1 }]);
  });
});

const LEDGER: AppTableSpec = {
  name: 'ledger',
  scope: 'actor',
  columns: [
    { name: 'key', type: 'text', primaryKey: true },
    { name: 'amount', type: 'integer' },
    { name: 'proof', type: 'blob' },
    { name: 'detail', type: 'json' },
  ],
};

/** More rows than one page of the store's export, so the copy resumes by rowid. */
const LEDGER_ROWS = 450;

describe('what a fork carries of what its source learned', () => {
  test('lessons cross as they stood at the cut: none taught after it, and one confirmed after it still provisional', async () => {
    const src = await source();
    const tgt = fresh();
    const actor = openWorkspaceMainActor(src.sql);

    const cut = src.sql<{ recorded_at: number }>`
      SELECT recorded_at FROM conversation_entries WHERE actor_id = ${actor.actorId} AND id = ${'m2'}`[0]?.recorded_at;

    if (cut === undefined) throw new Error('expected the cut entry m2');
    recordLesson(src.sql, actor, { turnIds: ['t-settled'], text: 'Confirmed before the cut.', source: 'turn_reflection', status: 'corroborated', now: cut - 2 });
    recordLesson(src.sql, actor, { turnIds: ['t-later'], text: 'Taught before the cut, confirmed after.', source: 'turn_reflection', status: 'provisional', now: cut - 1 });
    corroborateLessonsForTurn(src.sql, actor, 't-later', cut + 1);
    recordLesson(src.sql, actor, { turnIds: ['t-after'], text: 'Taught after the cut.', source: 'turn_reflection', status: 'provisional', now: cut + 2 });

    const { result } = await transfer(src, receiverFor(tgt), { untilMessageId: 'm2' });
    expect(result).not.toBeNull();

    const landed = listLessons(tgt.sql, openWorkspaceMainActor(tgt.sql))
      .map(({ text, status, createdAt, corroboratedAt }) => ({ text, status, createdAt, corroboratedAt }))
      .sort((left, right) => left.createdAt - right.createdAt);

    expect(landed).toEqual([
      { text: 'Confirmed before the cut.', status: 'corroborated', createdAt: cut - 2, corroboratedAt: cut - 2 },
      { text: 'Taught before the cut, confirmed after.', status: 'provisional', createdAt: cut - 1, corroboratedAt: null },
    ]);
  });

  test("tool lessons, facts and the db tool's tables cross as they stand, each row its new owner's", async () => {
    const src = await source();
    const tgt = fresh();
    const actor = openWorkspaceMainActor(src.sql);

    applyStruggleLesson(src.sql, actor, { turnId: 't-1', tool: 'bash', answer: { update: null, text: 'Quote the glob.' } });
    // A revision after the cut still crosses: a tool lesson keeps no history to cut it at.
    applyStruggleLesson(src.sql, actor, { turnId: 't-9', tool: 'bash', answer: { update: 'tl-t-1', text: 'Quote every glob.' } });
    createFactsStore(src.sql, actor).upsert('editor', 'helix', { confidence: 0.9, source: 'user' });
    createFactsStore(src.sql, actor).upsert('timezone', { zone: 'Europe/Lisbon' });

    const parent = appDataOf(src);
    const shared: AppTableSpec = { name: 'shared', scope: 'workspace', columns: [{ name: 'note', type: 'text' }] };

    const ledger = Array.from({ length: LEDGER_ROWS }, (_, at) => ({
      key: `k${String(at).padStart(3, '0')}`, amount: at, proof: at % 2 === 0 ? 'AAECf4D//g==' : null, detail: { at },
    }));

    parent.createTable(LEDGER);
    parent.createTable(shared);
    parent.apply({ op: 'insert', table: 'ledger', rows: ledger });
    parent.apply({ op: 'insert', table: 'shared', rows: [{ note: 'read by every agent' }] });

    const { result } = await transfer(src, receiverFor(tgt), { untilMessageId: 'm2' });
    expect(result).not.toBeNull();
    const forkActor = openWorkspaceMainActor(tgt.sql);

    expect(listToolLessons(tgt.sql, forkActor, ['bash'], 10).map((lesson) => lesson.text)).toEqual(['Quote every glob.']);
    expect(createFactsStore(tgt.sql, forkActor).all()).toMatchObject([
      { key: 'editor', value: 'helix', confidence: 0.9, source: 'user' },
      { key: 'timezone', value: { zone: 'Europe/Lisbon' } },
    ]);

    const fork = appDataOf(tgt);

    expect(fork.listTables()).toMatchObject([{ ...LEDGER, createdBy: forkActor.actorId }, { ...shared, createdBy: forkActor.actorId }]);
    // The target's main actor reads the actor-scope rows: they landed as its own, not the source actor's.
    expect(fork.count('ledger')).toBe(LEDGER_ROWS);
    expect(fork.select('ledger', { orderBy: [{ column: 'key' }], limit: LEDGER_ROWS })).toEqual(ledger);
    expect(fork.select('shared')).toEqual([{ note: 'read by every agent' }]);
  });

  test('a db row crosses whatever its table declares: a column named rowid, or an integer key at or below zero', async () => {
    const src = await source();
    const tgt = fresh();
    const parent = appDataOf(src);
    parent.createTable({ name: 'shadowed', scope: 'actor', columns: [{ name: 'rowid', type: 'integer' }, { name: 'note', type: 'text' }] });
    // Past one page of the export, so the copy resumes after a row, and that row's own `rowid` repeats or is null.
    parent.apply({
      op: 'insert', table: 'shadowed',
      rows: Array.from({ length: 250 }, (_, at) => ({ rowid: at % 2 === 0 ? null : 7, note: `n${String(at).padStart(3, '0')}` })),
    });
    parent.createTable({ name: 'keyed', scope: 'workspace', columns: [{ name: 'id', type: 'integer', primaryKey: true }, { name: 'note', type: 'text' }] });
    parent.apply({ op: 'insert', table: 'keyed', rows: [{ id: -1, note: 'below' }, { id: 0, note: 'zero' }, { id: 1, note: 'above' }] });

    const { result } = await transfer(src, receiverFor(tgt), { untilMessageId: 'm2' });
    expect(result).not.toBeNull();

    for (const [table, column] of [['shadowed', 'note'], ['keyed', 'id']] as const) {
      const rows = (store: AppDataStore) => store.select(table, { orderBy: [{ column }], limit: 1000 });

      expect(rows(appDataOf(tgt))).toEqual(rows(parent));
    }
  });

  test('a target holding a physical table a declaration would land on refuses the transfer and adopts nothing', async () => {
    const src = await source();
    appDataOf(src).createTable({ name: 'secrets', scope: 'workspace', columns: [{ name: 'token', type: 'text' }] });
    const tgt = fresh();
    // A host table carrying the agent prefix; declaring over it would hand its rows to the fork's agents.
    tgt.db.exec(`CREATE TABLE app_secrets (token TEXT)`);
    tgt.db.exec(`INSERT INTO app_secrets (token) VALUES ('sk-live')`);

    await expect(transfer(src, receiverFor(tgt), { untilMessageId: 'm2' })).rejects.toThrow();
    expect(isFork(tgt)).toBe(false);
    expect(appDataOf(tgt).listTables()).toEqual([]);
    expect(tgt.sql<{ token: string }>`SELECT token FROM app_secrets`).toEqual([{ token: 'sk-live' }]);
  });

  test("a replacement transfer drops the db tool's tables an abandoned one declared", async () => {
    const abandoned = await source();
    appDataOf(abandoned).createTable({ name: 'stale', scope: 'actor', columns: [{ name: 'note', type: 'text' }] });
    appDataOf(abandoned).apply({ op: 'insert', table: 'stale', rows: [{ note: 'from the abandoned transfer' }] });
    const replacement = await source();
    const tgt = fresh();
    const first = framesFor(await sourceFrames(abandoned, 'm3'), { transferId: 'tx-first' });
    const second = framesFor(await sourceFrames(replacement, 'm3'), { transferId: 'tx-second' });
    const receiver = receiverFor(tgt);

    await drain(receiver, first.slice(0, first.findIndex((frame) => frame.kind === 'appRows') + 1));
    expect(appDataOf(tgt).listTables().map((table) => table.name)).toEqual(['stale']);

    await drain(receiver, second);
    expect(isFork(tgt)).toBe(true);
    expect(appDataOf(tgt).listTables()).toEqual([]);
    expect(tgt.sql<{ name: string }>`SELECT name FROM sqlite_master WHERE name LIKE ${'%stale%'}`).toEqual([]);
  });
});
