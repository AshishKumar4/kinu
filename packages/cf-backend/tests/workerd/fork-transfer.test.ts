/**
 * A hosted fork across two DOs, evicted at the row/file boundary and before commit. The wire's resumability and
 * idempotence are state surviving an activation's end, which only workerd's `abortAllDurableObjects` can produce.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FORK_ROW_SECTIONS } from '@kinu.run/core';
import {
  PROBE_CUT_MESSAGE_ID, PROBE_CUT_RECORDED_AT, PROBE_SOUL_MISSION, PROBE_SOURCE_NAME,
} from './fork-probe';

/** A stub held across a reset is broken by it; the id survives. */
const source = (name: string) => env.FORK_SOURCE.get(env.FORK_SOURCE.idFromName(name));

const target = (name: string) => env.FORK_TARGET.get(env.FORK_TARGET.idFromName(name));

/** The fork point is this entry's time, so the published result names this exact millisecond. */
const CUT_MS = PROBE_CUT_RECORDED_AT;

describe('a fork transfer interrupted by a real eviction', () => {
  it('resumes at the exact frame, stays invisible until the commit, and publishes once', async () => {
    const name = 'fork-eviction-proof';
    await source(name).seed();
    const inherited = await source(name).sourceFiles();
    expect(inherited.map((file) => file.path)).toEqual([
      'SOUL.md', 'memory/deep/proof.bin', 'memory/notes.md',
    ]);

    const rows = await source(name).deliver({ target: name, from: 0, stop: 'files' });
    expect(rows.refusal).toBeNull();
    expect(rows.staged).toBe(rows.sent);
    // More frames than sections, so the boundary this activation ends at is a real one.
    expect(rows.sent).toBeGreaterThan(FORK_ROW_SECTIONS.length);

    const staged = await target(name).state();
    expect(staged.entries).toBe(3);
    expect(staged.contextMembers).toBe(3);
    expect(staged.craftedTools).toBe(1);
    expect(staged.lineage).toBeNull();
    expect(staged.markers).toBe(0);
    expect(staged.displayName).toBeNull();
    expect(staged.identity?.name).toBe('unpublished-target');
    expect(staged.identity?.mission ?? '').toBe('');
    expect(staged.files).toEqual([]);

    const cursorBefore = await target(name).cursor();
    expect(cursorBefore).toMatchObject({ expectedSeq: rows.nextSeq, stream: rows.stream, published: false });

    await abortAllDurableObjects();

    // The cursor is the object's own SQLite, so the reset did not touch it.
    expect(await target(name).cursor()).toEqual(cursorBefore);

    const files = await source(name).deliver({ target: name, from: rows.nextSeq, stop: 'commit' });
    expect(files.refusal).toBeNull();
    // SOUL in its one protected frame, then four ranges each for proof.bin and notes.md.
    expect(files.sent).toBe(9);
    expect(files.staged).toBe(9);

    const beforeCommit = await target(name).state();
    expect(beforeCommit.files).toEqual(inherited);
    expect(beforeCommit.lineage).toBeNull();
    expect(beforeCommit.markers).toBe(0);
    expect(beforeCommit.displayName).toBeNull();
    expect(beforeCommit.identity?.mission ?? '').toBe('');
    expect(await target(name).cursor()).toMatchObject({
      expectedSeq: files.nextSeq, stream: files.stream, published: false,
    });

    const commitSeq = files.nextSeq;
    await abortAllDurableObjects();

    const commit = await source(name).deliver({ target: name, from: commitSeq, stop: 'end' });
    expect(commit.refusal).toBeNull();
    expect(commit.fork).toEqual({ forkPointMs: CUT_MS, messagesCopied: 3, craftedToolsCopied: 1 });

    const published = await target(name).state();
    expect(published.lineage).toMatchObject({
      sourceWorkspaceName: PROBE_SOURCE_NAME,
      sourceMessageId: PROBE_CUT_MESSAGE_ID,
      sourceMessageCreatedAt: CUT_MS,
    });
    // Read from SOUL two activations ago; had to survive both resets.
    expect(published.identity?.mission).toBe(PROBE_SOUL_MISSION);
    expect(published.identity?.name).toBe('fork-target');
    expect(published.displayName).toBe('fork-target');
    expect(published.markers).toBe(1);
    expect(published.entries).toBe(3);
    // The public chain and the working context are two selections over one canonical store.
    expect(published.messages).toBe(4);
    expect(published.contextMembers).toBe(3);
    expect(published.files).toEqual(inherited);

    const redrive = await source(name).deliver({ target: name, from: commitSeq - 1, stop: 'end' });
    expect(redrive.refusal).toBeNull();
    expect(redrive.settled).toBe(2);
    expect(redrive.fork).toEqual(commit.fork);
    expect(await target(name).state()).toEqual(published);

    await abortAllDurableObjects();

    // Answered from storage, not from a receiver still in memory.
    const cold = await source(name).deliver({ target: name, from: commitSeq, stop: 'end' });
    expect(cold.refusal).toBeNull();
    expect(cold.settled).toBe(1);
    expect(cold.fork).toEqual(commit.fork);
    expect(await target(name).state()).toEqual(published);
  });

  it('refuses a corrupt frame and leaves a transfer that can never publish', async () => {
    const name = 'fork-corruption-proof';
    await source(name).seed();
    const rows = await source(name).deliver({ target: name, from: 0, stop: 'files' });
    expect(rows.refusal).toBeNull();
    const cursor = await target(name).cursor();

    await abortAllDurableObjects();

    // Seal untouched: the receiver's per-frame digest is what refuses it.
    const corrupt = await source(name).deliver({
      target: name, from: rows.nextSeq, stop: 'end', corrupt: 'frame',
    });

    expect(corrupt.refusal).toMatch(
      new RegExp(`fork transfer frame ${rows.nextSeq} digest does not match its content`),
    );
    expect(corrupt.fork).toBeNull();

    // The cursor did not move, so the transfer can never reach a commit.
    expect(await target(name).cursor()).toEqual(cursor);
    const after = await source(name).deliver({ target: name, from: rows.nextSeq + 1, stop: 'end' });
    expect(after.refusal).toMatch(
      new RegExp(`arrived where frame ${rows.nextSeq} was expected`),
    );
    expect(after.fork).toBeNull();

    const state = await target(name).state();
    expect(state.lineage).toBeNull();
    expect(state.markers).toBe(0);
    expect(state.displayName).toBeNull();
    expect(state.files).toEqual([]);
  });

  it('resumes a file at the exact next offset when the activation ended mid-file', async () => {
    const name = 'fork-midfile-proof';
    await source(name).seed();
    const inherited = await source(name).sourceFiles();
    const rows = await source(name).deliver({ target: name, from: 0, stop: 'files' });
    const range = await source(name).deliver({ target: name, from: rows.nextSeq, stop: 'range' });
    expect(range.refusal).toBeNull();

    const cursor = await target(name).cursor();
    expect(cursor).toMatchObject({ filePath: 'memory/deep/proof.bin', fileBytes: 64 });

    await abortAllDurableObjects();

    // The staged offset is a column: the resumed activation adopts the staging and writes the next byte.
    const rest = await source(name).deliver({ target: name, from: range.nextSeq, stop: 'end' });
    expect(rest.refusal).toBeNull();
    expect(rest.sent).toBe(8);
    expect(rest.fork).toEqual({ forkPointMs: CUT_MS, messagesCopied: 3, craftedToolsCopied: 1 });

    // Digest computed by reading the staging back, since no activation saw every range.
    const published = await target(name).state();
    expect(published.files).toEqual(inherited);
    expect(published.lineage).toMatchObject({
      sourceWorkspaceName: PROBE_SOURCE_NAME,
      sourceMessageId: PROBE_CUT_MESSAGE_ID,
      sourceMessageCreatedAt: CUT_MS,
    });
    expect(published.identity?.mission).toBe(PROBE_SOUL_MISSION);

    const redrive = await source(name).deliver({ target: name, from: rows.nextSeq, stop: 'end' });
    expect(redrive.refusal).toBeNull();
    expect(redrive.settled).toBe(redrive.sent);
    expect(redrive.fork).toEqual(rest.fork);
    expect(await target(name).state()).toEqual(published);
  });

  it('refuses a range that was resealed around different bytes, at the digest read back from the staging', async () => {
    const name = 'fork-reseal-proof';
    await source(name).seed();
    const rows = await source(name).deliver({ target: name, from: 0, stop: 'files' });
    const range = await source(name).deliver({ target: name, from: rows.nextSeq, stop: 'range' });
    expect(range.refusal).toBeNull();

    await abortAllDurableObjects();

    // Frame resealed so frame digest, offset and sequence agree: only the whole-file digest can see it.
    const resealed = await source(name).deliver({
      target: name, from: range.nextSeq, stop: 'end', corrupt: 'resealed',
    });

    expect(resealed.refusal).toContain(
      'fork transfer file "memory/deep/proof.bin" does not match the digest the source declared',
    );
    expect(resealed.fork).toBeNull();

    const state = await target(name).state();
    expect(state.lineage).toBeNull();
    expect(state.markers).toBe(0);
    expect(state.files.map((file) => file.path)).toEqual(['SOUL.md']);
  });
});
