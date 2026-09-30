// The sandbox size in Kinu (DEVBOX-DECISIONS D50): the owner's account default through the user config route, which
// takes only a size the table names, the words the Environment card and User settings show for it, and
// `sandbox.resize` through the adapter.
import './helpers/ui-module-globals';
import { describe, expect, test } from 'bun:test';
import { DevboxError } from '@kinu.run/devbox';
import type { AuthIdentity } from '../src/auth/session';
import type { KinuDevbox } from '../src/kinu-devbox';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import { userRoutes, type UserRoutesEnv } from '../src/user/routes';
import { accountSandboxSize, SANDBOX_SIZE_CONFIG_KEY } from '../src/sandbox-size';
import { sandboxSizeText, workspaceSizeNote, workspaceSizeOptions } from '../src/lib/sandbox-size-text';
import { settingsSection } from '../src/components/SettingsRail';
import { serveFamily } from './helpers/api';
import { unreachableNamespace, workerContext } from './helpers/bindings';
import { TEST_CREDENTIAL_ENCRYPTION_KEY, createTestUserDO, testOwner, type TestUserDO } from './helpers/user-do';

const USER_ID = '0123456789abcdef0123456789abcdef';

const IDENTITY: AuthIdentity = { userId: USER_ID, email: 'ashish@example.com', sub: 'route-test', provider: 'test', displayName: 'Ashish' };

function routeEnv(userDO: TestUserDO['userDO']): UserRoutesEnv<string> {
  return {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    UserDO: { idFromName: (name) => name, get: () => userDO },
    OrchestratorAgent: unreachableNamespace('OrchestratorAgent'),
  };
}

async function sizeRoute(env: UserRoutesEnv<string>, method: string, value?: string): Promise<Response> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };

  if (value !== undefined) init.body = JSON.stringify({ value });

  const answered = await serveFamily(userRoutes, { identity: IDENTITY, ctx: workerContext() })(
    new Request(`https://kinu.example.com/api/user/config/${SANDBOX_SIZE_CONFIG_KEY}`, init), env);

  if (answered === null) throw new Error('the user routes did not answer the sandbox size');

  return answered;
}

describe("the owner's account default", () => {
  test('takes a size the table names, reads back as that size, and refuses any other', async () => {
    const harness = createTestUserDO({ durableObjectId: USER_ID });
    await harness.userDO.ensureProfile(await testOwner(), IDENTITY.email, IDENTITY.displayName ?? undefined);
    const env = routeEnv(harness.userDO);

    const refused = await sizeRoute(env, 'PUT', 'huge');
    const refusedText = await refused.text();
    const unset = await (await sizeRoute(env, 'GET')).json();
    const stored = (await sizeRoute(env, 'PUT', 'large')).status;
    const read = await (await sizeRoute(env, 'GET')).json();

    expect({ refused: refused.status, refusedText, unset, stored, read }).toEqual({
      refused: 400,
      refusedText: expect.stringContaining('sandbox_size must be one of small, medium, large'),
      unset: { key: 'sandbox_size', value: null },
      stored: 200,
      read: { key: 'sandbox_size', value: 'large' },
    });
    harness.close();
  });

  test('a stored value that names no size reads as no choice', () => {
    expect([accountSandboxSize('large'), accountSandboxSize('huge'), accountSandboxSize(null)]).toEqual(['large', null, null]);
  });
});

describe('what the owner reads', () => {
  test('each size reads as its table row', () => {
    expect(sandboxSizeText('medium')).toBe('Medium · 2 vCPU · 8 GiB · 20 GB disk');
  });

  test("the Environment card offers the account default, named, then every size", () => {
    expect(workspaceSizeOptions('large')).toEqual([
      { value: 'account', label: 'Account default: Large · 4 vCPU · 12 GiB · 20 GB disk' },
      { value: 'small', label: 'Small · 1 vCPU · 4 GiB · 20 GB disk' },
      { value: 'medium', label: 'Medium · 2 vCPU · 8 GiB · 20 GB disk' },
      { value: 'large', label: 'Large · 4 vCPU · 12 GiB · 20 GB disk' },
    ]);
    expect(workspaceSizeOptions(null)[0]?.label).toBe('Account default: Medium · 2 vCPU · 8 GiB · 20 GB disk');
  });

  const NOTES = [
    { name: 'a sandbox running at its size says nothing more', state: { account: null, chosen: null, size: 'medium', running: 'medium' }, pending: false, says: null },
    { name: 'a stopped sandbox says nothing more', state: { account: null, chosen: 'large', size: 'large', running: null }, pending: false, says: null },
    { name: 'a sandbox still running at an older size says when it changes',
      state: { account: 'small', chosen: null, size: 'small', running: 'medium' }, pending: false,
      says: 'Runs at Medium until it next starts, then at Small.' },
    { name: 'a change to a running sandbox restarts it', state: { account: null, chosen: null, size: 'medium', running: 'medium' }, pending: true,
      says: 'Restarting at the new size…' },
    { name: 'a change to a stopped sandbox only saves', state: { account: null, chosen: null, size: 'medium', running: null }, pending: true,
      says: 'Saving…' },
  ] as const;

  for (const { name, state, pending, says } of NOTES) {
    test(name, () => {
      expect(workspaceSizeNote(state, pending)).toBe(says);
    });
  }

  test('User settings has a Sandbox section of its own', () => {
    expect(settingsSection('#sandbox')).toBe('sandbox');
  });
});

describe('sandbox.resize through the adapter', () => {
  test('configures the box, which pushes the account default, then resizes it without attaching it', async () => {
    const steps: string[] = [];

    // Any other box call would be a TypeError: a box that is not running only records the size.
    const box: KinuDevbox = Object.create({
      resize: async (size: string | null) => {
        steps.push(`resize ${String(size)}`);

        return { kind: 'recorded', size, previous: undefined };
      },
    });

    const handle = adaptCloudflareSandbox(box, async () => { steps.push('configured'); }, null);

    expect({ resized: await handle.resize('small'), steps })
      .toEqual({ resized: { kind: 'recorded', size: 'small' }, steps: ['configured', 'resize small'] });
  });

  test('a size devbox does not know is refused as bad input', async () => {
    const box: KinuDevbox = Object.create({
      resize: async (size: string) => {
        throw new DevboxError('invalid-input', `no box size ${size}; the sizes are small, medium, large`);
      },
    });

    await expect(adaptCloudflareSandbox(box, async () => {}, null).resize('huge'))
      .rejects.toMatchObject({ code: 'bad_input', message: expect.stringContaining('no box size huge') });
  });
});
