/**
 * One principal model for every egress a program's request leaves Kinu by (audit SelfishJaguar #6): the container's and a
 * Nimbus workspace's (`KinuEgress`, its props as a devbox keeps them) and a codemode program's or a slate's
 * (`CodemodeEgress`). What a request may do follows from whom it runs for, never from which of them carries it: the
 * owner's opens the workspace's own previews with its pass, spends the owner's secrets, and has its GitHub work recorded
 * as the owner's; a share's viewer's does none of these.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asFetchFunction, sandboxPreviewExposures, type EgressPrincipal, type EgressRequestFacts, type GitHubFact, type UserCaller } from '@kinu.run/core';
import { exports as workersExports } from 'cloudflare:workers';
import { CodemodeEgress } from '../src/codemode-egress';
import type { PreviewVisit } from '../src/nimbus-route';
import { PREVIEW_SELF } from '../src/viewer-pass';
import { workerContext } from './helpers/bindings';
import { makeKv } from './helpers/kv';
import { jsrpcStub } from './helpers/jsrpc-stub';
import { TEST_CREDENTIAL_ENCRYPTION_KEY, TEST_USER_ENV, createTestUserDO, provisionTestWorkspace, testOwner } from './helpers/user-do';

const OWNER_ID = '0123456789abcdef0123456789abcdef';

const SECRET = ['sk_live_', 'principal0123456789a'].join('');

const OWNER: EgressPrincipal = { as: 'owner', workspace: 'hello', actorId: 'a1', ownerUserId: OWNER_ID };

const VIEWER: EgressPrincipal = { as: 'viewer', workspace: 'hello', actorId: null };

/** Each egress built for `principal`, as its own caller mints it: the devbox keeps KinuEgress's props in their stored shape. */
const EGRESSES = {
  container: (principal: EgressPrincipal, env: Env, ctx: ExecutionContext) => new KinuEgress(
    { ...ctx, props: principal.as === 'owner' ? { workspaceName: principal.workspace, ownerUserId: principal.ownerUserId, actorId: principal.actorId } : { principal: 'viewer', workspaceName: principal.workspace } },
    env,
  ),
  codemode: (principal: EgressPrincipal, env: Env, ctx: ExecutionContext) => new CodemodeEgress({ ...ctx, props: { principal } }, env),
} as const;

const CASES: ReadonlyArray<readonly [keyof typeof EGRESSES, 'owner' | 'viewer', EgressPrincipal]> = (['container', 'codemode'] as const).flatMap((egress) => [
  [egress, 'owner', OWNER] as const,
  [egress, 'viewer', VIEWER] as const,
]);

/** The computer of `hello` published port 8080 under this token. */
const PREVIEWS = makeKv();

await sandboxPreviewExposures(PREVIEWS, 'kinu-hello').publish(8080, 'p8080_ab12cd34');

// Dynamic: the entry's graph reaches `cloudflare:email` and `cloudflare:workers` through `agents`.
const { default: server, KinuEgress } = await import('../src/server');

let sent: Request[];

let recorded: { workspace: string; facts: readonly GitHubFact[]; actorId: string | null }[];

/** Workspace `hello`, owned by OWNER_ID, holding Stripe's secret; its previews under previews.example; GitHub's work recorded. */
async function workspaceEnv() {
  const harness = createTestUserDO();
  const workspace: UserCaller = { workspaceToken: await provisionTestWorkspace(harness, 'hello') };

  await harness.userDO.putSecrets(await testOwner(), [{ name: 'STRIPE_SECRET_KEY', hosts: ['api.stripe.com'], position: { kind: 'authorization' }, value: SECRET }], ['hello']);
  const placeholder = (await harness.userDO.grantedSecrets(workspace)).granted[0]?.placeholder ?? '';
  const view: Partial<Env> = {};

  Object.assign(view, {
    ...TEST_USER_ENV,
    PREVIEW_HOST_SUFFIX: 'previews.example',
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    AUTH_KV: PREVIEWS,
    KinuDevbox: { getByName: (sandbox: string) => ({ fetch: async () => new Response(`computer ${sandbox}`) }) },
    UserDO: {
      idFromName: (name: string) => name,
      get: () => jsrpcStub({ resolveEgressInjection: (caller: UserCaller, facts: EgressRequestFacts, name: string) => harness.userDO.resolveEgressInjection(caller, facts, name) }),
    },
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        __unsafe_ensureInitialized: async () => undefined,
        recordGitHubEgress: async (facts: readonly GitHubFact[], actorId: string | null) => { recorded.push({ workspace: name, facts, actorId }); },
        // A preview opens for its owner and for the workspace itself, which its own programs' fetches are.
        routeWorkspacePreview: async ({ port, pathname, viewer }: PreviewVisit) =>
          new Response(`preview of ${name} port ${String(port)} ${pathname}${viewer === PREVIEW_SELF ? '' : ` as ${String(viewer)}`}`),
      }),
    },
  });
  // SAFETY: each member the egresses and the preview rail read is constructed above: UserDO, CREDENTIAL_ENCRYPTION_KEY,
  // PREVIEW_HOST_SUFFIX and OrchestratorAgent (egress/policy.ts, egress/send-out.ts), AUTH_KV and KinuDevbox (the
  // preview rail, step 1 of nimbus-route.ts's table); no other member is reachable.
  const env = view as Env;

  Object.assign(workersExports, { default: { fetch: (request: Request) => server.fetch(request, env, workerContext()) } });

  return { env, placeholder };
}

beforeEach(() => {
  sent = [];
  recorded = [];
  globalThis.fetch = asFetchFunction(async (input, init) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);

    sent.push(request);

    return request.url.startsWith('https://api.github.com/')
      ? Response.json({ number: 42, title: 'Guard webhook retries', state: 'open', html_url: 'https://github.com/acme/api/pull/42', head: { ref: 'fix/webhook-retries' } }, { status: 201 })
      : new Response('upstream');
  });
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(workersExports, 'default');
});

describe.each(CASES)('the %s egress, for the %s', (egress, as, principal) => {
  test(as === 'owner' ? 'opens its workspace\'s own preview with the workspace\'s pass, from this Worker' : 'reaches its workspace\'s preview as no one', async () => {
    const { env } = await workspaceEnv();
    const answer = await EGRESSES[egress](principal, env, workerContext()).fetch(new Request('https://8080-kinu-hello-p8080_ab12cd34.previews.example/status'));

    expect(answer.status).toBe(as === 'owner' ? 200 : 403);
    expect(sent).toEqual([]);
  });

  test(as === 'owner' ? 'spends the owner\'s secret on its host' : 'spends no secret, and the account is not asked', async () => {
    const { env, placeholder } = await workspaceEnv();
    const answer = await EGRESSES[egress](principal, env, workerContext()).fetch(new Request('https://api.stripe.com/v1/charges', { headers: { authorization: `Bearer ${placeholder}` } }));

    expect(answer.status).toBe(as === 'owner' ? 200 : 403);
    expect(sent.map((request) => request.headers.get('authorization'))).toEqual(as === 'owner' ? [`Bearer ${SECRET}`] : []);
  });

  test(as === 'owner' ? 'has its GitHub work recorded as the owner\'s, for its agent' : 'has none of its GitHub work recorded as the owner\'s', async () => {
    const { env } = await workspaceEnv();
    const ctx = workerContext();
    const answer = await EGRESSES[egress](principal, env, ctx).fetch(new Request('https://api.github.com/repos/acme/api/pulls', { method: 'POST', body: '{}' }));

    await answer.text();
    await Promise.all(ctx.retained);
    expect(answer.status).toBe(201);
    expect(recorded).toEqual(as === 'owner' ? [{ workspace: 'hello', actorId: 'a1', facts: [expect.objectContaining({ action: 'opened', subject: 'pr', repo: 'acme/api', number: 42 })] }] : []);
  });

  test('is refused a private destination before the network', async () => {
    const { env } = await workspaceEnv();
    const answer = await EGRESSES[egress](principal, env, workerContext()).fetch(new Request('http://169.254.169.254/latest/meta-data/'));

    expect(answer.status).toBe(403);
    expect(sent).toEqual([]);
  });
});
