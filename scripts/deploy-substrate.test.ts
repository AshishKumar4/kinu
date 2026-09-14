import { describe, expect, test } from 'bun:test';

import {
  WRANGLER_FAILED,
  awaitApplicationRollout,
  containerAppIds,
  containerApplicationName,
  deleteFixtureWorker,
  provisionedInstances,
  wranglerProvesAbsence,
  type ApplicationHealth,
  type WranglerOptions,
} from './fixtures/r2-bench/deploy-substrate';

const listing = (output: string) => (
  _repoRoot: string,
  _args: readonly string[],
  _options?: WranglerOptions,
): string => output;

describe('ephemeral container application listings', () => {
  test('a Wrangler failure never proves absence', () => {
    const messages: string[] = [];
    expect(() => containerAppIds(
      '/repo',
      ['wanted'],
      (message) => messages.push(message),
      listing(`${WRANGLER_FAILED}: account selection failed`),
    )).toThrow('absence is unproved');
    expect(messages[0]).toContain('listing failed');
  });

  test('malformed listing output never proves absence', () => {
    expect(() => containerAppIds('/repo', ['wanted'], () => {}, listing('<html>error</html>')))
      .toThrow('no JSON array');
    expect(() => containerAppIds('/repo', ['wanted'], () => {}, listing('[{"id":7}]')))
      .toThrow('invalid');
  });

  test('a parsed account listing is the only absence oracle', () => {
    const output = `banner\n${JSON.stringify([
      { id: 'app-1', name: 'wanted' },
      { id: 'app-2', name: 'other' },
    ])}`;

    expect(containerAppIds('/repo', ['wanted'], () => {}, listing(output))).toEqual([
      { id: 'app-1', name: 'wanted' },
    ]);
    expect(containerAppIds('/repo', ['missing'], () => {}, listing(output))).toEqual([]);
  });
});

describe('container application naming', () => {
  test('names derive from the bound DO class', () => {
    expect(containerApplicationName('kinu-probe-a', 'FuseProbeBox'))
      .toBe('kinu-probe-a-fuseprobebox');
    expect(containerApplicationName('kinu-probe-b', 'PayloadBenchSandbox'))
      .toBe('kinu-probe-b-payloadbenchsandbox');
  });
});

describe('ephemeral Worker deletion', () => {
  test('an already-deleted Worker passes only from explicit absence', () => {
    const outputs = [
      `${WRANGLER_FAILED}: config route failed`,
      `${WRANGLER_FAILED}: This Worker does not exist on your account. [code: 10007]`,
    ];

    const wrangle = (
      _repoRoot: string,
      _args: readonly string[],
      _options?: WranglerOptions,
    ): string => outputs.shift() ?? `${WRANGLER_FAILED}: no response`;

    expect(deleteFixtureWorker('/repo', '/tmp/config', 'worker', () => {}, wrangle)).toBe(true);
  });

  test('authentication and network failures never prove Worker absence', () => {
    expect(wranglerProvesAbsence(`${WRANGLER_FAILED}: Authentication error`)).toBe(false);
    expect(wranglerProvesAbsence(`${WRANGLER_FAILED}: network timeout`)).toBe(false);
    expect(wranglerProvesAbsence(`${WRANGLER_FAILED}: Worker not found`)).toBe(true);
  });
});

/**
 * MEASURED 2026-09-14, `bench-artifacts/rollout-probe/r20260914233505/`: a
 * fresh application's instance read `scheduling:1`, then `starting:1`, and
 * only reported `healthy:1` 37,760 ms after `wrangler deploy` returned; a
 * Durable Object holding the instance reads `active:1` instead. Every
 * `container.start()` before that answers "There is no container instance
 * that can be provided to this Durable Object, try again later".
 */
describe('container application rollout', () => {
  const listed = (_repoRoot: string, names: readonly string[]) => names.map((name) => ({ id: `id-${name}`, name }));

  const readings = (rows: readonly (readonly [number, Record<string, number>])[]) => {
    const queue = [...rows];

    return (_applicationId: string): ApplicationHealth => {
      const next = queue.shift();

      if (next === undefined) throw new Error('the rollout read past its scripted readings');

      return { at: 1_000 + next[0], instances: next[1] };
    };
  };

  test('only provisioned states count; a rollout in progress is zero', () => {
    expect(provisionedInstances({ scheduling: 1 })).toBe(0);
    expect(provisionedInstances({ starting: 1 })).toBe(0);
    expect(provisionedInstances({ healthy: 1 })).toBe(1);
    expect(provisionedInstances({ active: 1, assigned: 1, starting: 2 })).toBe(2);
  });

  test('a deployment is held until its application reports a provisioned instance', async () => {
    const slept: number[] = [];
    const messages: string[] = [];

    const rollout = await awaitApplicationRollout({
      repoRoot: '/repo', application: 'worker-box', log: (message) => messages.push(message), since: 1_000,
      listApplications: listed, pollMs: 2_000, sleep: async (ms) => { slept.push(ms); },
      readHealth: readings([[3_000, { scheduling: 1 }], [5_000, { starting: 1 }], [7_000, { starting: 1 }], [9_000, { healthy: 1 }]]),
    });

    expect(rollout).toEqual({
      application: 'worker-box', applicationId: 'id-worker-box', readyAfterMs: 9_000,
      readings: ['3000 scheduling:1', '5000 starting:1', '7000 starting:1', '9000 healthy:1'],
    });
    expect(slept).toEqual([2_000, 2_000, 2_000]);
    expect(messages).toEqual(['container application worker-box provisioned 9000 ms after deploy (3000 scheduling:1, 5000 starting:1, 7000 starting:1, 9000 healthy:1)']);
  });

  test('an instance a Durable Object already holds is provisioned too', async () => {
    const rollout = await awaitApplicationRollout({
      repoRoot: '/repo', application: 'worker-box', log: () => {}, since: 1_000,
      listApplications: listed, sleep: async () => {}, readHealth: readings([[40_000, { active: 1 }]]),
    });

    expect(rollout.readyAfterMs).toBe(40_000);
  });

  test('a rollout that never provisions refuses the deployment by name and last reading', async () => {
    await expect(awaitApplicationRollout({
      repoRoot: '/repo', application: 'worker-box', log: () => {}, since: 1_000, deadlineMs: 10_000,
      listApplications: listed, sleep: async () => {},
      readHealth: readings([[4_000, { starting: 1 }], [8_000, { starting: 1 }], [12_000, { failed: 1 }]]),
    })).rejects.toThrow('container application worker-box reported no provisioned instance within 10000 ms of deploy (last reading: failed:1)');
  });

  test('an application the account does not list cannot be waited on', async () => {
    await expect(awaitApplicationRollout({
      repoRoot: '/repo', application: 'worker-box', log: () => {}, listApplications: () => [], readHealth: readings([]),
    })).rejects.toThrow('container application worker-box is not listed after deploy');
  });
});
