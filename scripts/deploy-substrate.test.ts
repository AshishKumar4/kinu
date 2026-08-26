import { describe, expect, test } from 'bun:test';

import {
  WRANGLER_FAILED,
  containerAppIds,
  containerApplicationName,
  deleteFixtureWorker,
  wranglerProvesAbsence,
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
