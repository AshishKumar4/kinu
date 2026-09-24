// Checks that the store mount sets its own s3fs connect, silence and retry bounds.
// s3fs defaults let an attach abandoned at `attachBudgetMs` linger beside its retry.
import { describe, expect, test } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY } from '../src/lifecycle';
import { chainBox } from './support/chain-box';
import { DEVBOX_RUNTIME_DIR } from '../src/storage';

/** A key the mount omits leaves s3fs's own default in charge, so its absence fails by name. */
function bound(options: readonly string[], key: string): number {
  const stated = options.find((option) => option.startsWith(`${key}=`));

  if (stated === undefined) throw new Error(`the store mount states no ${key}, leaving s3fs's default in charge`);

  return Number(stated.slice(key.length + 1));
}

describe('the store mount states its own s3fs bounds', () => {
  // Deployed run 20260923160413: the reseat failed EBUSY on the idle default shell (D10, D30).
  test('a first quiesce seats its base though the default session rests on the workspace', async () => {
    const arm = chainBox();
    await arm.box.attachNow();
    await arm.box.writeFile('/workspace/file', 'baseline');
    await arm.box.exec('pwd');
    expect(arm.container.sessionCwds.get('default')).toBe('/workspace');

    expect((await arm.box.checkpointNow('quiesce')).kind).toBe('committed');
    expect(arm.container.layerMounts.size).toBe(1);
    expect(arm.container.sequence).toContain(`cd:default:${DEVBOX_RUNTIME_DIR}`);
    expect(arm.container.sessionCwds.get('default')).toBe('/workspace');
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

    // The connect bound sits inside the attach budget: an abandoned attach must not still be
    // waiting on its connect.
    expect(Number.isFinite(connect)).toBe(true);
    expect(Number.isFinite(silence)).toBe(true);
    expect(Number.isFinite(retries)).toBe(true);
    expect(connect * 1000).toBeLessThanOrEqual(DEFAULT_DEVBOX_POLICY.attachBudgetMs);
    // Each bound sits below s3fs's own default for that option.
    expect(connect).toBeLessThan(300);
    expect(silence).toBeLessThan(120);
    expect(retries).toBeLessThan(5);
  });
});
