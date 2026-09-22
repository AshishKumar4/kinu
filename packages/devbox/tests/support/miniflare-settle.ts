/**
 * Miniflare disposal that observes the platform rather than trusting the clock.
 *
 * `Miniflare.dispose()` calls `removeDir(tmpPath, { fireAndForget: true })` and
 * resolves while its workerd children are still writing — measured under strace
 * on this suite's own failure: `mkdir` calls for the child's cache and r2
 * directories land AFTER the test's dispose returned, which is the
 * "survived rmSync" survivor `releaseScratch` names when the suite's scratch
 * release wins the race against a dying child.
 *
 * Quiet is observed, not slept: the poll returns once no miniflare-prefixed
 * entry under the process temp directory has changed across one interval, so a
 * fast child costs ~100ms and a wedged one hits the cap and still lets the
 * release report it honestly. `process.env.TMPDIR` is the preload's scratch
 * root under `bun test`, so this watches the same directory the release deletes.
 */
import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Miniflare } from 'miniflare';

/** Every path under each miniflare-prefixed root, with the mtime a writer
 *  bumps. An entry disappearing between readdir and stat is a writer racing
 *  the snapshot — that IS a change, so the entry reads ':gone' rather than
 *  being dropped. */
function miniflareFootprint(): string {
  const parts: string[] = [];

  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('miniflare-')) continue;
    const root = join(tmpdir(), name);
    let entries: unknown[];


    try {
      entries = readdirSync(root, { recursive: true });
    } catch (cause) {
      // ENOENT is the change being watched for: the root was removed between
      // the two readdirs, and disappearance IS activity. Anything else means
      // the snapshot cannot be trusted, so it propagates.
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
