/**
 * A fresh NimbusProcess instance that never saw `startProcess` must materialize the process before serving; measured on
 * production 2ee3f7c92 (~/kinu-logs/slate-cold/REPORT.md) as `404 x-slate-runner: unstarted`. Runs `slateRunnerSource` verbatim.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { present, scratchDir } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { SLATE_SERVER_MODULE } from '@kinu.run/core/slates';
import { slateRunnerSource } from '../src/slates/resident';
import { slateBatchStub } from '../src/slates/rpc-transport';

/** Only `storage.sql` and `waitUntil` are read before `startProcess`. */
interface RunnerCtx { readonly storage: { readonly sql: Record<string, never> }; waitUntil(task: Promise<void>): void }

/** `{ok, value}` on success. */
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

/** Dynamic import: the runner module is generated at runtime. */
async function loadRunner(dir: string, application: string): Promise<RunnerClass> {
  writeFileSync(join(dir, 'cf-stub.js'), [
    'export class DurableObject {',
    '  constructor(ctx, env) { this.ctx = ctx; this.env = env; }',
    '}',
  ].join('\n'));

  // Scratch dirs live outside the repo, so capnweb resolves by absolute path.
  writeFileSync(join(dir, 'capnweb.js'), `export { newWorkersRpcResponse, newWebSocketRpcSession, RpcTarget } from ${JSON.stringify(import.meta.resolve('capnweb'))};`);
  writeFileSync(join(dir, 'vendor.js'), 'export const react = ""; export const capnweb = ""; export const slateClient = "";');
  writeFileSync(join(dir, 'server.js'), SLATE_SERVER_MODULE);
  writeFileSync(join(dir, 'application.js'), application);
  writeFileSync(join(dir, 'runner.js'),
    slateRunnerSource([], undefined).replace('"cloudflare:workers"', '"./cf-stub.js"'));

  const mod: { NimbusProcess?: RunnerClass } = await import(join(dir, 'runner.js'));

  return present(mod.NimbusProcess, "the runner module's NimbusProcess export");
}

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

    // No startProcess call: an instance re-created behind an already-running process row.
    const first = await runner.fetch(get('/ping'));

    expect(first.status).toBe(200);
    expect(first.headers.get('x-slate-runner')).toBeNull();
    // SAFETY: `PING_APP` answers `Response.json({ message: 'pong' })` on /ping.
    expect(await first.json<{ message: string }>()).toEqual({ message: 'pong' });
    expect(slateStarts()).toBe(base + 1);

    const second = await runner.fetch(get('/ping'));

    expect(second.status).toBe(200);
    expect(slateStarts()).toBe(base + 1);

    const cold = instanceOf(Runner);
    const answers = await Promise.all([cold.fetch(get('/ping')), cold.fetch(get('/ping'))]);

    expect(answers.map((response) => response.status)).toEqual([200, 200]);
    expect(slateStarts()).toBe(base + 2);
  });

  test('boots through the same memo whether spawn calls startProcess or a request does', async () => {
    const Runner = await loadRunner(scratchDir('kinu-runner-idem'), PING_APP);
    const runner = instanceOf(Runner);
    const base = slateStarts();

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
      // capnweb HTTP batch against a cold instance: needs the memo and a rebuilt forwarder.
      const before = slateStarts();

      expect((await stub.ping()).starts).toBe(before + 1);
      expect(slateStarts()).toBe(before + 1);
    } finally {
      stub[Symbol.dispose]();
    }
  });

  test('a failed start answers 503 x-slate-runner:start-failed and the next request retries', async () => {
    const dir = scratchDir('kinu-runner-failed');

    const Runner = await loadRunner(dir, [
      'import { SlateObject } from "./server.js";',
      // A live binding: `promote` installs the real class so the retry proves the memo cleared.
      'export let Slate = "not a class";',
      'export function promote() { Slate = class extends SlateObject {',
      '  async fetch() { return new Response("recovered"); }',
      '}; }',
    ].join('\n'));

    const runner = instanceOf(Runner);
    const failed = await runner.fetch(get('/ping'));

    expect(failed.status).toBe(503);
    expect(failed.headers.get('x-slate-runner')).toBe('start-failed');

    const body = v.parse(v.object({ reason: v.string(), error: v.string() }), await failed.json());

    expect(body.reason).toContain('must export class Slate');
    expect(body.error).toBe(body.reason);

    const application: { promote?: () => void } = await import(join(dir, 'application.js'));

    present(application.promote, "the application module's promote export")();

    const retried = await runner.fetch(get('/ping'));

    expect(retried.status).toBe(200);
    expect(await retried.text()).toBe('recovered');
  });
});
