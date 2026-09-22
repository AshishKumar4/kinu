/**
 * The one process-wide Sandbox SDK stand-in: `mock.module` is process-wide with no undo, so faked
 * members route through an override that defaults to the real SDK. Suites reset it to null in `afterAll`.
 */
import { mock } from 'bun:test';
import * as realSandboxSdk from '@cloudflare/sandbox';
import type { SandboxOptions } from '@cloudflare/sandbox';

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

// Captured before the mock exists: afterwards the module namespace answers with the mock.
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

/** Idempotent. Call before importing the module under test. */
export async function installSandboxSdkMock(): Promise<void> {
  if (installed) return;
  installed = true;
  await mock.module('@cloudflare/sandbox', factory);
}

/** Point the stand-in at a suite's double, or back at the real SDK with null. */
export function setSandboxSdk<GetSandboxAnswer, ProxyAnswer>(
  override: SandboxSdkOverride<GetSandboxAnswer, ProxyAnswer> | null,
): void {
  current = override;
  const completion = mock.module('@cloudflare/sandbox', factory);

  if (completion !== undefined) {
    throw new Error('mock.module(@cloudflare/sandbox) must register synchronously');
  }
}
