// The composer's attachment cap is an aggregate: concurrent additions must each be sized against
// the list as it is when they commit.
import { describe, test, expect } from 'bun:test';
import type { FileUIPart } from 'ai';
import { admitAttachments } from '../src/hooks/use-pending-attachments';
import { dataUrlRawBytes } from '../src/components/AttachmentChip';

const LIMIT = 1024 * 1024;

/** Exactly `bytes` raw bytes as `dataUrlRawBytes` measures them (3 per 4 base64 chars). */
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
    // Reordering to fit more would rewrite the message the user assembled.
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
    // The replaced mechanism: both sized against the same starting list, and together broke the cap.
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
    // Identity: an unchanged list must not re-render chips.
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
