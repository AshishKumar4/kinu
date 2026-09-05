/**
 * The one process-wide stand-in for the Sandbox SDK.
 *
 * `mock.module` is process-wide and has no undo. Each suite that replaced
 * `getSandbox` leaked its double into every file after it. A fetch-less exec
 * double broke the suite that proves the real preview forward. This helper
 * installs the mock once and spreads the real module. The two faked members
 * route through a mutable override that defaults to the real SDK. Each suite
 * sets its double and resets to null in `afterAll`. Later files then meet the
 * real SDK. Re-installing the same factory changes nothing, and a later
 * registration wins, so setting the override also evicts a double that a
 * suite installed directly.
 */
import { mock } from 'bun:test';
import * as realSandboxSdk from '@cloudflare/sandbox';
import type { SandboxOptions } from '@cloudflare/sandbox';

/** The members a suite may fake. The answer types stay generic over each
 *  suite's double rather than naming any suite. */
export interface SandboxSdkOverride<GetSandboxAnswer, ProxyAnswer> {
  getSandbox?: (
    ns: NonNullable<Env['Sandbox']>,
    id: string,
    options?: SandboxOptions,
  ) => GetSandboxAnswer;
  proxyToSandbox?: (request: Request, env: Env) => ProxyAnswer;
}

let current: SandboxSdkOverride<unknown, unknown> | null = null;
let installed = false;

// The real members the routers fall back to, captured by value before the mock
// exists. After installation every read of the module namespace answers with
// the mock, so the routers must never reach the real SDK through it.
const realGetSandbox = realSandboxSdk.getSandbox;
const realProxyToSandbox = realSandboxSdk.proxyToSandbox;

function factory() {
  return {
    ...realSandboxSdk,
    getSandbox: (
      ns: NonNullable<Env['Sandbox']>,
      id: string,
      options?: SandboxOptions,
    ) => {
      const override = current?.getSandbox;
      if (override) return override(ns, id, options);
      return realGetSandbox(ns, id, options);
    },
    proxyToSandbox: (request: Request, env: Env) => {
      const override = current?.proxyToSandbox;
      if (override) return override(request, env);
      return realProxyToSandbox(request, env);
    },
  };
}

/**
 * Install the shared stand-in. Idempotent. Call before importing the module
 * under test.
 */
export async function installSandboxSdkMock(): Promise<void> {
  if (installed) return;
  installed = true;
  await mock.module('@cloudflare/sandbox', factory);
}

/**
 * Point the shared stand-in at a suite's double, or back at the real SDK
 * with null. Reset to null in `afterAll`.
 */
export function setSandboxSdk<GetSandboxAnswer, ProxyAnswer>(
  override: SandboxSdkOverride<GetSandboxAnswer, ProxyAnswer> | null,
): void {
  current = override;
  const completion = mock.module('@cloudflare/sandbox', factory);
  if (completion !== undefined) {
    throw new Error('mock.module(@cloudflare/sandbox) must register synchronously');
  }
}
