import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('the standalone page assets', () => {
  test.each([
    ['schibsted-latin-var.woff2', 50_000],
    ['fragmentmono-latin.woff2', 30_000],
  ])('%s is a licensed woff2 latin subset inside its byte budget', (filename, budget) => {
    const file = resolve(import.meta.dir, '../public/assets/fonts', filename);
    const bytes = readFileSync(file);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('wOF2');
    expect(bytes.byteLength).toBeLessThanOrEqual(budget);
    expect(readFileSync(resolve(file, '../OFL.txt'), 'utf8')).toContain('SIL Open Font License');
  });
});

