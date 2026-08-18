import { describe, expect, test } from 'bun:test';
import {
  fetchServedVersion,
  isSameBuild,
  shouldCheckForUpdate,
  updateNotice,
} from '../src/version-check';
import type { JsonValue } from '@proteus/core';

const served = (version: string) => ({ version });

describe('build comparison', () => {
  test('semver build metadata is significant — same version, different build', () => {
    expect(isSameBuild('0.1.0+abc1234', '0.1.0+abc1234')).toBe(true);
    expect(isSameBuild('0.1.0+abc1234', '0.1.0+def5678')).toBe(false);
    // An unstamped local build vs a stamped served one is NOT the same build.
    expect(isSameBuild('0.1.0', '0.1.0+abc1234')).toBe(false);
    expect(isSameBuild('0.1.0', '0.1.0')).toBe(true);
  });

  test('notice appears only for a different build', () => {
    expect(updateNotice('0.1.0+aaa', served('0.1.0+aaa'))).toBeNull();
    expect(updateNotice('0.1.0+aaa', null)).toBeNull();
    expect(updateNotice('0.1.0+aaa', served('0.1.0+bbb')))
      .toContain('0.1.0+bbb');
  });
});

describe('startup-check suppression', () => {
  const base = { origin: 'https://example.test', updateCheckedAt: 0 };
  const DAY = 24 * 60 * 60_000;

  test('runs on a TTY, signed in, once past the 24h window', () => {
    expect(shouldCheckForUpdate({ config: base, isTTY: true, now: DAY + 1 })).toBe(true);
  });

  test('suppressed in non-TTY runs (CI, pipes, --json)', () => {
    expect(shouldCheckForUpdate({ config: base, isTTY: false, now: DAY + 1 })).toBe(false);
  });

  test('suppressed by the opt-out flag', () => {
    expect(shouldCheckForUpdate({
      config: { ...base, updateCheck: false }, isTTY: true, now: DAY + 1,
    })).toBe(false);
  });

  test('suppressed with no configured origin', () => {
    expect(shouldCheckForUpdate({
      config: { updateCheckedAt: 0 }, isTTY: true, now: DAY + 1,
    })).toBe(false);
  });

  test('throttled inside the 24h window', () => {
    expect(shouldCheckForUpdate({
      config: { ...base, updateCheckedAt: DAY }, isTTY: true, now: DAY + 60_000,
    })).toBe(false);
  });
});

describe('fetchServedVersion is fail-soft', () => {
  const ok = (body: JsonValue) => async () => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

  test('parses a well-formed payload', async () => {
    const v = await fetchServedVersion('https://x.test', ok({ version: '0.1.0+abc', sha: 'abc' }));
    expect(v).toEqual({ version: '0.1.0+abc', sha: 'abc' });
  });

  test('returns null on 404 (server without the endpoint)', async () => {
    const f = async () => new Response('nope', { status: 404 });
    expect(await fetchServedVersion('https://x.test', f)).toBeNull();
  });

  test('returns null on malformed payloads and network errors', async () => {
    expect(await fetchServedVersion('https://x.test', ok({ nope: true }))).toBeNull();
    expect(await fetchServedVersion('https://x.test', ok({ version: '  ' }))).toBeNull();
    const boom = async () => { throw new Error('offline'); };
    expect(await fetchServedVersion('https://x.test', boom)).toBeNull();
  });

  test('returns null rather than hanging when the origin stalls', async () => {
    const stall = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    });
    expect(await fetchServedVersion('https://x.test', stall, 10)).toBeNull();
  });
});
