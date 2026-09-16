// `bun test`'s entry, named by `bunfig.toml`'s `preload`.
//
// Short on purpose: the throwaway KINU_HOME, the release and the
// SIGKILL backstop all live in `./test-scratch-home.ts`, which vitest's entry
// imports too. All this file contributes is the `afterAll` that belongs to THIS
// runner — `bun:test`'s, which throws if called under any other.
import { afterAll, setDefaultTimeout } from 'bun:test';

import { buildSlateVendor } from '../packages/cf-backend/slate-vendor';
import { release } from './test-scratch-home';

// No per-test clock. Bun's 5 s default is a wall clock racing the machine: on
// 2026-09-15 it read red on a test that passes alone, under the deploy wave's
// load. A test ends on its condition or on the process's own end; a hang is
// killed by the deploy ladder at the gate's deadline, which names the gate.
// `0` disables the default (measured on bun 1.4.0: a 5.6 s test passes under
// this preload and fails without it). FIRST, before any hook: bun reads the
// default when a hook is registered, so an `afterAll` above this line keeps
// the 5 s clock (measured 2026-09-15: the release hook below timed out at
// 5000 ms with this call after it). This call reaches the FIRST file of a run
// only (measured the same day: the second of two files timed out at 5000 ms
// under it), so every `bun test` invocation in this tree also carries
// `--timeout=0`, and the ladder rows are pinned to it by `test-clocks.test.ts`.
// `gate:test-clocks` refuses per-test durations in the corpus.
setDefaultTimeout(0);

afterAll(release);

// The two `cloudflare:` builtins the Agents SDK's ROOT module imports
// (`EmailMessage` from cloudflare:email, `RpcTarget`/`exports` from
// cloudflare:workers). They exist only inside workerd, so under `bun test`
// any suite whose graph reaches `agents`' root — every real UserDO or
// orchestrator harness — fails to LOAD, and its coverage silently never runs.
// This is a boundary shim, not behavior: the platform semantics of both
// modules are exercised where they are real, in `tests/workerd` under vitest
// (see bunfig.toml's runner-boundary note); bun-side tests only need the SDK
// module graph to link. `WorkerEntrypoint` and `DurableObject` keep the one
// thing the platform classes do in their constructor — store `ctx` and `env`
// — because code under test reads them: `SupervisorRPC extends
// WorkerEntrypoint` reads `this.ctx.props` on every hosted `git clone`, and
// a bare stub made that clone fail in whichever process loaded the stub
// first. `EmailMessage` keeps its constructor arguments so an assertion can
// read an email a test composed; nothing here fakes delivery: sending under
// bun is refused by the class itself.
//
// ONE stub per specifier. A suite that needs to replace a member spreads this
// module and overrides that member; a second bare `class {}` beside this one
// is how the facets suite and the actor harness came to disagree.

Bun.plugin({
  name: 'workerd-builtins-for-bun-test',
  setup(build) {
    build.module('cloudflare:email', () => ({
      exports: {
        EmailMessage: class EmailMessage {
          constructor(
            readonly from: string,
            readonly to: string,
            readonly raw: string | ReadableStream,
          ) {}
        },
      },
      loader: 'object',
    }));
    build.module('cloudflare:workers', () => ({
      exports: {
        DurableObject: class DurableObject<Ctx, Env> {
          constructor(readonly ctx: Ctx, readonly env: Env) {}
        },
        WorkerEntrypoint: class WorkerEntrypoint<Ctx, Env> {
          constructor(readonly ctx: Ctx, readonly env: Env) {}
        },
        WorkflowEntrypoint: class WorkflowEntrypoint {},
        WorkflowEvent: class WorkflowEvent {},
        RpcTarget: class RpcTarget {},
        exports: {},
        // `enterSpan` deliberately ABSENT: cf-tracer feature-detects it and
        // takes its scoped-fallback path, the same behaviour the workerd
        // tracing-fallback test pins for a runtime without native spans.
        tracing: {},
        // Reading platform env under bun is a test reaching for state that
        // does not exist here; failing by name beats an undefined that
        // reads as "unbound".
        env: new Proxy({}, {
          get(_target, property) {
            throw new Error(
              `cloudflare:workers env.${String(property)} does not exist under bun test — `
              + 'platform bindings live in tests/workerd under vitest',
            );
          },
        }),
      },
      loader: 'object',
    }));
  },
});

// The slate vendor bundle under bun test: the same `virtual:kinu-slate-vendor`
// module the Vite plugin serves in dev/build/vitest, resolved here through
// the package's own `buildSlateVendor` so bun tests measure the real bytes.
Bun.plugin({
  name: 'kinu-slate-vendor-for-bun-test',
  setup(build) {
    let vendor: ReturnType<typeof buildSlateVendor> | undefined;

    build.module('virtual:kinu-slate-vendor', () => {
      vendor ??= buildSlateVendor();

      return { exports: { default: vendor }, loader: 'object' };
    });
  },
});
