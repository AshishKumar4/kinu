/** SIGKILL skips exit handlers; only builds whose owner has gone may be reclaimed. */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { scratchDir } from '../packages/test-utils/src/scratch';

import { contrast, reclaimLeakedBuilds, rgba } from './gallery-harness';

test('a contrast just below WCAG AA does not pass by rounding', () => {
  // WCAG 2.2 SC 1.4.3 forbids rounding its threshold; this pair's ratio is 4.499795462746351:1.
  const ratio = contrast(rgba('rgb(112, 121, 114)'), rgba('rgb(255, 255, 255)'));

  expect(ratio).toBeLessThan(4.5);
  expect(ratio).toBeGreaterThan(4.499);
});

test('fractional sRGB channels below the WCAG 2.2 cutoff stay on its linear branch', () => {
  expect(contrast(rgba('rgb(10.3, 10.3, 10.3)'), rgba('rgb(255, 255, 255)')))
    .toBeCloseTo(19.764211849397245, 10);
});

describe('gallery builds under the temp directory', () => {
  test('a dead owner\'s build is removed and a live owner\'s build stays', () => {
    // A pid that was a process and is not one now: a child that has exited.
    const exited = spawnSync('true');
    expect(exited.status).toBe(0);
    const directory = scratchDir('gallery-reclaim');
    const deadBuild = scratchDir(`gallery-dist-${String(exited.pid)}`, directory);
    const liveBuild = scratchDir(`gallery-dist-${String(process.pid)}`, directory);

    expect(reclaimLeakedBuilds(directory)).toBeGreaterThanOrEqual(1);
    expect(existsSync(deadBuild)).toBe(false);
    expect(existsSync(liveBuild)).toBe(true);
  });
});
