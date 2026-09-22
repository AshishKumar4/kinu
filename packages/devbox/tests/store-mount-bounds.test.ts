// KINU-038. The store mount ran on s3fs's own defaults: 300 s to connect, 120 s
// of silence per request, five retries with backoff. A restoration abandons
// its attach at `attachBudgetMs`, so a mount whose connection had died could
// hold that abandoned attempt's s3fs on the container for minutes while the
// retry mounted beside it. The bounds are stated by the box, and this reads
// them off the one call the container's s3fs is configured from.
import { describe, expect, test } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY } from '../src/lifecycle';
import { chainBox } from './support/chain-box';
import { DEVBOX_RUNTIME_DIR } from '../src/storage';

/** The numeric value of one `key=value` s3fs option. A key the mount did not
 *  state leaves s3fs's own default in charge, which is the whole defect here,
 *  so its absence fails by name. */
function bound(options: readonly string[], key: string): number {
  const stated = options.find((option) => option.startsWith(`${key}=`));

  if (stated === undefined) throw new Error(`the store mount states no ${key}, leaving s3fs's default in charge`);

  return Number(stated.slice(key.length + 1));
}

describe('the store mount states its own s3fs bounds', () => {
  test('a first checkpoint seats its base with the command session outside the workspace', async () => {
    const arm = chainBox();
    await arm.box.attachNow();
    await arm.box.writeFile('/workspace/file', 'baseline');
    await arm.box.exec('pwd');
    expect(arm.container.sessionCwd).toBe('/workspace');
    expect((await arm.box.checkpointNow('quiesce')).kind).toBe('committed');
    expect(arm.container.layerMounts.size).toBe(1);
    expect(arm.container.sessionCwd).toBe(DEVBOX_RUNTIME_DIR);
  });

  test('a publish mounts the store under connect, silence and retry bounds', async () => {
    const arm = chainBox();
    expect((await arm.box.attachNow()).kind).toBe('empty');
    await arm.box.writeFile('/workspace/notes.md', 'one line');
    expect((await arm.box.checkpointNow('quiesce')).kind).toBe('committed');

    const mounted = [...arm.container.s3fsOptionsByMount.entries()];
    expect(mounted).toHaveLength(1);
    const [, options] = mounted[0];
    const connect = bound(options, 'connect_timeout');
    const silence = bound(options, 'readwrite_timeout');
    const retries = bound(options, 'retries');

    // Each bound is a real number, and the connect bound sits inside the
    // restoration budget: an attach that has already been abandoned must not
    // still be waiting on its connect.
    expect(Number.isFinite(connect)).toBe(true);
    expect(Number.isFinite(silence)).toBe(true);
    expect(Number.isFinite(retries)).toBe(true);
    expect(connect * 1000).toBeLessThanOrEqual(DEFAULT_DEVBOX_POLICY.attachBudgetMs);
    // Under s3fs's own defaults on every axis, which is the whole finding.
    expect(connect).toBeLessThan(300);
    expect(silence).toBeLessThan(120);
    expect(retries).toBeLessThan(5);
  });
});
