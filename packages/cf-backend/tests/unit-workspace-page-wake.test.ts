/**
 * A workspace's page wakes its object while the page loads: the document's request makes the same claim the page's
 * socket makes a moment later, so a cold object's construction runs beside the document, the app and the socket's own
 * connection rather than after them. A name the account does not hold wakes nothing.
 */
import { describe, expect, test } from 'bun:test';
import { workerContext } from './helpers/bindings';
import { makeKv } from './helpers/kv';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

// Dynamic: the entry's graph reaches `cloudflare:email` and `cloudflare:workers` through `agents`.
const { default: worker } = await import('../src/server');

function account(holds: readonly string[]) {
  const asked: string[] = [];

  const workspace = (name: string) => ({
    async claimOwner(userId: string) {
      asked.push(`claim:${name}`);

      return { owner: userId, capabilityHash: 'sha' };
    },
  });

  const env: Partial<Env> = {};

  Object.assign(env, {
    AUTH_KV: makeKv(),
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    DEV_USER_EMAIL: 'owner@example.com',
    ASSETS: { fetch: async () => new Response('<!doctype html><title>Kinu</title>', { headers: { 'content-type': 'text/html' } }) },
    UserDO: {
      idFromName: (name: string) => name,
      get: () => ({
        async hasWorkspace(_caller: { readonly workspaceToken?: string }, name: string) {
          asked.push(`member:${name}`);

          return holds.includes(name);
        },
        async ensureWorkspaceCapability() {},
        // The page's shell names the account's theme; this account chose none.
        async getConfig() { return null; },
      }),
    },
    OrchestratorAgent: { idFromName: (name: string) => name, get: (name: string) => workspace(name) },
  });

  // SAFETY: every member a workspace page's document and its claim read is constructed above.
  return { env: env as Env, asked };
}

describe("a workspace's page", () => {
  // Each case its own name: an isolate keeps the membership it proved, and asks the account once.
  for (const [workspace, path] of [['jarvis', '/workspace/jarvis'], ['friday', '/workspace/friday/agents/researcher']] as const) {
    test(`${path} wakes the workspace as its document is answered`, async () => {
      const { env, asked } = account([workspace]);
      const context = workerContext();

      // The loopback host is where the dev identity signs the request in.
      const answer = await worker.fetch(new Request(`http://localhost${path}`), env, context);

      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain('<title>Kinu</title>');
      await Promise.all(context.retained);
      expect(asked).toEqual([`member:${workspace}`, `claim:${workspace}`]);
    });
  }

  test('of a name the account does not hold wakes nothing', async () => {
    const { env, asked } = account([]);
    const context = workerContext();

    const answer = await worker.fetch(new Request('http://localhost/workspace/someone-elses'), env, context);

    expect(answer.status).toBe(200);
    await Promise.all(context.retained);
    expect(asked.filter((call) => call.startsWith('claim:'))).toEqual([]);
  });
});
