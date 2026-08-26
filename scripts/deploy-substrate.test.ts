import { describe, expect, test } from 'bun:test';

import {
  WRANGLER_FAILED,
  containerAppIds,
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
