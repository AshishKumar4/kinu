/**
 * The transport telemetry reports the transport the process actually used.
 *
 * THE FAILURE THIS LOCKS DOWN SHIPPED. `sandbox.executor_registered` emitted
 * `transport: 'websocket'` from `runtime.ts`, forty lines below a
 * `getSandbox(… transport: "rpc")` in the same `try` block. Every metric on that
 * field named the ONE transport Kinu deliberately does not use — the route-based
 * compatibility client Cloudflare deprecated on 2026-06-09, which cannot restore
 * a workspace past ~11 MiB. Nothing asserted the field, so nothing went red.
 *
 * The fix is a single exported constant rather than a corrected literal, because
 * a literal is what drifted: the SDK persists transport per sandbox object and
 * drops in-flight requests when it changes mid-life for an id, so the call sites
 * must already agree, and the report has to be the same value they agree on.
 * {@link SANDBOX_TRANSPORT} lives in `sandbox-exec-lane.ts` — the one module in
 * the container boundary that imports without a Durable Object, which is why
 * this suite can read it at all.
 *
 * SOURCE ASSERTIONS ARE THE SUBJECT HERE, not a shortcut around one. `runtime.ts`
 * reaches the Agents SDK at load, so its registration path cannot be driven from
 * a test process; and the second half of the claim is agreement between code and
 * `wrangler.jsonc`, which is a fact about the deployed configuration and nowhere
 * else. `scripts/payload-transport.test.ts` pins the same var the same way.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_TRANSPORT } from '../src/sandbox-exec-lane';

const ROOT = join(import.meta.dir, '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

/** Every module that acquires a sandbox for a Kinu workspace. */
const CALL_SITES = [
  'src/runtime.ts',
  'src/orchestrator.ts',
  'src/preview-proxy.ts',
  'src/terminal-route.ts',
] as const;

describe('one transport, named once', () => {
  test('the shared constant is rpc, which is the owner decision the evidence supports', () => {
    // Not a style preference. `http`/`websocket` select the route-based
    // compatibility client: deprecated upstream, and measured against a real
    // 0.12.7 container it fails every /workspace restore at 12 MiB and above
    // (base64 expansion against a 16 MiB frame) while leaving /workspace empty.
    // Changing this value is an owner decision that has to answer that
    // measurement, so the value is pinned rather than merely defaulted.
    expect(SANDBOX_TRANSPORT).toBe('rpc');
  });

  test('every getSandbox call site passes the constant, never a literal', () => {
    for (const site of CALL_SITES) {
      const source = read(site);
      expect(source).toContain('transport: SANDBOX_TRANSPORT');
      // A literal beside the constant is the drift this replaced: two spellings
      // of one value, one of which nothing keeps in step.
      expect(source).not.toContain('transport: "rpc"');
      expect(source).not.toContain("transport: 'rpc'");
    }
  });

  test('the executor_registered event reports the constant, not a literal', () => {
    const runtime = read('src/runtime.ts');
    const event = runtime.slice(runtime.indexOf("diagnostics.event('sandbox.executor_registered'"));
    expect(event).not.toBe('');
    const emitted = event.slice(0, event.indexOf('}'));
    expect(emitted).toContain('transport: SANDBOX_TRANSPORT');
    // The exact stale value, refused by name: this is the literal that shipped.
    expect(emitted).not.toContain('websocket');
  });

  test('no cf-backend source names websocket as a transport any more', () => {
    for (const site of CALL_SITES) {
      expect(read(site)).not.toContain("transport: 'websocket'");
      expect(read(site)).not.toContain('transport: "websocket"');
    }
  });
});

describe('the constant and the deployed configuration agree', () => {
  const wrangler = read('wrangler.jsonc');

  test('both environments declare the same value the code passes', () => {
    const declared = [...wrangler.matchAll(/"SANDBOX_TRANSPORT"\s*:\s*"([^"]+)"/g)]
      .map((match) => match[1]);
    // Production and staging. A third would be a new environment that has to be
    // read, not silently averaged into a pass.
    expect(declared).toEqual([SANDBOX_TRANSPORT, SANDBOX_TRANSPORT]);
  });

  test('the var is still set, because a dropped option must inherit rpc', () => {
    // The option and the var are not redundant. The SDK's `transport` field
    // defaults to `http`, so a future getSandbox that forgets the option falls
    // to the deprecated compatibility client unless the var catches it.
    expect(wrangler).toContain(`"SANDBOX_TRANSPORT": "${SANDBOX_TRANSPORT}"`);
  });
});
