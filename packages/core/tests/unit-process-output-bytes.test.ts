/** Process output crosses Nimbus core 0.9 as bytes: `textSink` decodes per stream, so a multibyte character
 *  split across chunks lands whole; `shellExecute` (vfs/workspace-runtimes.ts) relies on this. */
import { expect, test } from 'bun:test';
import { textSink } from '@nimbus-sh/core/_shared/bytes.js';

test('a multibyte character split across chunks lands whole', () => {
  const seen: string[] = [];
  const sink = textSink((text) => { seen.push(text); });
  const bytes = new TextEncoder().encode('naïve — ok');
  const cut = 3; // inside the two-byte ï

  sink(bytes.subarray(0, cut));
  sink(bytes.subarray(cut));

  expect(seen.join('')).toBe('naïve — ok');
  expect(seen.join('')).not.toContain('\uFFFD');
});
