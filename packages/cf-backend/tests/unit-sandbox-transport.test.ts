/**
 * Defends: `sandbox.executor_registered` reporting `transport: 'websocket'` while the process used rpc.
 * Source assertions are the subject: `runtime.ts` cannot load in a test, and `wrangler.jsonc` agreement is config.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_TRANSPORT } from '../src/sandbox-exec-lane';

const ROOT = join(import.meta.dir, '..');

const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const CALL_SITES = [
  'src/runtime.ts',
  'src/orchestrator.ts',
  'src/preview-proxy.ts',
  'src/terminal-route.ts',
] as const;

describe('one transport, named once', () => {
  test('the shared constant is rpc, which is the owner decision the evidence supports', () => {
    // The route-based client (`http`/`websocket`) fails restores at 12 MiB and above on a real 0.12.7
    // container (`sandbox.route_client.restore_bytes`); changing this value is an owner decision.
    expect(SANDBOX_TRANSPORT).toBe('rpc');
  });

  test('every getSandbox call site passes the constant, never a literal', () => {
    for (const site of CALL_SITES) {
      const source = read(site);
      expect(source).toContain('transport: SANDBOX_TRANSPORT');
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
    // The exact stale value that shipped, refused by name.
    expect(emitted).not.toContain('websocket');
  });

  test('no cf-backend source names websocket as a transport', () => {
    for (const site of CALL_SITES) {
      expect(read(site)).not.toContain("transport: 'websocket'");
      expect(read(site)).not.toContain('transport: "websocket"');
    }
  });
});

describe('the constant and the deployed configuration agree', () => {
  const wrangler = read('wrangler.jsonc');

  test('the deployment declares the same value the code passes', () => {
    const declared = [...wrangler.matchAll(/"SANDBOX_TRANSPORT"\s*:\s*"([^"]+)"/g)]
      .map((match) => match[1]);

    // Exactly one: a second environment must be read, not averaged into a pass.
    expect(declared).toEqual([SANDBOX_TRANSPORT]);
  });

  test('the var is still set, because a dropped option must inherit rpc', () => {
    // Not redundant: the SDK's `transport` defaults to `http`, so the var catches a getSandbox missing the option.
    expect(wrangler).toContain(`"SANDBOX_TRANSPORT": "${SANDBOX_TRANSPORT}"`);
  });
});
