import { describe, expect, test } from 'bun:test';
import { BoundedOutput, type OutputSpill } from '../src/execution/bounded-output';

function collectingSpill(saved: Uint8Array[]): () => OutputSpill {
  return () => ({ write: (chunk) => { saved.push(new Uint8Array(chunk)); }, close: () => ({ path: 'out.log' }) });
}

describe('a bounded command output', () => {
  test('a character split across two writes decodes whole', () => {
    const bytes = new TextEncoder().encode('é');
    const output = new BoundedOutput({ headBytes: 16, tailBytes: 16 });
    output.write(bytes.subarray(0, 1));
    output.write(bytes.subarray(1));

    expect(output.finish('stdout')).toBe('é');
  });

  test('a character cut at either seam is dropped whole, the count says so, and the spill keeps every byte', () => {
    const text = `aaaé${'b'.repeat(20)}éccc`;
    const bytes = new TextEncoder().encode(text);
    const saved: Uint8Array[] = [];
    const output = new BoundedOutput({ headBytes: 4, tailBytes: 4 }, collectingSpill(saved));

    for (let offset = 0; offset < bytes.length; offset += 7) output.write(bytes.subarray(offset, offset + 7));

    expect(output.finish('stdout')).toBe('aaa\n[… 24 bytes omitted …]\nccc\n[stdout: 30 bytes, 24 omitted from the middle; the full stdout is at out.log]\n');
    expect(new TextDecoder().decode(Buffer.concat(saved))).toBe(text);
  });
});
