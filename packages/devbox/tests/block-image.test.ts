import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { releaseWorkdirHoldersCommand } from '../src/lifecycle';
import { buildBlockImage, removeBlockImage } from './support/block-image';
import { bundleSync } from '../block-lower/bundle-sync';
import artifact from '../block-lower/upstream.json';

test('the pinned image carries the sync this tree bundles, so no container runs a sync its box does not speak', async () => {
  expect(createHash('sha256').update(await bundleSync()).digest('hex')).toBe(artifact.binaries['sync.js']);
});

test('releasing workspace holders does not stop the native image init', () => {
  const image = `devbox-init-owner-${process.pid}`;
  const name = `devbox-init-owner-${process.pid}`;
  buildBlockImage(image);

  try {
    const started = spawnSync('docker', ['run', '--detach', '--name', name, '--network=none', image], { encoding: 'utf8' });

    if (started.status !== 0) throw new Error(started.stderr);

    let removed = '';

    try {
      const released = spawnSync('docker', ['exec', name, '/bin/sh', '-c', releaseWorkdirHoldersCommand('/workspace')], { encoding: 'utf8' });
      const inspected = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', name], { encoding: 'utf8' });
      expect({ exit: released.status, alive: inspected.status === 0 && inspected.stdout.trim() === 'true' })
        .toEqual({ exit: 0, alive: true });
    } finally {
      const removal = spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });

      removed = removal.status === 0 ? '' : removal.stderr;
    }

    expect(removed).toBe('');
  } finally { removeBlockImage(image); }
});
