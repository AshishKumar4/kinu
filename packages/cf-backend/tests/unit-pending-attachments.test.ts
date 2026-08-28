// The composer's per-message attachment budget. The cap is an AGGREGATE, so
// admitting a file spends capacity the other pending parts already hold — and
// the defect was that two overlapping additions each sized themselves against
// the list as it was BEFORE either landed, then both appended.
import { describe, test, expect } from 'bun:test';
import type { FileUIPart } from 'ai';
import { admitAttachments } from '../src/hooks/use-pending-attachments';
import { dataUrlRawBytes } from '../src/components/AttachmentChip';

const LIMIT = 1024 * 1024;

/** A data-URL part of exactly `bytes` raw bytes, as `dataUrlRawBytes` measures
 *  them: base64 carries 3 raw bytes per 4 characters. */
function part(filename: string, bytes: number): FileUIPart {
  return {
    type: 'file',
    filename,
    mediaType: 'application/octet-stream',
    url: `data:application/octet-stream;base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`,
  };
}

const names = (parts: readonly FileUIPart[]): (string | undefined)[] =>
  parts.map((p) => p.filename);

describe('attachment budget admission', () => {
  test('what fits is admitted in offer order', () => {
    const admission = admitAttachments([], [part('a', 400_000), part('b', 400_000)], LIMIT);
    expect(names(admission.parts)).toEqual(['a', 'b']);
    expect(admission.refused).toEqual([]);
  });

  test('the order is the user\'s, not best-fit', () => {
    // 'big' is admitted first and leaves no room for 'small'. Reordering to fit
    // more would rewrite the message the user assembled.
    const admission = admitAttachments([], [part('big', 900_000), part('small', 200_000)], LIMIT);
    expect(names(admission.parts)).toEqual(['big']);
    expect(admission.refused).toEqual(['small']);
  });

  test('capacity already held by pending parts is not available again', () => {
    const pending = [part('held', 800_000)];
    const admission = admitAttachments(pending, [part('late', 400_000)], LIMIT);
    expect(names(admission.parts)).toEqual(['held']);
    expect(admission.refused).toEqual(['late']);
  });

  test('INTERLEAVED ADDITIONS CANNOT BOTH SPEND THE SAME CAPACITY', () => {
    // The reproduction. Two additions convert concurrently; both then commit.
    // Each commit is sized against the list AS IT IS at that moment, which is
    // what the reducer guarantees — so the second sees the first one's parts.
    const dropped = [part('dropped', 700_000)];
    const pasted = [part('pasted', 700_000)];

    const first = admitAttachments([], dropped, LIMIT);
    const second = admitAttachments(first.parts, pasted, LIMIT);

    expect(names(second.parts)).toEqual(['dropped']);
    expect(second.refused).toEqual(['pasted']);
    const total = second.parts.reduce((sum, p) => sum + dataUrlRawBytes(p.url), 0);
    expect(total).toBeLessThanOrEqual(LIMIT);
  });

  test('NEGATIVE CONTROL: sizing both against the pre-await list exceeds the cap', () => {
    // The mechanism this replaced: each addition read the remaining capacity
    // from the SAME starting list, then appended. Both fit "the remaining
    // capacity" and the combined message broke the cap.
    const start: readonly FileUIPart[] = [];
    const first = admitAttachments(start, [part('dropped', 700_000)], LIMIT);
    const second = admitAttachments(start, [part('pasted', 700_000)], LIMIT);
    const combined = [...first.parts, ...second.parts];

    expect(names(combined)).toEqual(['dropped', 'pasted']);
    expect(combined.reduce((sum, p) => sum + dataUrlRawBytes(p.url), 0)).toBeGreaterThan(LIMIT);
  });

  test('nothing admitted keeps the exact list it was handed', () => {
    const pending = [part('held', LIMIT)];
    const admission = admitAttachments(pending, [part('late', 1)], LIMIT);
    // Identity, not just equality: an unchanged list must not re-render chips.
    expect(admission.parts).toBe(pending);
  });

  test('a part with no filename is still named in the refusal', () => {
    const nameless: FileUIPart = {
      type: 'file',
      mediaType: 'application/octet-stream',
      url: `data:application/octet-stream;base64,${'A'.repeat(LIMIT * 2)}`,
    };
    const admission = admitAttachments([], [nameless], LIMIT);
    expect(admission.parts).toEqual([]);
    expect(admission.refused).toEqual(['an attachment']);
  });

  test('an empty offer is a no-op with nothing refused', () => {
    const pending = [part('held', 10)];
    expect(admitAttachments(pending, [], LIMIT)).toEqual({ parts: pending, refused: [] });
  });
});
