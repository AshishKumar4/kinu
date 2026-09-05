/**
 * KINU-083, the Workers tracing fallback, measured instead of read.
 *
 * WHAT THE FINDING CLAIMS. `createWorkersTracer` calls `tracing.enterSpan`
 * directly. If the runtime does not give a callable `enterSpan`, the wrapped
 * callback may never run, and a request that is healthy in every other way
 * fails only because tracing is unavailable. The finding's deciding validation
 * asks for a Worker or workerd path run twice, once with the tracing API absent
 * and once with `enterSpan` present but not callable, and asks for three
 * assertions in each run: the callback runs exactly once, its result is
 * preserved, and no tracing exception escapes.
 *
 * WHAT THIS FILE DECIDES. Four questions, with four different answers.
 *
 *   1. Is the API present and callable under the runtime we deploy? Yes. The
 *      pin here is the pin at `wrangler.jsonc:10`, and `enterSpan` is a
 *      function on `Tracing.prototype` that the shipped tracer calls.
 *   2. Does the tracer survive the API being unavailable? No. With the member
 *      taken away the callback runs ZERO times, no result exists to preserve,
 *      and a `TypeError` reaches the caller. All three properties the finding
 *      asks for fail together, in both arms. There is no fallback in the file.
 *   3. Is a result preserved when the callback returns a promise? By value,
 *      yes. By identity, no: `enterSpan` returns a promise of its own. A
 *      thenable that is not a `Promise`, which is the shape of a pipelined RPC
 *      stub, passes through with its identity intact.
 *   4. Does a span reach Cloudflare's own trace pipeline? Not decidable in
 *      workerd. The last test says exactly that, names the capability it
 *      lacks, and FAILS until a holder of that capability supplies the
 *      observation. It never skips. A skipped test over an undecided premise
 *      reads as a pass, and that is the failure this probe exists to avoid.
 *
 * WHY THE REAL MODULE. The import is `../../src/obs/cf-tracer`, the shipped
 * file, reached through the same specifier production uses. A copy of the
 * tracer would assert about the copy, and the defect lives in the shipped call.
 *
 * HOW THE MEMBER IS TAKEN AWAY, WITHOUT TOUCHING PRODUCTION SOURCE. `tracing`
 * is one runtime singleton, and this file and the module under test import that
 * same object. `enterSpan` is inherited from `Tracing.prototype`, and it is
 * writable and configurable, so a test defines an own property of the same name
 * on the singleton, then deletes it. Deleting an own property restores the
 * prototype member, which a later test asserts rather than assumes.
 *
 * WHY `bun test` CANNOT HOST THIS. `cloudflare:workers` is a workerd module, so
 * the bun tier substitutes `tracing.enterSpan` (`tests/helpers/agents-sdk.ts`).
 * A substitute cannot answer whether the PLATFORM provides the member, and that
 * is question 1. The substitute also returns a native promise for a promise,
 * so it cannot answer question 3 either.
 *
 * WHAT THIS FILE DOES NOT COVER, so it is not read as more than it is.
 *   - The `tracing` EXPORT being absent, as opposed to its `enterSpan` member.
 *     A module namespace binding is immutable, so no test can remove the
 *     export. If the export were gone, `import { tracing }` in the tracer would
 *     be a module load error, and no callback would run for a stronger reason
 *     than the two arms below.
 *   - The production bundle. Vite's SSR transform loads the tracer here, while
 *     `scripts/tracing-gate.ts` measures the esbuild bundle. Both read
 *     `tracing.enterSpan` at call time, so the arms below apply to both, but
 *     only that gate measures emitted code.
 *   - Whether a span is RECORDED. `scripts/tracing-gate.ts` measures that under
 *     real workerd in both polarities, with a tail sink and without one.
 */
import { tracing } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createWorkersTracer } from '../../src/obs/cf-tracer';

const OPEN = { isolateGen: 1, selfPath: 'TracingFallbackProbe:root' } as const;

/** The one platform member the shipped tracer depends on. */
const MEMBER = 'enterSpan';

/**
 * The variable that carries a deployed observation into this file.
 *
 * `import.meta.env` is DECLARED here rather than probed. Vite populates it, but
 * its shape lives in `vite/client`, which `tests/workerd/tsconfig.json`
 * deliberately does not load, so this file declares the one slice it reads.
 * Declaring the boundary is what makes the access below typed; reaching it
 * through `Reflect.get` and then narrowing with `typeof` would assert a shape
 * at runtime that nothing had ever stated.
 */
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
  `  1. npx wrangler deploy --config packages/cf-backend/wrangler.jsonc --env staging`,
  `  2. npx wrangler tail kinu-staging --format json          (leave it running)`,
  `  3. send one request that reaches OrchestratorAgent. Its "tracing" getter is the`,
  `     production call site: it calls createWorkersTracer in src/actor-agent.ts,`,
  `     the one tracing seam every facet mode shares. Named by symbol, not by line.`,
  `WHAT TO LOOK FOR: a trace for worker kinu-staging carrying a span whose name begins`,
  `  with "fetch." and whose attributes include kinu.isolate_gen and kinu.self_path.`,
  `  env.staging.observability.traces.enabled is true in that wrangler config, so`,
  `  no such span is the deployed defect, and such a span present is the deployed pass.`,
  `TO SETTLE THIS TEST: re-run this file with ${EVIDENCE_KEY} set to the trace id from step 3.`,
].join('\n');

interface Attempt {
  /** How many times the wrapped callback ran. */
  readonly ran: number;
  /** What `span` returned, or `undefined` when it threw. */
  readonly returned: unknown;
  /** What escaped to the caller, or `null` when nothing did. */
  readonly thrown: unknown;
  /**
   * True when the callback received the tracer's shared frozen fallback span
   * rather than a live one. This is the discriminator that proves a shadow
   * REACHED the module under test, and it is load bearing rather than
   * decorative.
   *
   * Since the capability guard landed, the fallback arms assert `ran: 1` and
   * `thrown: null`, which is exactly what the TRACED path also produces. And
   * `isTraced` cannot separate them either: this layer binds no sink, so a real
   * span reports false here too. So if `shadowMember` ever silently stopped
   * reaching the tracer, both arms would keep passing for the wrong reason and
   * the probe would report a fallback it never took. Frozen-ness separates
   * them, because the traced path builds a fresh span object per call and the
   * fallback path hands out one `Object.freeze`d value.
   */
  readonly fallbackSpan: boolean;
}

/**
 * One call into the shipped tracer, with every observation the finding asks
 * about recorded. It never rethrows, because "an exception escaped" is one of
 * the three observations rather than a reason to stop measuring.
 */
function attempt<T>(name: string, body: (traced: boolean) => T): Attempt {
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

/**
 * What an unavailable member looks like from the tracer's side. Exactly the two
 * cases the finding names: the member reads `undefined`, or it reads a value
 * that is not callable.
 */
type UnavailableMember = undefined | { readonly present: true; readonly callable: false };

/** Shadows the platform member on the singleton the tracer imports. */
function shadowMember(value: UnavailableMember): void {
  Object.defineProperty(tracing, MEMBER, { value, writable: true, configurable: true, enumerable: true });
}

/**
 * Removes the shadow. The own property goes and the prototype member returns.
 * `Reflect.deleteProperty` rather than `delete` through a cast: it is the exact
 * inverse of the `Object.defineProperty` above, and it needs no dictionary type
 * to reach a member the platform's own declaration already names.
 */
function clearShadow(): void {
  Reflect.deleteProperty(tracing, MEMBER);
}

/** The `then` a pipelined stub answers with, and the only member it exposes. */
type StubThen = (resolve: (settled: string) => void) => void;

/**
 * The shape a pipelined RPC stub actually has.
 *
 * A workerd RPC stub is a PROXY that answers `then`, not an object carrying a
 * literal one, so this models the production shape rather than approximating it
 * with a hand-rolled object. The `then` it answers resolves immediately, which
 * is all this fixture needs: what is under test is whether the tracer and the
 * platform hand the value BACK unchanged, never how it settles.
 *
 * The proxy is typed `PromiseLike<string>` at CONSTRUCTION, so the value handed
 * to a caller needs no conversion of its own. Converting the proxy afterwards
 * would need `as unknown as`, and a chained assertion is worse than the shape it
 * would buy.
 */
function pipelinedStub(value: string): PromiseLike<string> {
  // SAFETY: `then` is the only member `PromiseLike<string>` declares, and it is
  // constructed by the `get` trap below. Verified against that trap's body,
  // which returns a `resolve`-calling function for `'then'` and `undefined` for
  // every other key, so nothing is ever read off this target.
  const target = {} as PromiseLike<string>;
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
    // Identity, not equality: the tracer must hand back the callback's value.
    expect(observed.returned).toBe(sentinel);
  });

  it('preserves an async result by value, and a pipelined thenable by identity', async () => {
    const native = Promise.resolve('async result');
    const stub = pipelinedStub('stub result');

    const nativeArm = attempt('probe.async', () => native);
    const stubArm = attempt('probe.thenable', () => stub);

    expect(nativeArm.thrown).toBeNull();
    expect(nativeArm.ran).toBe(1);
    // Measured, and it is NOT what `cf-tracer.ts` documents. That file returns
    // the callback's promise untouched, and then `enterSpan` returns a promise
    // of its own, so the value survives and the identity does not. The negative
    // is asserted on purpose: if the platform ever stops deriving, this layer
    // exists to report it rather than to keep a stale claim alive.
    expect(nativeArm.returned).not.toBe(native);
    await expect(Promise.resolve<unknown>(nativeArm.returned)).resolves.toBe('async result');

    // A thenable that is not a `Promise` passes straight through. This is what
    // makes the file's prohibition on wrapping a pipelined RPC stub hold: the
    // platform wraps a native promise only, so a stub keeps its pipelining.
    expect(stubArm.ran).toBe(1);
    expect(stubArm.returned).toBe(stub);
    await expect(Promise.resolve<unknown>(stubArm.returned)).resolves.toBe('stub result');
  });

  it(`reaches the platform ${MEMBER} at the pinned compatibility date`, () => {
    // BEHAVIOURAL, and it has to be. This test used to read the member off the
    // singleton and assert `typeof member === 'function'`, which measured the
    // platform's declaration rather than the runtime. Worse, once the capability
    // guard landed, `ran: 1` stopped proving the member exists at all, because
    // the fallback also runs the callback exactly once. A NON-frozen span is the
    // only observation here that separates the two paths, and the traced path
    // can only be taken if the runtime supplied a callable member.
    expect(attempt('probe.callable', () => 'entered')).toMatchObject({
      ran: 1,
      returned: 'entered',
      thrown: null,
      fallbackSpan: false,
    });
  });

  /**
   * The finding's first case as the tracer sees it: `tracing.enterSpan` reads
   * `undefined`. This measured the defect before KINU-083 was fixed, when the
   * callback ran zero times and a `TypeError` escaped. It now measures the
   * guard. The three observations are unchanged; only their expected values
   * moved, which is what makes this the same measurement rather than a new one.
   */
  it(`falls back when ${MEMBER} is absent: the callback runs once and nothing escapes`, () => {
    const sentinel = Object.freeze({ probe: 'fallback identity' });
    let observed: Attempt;
    try {
      shadowMember(undefined);
      observed = attempt('probe.absent', () => sentinel);
    } finally {
      clearShadow();
    }

    expect(observed.thrown).toBeNull();
    expect(observed.ran).toBe(1);
    // Identity. The fallback arm calls the callback and returns its value, so it
    // is indistinguishable from calling it directly, which is the point: an
    // untraceable request must be an ordinary request.
    expect(observed.returned).toBe(sentinel);
    // And it really was the FALLBACK. Every assertion above reads identically
    // on the traced path, so without this one a shadow that stopped reaching
    // the tracer would leave this test green while measuring nothing.
    expect(observed.fallbackSpan).toBe(true);
  });

  /** The second arm: the member is present, and it is not callable. */
  it(`falls back when ${MEMBER} is present but not callable`, () => {
    let observed: Attempt;
    try {
      shadowMember({ present: true, callable: false });
      observed = attempt('probe.non-callable', () => 'entered');
    } finally {
      clearShadow();
    }

    expect(observed).toMatchObject({ ran: 1, returned: 'entered', thrown: null, fallbackSpan: true });
  });

  it('reports the fallback span as untraced rather than claiming a recording', () => {
    let observed: Attempt;
    try {
      shadowMember(undefined);
      observed = attempt('probe.untraced', (traced) => traced);
    } finally {
      clearShadow();
    }

    // Not a cosmetic detail. `isTraced` is what a caller reads to decide whether
    // to bother assembling an attribute, and a fallback that claimed `true` would
    // have every caller paying for a span nothing recorded.
    //
    // `fallbackSpan: true` is what makes this arm about the FALLBACK. A traced
    // span reports `isTraced` false here too, because this layer binds no sink,
    // so the other three readings alone would pass without a fallback ever
    // being taken.
    expect(observed).toMatchObject({ ran: 1, returned: false, thrown: null, fallbackSpan: true });
  });

  it('preserves an async result and a rejection through the fallback', async () => {
    const resolved = Promise.resolve('async result');
    const rejection = new Error('the traced work failed');
    let value: Attempt;
    let rejected: Attempt;
    let threw: Attempt;
    try {
      shadowMember(undefined);
      value = attempt('probe.fallback-async', () => resolved);
      rejected = attempt('probe.fallback-rejection', () => Promise.reject(rejection));
      threw = attempt('probe.fallback-throw', () => { throw rejection; });
    } finally {
      clearShadow();
    }

    // By IDENTITY here, unlike the traced arm above: the platform derives a
    // promise of its own and this arm derives nothing, so a pipelined stub keeps
    // its pipelining and a rejection keeps its identity.
    expect(value).toMatchObject({ ran: 1, thrown: null });
    expect(value.returned).toBe(resolved);

    // A rejection is RETURNED, not thrown, and it is the same rejection.
    expect(rejected).toMatchObject({ ran: 1, thrown: null });
    await expect(Promise.resolve<unknown>(rejected.returned)).rejects.toBe(rejection);

    // A synchronous throw still escapes, with its identity. The fallback adds no
    // catch: swallowing a caller's failure would be a worse instrument than none.
    expect(threw).toMatchObject({ ran: 1, returned: undefined });
    expect(threw.thrown).toBe(rejection);
  });

  it('restores the member after both arms, so neither leaks into another test', () => {
    expect(Object.getOwnPropertyDescriptor(tracing, MEMBER)).toBeUndefined();
    // `fallbackSpan: false` is the restoration proof. `ran: 1` and the returned
    // value hold on the fallback path too, so without it a member that never
    // came back would still read as restored.
    expect(attempt('probe.restored', () => 'entered')).toMatchObject({
      ran: 1,
      returned: 'entered',
      thrown: null,
      fallbackSpan: false,
    });
  });

  /**
   * The half this runner cannot decide, and where its obligation lives.
   *
   * A permanently red test does not belong here. `bun run test:workerd` is a
   * required gate on the root deploy path (`scripts/deploy.sh`), so a test that
   * can only pass after a deployment would block every deployment, including the
   * one that would settle it. That is a deadlock, not a control.
   *
   * So this asserts the local witness, which is real and decides something: the
   * span DOES open, and the runtime itself reports it as not recorded, because
   * this layer binds no trace sink. Above that line an inert span and a recorded
   * span are indistinguishable, which is exactly why the deployed question stays
   * open.
   *
   * The obligation is enforced by `docs/research/coverage-matrix.ts`, which
   * refuses a platform-premise row that claims completion without a named
   * artifact, an ISO date and a measuring identity. KINU-083 carries the
   * `deployed-probe` premise there, so the day somebody marks it closed without
   * a measurement the coverage gate fails by name. When the measurement exists,
   * supplying its trace id here turns the assertion below into a real check of
   * the evidence rather than a placeholder.
   */
  it('opens a real span the runtime does not record, and checks deployed evidence only when it exists', () => {
    const observed = attempt('probe.pipeline', (traced) => traced);

    expect(observed.ran).toBe(1);
    // A REAL span, on the traced path. Without this line the arm cannot tell
    // "the runtime recorded nothing because no sink is bound" from "the guard
    // took the fallback", since both report `isTraced` false. The prose below
    // attributes the false to the absent sink, so the arm has to earn that.
    expect(observed.fallbackSpan).toBe(false);
    expect(observed.returned).toBe(false);

    const evidence = deployedEvidence();
    if (evidence === null) return;
    // A trace id, not a word. `wrangler tail` reports a 32-character hex id, and
    // an operator pasting "yes" or "done" must not settle a measurement.
    expect(evidence, CENSORED).toMatch(/^[0-9a-f]{16,}$/u);
  });
});
