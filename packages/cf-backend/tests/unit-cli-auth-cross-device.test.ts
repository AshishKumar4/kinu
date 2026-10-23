/**
 * `kinu auth` approved on another device (2026-10-23: the CLI on a PC over SSH, the browser on a laptop): the terminal
 * polls from its own Cloudflare location and the approval is made at another. Each side here reaches KV through its
 * own location's read cache, as Workers KV serves it, and every request goes through the real routes.
 */
import { describe, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { present } from '@kinu.run/test-utils';
import type { UserCaller } from '@kinu.run/core';
import { CLI_APPROVAL_CSRF_COOKIE_NAME } from '../src/auth/cookies';
import { cliPageRoutes, cliRoutes, type CliRoutesEnv } from '../src/cli/routes';
import { serveFamily } from './helpers/api';
import { bootstrappedProfile, cliAccount, unreachableAssets, unreachableNamespace } from './helpers/bindings';
import { cliAuthObjects } from './helpers/cli-auth';
import { locatedKv } from './helpers/kv';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

/** Loopback, where the dev identity stands for the signed-in browser. */
const LOCAL = 'http://localhost';

const api = serveFamily(cliRoutes);

const pages = serveFamily(cliPageRoutes);

const StartedSchema = v.object({ deviceToken: v.string(), userCode: v.string() });

const PolledSchema = v.object({ status: v.string(), token: v.optional(v.string()) });

/** One account and one Worker, seen from two locations: the terminal's and the laptop browser's. */
function twoLocations() {
  const kv = locatedKv();
  const objects = cliAuthObjects();

  const account = cliAccount({
    async ensureProfile(_caller: UserCaller, email: string) { return bootstrappedProfile(email); },
    async mintCliToken(_caller: UserCaller, userId: string) {
      return { token: `ptc_${userId}_terminal`, tokenHash: 'hash', expiresAt: Date.now() + 60_000 };
    },
  });

  const at = (location: string): CliRoutesEnv<string> => ({
    AUTH_KV: kv(location),
    CliAuthDO: objects,
    UserDO: { idFromName: (name) => name, get: () => account },
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    ASSETS: unreachableAssets(),
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
    DEV_USER_EMAIL: 'owner@example.com',
  });

  return { terminal: at('pc'), laptop: at('laptop') };
}

function postJson(path: string, body: string): Request {
  return new Request(`${LOCAL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

/** The approval page opened and its form submitted, as the browser does. */
async function approveInBrowser(env: CliRoutesEnv<string>, userCode: string): Promise<Response> {
  const page = present(await pages(new Request(`${LOCAL}/cli/auth?code=${encodeURIComponent(userCode)}`), env), 'the approval page');
  const csrf = present(/name="csrf" value="([^"]+)"/u.exec(await page.text())?.[1], 'the form\'s csrf field');
  const cookie = present(page.headers.getSetCookie().find((value) => value.startsWith(`${CLI_APPROVAL_CSRF_COOKIE_NAME}=`)), 'the CSRF cookie');
  const form = new FormData();

  form.set('userCode', userCode);
  form.set('csrf', csrf);

  return present(await pages(new Request(`${LOCAL}/cli/auth`, {
    method: 'POST', headers: { origin: LOCAL, cookie: cookie.split(';')[0] ?? '' }, body: form,
  }), env), 'the approval');
}

describe('a sign-in approved on another device', () => {
  test('the terminal reads the approval on its next poll, wherever it polls from', async () => {
    const { terminal, laptop } = twoLocations();
    const started = v.parse(StartedSchema, await present(await api(postJson('/api/cli/auth/start', JSON.stringify({ deviceName: 'pc' })), terminal), 'the start').json());

    const poll = async () => v.parse(PolledSchema, await present(
      await api(postJson('/api/cli/auth/poll', JSON.stringify({ deviceToken: started.deviceToken })), terminal), 'a poll',
    ).json());

    expect(await poll()).toMatchObject({ status: 'pending' });
    const approval = await approveInBrowser(laptop, started.userCode);

    expect(approval.status).toBe(200);
    expect(await approval.text()).toContain('The Kinu CLI is connected.');
    // Read through the terminal location's KV, this poll answered the copy read a moment ago, `pending`, for 60 s more.
    expect(await poll()).toMatchObject({ status: 'approved', token: expect.stringMatching(/^ptc_/u) });
  });

  test('a location keeps what it read for 60 s, as Workers KV does', async () => {
    const kv = locatedKv();
    const pc = kv('pc');
    const laptop = kv('laptop');

    await pc.put('request', 'pending', { expirationTtl: 600 });
    expect(await pc.get('request')).toBe('pending');
    await laptop.put('request', 'approved', { expirationTtl: 600 });
    expect(await laptop.get('request')).toBe('approved');
    expect(await pc.get('request')).toBe('pending');

    try {
      setSystemTime(new Date(Date.now() + 61_000));
      expect(await pc.get('request')).toBe('approved');
    } finally {
      setSystemTime();
    }
  });
});
