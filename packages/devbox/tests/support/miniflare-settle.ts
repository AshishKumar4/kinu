/** Waits for miniflare's workerd children to go quiet after `dispose()`, which resolves while
 *  they still write; polls miniflare-prefixed temp entries until unchanged for one interval. */
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Miniflare } from 'miniflare';

/** An entry vanishing between readdir and stat is a racing writer, which counts as a change,
 *  so it reads ':gone' rather than being dropped. */
function miniflareFootprint(): string {
  const parts: string[] = [];

  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('miniflare-')) continue;
    const root = join(tmpdir(), name);
    let entries: unknown[];


    try {
      entries = readdirSync(root, { recursive: true });
    } catch (cause) {
      // ENOENT means the root vanished between the readdirs, and disappearance counts as activity.
      // Any other error makes the snapshot untrustworthy, so it propagates.
      if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'ENOENT') throw cause;
      parts.push(`${root}:gone`);
      continue;
    }

    for (const entry of entries) {
      const path = join(root, String(entry));

      try {
        parts.push(`${path}:${String(statSync(path).mtimeMs)}`);
      } catch (cause) {
        if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'ENOENT') throw cause;
        parts.push(`${path}:gone`);
      }
    }
  }

  return parts.join('|');
}

export async function disposeMiniflare(runtime: Miniflare): Promise<void> {
  await runtime.dispose();

  let last = miniflareFootprint();
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = miniflareFootprint();

    if (now === last) return;
    last = now;
  }
}
