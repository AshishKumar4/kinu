/**
 * Retrying an RPC into another Durable Object when the PLATFORM dropped it.
 *
 * A call from the Worker into a DO, or from one DO into another, has failure
 * modes that belong to Cloudflare rather than to the code on either side: the
 * connection between the isolate and the object drops, a deploy supersedes the
 * callee's isolate mid-call, storage resets the object on a cold start or a
 * timeout, or the platform flags the error `retryable`. All of them succeed on a
 * second attempt against a healthy object, and none of them says anything about
 * the request that was made.
 *
 * THIS IS NOT A BLANKET WRAPPER, and it must not become one. It is applied only
 * where the operation is idempotent — a read, or a converge-to-a-value write —
 * and where a dropped call has been observed to cost the user something. An
 * operation that appends, sends, charges or mints is never wrapped: a dropped
 * call there may already have run, so a retry is a correctness bug wearing
 * resilience as a costume, and the honest answer is the error.
 *
 * ## Where the classification comes from
 *
 * The re-attemptable reset class is `PLATFORM_CATALOG['do.reset.transient']`,
 * whose whole subject is "Durable Object resets that are safe to re-attempt, as
 * distinct from resource resets that are not", and whose `onBreach` records that
 * the RPC rejects while the work never ran to a conclusion. Its three observable
 * strings are the set, and `unit-do-transient.test.ts` asserts every one of them
 * classifies here, so the entry and this matcher cannot drift apart. Two further
 * classes are not in the catalog and come from the Agents SDK's own matcher
 * (`node_modules/agents/dist/retries.js:98,109`): the "script has been upgraded"
 * spelling of a supersede, and "Network connection lost." — which is the one this
 * exists for, because it is what a dropped stub or storage connection surfaces as.
 *
 * We MIRROR that matcher rather than import it. Re-verified 2026-08-18 against
 * agents@0.20.1: `./retries` is not in the package's `exports` map, so loading
 * `agents/retries` fails with `Cannot find module`; and the root entry it would
 * otherwise have to come through is `dist/index.js`, whose line 16 is
 * `import { EmailMessage } from "cloudflare:email"` — a workerd-only builtin, so
 * loading `agents` under bun fails with `Cannot find package 'cloudflare:email'`.
 * Nothing loadable under a test runner can depend on it. If a future release
 * exports the subpath, take it from there and delete the patterns below.
 *
 * ## What is deliberately EXCLUDED
 *
 *  - The overloaded class. Retrying an object that is already overloaded is what
 *    overloaded it (`PLATFORM_CATALOG['do.requests_per_second_soft']`, whose
 *    observable is "Durable Object is overloaded").
 *  - An isolate memory-limit reset. It RECURS on retry — the footprint, not the
 *    platform, is the cause — so it is a poison pill rather than a transient
 *    (`PLATFORM_CATALOG['do.isolate.oom_reported']`), and none of the patterns
 *    below match its string. Pinned by a test, not by a pattern.
 *  - "Internal error in Durable Object storage caused object to be reset", which
 *    the SDK's matcher DOES treat as transient. In this repository that string is
 *    recorded against `PLATFORM_CATALOG['do.storage.bytes']` as what a facet
 *    clone over quota surfaces, where a retry cannot help because the quota does
 *    not free itself, and that entry states a generic internal-storage reset must
 *    not be filed as merely unavailable storage. `do.reset.transient` does not
 *    list it. Kinu has no clone path today (zero `ctx.facets.clone(` call
 *    sites outside the catalog), so the string is unreachable here either way —
 *    but the divergence from the SDK is deliberate, not an oversight.
 *
 * Note the separation from `withSandboxRetry` (core execution/sandbox.ts). That
 * one guards the container plane and matches container-lifecycle strings this
 * classifier knows nothing about; it also lives in core, which has no business
 * knowing what a Durable Object is. Two planes, one classifier each.
 */

import { diagnostics, renderCauseChain, toKinuError } from '@kinu/core/obs';

/** Which platform failure a call hit — the value `null` is the absence of one,
 *  and is what makes "the platform dropped this" distinguishable from "your
 *  request was wrong" at the seams that REPORT rather than retry. */
export type DOTransientClass =
  /** A deploy replaced the isolate mid-call. */
  | 'superseded_isolate'
  /** The stub or storage connection dropped. */
  | 'connection_lost'
  /** Storage reset the object on a cold start or an operation timeout. */
  | 'storage_reset'
  /** The runtime flagged the error `retryable` itself. */
  | 'retryable_flag';

/**
 * The verbatim platform surfacings, one entry per class, kept narrow on purpose:
 * an ordinary application error that merely mentions "reset" or "internal error"
 * is not a transient and must not be retried. `do.reset.transient` records why —
 * an OOM also says "was reset" and recurs, so a discriminator matching "reset"
 * alone would loop forever on a real one.
 */
const PLATFORM_TRANSIENT: ReadonlyArray<readonly [DOTransientClass, RegExp]> = [
  ['superseded_isolate', /reset because its code was updated|this script has been upgraded/i],
  ['connection_lost', /network connection lost/i],
  ['storage_reset', /starting up Durable Object storage caused object to be reset|storage operation exceeded timeout which caused the object to be reset/i],
];

/**
 * Whether a caught value, or anything in its `cause` chain, is a platform
 * transient rather than a failure of the call itself — and if so, which class.
 *
 * Reading the WHOLE chain is load-bearing, not defensive: a `SqlError` wrapper
 * keeps only message and `cause`, so the runtime's `retryable` property does not
 * survive one and the verbatim strings have to be matched at any depth. That is
 * what `renderCauseChain` gives — one rendering of the whole chain, from core's
 * single reader of it, cycle-terminating — so the strings are tested against
 * every link at once rather than against a top-level message.
 *
 * A non-`Error` throw is unclassifiable, exactly as `classifyErrorCode` treats
 * one: the platform surfaces these as `Error`s, and inventing a shape for a
 * thrown string would claim a signal nothing sends.
 *
 * Exported for the callers that must REPORT rather than retry, so "the platform
 * dropped this, try again" reads differently from "your request was wrong".
 */
export function classifyTransientDO(input: { cause: unknown }): DOTransientClass | null {
  const caught = input.cause;
  if (!(caught instanceof Error)) return null;
  const chain = renderCauseChain(caught);
  for (const [transient, pattern] of PLATFORM_TRANSIENT) {
    if (pattern.test(chain)) return transient;
  }
  // The `retryable` flag, at every link. It is read separately because it is a
  // PROPERTY rather than prose, so the rendered chain cannot carry it — and the
  // mirrored matcher checks it per link, so dropping that would be drift.
  const seen = new Set<Error>();
  let link: Error | null = caught;
  while (link !== null && !seen.has(link)) {
    seen.add(link);
    const flagged = 'retryable' in link && link.retryable === true;
    const overloaded = ('overloaded' in link && link.overloaded === true)
      || /Durable Object is overloaded/i.test(link.message);
    if (flagged && !overloaded) return 'retryable_flag';
    const cause: unknown = link.cause;
    link = cause instanceof Error ? cause : null;
  }
  return null;
}

/** Total attempts. Two retries is what a dropped connection or a deploy bounce
 *  needs; beyond that the object is not coming back inside this request. */
const MAX_ATTEMPTS = 3;
/** Full-jitter exponential backoff, in the shape the SDK itself uses. Kept short
 *  because every caller is on a request's critical path: at MAX_ATTEMPTS the only
 *  delays ever computed are 2¹·60 = 120 ms and 2²·60 = 240 ms, because attempt 3's
 *  failure throws before a third delay exists. There is no ceiling constant — the
 *  400 ms one that used to sit here could not bind at any attempt count this
 *  module allows, so it was a bound that could not fail. */
const BASE_DELAY_MS = 60;

/**
 * Run an idempotent cross-DO call, retrying only the platform transients above.
 * Any other error — and a transient one that outlives the attempts — throws
 * unchanged, so the caller still reports honestly.
 *
 * `operation` names the call in the log a retry emits, so a flaky object is
 * visible in Workers Logs rather than silently absorbed.
 *
 * A `superseded_isolate` retry is futile when it was the CALLER's isolate that a
 * deploy replaced — code never reloads mid-invocation, so every attempt throws
 * the same error and only the next fresh invocation succeeds. It is retried
 * anyway because the callee case is the common one here and does succeed, and the
 * futile case costs two short backoffs before throwing the error it would have
 * thrown immediately.
 */
export async function retryTransientDO<T>(operation: string, call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const transient = classifyTransientDO({ cause: err });
      if (transient === null || attempt >= MAX_ATTEMPTS) throw err;
      diagnostics.failure('do_rpc.transient_retry', toKinuError({
        doing: `an idempotent Durable Object call (${operation})`,
        cause: err,
        otherwise: 'io',
      }), { operation, transient, attempt, attempts: MAX_ATTEMPTS });
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Math.floor(Math.random() * 2 ** attempt * BASE_DELAY_MS));
      await promise;
    }
  }
}
