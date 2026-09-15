/**
 * The generated runner's own contract: the process is the NimbusProcess
 * instance's state, so a FRESH instance — one that never saw spawn's
 * `startProcess` call — must materialize it before serving. Measured on
 * production 2ee3f7c92 (~/kinu-logs/slate-cold/REPORT.md): a routed request
 * reached a re-created facet instance that answered
 * `404 x-slate-runner: unstarted` because `#slate` was never set.
 *
 * The module text under test is `slateRunnerSource` verbatim; only the
 * imports change. `cloudflare:workers` does not exist under bun, so the DO
 * base class comes from a stub; `server.js` is the real
 * `SLATE_SERVER_MODULE` and `capnweb.js` the real package, so the batch RPC
 * arm below exercises the runner's actual forwarder.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { SLATE_SERVER_MODULE } from '@kinu.run/core/slates';
import { slateRunnerSource } from '../src/slates/resident';
import { slateBatchStub } from '../src/slates/rpc-transport';

/** The `ctx` the platform hands a Durable Object — only `storage.sql` and
 *  `waitUntil` are read before `startProcess`, so the stub needs no more. */
interface RunnerCtx { readonly storage: { readonly sql: Record<string, never> }; waitUntil(task: Promise<void>): void }

/** The bindings the host plants on the facet: `__storage` and `__host` are
 *  raw RPC handles the generated code only forwards through. */
/** The host RPC envelope the generated code checks: `{ok, value}` on success. */
interface HostCallResult { readonly ok: boolean; readonly value?: JsonInput; readonly reason?: string; readonly error?: string }

interface RunnerEnv {
  readonly __storage: { call(member: string, args: readonly JsonInput[]): Promise<HostCallResult> };
  readonly __host: { call(member: string, args: readonly JsonInput[]): Promise<HostCallResult> };
}

type JsonInput = string | number | boolean | null | readonly JsonInput[] | { readonly [key: string]: JsonInput };

interface RunnerInstance {
  fetch(request: Request): Promise<Response>;
  startProcess(startArgs?: JsonInput): Promise<{ ok: boolean }>;
}

interface RunnerClass { new (ctx: RunnerCtx, env: RunnerEnv): RunnerInstance }

// The authored fixture below counts its own constructions on a declared
// global — the runner's start count, since a boot exists to produce exactly
// one Slate. A `var` declaration, not an assertion, because the string source
// under test writes through `globalThis`.
declare global {
  var __slateStarts: number | undefined;
}

const slateStarts = () => globalThis.__slateStarts ?? 0;

/** Write `slateRunnerSource` and its module map into `dir`, then import the
 *  runner the way the dynamic worker loads it. Dynamic import is required:
 *  the module is generated at runtime, so no static specifier can name it. */
async function loadRunner(dir: string, application: string): Promise<RunnerClass> {
  writeFileSync(join(dir, 'cf-stub.js'), [
    'export class DurableObject {',
    '  constructor(ctx, env) { this.ctx = ctx; this.env = env; }',
    '}',
  ].join('\n'));

  // Scratch dirs live outside the repo, so sibling stubs resolve capnweb by
  // absolute path — a bare specifier would walk /tmp for it.
  writeFileSync(join(dir, 'capnweb.js'), `export { newWorkersRpcResponse, newWebSocketRpcSession, RpcTarget } from ${JSON.stringify(import.meta.resolve('capnweb'))};`);
  writeFileSync(join(dir, 'vendor.js'), 'export const react = ""; export const capnweb = ""; export const slateClient = "";');
  writeFileSync(join(dir, 'server.js'), SLATE_SERVER_MODULE);
  writeFileSync(join(dir, 'application.js'), application);
  writeFileSync(join(dir, 'runner.js'),
    slateRunnerSource([], undefined).replace('"cloudflare:workers"', '"./cf-stub.js"'));

  // SAFETY: `runner.js` is `slateRunnerSource`'s own output, which declares
  // `export class NimbusProcess` unconditionally; bun's loader cannot see it.
  const mod = await import(join(dir, 'runner.js')) as { NimbusProcess: RunnerClass };

  return mod.NimbusProcess;
}

/** The `ctx`/`env` the fabric hands the object: `ctx.storage` for `this.sql`,
 *  a `__storage` stub answering an in-memory KV, and `__host` for releases. */
function instanceOf(Runner: RunnerClass): RunnerInstance {
  const kv = new Map<JsonInput, JsonInput>();

  const env: RunnerEnv = {
    __storage: {
      call(member: string, args: readonly JsonInput[]) {
        if (member === 'get') return Promise.resolve({ ok: true, value: { value: kv.get(args[0] ?? null) ?? null } });

        if (member === 'put') {
          kv.set(args[0] ?? null, args[1] ?? null);

          return Promise.resolve({ ok: true, value: null });
        }

        if (member === 'delete') return Promise.resolve({ ok: true, value: kv.delete(args[0] ?? null) });

        if (member === 'list') return Promise.resolve({ ok: true, value: [...kv.keys()] });

        return Promise.resolve({ ok: false, reason: 'bad_input', error: `unknown storage op ${member}` });
      },
    },
    __host: { call: () => Promise.resolve({ ok: true, value: null }) },
  };

  return new Runner({ storage: { sql: {} }, waitUntil() {} }, env);
}

const PING_APP = [
  'import { SlateObject } from "./server.js";',
  'export class Slate extends SlateObject {',
  '  constructor(ctx, env) { super(ctx, env); globalThis.__slateStarts = (globalThis.__slateStarts ?? 0) + 1; }',
  '  async ping() { return { starts: globalThis.__slateStarts }; }',
  '  async fetch(request) {',
  '    if (new URL(request.url).pathname === "/ping") {',
  '      return Response.json({ message: "pong" });',
  '    }',
  '    return new Response("Not found", { status: 404 });',
  '  }',
  '}',
].join('\n');

const get = (path: string) => new Request(`https://slate.invalid${path}`);

describe('a re-created runner instance', () => {
  test('starts its process on the first request and starts only once', async () => {
    const Runner = await loadRunner(scratchDir('kinu-runner-cold'), PING_APP);
    const runner = instanceOf(Runner);
    const base = slateStarts();

    // No startProcess call — exactly the shape of an instance re-created
    // behind an already-running process row.
    const first = await runner.fetch(get('/ping'));

    expect(first.status).toBe(200);
    expect(first.headers.get('x-slate-runner')).toBeNull();
    // SAFETY: `PING_APP` above is the fixture this test file constructs —
    // its fetch answers `Response.json({ message: 'pong' })` on /ping.
    expect(await first.json() as { message: string }).toEqual({ message: 'pong' });
    expect(slateStarts()).toBe(base + 1);

    const second = await runner.fetch(get('/ping'));

    expect(second.status).toBe(200);
    expect(slateStarts()).toBe(base + 1);

    // Concurrent requests on one cold instance share the one boot.
    const cold = instanceOf(Runner);
    const answers = await Promise.all([cold.fetch(get('/ping')), cold.fetch(get('/ping'))]);

    expect(answers.map((response) => response.status)).toEqual([200, 200]);
    expect(slateStarts()).toBe(base + 2);
  });

  test('boots through the same memo whether spawn calls startProcess or a request does', async () => {
    const Runner = await loadRunner(scratchDir('kinu-runner-idem'), PING_APP);
    const runner = instanceOf(Runner);
    const base = slateStarts();

    // The normal path — spawn's startProcess lands first, requests second —
    // and the cold-start path see the same single boot per instance.
    expect((await runner.startProcess()).ok).toBe(true);
    expect((await runner.startProcess()).ok).toBe(true);
    expect((await runner.fetch(get('/ping'))).status).toBe(200);
    expect(slateStarts()).toBe(base + 1);

    const cold = instanceOf(Runner);

    expect((await cold.fetch(get('/ping'))).status).toBe(200);
    expect((await cold.startProcess()).ok).toBe(true);
    expect(slateStarts()).toBe(base + 2);
  });

  test('the /__rpc batch path starts the process before it forwards', async () => {
    const Runner = await loadRunner(scratchDir('kinu-runner-rpc'), PING_APP);
    const runner = instanceOf(Runner);

    interface PingSurface { ping(): Promise<{ starts: number }> }

    const stub = slateBatchStub<PingSurface>(
      { request: (request) => runner.fetch(request) }, 'inv-1',
    );

    try {
      // One authored method over capnweb's HTTP batch transport, issued
      // against a cold instance: requires the memo AND a rebuilt forwarder.
      const before = slateStarts();

      expect((await stub.ping()).starts).toBe(before + 1);
      expect(slateStarts()).toBe(before + 1);
    } finally {
      // SAFETY: `getRemoteMain` returns the session's RpcStub, which is
      // always disposable; the generic surface cannot name the symbol.
      (stub as { [Symbol.dispose](): void })[Symbol.dispose]();
    }
  });

  test('a failed start answers 503 x-slate-runner:start-failed and the next request retries', async () => {
    const dir = scratchDir('kinu-runner-failed');

    // The slate publishes a non-class first; `promote` is how the test makes
    // the same module record succeed on retry.
    const Runner = await loadRunner(dir, [
      'import { SlateObject } from "./server.js";',
      // `Slate` is a live binding: the first start sees a value that fails the
      // class contract; `promote` installs the real class so the retry proves
      // the memo cleared rather than serving a cached refusal.
      'export let Slate = "not a class";',
      'export function promote() { Slate = class extends SlateObject {',
      '  async fetch() { return new Response("recovered"); }',
      '}; }',
    ].join('\n'));

    const runner = instanceOf(Runner);
    const failed = await runner.fetch(get('/ping'));

    expect(failed.status).toBe(503);
    expect(failed.headers.get('x-slate-runner')).toBe('start-failed');

    // SAFETY: the 503 body is the refusal the runner itself builds —
    // `{reason, error}`, the shape the host's previewUnavailable sends.
    const body = await failed.json() as { reason: string; error: string };

    expect(body.reason).toContain('must export class Slate');
    expect(body.error).toBe(body.reason);

    // SAFETY: `promote` is constructed into `application.js` by `loadRunner`
    // above — this test file owns that module's text, so the member exists.
    (await import(join(dir, 'application.js')) as { promote(): void }).promote();

    const retried = await runner.fetch(get('/ping'));

    expect(retried.status).toBe(200);
    expect(await retried.text()).toBe('recovered');
  });
});
