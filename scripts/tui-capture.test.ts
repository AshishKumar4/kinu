import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { runToExit, scratchDir } from '@kinu.run/test-utils';

test('the capture command renders every screen without OpenTUI render errors', async () => {
  const captureDir = scratchDir('tui-capture');
  const set = 'regression';

  const run = await runToExit([process.execPath, resolve(import.meta.dir, 'tui-capture.ts'), set], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...process.env, TUI_CAPTURE_DIR: captureDir },
  });

  expect(run.exitCode, run.stderr).toBe(0);
  const frames = readdirSync(join(captureDir, set));
  expect(frames).toHaveLength(13);

  for (const frame of frames) expect(readFileSync(join(captureDir, set, frame), 'utf8').trim()).not.toBe('');

  expect(run.stderr).toBe('');
  expect(run.stdout.trim()).toBe(`captured ${set}: done`);
});
