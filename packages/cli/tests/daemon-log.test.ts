// Rotation is copy-truncate, not rename: the detached daemon's inherited stdout fd keeps writing the live file.
import { scratchDir } from '../../test-utils/src/scratch';
import { appendFileSync, closeSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';

import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { appendDaemonLog, readDaemonLogTail, rotateDaemonLogIfNeeded } from '../src/daemon-log';

function makeLog(): string {
  const dir = scratchDir('daemon-log');

  return join(dir, 'daemon.log');
}

describe('daemon log rotation', () => {
  test('rolls at the cap and keeps exactly one predecessor', () => {
    const path = makeLog();
    writeFileSync(path, 'first generation\n'.repeat(10));

    appendDaemonLog(path, 'after the roll\n', 16);

    expect(readFileSync(path, 'utf-8')).toBe('after the roll\n');
    expect(readFileSync(`${path}.1`, 'utf-8')).toContain('first generation');

    // A second roll replaces the predecessor rather than accumulating.
    writeFileSync(path, 'second generation\n'.repeat(10));
    appendDaemonLog(path, 'after the second roll\n', 16);

    expect(readFileSync(`${path}.1`, 'utf-8')).toContain('second generation');
    expect(readFileSync(`${path}.1`, 'utf-8')).not.toContain('first generation');
  });

  test('leaves a log under the cap alone', () => {
    const path = makeLog();
    writeFileSync(path, 'small\n');

    expect(rotateDaemonLogIfNeeded(path, 1024)).toBe(false);
    appendDaemonLog(path, 'more\n', 1024);

    expect(readFileSync(path, 'utf-8')).toBe('small\nmore\n');
  });

  test('is a no-op before anything has been logged', () => {
    const path = makeLog();

    expect(rotateDaemonLogIfNeeded(path, 16)).toBe(false);
    expect(readDaemonLogTail(path, 10)).toBeNull();
  });

  test('an append-mode fd opened before the roll keeps writing to the live log', () => {
    // The daemon's own stdout: inherited at spawn, never reopened, so it must land back at the top after rotation.
    const path = makeLog();
    writeFileSync(path, 'x'.repeat(64));
    const fd = openSync(path, 'a');

    try {
      appendDaemonLog(path, 'rolled\n', 32);
      writeSync(fd, 'from the inherited fd\n');
    } finally {
      closeSync(fd);
    }

    const live = readFileSync(path, 'utf-8');
    expect(live).toContain('from the inherited fd');
    expect(live).not.toContain('x'.repeat(64));
    expect(statSync(path).size).toBeLessThan(64);
  });
});

describe('daemon log tail', () => {
  test('reads across a rotation so history does not vanish at the roll', () => {
    const path = makeLog();
    writeFileSync(path, 'old-1\nold-2\n');

    appendDaemonLog(path, 'new-1\n', 8);
    appendFileSync(path, 'new-2\n');

    expect(readDaemonLogTail(path, 10)).toBe('old-1\nold-2\nnew-1\nnew-2');
    expect(readDaemonLogTail(path, 2)).toBe('new-1\nnew-2');
  });

  test('does not invent a blank line where the files join', () => {
    const path = makeLog();
    writeFileSync(path, 'only-old\n');
    appendDaemonLog(path, 'only-new\n', 4);

    expect(readDaemonLogTail(path, 10)).toBe('only-old\nonly-new');
  });
});
