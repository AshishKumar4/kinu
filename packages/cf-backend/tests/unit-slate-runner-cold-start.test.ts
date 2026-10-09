/**
 * The runner as the preview host meets it, `slateRunnerSource` run verbatim. A runner whose start fails answers so and
 * retries on the next request; measured on production 253b86c01 (~/kinu-logs/slate-cold/REPORT.md) as
 * `404 x-slate-runner: unstarted`. A page its class's own `fetch` answers is opened as the runner's own pages are. A
 * cold start over HTTP and RPC, once for requests that arrive together, is the workerd slate-durability journey's.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { present, scratchDir } from '@kinu.run/test-utils';
import { SLATE_PAGE_PREAMBLE } from '@kinu.run/core';
import { SLATE_SERVER_MODULE } from '@kinu.run/core/slates';
import { slateRunnerSource } from '../src/slates/resident';

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
    slateRunnerSource([], undefined, 'class').replace('"cloudflare:workers"', '"./cf-stub.js"'));

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

const get = (path: string) => new Request(`https://slate.invalid${path}`);

describe('a runner whose application fails to start', () => {
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

    const application: { promote?: () => void } = await import(join(dir, 'application.js'));

    present(application.promote, "the application module's promote export")();

    const retried = await runner.fetch(get('/ping'));

    expect(retried.status).toBe(200);
    expect(await retried.text()).toBe('recovered');
  });
});

// Staging and the eval trials (1008-b, 1008-h): a slate serving its own page drew in a fixed box, in the browser's own
// light scheme, while every page the runner served sized to its content and took the chat's theme.
describe('a page the slate serves from its own fetch', () => {
  test('is opened as the runner opens its own: the same head, the page as written after it; other answers pass as sent', async () => {
    const dir = scratchDir('kinu-runner-own-page');
    const page = '<!doctype html><html><head><title>Queue</title></head><body><table><tr><td>4471</td></tr></table></body></html>';

    const Runner = await loadRunner(dir, [
      'import { SlateObject } from "./server.js";',
      'export class Slate extends SlateObject {',
      '  async fetch(request) {',
      '    if (new URL(request.url).pathname === "/api") return Response.json({ open: 3 });',
      `    return new Response(${JSON.stringify(page)}, { headers: { "content-type": "text/html; charset=utf-8", "content-length": "${String(page.length)}" } });`,
      '  }',
      '}',
    ].join('\n'));

    const runner = instanceOf(Runner);
    const opened = await runner.fetch(get('/'));
    const body = await opened.text();

    expect(body.indexOf(SLATE_PAGE_PREAMBLE)).toBeGreaterThan(-1);
    // The head comes first, inside the page's own <html>, and the page follows as it was written.
    expect(body.indexOf(SLATE_PAGE_PREAMBLE)).toBeLessThan(body.indexOf('<title>Queue</title>'));
    expect(body).toContain('<table><tr><td>4471</td></tr></table>');
    // A length the page no longer has would cut it short.
    expect(opened.headers.get('content-length')).toBeNull();

    const api = await runner.fetch(get('/api'));

    expect(await api.text()).toBe(JSON.stringify({ open: 3 }));
  });
});
