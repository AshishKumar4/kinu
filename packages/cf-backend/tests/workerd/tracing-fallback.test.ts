/**
 * KINU-083: defends a healthy request failing only because `tracing.enterSpan` is absent or not callable.
 * Imports the shipped tracer and shadows `enterSpan` on the runtime singleton; bun's substitute cannot answer this.
 */
import { tracing } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createWorkersTracer } from '../../src/obs/cf-tracer';

const OPEN = { isolateGen: 1, selfPath: 'TracingFallbackProbe:root' } as const;

/** The one platform member the shipped tracer depends on. */
const MEMBER = 'enterSpan';

/** `vite/client` is not loaded by tests/workerd/tsconfig.json, so declare the one slice read here. */
declare global {
  interface ImportMeta {
    readonly env?: Readonly<Record<string, string | undefined>>;
  }
}

const EVIDENCE_KEY = 'VITE_KINU083_DEPLOYED_TRACE';

function deployedEvidence(): string | null {
  const value = import.meta.env?.[EVIDENCE_KEY];

  return value !== undefined && value.length > 0 ? value : null;
}

const CENSORED = [
  `CENSORED: KINU-083 deployed half. A span reaching Cloudflare's trace pipeline cannot be observed in workerd.`,
  `MISSING CAPABILITY: authority to deploy packages/cf-backend, and read access to Workers Observability traces for that account.`,
  `COMMANDS a holder of that capability runs, from the repository root:`,
  `  1. bun run deploy`,
  `  2. npx wrangler tail kinu --format json                  (leave it running)`,
  `  3. send one request that reaches OrchestratorAgent. Its "tracing" getter is the`,
  `     production call site: it calls createWorkersTracer in src/actor-agent.ts,`,
  `     the one tracing seam every facet mode shares. Named by symbol, not by line.`,
  `WHAT TO LOOK FOR: a trace for worker kinu carrying a span whose name begins`,
  `  with "fetch." and whose attributes include kinu.isolate_gen and kinu.self_path.`,
  `  observability.traces.enabled is true in that wrangler config, so`,
  `  no such span is the deployed defect, and such a span present is the deployed pass.`,
  `TO SETTLE THIS TEST: re-run this file with ${EVIDENCE_KEY} set to the trace id from step 3.`,
].join('\n');

interface Attempt<T> {
  /** How many times the wrapped callback ran. */
  readonly ran: number;
  /** What `span` returned, or `undefined` when it threw. */
  readonly returned: T | undefined;
  /** What escaped to the caller, or `null` when nothing did. */
  readonly thrown: unknown;
  /**
   * True when the callback got the frozen fallback span: the only reading that proves a shadow reached
   * the tracer, since `ran`, `thrown` and `isTraced` read the same on the traced path here.
   */
  readonly fallbackSpan: boolean;
}

/** Never rethrows: an escaped exception is one of the observations. */
function attempt<T>(name: string, body: (traced: boolean) => T): Attempt<T> {
  let ran = 0;
  let fallbackSpan = false;

  try {
    const returned = createWorkersTracer().span(name, OPEN, (span) => {
      ran += 1;
      fallbackSpan = Object.isFrozen(span);

      return body(span.isTraced);
    });

    return { ran, returned, thrown: null, fallbackSpan };
  } catch (error) {
    return { ran, returned: undefined, thrown: error, fallbackSpan };
  }
}

type UnavailableMember = undefined | { readonly present: true; readonly callable: false };

/** Shadows the platform member on the singleton the tracer imports. */
function shadowMember(value: UnavailableMember): void {
  Object.defineProperty(tracing, MEMBER, { value, writable: true, configurable: true, enumerable: true });
}

/** Deleting the own property restores the prototype member. */
function clearShadow(): void {
  Reflect.deleteProperty(tracing, MEMBER);
}

/** The `then` a pipelined stub answers with, and the only member it exposes. */
type StubThen = (resolve: (settled: string) => void) => void;

/** A workerd RPC stub is a proxy that answers `then`, not an object carrying one. */
function pipelinedStub(value: string): PromiseLike<string> {
  // A real promise target would make the stub `instanceof Promise`, and the platform would wrap it.
  const target = Object.create(null);

  return new Proxy<PromiseLike<string>>(target, {
    get(_target: PromiseLike<string>, key: string | symbol): StubThen | undefined {
      if (key !== 'then') return undefined;

      return (resolve) => { resolve(value); };
    },
  });
}

describe('the shipped Workers tracer against the platform it deploys onto', () => {
  it('runs its callback exactly once and returns the callback result unchanged', () => {
    const sentinel = Object.freeze({ probe: 'result identity' });

    const observed = attempt('probe.sync', () => sentinel);

    expect(observed.thrown).toBeNull();
    expect(observed.ran).toBe(1);
    expect(observed.returned).toBe(sentinel);
  });

  it('preserves an async result by value, and a pipelined thenable by identity', async () => {
    const native = Promise.resolve('async result');
    const stub = pipelinedStub('stub result');

    const nativeArm = attempt('probe.async', () => native);
    const stubArm = attempt('probe.thenable', () => stub);

    expect(nativeArm.thrown).toBeNull();
    expect(nativeArm.ran).toBe(1);
    // `enterSpan` returns a promise of its own: the value survives, the identity does not.
    expect(nativeArm.returned).not.toBe(native);
    await expect(Promise.resolve<unknown>(nativeArm.returned)).resolves.toBe('async result');

    // The platform wraps a native promise only, so a pipelined stub keeps its identity.
    expect(stubArm.ran).toBe(1);
    expect(stubArm.returned).toBe(stub);
    await expect(Promise.resolve<unknown>(stubArm.returned)).resolves.toBe('stub result');
  });

  it(`reaches the platform ${MEMBER} at the pinned compatibility date`, () => {
    // Behavioural: only a non-frozen span proves the runtime supplied a callable member.
    expect(attempt('probe.callable', () => 'entered')).toMatchObject({
      ran: 1,
      returned: 'entered',
      thrown: null,
      fallbackSpan: false,
    });
  });

  it(`falls back when ${MEMBER} is absent: the callback runs once and nothing escapes`, () => {
    const sentinel = Object.freeze({ probe: 'fallback identity' });
    let observed: Attempt<typeof sentinel>;

    try {
      shadowMember(undefined);
      observed = attempt('probe.absent', () => sentinel);
    } finally {
      clearShadow();
    }

    expect(observed.thrown).toBeNull();
    expect(observed.ran).toBe(1);
    expect(observed.returned).toBe(sentinel);
    expect(observed.fallbackSpan).toBe(true);
  });

  it(`falls back when ${MEMBER} is present but not callable`, () => {
    let observed: Attempt<string>;

    try {
      shadowMember({ present: true, callable: false });
      observed = attempt('probe.non-callable', () => 'entered');
    } finally {
      clearShadow();
    }

    expect(observed).toMatchObject({ ran: 1, returned: 'entered', thrown: null, fallbackSpan: true });
  });

  it('reports the fallback span as untraced rather than claiming a recording', () => {
    let observed: Attempt<boolean>;

    try {
      shadowMember(undefined);
      observed = attempt('probe.untraced', (traced) => traced);
    } finally {
      clearShadow();
    }

    // A fallback claiming `isTraced` true would have callers build attributes for a span nothing records.
    expect(observed).toMatchObject({ ran: 1, returned: false, thrown: null, fallbackSpan: true });
  });

  it('preserves an async result and a rejection through the fallback', async () => {
    const resolved = Promise.resolve('async result');
    const rejection = new Error('the traced work failed');
    let value: Attempt<Promise<string>>;
    let rejected: Attempt<Promise<never>>;
    let threw: Attempt<never>;

    try {
      shadowMember(undefined);
      value = attempt('probe.fallback-async', () => resolved);
      rejected = attempt('probe.fallback-rejection', () => Promise.reject(rejection));
      threw = attempt('probe.fallback-throw', () => { throw rejection; });
    } finally {
      clearShadow();
    }

    // By identity here: unlike the platform, the fallback derives no promise of its own.
    expect(value).toMatchObject({ ran: 1, thrown: null });
    expect(value.returned).toBe(resolved);

    // A rejection is RETURNED, not thrown, and it is the same rejection.
    expect(rejected).toMatchObject({ ran: 1, thrown: null });
    await expect(Promise.resolve<unknown>(rejected.returned)).rejects.toBe(rejection);

    // The fallback adds no catch: swallowing a caller's failure would be worse than no tracing.
    expect(threw).toMatchObject({ ran: 1, returned: undefined });
    expect(threw.thrown).toBe(rejection);
  });

  it('restores the member after both arms, so neither leaks into another test', () => {
    expect(Object.getOwnPropertyDescriptor(tracing, MEMBER)).toBeUndefined();
    expect(attempt('probe.restored', () => 'entered')).toMatchObject({
      ran: 1,
      returned: 'entered',
      thrown: null,
      fallbackSpan: false,
    });
  });

  /**
   * Must not be permanently red: `test:workerd` gates `scripts/deploy.sh`, so it would block the deploy that settles it.
   * The deployed obligation is enforced by `docs/research/coverage-matrix.ts` (KINU-083 `deployed-probe` premise).
   */
  it('opens a real span the runtime does not record, and checks deployed evidence only when it exists', () => {
    const observed = attempt('probe.pipeline', (traced) => traced);

    expect(observed.ran).toBe(1);
    // Separates "no sink bound" from "guard took the fallback"; both report `isTraced` false.
    expect(observed.fallbackSpan).toBe(false);
    expect(observed.returned).toBe(false);

    const evidence = deployedEvidence();

    if (evidence === null) return;
    // A trace id, not a word: "yes" must not settle the measurement.
    expect(evidence, CENSORED).toMatch(/^[0-9a-f]{16,}$/u);
  });
});
