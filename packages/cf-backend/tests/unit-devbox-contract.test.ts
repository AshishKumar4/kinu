// The desktop and digest-write wire is declared twice, by rule: core may not depend on @kinu.run/devbox
// (core/execution/sandbox.ts), and devbox depends on no workspace package. cf-backend forwards one to the other
// (sandbox-exec-lane.ts), so it holds them equal. tsc reads this file: a variant, field or bound added on one side
// alone fails the typecheck, not a request at run time.
import { expect, test } from 'bun:test';
import type { SandboxHandle } from '@kinu.run/core';
import type { KinuDevbox } from '../src/kinu-devbox';

/** Every field required, at every depth: an optional field one side added alone is then a field the other lacks. */
type Whole<T> = T extends readonly unknown[] ? { [K in keyof T]: Whole<T[K]> } : T extends object ? { [K in keyof T]-?: Whole<T[K]> } : T;

type Same<A, B> = [Whole<A>] extends [Whole<B>] ? ([Whole<B>] extends [Whole<A>] ? true : false) : false;

type CoreRequest = Parameters<SandboxHandle['desktop']>[0];

type BoxRequest = Parameters<KinuDevbox['desktop']>[0];

const HELD = {
  // The box's request adds only the id its stop ends the action by.
  desktopRequest: true satisfies Same<CoreRequest, Omit<BoxRequest, 'execId'>>,
  desktopAnswer: true satisfies Same<Awaited<ReturnType<SandboxHandle['desktop']>>, Awaited<ReturnType<KinuDevbox['desktop']>>>,
  digestWrite: true satisfies Same<Parameters<SandboxHandle['writeFileIfDigest']>[0], Parameters<KinuDevbox['writeFileIfDigest']>[0]>,
};

test('the computer contract core declares is the one the box takes', () => {
  expect(Object.values(HELD).every(Boolean)).toBe(true);
});
