/**
 * Retrying an idempotent RPC into another Durable Object when the platform dropped it. Never wrap an
 * operation that appends, sends, charges or mints: a dropped call may already have run.
 * Classes come from `PLATFORM_CATALOG['do.reset.transient']` (held by `unit-do-transient.test.ts`) plus the
 * Agents SDK's matcher (`node_modules/agents/dist/retries.js`), mirrored because `agents/retries` is not
 * exported and `agents` imports `cloudflare:*` builtins. Excluded: overload (`do.requests_per_second_soft`),
 * memory-limit resets (`do.isolate.oom_reported`), and the storage-reset string (`do.storage.bytes`).
 */

import { diagnostics, renderCauseChain, toKinuError } from '../obs/index';

/** Which platform failure a call hit; `null` means none. */
export type DOTransientClass =
  /** A deploy replaced the isolate mid-call. */
  | 'superseded_isolate'
  /** The stub or storage connection dropped. */
  | 'connection_lost'
  /** Storage reset the object on a cold start or an operation timeout. */
  | 'storage_reset'
  /** The runtime flagged the error `retryable` itself. */
  | 'retryable_flag';

/** Verbatim platform strings, one per class, kept narrow: an OOM also says "was reset" and recurs
 *  (`do.reset.transient`), so matching "reset" alone would loop. */
const PLATFORM_TRANSIENT: ReadonlyArray<readonly [DOTransientClass, RegExp]> = [
  ['superseded_isolate', /reset because its code was updated|this script has been upgraded/i],
  ['connection_lost', /network connection lost/i],
  ['storage_reset', /starting up Durable Object storage caused object to be reset|storage operation exceeded timeout which caused the object to be reset/i],
];

/** Whether a caught value or anything in its `cause` chain is a platform transient, and which class.
 *  The whole chain matters: a `SqlError` wrapper drops `retryable`. Non-`Error` throws are unclassifiable. */
export function classifyTransientDO(input: { cause: unknown }): DOTransientClass | null {
  const caught = input.cause;

  if (!(caught instanceof Error)) return null;
  const chain = renderCauseChain(caught);

  for (const [transient, pattern] of PLATFORM_TRANSIENT) {
    if (pattern.test(chain)) return transient;
  }

  // `retryable` is a property, not prose, so it is checked per link separately from the rendered chain.
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

/** Total attempts. */
const MAX_ATTEMPTS = 3;

/** Full-jitter exponential backoff, in the SDK's shape; short because callers are on the request path. */
const BASE_DELAY_MS = 60;

/** Run an idempotent cross-DO call, retrying only the platform transients above; other errors and
 *  exhausted transients throw unchanged. `operation` names the call in the retry log. */
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
