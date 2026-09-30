/**
 * A generated build file is replaced whole. On 2026-09-30 a deploy wave's workerd rows read the slate vendor module
 * while another config load rewrote it in place, and built `kinu-puppeteer.js` with no exports. A reader that opened
 * the file before a rewrite is that race made deterministic: it must still read one complete version, never a
 * truncated one.
 */

import { expect, test } from 'bun:test';
import { openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { writeWhole } from '../vite-agent-bundle';

test('a reader holding the file across a rewrite reads one whole version', () => {
  const path = join(scratchDir('write-whole'), 'slate-vendor.js');
  const before = `export default ${JSON.stringify('a'.repeat(64 * 1024))};\n`;

  writeFileSync(path, before);

  const reader = openSync(path, 'r');

  writeWhole(path, 'export default "b";\n');

  const held = Buffer.alloc(before.length);
  const read = readSync(reader, held, 0, held.length, 0);

  expect(held.subarray(0, read).toString()).toBe(before);
  expect(readFileSync(path, 'utf8')).toBe('export default "b";\n');
});
