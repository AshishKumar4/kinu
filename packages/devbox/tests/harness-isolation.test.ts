// The harness's fake SDK base reaches the harness's own box and nothing else in the process: bun runs every file of
// one `bun test` in one process and one module registry, so a substitution left in place is every later suite's.
import { expect, test } from 'bun:test';
import * as sdk from '@cloudflare/sandbox';
// Loaded BEFORE the harness, the way a suite that ran earlier in the process loads the product's class.
import { Devbox as EarlierDevbox } from '../src/devbox';
import { Devbox, FakeSandbox } from './support/devbox-harness';

/** A fresh instance of the product's class module, first evaluated after the harness, the way a later suite's
 *  import of `@kinu.run/devbox` first evaluates it. */
const LATER_INSTANCE = '../src/devbox.ts?after-the-harness';

test('the harness builds its box on the fake though the process loaded the class first', () => {
  expect(Object.getPrototypeOf(Devbox)).toBe(FakeSandbox);
  expect(Object.getPrototypeOf(EarlierDevbox)).toBe(sdk.Sandbox);
});

test('after the harness, the SDK is the one it ships, so a later importer links and builds on the real base', async () => {
  const later: typeof import('../src/devbox') = await import(LATER_INSTANCE);

  expect(sdk.Sandbox).not.toBe(FakeSandbox);
  expect(Object.getPrototypeOf(later.Devbox)).toBe(sdk.Sandbox);
  expect(sdk.getSandbox).toBeInstanceOf(Function);
  expect(sdk.proxyToSandbox).toBeInstanceOf(Function);
});
