// KINU-038. The store mount ran on s3fs's own defaults: 300 s to connect, 120 s
// of silence per request, five retries with backoff. A restoration abandons
// its attach at `attachBudgetMs`, so a mount whose connection had died could
// hold that abandoned attempt's s3fs on the container for minutes while the
// retry mounted beside it. The bounds are stated by the box, and this reads
// them off the one call the container's s3fs is configured from.
import { describe, expect, test } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY } from '../src/lifecycle';
import { chainBox } from './support/chain-box';

/** The numeric value of one `key=value` s3fs option, or undefined when the
 *  mount did not state it — which leaves s3fs's own default in charge. */
function bound(options: readonly string[], key: string): number | undefined {
  const stated = options.find((option) => option.startsWith(`${key}=`));

  return stated === undefined ? undefined : Number(stated.slice(key.length + 1));
}

describe('the store mount states its own s3fs bounds', () => {
  test('a publish mounts the store under connect, silence and retry bounds', async () => {
    const arm = chainBox();
    expect((await arm.box.attachNow()).kind).toBe('empty');
    await arm.box.writeFile('/workspace/notes.md', 'one line');
    expect((await arm.box.checkpointNow('quiesce')).kind).toBe('committed');

    const mounted = [...arm.container.s3fsOptionsByMount.entries()];
    expect(mounted).toHaveLength(1);
    const [, options] = mounted[0]!;
    const connect = bound(options, 'connect_timeout');
    const silence = bound(options, 'readwrite_timeout');
    const retries = bound(options, 'retries');

    // Each bound is a real number, and the connect bound sits inside the
    // restoration budget: an attach that has already been abandoned must not
    // still be waiting on its connect.
    expect(Number.isFinite(connect)).toBe(true);
    expect(Number.isFinite(silence)).toBe(true);
    expect(Number.isFinite(retries)).toBe(true);
    expect(connect! * 1000).toBeLessThanOrEqual(DEFAULT_DEVBOX_POLICY.attachBudgetMs);
    // Under s3fs's own defaults on every axis, which is the whole finding.
    expect(connect).toBeLessThan(300);
    expect(silence).toBeLessThan(120);
    expect(retries).toBeLessThan(5);
  });
});
