/**
 * Process output crosses Nimbus core 0.9 as BYTES, not text: a multibyte
 * character split across two chunks must land whole on the other side.
 *
 * Measured 2026-09-16 on @nimbus-sh/core 0.9.0 (`_shared/bytes.js`
 * `textSink`): the sink is a streaming decoder per stream, so the split
 * character below arrives as one code point. `shellExecute` in
 * `vfs/workspace-runtimes.ts` wraps each of its two streams in exactly this
 * sink; a sink that decoded chunk by chunk would hand `ctx.stdout.write` two
 * replacement characters and the property this file holds would be gone.
 */
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
