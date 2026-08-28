/**
 * The failure classification.
 *
 * What is being defended: an executor tool that could not do what it was asked
 * returned a descriptive STRING, so a caller could not tell a timeout from a
 * denial from an OOM. Every case here is a distinction that was unavailable
 * before `ErrorCode` existed, and each is provoked rather than asserted against a
 * literal wherever the runtime can be made to produce it — the same method
 * `unit-obs-expected-failure.test.ts` uses, for the same reason: a hardcoded
 * error string tests our memory of a platform, not the platform.
 *
 * The two classes no test can provoke cheaply — an isolate memory kill and a
 * transport refusal — are pinned differently, against `platform-catalog.ts`,
 * which is where this repo keeps observed platform wordings with their
 * provenance. That is what makes the local regexes in `obs/error.ts` a citation
 * rather than a copy.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  classifyErrorCode,
  CODE_IS_REFUSAL,
  ERROR_CODES,
  KinuError,
  refusalOf,
  renderCauseChain,
  toKinuError,
  type ErrorCode,
} from '../src/obs/index';
import { PLATFORM_CATALOG } from '../src/platform-catalog';

/**
 * The real error an operation raises, narrowed to `Error` here so every assertion
 * below reads the platform's own value rather than an `unknown` it has to widen.
 *
 * Both escapes are failures of the test, not tolerated conditions: an operation
 * that did NOT fail means the provocation stopped provoking, which is exactly how
 * a classifier test rots into asserting nothing.
 */
function raisedBy(operation: () => void): Error {
  try {
    operation();
  } catch (caught) {
    if (caught instanceof Error) return caught;
    throw new Error('the runtime raised a non-Error', { cause: caught });
  }
  throw new Error('the operation did not fail, so there is nothing to classify');
}

/** The real DOMException the platform raises for an aborted signal. */
function provokeAbort(): Error {
  const controller = new AbortController();
  controller.abort();
  return raisedBy(() => { controller.signal.throwIfAborted(); });
}

/** The real DOMException `AbortSignal.timeout` raises, which is a DIFFERENT one.
 *  Awaits the signal's own abort event rather than a guessed duration. */
async function provokeTimeout(): Promise<Error> {
  const signal = AbortSignal.timeout(1);
  const { promise, resolve } = Promise.withResolvers<void>();
  signal.addEventListener('abort', () => { resolve(); }, { once: true });
  await promise;
  return raisedBy(() => { signal.throwIfAborted(); });
}

describe('a cancelled wait and an expired deadline are not the same failure', () => {
  test('an aborted signal classifies as cancelled, a timed-out one as timeout', async () => {
    // Both are DOMExceptions and both carry a legacy NUMERIC `code` (20 and 23),
    // so the errno-style `code` read that identifies a filesystem error cannot
    // tell them apart at all. The NAME is the discriminator, and a remote
    // executor that cannot kill an in-flight command rejects with exactly this
    // (execution/signal.ts) — which is why the run tool used to report a
    // cancelled wait and a dead transport identically.
    const aborted = provokeAbort();
    const timedOut = await provokeTimeout();
    expect(aborted).toBeInstanceOf(Error);
    expect(timedOut).toBeInstanceOf(Error);
    expect(classifyErrorCode({ cause: aborted })).toBe('cancelled');
    expect(classifyErrorCode({ cause: timedOut })).toBe('timeout');
  });

  test('a filesystem absence is `missing`, and a truncated payload is `bad_input`', () => {
    const enoent = raisedBy(() => { readFileSync('/kinu-does-not-exist/nor-does-this'); });
    const malformed = raisedBy(() => { JSON.parse('{"truncated":'); });
    expect(classifyErrorCode({ cause: enoent })).toBe('missing');
    expect(classifyErrorCode({ cause: malformed })).toBe('bad_input');
  });

  test('errno codes the platform sets, read through the one reader of `code`', () => {
    // Synthesised deliberately: what is asserted is libuv's `code` CONTRACT, not
    // a wording, and provoking EACCES or ENOMEM would need a filesystem this test
    // cannot rely on having.
    const cases: readonly (readonly [string, ErrorCode])[] = [
      ['EACCES', 'denied'],
      ['EPERM', 'denied'],
      ['ENOMEM', 'oom'],
      ['ETIMEDOUT', 'timeout'],
      ['ECONNREFUSED', 'unavailable'],
      ['ENOTSUP', 'unsupported'],
    ];
    for (const [code, expected] of cases) {
      const error = Object.assign(new Error(`failed: ${code}`), { code });
      expect(classifyErrorCode({ cause: error })).toBe(expected);
    }
  });

  test('nothing pinned recognises it, and saying so is the point', () => {
    // Null, never a fallback code. A classifier that guessed would file every
    // unrecognised failure under one class and the class would stop meaning
    // anything — which is the defect one level up from the string returns.
    expect(classifyErrorCode({ cause: new Error('the disk sang a sad song') })).toBeNull();
    expect(classifyErrorCode({ cause: 'a thrown string' })).toBeNull();
    expect(classifyErrorCode({ cause: undefined })).toBeNull();
  });
});

describe('the memory wall is classified from the catalogue, not from memory', () => {
  /**
   * Every catalogued wording, partitioned by whether a memory entry produces it,
   * a non-memory entry produces it, or BOTH do.
   *
   * Selected by the entry KEY rather than by matching the wording, which would
   * make the test circular: a message the classifier misses would also be skipped
   * by the scan. The shared bucket is not a wrinkle — it is a platform fact
   * discovered by writing this test, and the classifier is required to refuse it.
   */
  const isMemoryKey = (key: string): boolean => /oom|memory/u.test(key);
  const wordings = new Map<string, { memory: boolean; other: boolean }>();
  for (const [key, fact] of Object.entries(PLATFORM_CATALOG)) {
    for (const seen of fact.observable) {
      const entry = wordings.get(seen.message) ?? { memory: false, other: false };
      if (isMemoryKey(key)) entry.memory = true;
      else entry.other = true;
      wordings.set(seen.message, entry);
    }
  }
  const only = (want: 'memory' | 'other'): readonly string[] => [...wordings]
    .filter(([, seen]) => seen[want] && !seen[want === 'memory' ? 'other' : 'memory'])
    .map(([message]) => message);
  const shared = [...wordings].filter(([, seen]) => seen.memory && seen.other).map(([m]) => m);

  test('a wording only the memory entries produce classifies as oom', () => {
    const memoryOnly = only('memory');
    // A non-zero length is part of the assertion: an empty scan is the shape of a
    // gate that stopped reaching its corpus.
    expect(memoryOnly.length).toBeGreaterThan(0);
    for (const message of memoryOnly) {
      expect(classifyErrorCode({ cause: new Error(message) })).toBe('oom');
      // And through a wrap, because the owner observed it as
      // `clone failed: Worker exceeded memory limit` — one frame of our prose
      // outside the platform's own sentence.
      const wrapped = new Error('clone failed', { cause: new Error(message) });
      expect(classifyErrorCode({ cause: wrapped })).toBe('oom');
    }
  });

  test('a wording TWO different limits produce is refused, not guessed', () => {
    // `Worker exceeded resource limits` is what the client sees for BOTH
    // `worker.isolate.memory` and `do.cpu_ms_per_invocation`. It names a resource
    // limit, not which one, so reading it as `oom` would report a CPU-time kill as
    // a memory kill. The classifier answers null and the call site's `otherwise`
    // decides — which is the whole reason `otherwise` is required.
    expect(shared).toEqual(['Worker exceeded resource limits']);
    for (const message of shared) {
      expect(classifyErrorCode({ cause: new Error(message) })).toBeNull();
    }
  });

  test('no other catalogued wording is read as a memory kill', () => {
    const otherOnly = only('other');
    expect(otherOnly.length).toBeGreaterThan(0);
    for (const message of otherOnly) {
      expect(classifyErrorCode({ cause: new Error(message) })).not.toBe('oom');
    }
  });
});

describe('the cause chain is the language `%w` and is never broken', () => {
  test('every link is rendered, outermost first', () => {
    const inner = new Error('ECONNRESET');
    const middle = new Error('reading the exec response', { cause: inner });
    const outer = new Error('run `pytest` on sandbox', { cause: middle });
    expect(renderCauseChain(outer))
      .toBe('run `pytest` on sandbox: reading the exec response: ECONNRESET');
  });

  test('a thrown non-Error is the last link, not a dropped one', () => {
    const outer = new Error('calling the provider', { cause: 'nope' });
    expect(renderCauseChain(outer)).toBe('calling the provider: nope');
  });

  test('a cycle terminates', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;
    expect(renderCauseChain(first)).toBe('first: second');
  });

  test('a wrapper that embeds its cause renders those words once', () => {
    // `toProviderError` puts the refined provider text in its own message and
    // keeps the raw cause for sinks. Before the join-boundary dedup this
    // rendered `calling the model: Your account is not active.: Your account
    // is not active.` on the product surface (packages/cli behavior suite).
    const provider = new Error('Your account is not active.');
    const outer = new Error('calling the model: Your account is not active.', { cause: provider });
    expect(renderCauseChain(outer)).toBe('calling the model: Your account is not active.');
    // A link that says anything NEW still renders whole — dedup is exact
    // containment at the tail, never similarity.
    const refined = new Error('calling the model: account inactive', { cause: provider });
    expect(renderCauseChain(refined))
      .toBe('calling the model: account inactive: Your account is not active.');
  });
});

describe('toKinuError', () => {
  test('the message is what we were doing, and the detail is on the cause', () => {
    // `new Error('what we were doing', { cause: caught })` — AGENTS.md rule 2.
    // The detail is NOT baked into the message: `renderCauseChain` assembles it
    // once at the display boundary, so nothing renders beneath itself.
    const cause = raisedBy(() => { readFileSync('/kinu-does-not-exist/manifest.json'); });
    const wrapped = toKinuError({ doing: 'reading the manifest', cause, otherwise: 'io' });
    expect(wrapped.code).toBe('missing');
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).toBe('reading the manifest');
    expect(renderCauseChain(wrapped)).toStartWith('reading the manifest: ');
    expect(renderCauseChain(wrapped)).toContain('ENOENT');
    expect(wrapped).toBeInstanceOf(Error);
  });

  test('`otherwise` is used only when nothing pinned matched', () => {
    const unrecognised = toKinuError({
      doing: 'running a command', cause: new Error('mystery'), otherwise: 'io',
    });
    expect(unrecognised.code).toBe('io');
    const recognised = toKinuError({
      doing: 'running a command', cause: provokeAbort(), otherwise: 'io',
    });
    expect(recognised.code).toBe('cancelled');
  });

  test('an already-classified cause keeps its class on the way up', () => {
    // The inner site knew more about the failure than the outer one does.
    // Re-classifying from outside is how a precise `oom` becomes a generic `io`.
    const inner = new KinuError('oom', 'Worker exceeded memory limit');
    const outer = toKinuError({ doing: 'forking a head', cause: inner, otherwise: 'io' });
    expect(outer.code).toBe('oom');
    expect(renderCauseChain(outer)).toBe('forking a head: Worker exceeded memory limit');
    expect(outer.cause).toBe(inner);
  });

  test('a thrown non-Error is still evidence', () => {
    const wrapped = toKinuError({ doing: 'parsing', cause: 'raw string', otherwise: 'bad_input' });
    expect(wrapped.code).toBe('bad_input');
    expect(wrapped.cause).toBe('raw string');
    expect(renderCauseChain(wrapped)).toBe('parsing: raw string');
  });
});

describe('the refusal payload', () => {
  test('the classification LEADS, where no clamp can reach it', () => {
    // Every seam that shows a tool result to a human or hashes it for steering
    // bounds it to a head slice, and the prose is the long part. Key order is the
    // contract, not a formatting preference.
    const refusal = refusalOf(new KinuError('unavailable', 'runtime_not_provisioned'));
    expect(Object.keys(refusal)).toEqual(['reason', 'error']);
    expect(JSON.stringify(refusal)).toStartWith('{"reason":');
  });

  test('the whole chain reaches the wire', () => {
    const failure = toKinuError({
      doing: 'run `pytest` on sandbox',
      cause: new Error('exec channel closed'),
      otherwise: 'io',
    });
    expect(refusalOf(failure)).toEqual({
      reason: 'io',
      error: 'run `pytest` on sandbox: exec channel closed',
    });
  });
});

describe('refusing and breaking are opposite facts', () => {
  test('every code has a verdict, and the three refusals are the decisions', () => {
    // Totality is enforced by the type; what this asserts is the VERDICTS, since
    // pooling a correct refusal with a defect is worse than reporting no rate.
    const refusals = ERROR_CODES.filter((code) => CODE_IS_REFUSAL[code]);
    expect([...refusals]).toEqual(['bad_input', 'denied', 'unsupported']);
    for (const code of ['unavailable', 'missing', 'timeout', 'cancelled', 'oom', 'io'] as const) {
      expect(CODE_IS_REFUSAL[code]).toBe(false);
    }
  });
});
