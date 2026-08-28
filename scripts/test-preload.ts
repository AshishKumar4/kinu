// `bun test`'s entry, named by `bunfig.toml`'s `preload`.
//
// Three lines on purpose: the throwaway KINU_HOME, the release and the
// SIGKILL backstop all live in `./test-scratch-home.ts`, which vitest's entry
// imports too. All this file contributes is the `afterAll` that belongs to THIS
// runner — `bun:test`'s, which throws if called under any other.
import { afterAll } from 'bun:test';

import { release } from './test-scratch-home';

afterAll(release);

// The two `cloudflare:` builtins the Agents SDK's ROOT module imports
// (`EmailMessage` from cloudflare:email, `RpcTarget`/`exports` from
// cloudflare:workers). They exist only inside workerd, so under `bun test`
// any suite whose graph reaches `agents`' root — every real UserDO or
// orchestrator harness — failed to LOAD, and its coverage silently never ran.
// This is a boundary shim, not behavior: the platform semantics of both
// modules are exercised where they are real, in `tests/workerd` under vitest
// (see bunfig.toml's runner-boundary note); bun-side tests only need the SDK
// module graph to link. The worker classes are bare link stubs — nothing under
// bun reads a state handle off them, and `EmailMessage` alone keeps its
// constructor arguments so an assertion can read an email a test composed;
// nothing here fakes delivery: sending under bun is refused by the class itself.

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
        DurableObject: class DurableObject {},
        WorkerEntrypoint: class WorkerEntrypoint {},
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
