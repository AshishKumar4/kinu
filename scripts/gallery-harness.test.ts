/**
 * The gallery build's owner is in its name, and the next build removes the
 * builds of owners that are gone. Sixty-one leaked builds, 71 MiB each,
 * exhausted a tmpfs quota on 2026-09-05; the `exit` handler that removes a
 * build never runs for a killed process, so liveness is the rule.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reclaimLeakedBuilds } from './gallery-harness';

describe('gallery builds under the temp directory', () => {
  test('a dead owner\'s build is removed and a live owner\'s build stays', () => {
    // A pid that was a process and is not one now: a child that has exited.
    const exited = spawnSync('true');
    expect(exited.status).toBe(0);
    const deadBuild = mkdtempSync(join(tmpdir(), `kinu-gallery-dist-${String(exited.pid)}-`));
    const liveBuild = mkdtempSync(join(tmpdir(), `kinu-gallery-dist-${String(process.pid)}-`));
    try {
      expect(reclaimLeakedBuilds()).toBeGreaterThanOrEqual(1);
      expect(existsSync(deadBuild)).toBe(false);
      expect(existsSync(liveBuild)).toBe(true);
    } finally {
      rmSync(deadBuild, { recursive: true, force: true });
      rmSync(liveBuild, { recursive: true, force: true });
    }
  });
});
