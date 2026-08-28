/**
 * A hosted fork across two Durable Objects, evicted twice while it is in flight.
 *
 * WHAT IS BEING MEASURED, and why it cannot be measured under `bun test`. The
 * fork wire is resumable and idempotent BY CONTRACT — the receiver refuses a
 * frame that is not the next one, answers a re-delivered frame with the fork
 * that already landed, and publishes nothing until the commit has matched the
 * declared counts and the rolling digest. Every one of those statements is about
 * state that has to survive the end of an activation, and only workerd can end
 * one. `abortAllDurableObjects` is that ending: the isolate is reset, every
 * instance field goes with it, and the object's SQLite does not.
 *
 * The eviction points are the two the protocol actually has: between the last
 * row frame and the first file frame, and between the last file frame and the
 * commit. The source re-acquires its stub and resumes from the frame the target
 * reported, which is what a caller does after any cross-object failure.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROBE_CUT_MESSAGE_ID, PROBE_SOUL_MISSION, PROBE_SOURCE_NAME } from './fork-probe';

/** A stub held across a reset is itself broken by the reset; the id survives.
 *  Re-acquiring is what a real caller does on its next request. */
const source = (name: string) => env.FORK_SOURCE.get(env.FORK_SOURCE.idFromName(name));
const target = (name: string) => env.FORK_TARGET.get(env.FORK_TARGET.idFromName(name));

/** The cut point's own stamp, as the pane stores it. The fork point is the cut
 *  message's time, so the published result names this exact millisecond. */
const CUT_MS = Date.parse('2026-01-01T00:00:03.000Z');

describe('a fork transfer interrupted by a real eviction', () => {
  it('resumes at the exact frame, stays invisible until the commit, and publishes once', async () => {
    const name = 'fork-eviction-proof';
    await source(name).seed();
    const inherited = await source(name).sourceFiles();
    expect(inherited.map((file) => file.path)).toEqual([
      'SOUL.md', 'memory/deep/proof.bin', 'memory/notes.md',
    ]);

    // ── Rows only. The activation ends at the row/file boundary. ──
    const rows = await source(name).deliver({ target: name, from: 0, stop: 'files' });
    expect(rows.refusal).toBeNull();
    expect(rows.staged).toBe(rows.sent);
    // begin, two config frames, the crafted tool, two memory chunks, three pane
    // rows: the rows genuinely span frames, so the boundary is a real one.
    expect(rows.sent).toBeGreaterThan(5);

    const staged = await target(name).state();
    expect(staged.paneRows).toBe(3);
    expect(staged.craftedTools).toBe(1);
    // Staged and unreachable: no lineage, no fork marker, no display name, no
    // mission, and the identity row still the one the target came up with.
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

    // ── Files, on a fresh activation of both objects. ──
    const files = await source(name).deliver({ target: name, from: rows.nextSeq, stop: 'commit' });
    expect(files.refusal).toBeNull();
    // SOUL in its one protected frame, then four ranges each for proof.bin and
    // notes.md.
    expect(files.sent).toBe(9);
    expect(files.staged).toBe(9);

    // Every inherited file is published into the plane, byte for byte, and the
    // workspace is still not a fork.
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

    // ── The commit, on a third activation. ──
    const commit = await source(name).deliver({ target: name, from: commitSeq, stop: 'end' });
    expect(commit.refusal).toBeNull();
    expect(commit.fork).toEqual({ forkPointMs: CUT_MS, messagesCopied: 3, craftedToolsCopied: 1 });

    const published = await target(name).state();
    expect(published.lineage).toMatchObject({
      sourceWorkspaceName: PROBE_SOURCE_NAME,
      sourceMessageId: PROBE_CUT_MESSAGE_ID,
      sourceMessageCreatedAt: CUT_MS,
    });
    // The mission was read from SOUL's bytes two activations ago and had to
    // survive both resets to reach the identity row here.
    expect(published.identity?.mission).toBe(PROBE_SOUL_MISSION);
    expect(published.identity?.name).toBe('fork-target');
    expect(published.displayName).toBe('fork-target');
    expect(published.markers).toBe(1);
    expect(published.paneRows).toBe(3);
    // The transcript landed in ONE store: the pane, because that is the declared
    // authority. The plain rows crossed the wire and were dropped.
    expect(published.plainRows).toBe(0);
    expect(published.files).toEqual(inherited);

    // ── Re-delivery of the tail: the last file frame and the commit again. ──
    const redrive = await source(name).deliver({ target: name, from: commitSeq - 1, stop: 'end' });
    expect(redrive.refusal).toBeNull();
    expect(redrive.settled).toBe(2);
    expect(redrive.fork).toEqual(commit.fork);
    expect(await target(name).state()).toEqual(published);

    await abortAllDurableObjects();

    // And again on a cold activation: the answer comes from storage, not from a
    // receiver that happened to still be in memory.
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

    // One payload byte flipped, the frame's seal untouched: the receiver's own
    // per-frame digest is what refuses it.
    const corrupt = await source(name).deliver({
      target: name, from: rows.nextSeq, stop: 'end', corrupt: 'frame',
    });
    expect(corrupt.refusal).toMatch(
      new RegExp(`fork transfer frame ${rows.nextSeq} digest does not match its content`),
    );
    expect(corrupt.fork).toBeNull();

    // The cursor did not move, so the stream cannot be picked up after the hole:
    // the next frame is out of order and the transfer can never reach a commit.
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

    // SOUL published from its one protected frame, and one range of a file that
    // spans four is staged. The target's own row says which file and how far.
    const cursor = await target(name).cursor();
    expect(cursor).toMatchObject({ filePath: 'memory/deep/proof.bin', fileBytes: 64 });

    await abortAllDurableObjects();

    // The staged offset is a column, so the resumed activation neither restarts
    // the file nor refuses it: it adopts the staging and writes the next byte.
    const rest = await source(name).deliver({ target: name, from: range.nextSeq, stop: 'end' });
    expect(rest.refusal).toBeNull();
    // Three ranges of proof.bin, four of notes.md, then the commit.
    expect(rest.sent).toBe(8);
    expect(rest.fork).toEqual({ forkPointMs: CUT_MS, messagesCopied: 3, craftedToolsCopied: 1 });

    // The file the eviction interrupted is whole, and its digest is the source's
    // — computed by reading the staging back, since no activation saw every range.
    const published = await target(name).state();
    expect(published.files).toEqual(inherited);
    expect(published.lineage).not.toBeNull();
    expect(published.identity?.mission).toBe(PROBE_SOUL_MISSION);

    // Re-delivering the ranges that crossed either side of the eviction changes
    // nothing: the transfer has published, so each is answered with the fork.
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

    // One byte of one middle range flipped and the frame resealed, so the frame
    // digest, the offset and the sequence all agree. The remaining ranges go out
    // intact, and the whole-file digest at the last range is the only check that
    // can see it.
    const resealed = await source(name).deliver({
      target: name, from: range.nextSeq, stop: 'end', corrupt: 'resealed',
    });
    expect(resealed.refusal).toContain(
      'fork transfer file "memory/deep/proof.bin" does not match the digest the source declared',
    );
    expect(resealed.fork).toBeNull();

    // Nothing published, and the destination the staging shadowed never appeared:
    // only SOUL, which had already been committed from its own frame.
    const state = await target(name).state();
    expect(state.lineage).toBeNull();
    expect(state.markers).toBe(0);
    expect(state.files.map((file) => file.path)).toEqual(['SOUL.md']);
  });
});
