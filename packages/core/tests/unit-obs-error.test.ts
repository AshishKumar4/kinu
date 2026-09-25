/**
 * Failure classification, provoked from the runtime where possible. Unprovokable wordings (isolate
 * memory kill, transport refusal) are pinned against `platform-catalog.ts` entries.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  classifyErrorCode,
  CODE_IS_REFUSAL,
  CODE_WORK_DID_NOT_START,
  KinuError,
  refusalOf,
  renderCauseChain,
  toKinuError,
  type ErrorCode,
} from '../src/obs/index';
import { PLATFORM_CATALOG } from '../src/platform-catalog';

/** A provocation that stops failing is a test failure, not a tolerated condition. */
function raisedBy(operation: () => void): Error {
  try {
    operation();
  } catch (caught) {
    if (caught instanceof Error) return caught;
    throw new Error('the runtime raised a non-Error', { cause: caught });
  }

  throw new Error('the operation did not fail, so there is nothing to classify');
}

function provokeAbort(): Error {
  const controller = new AbortController();
  controller.abort();

  return raisedBy(() => { controller.signal.throwIfAborted(); });
}

/** The `AbortSignal.timeout` DOMException (`TimeoutError`), minted without a timer. */
function provokeTimeout(): Error {
  const controller = new AbortController();
  controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));

  return raisedBy(() => { controller.signal.throwIfAborted(); });
}

describe('a cancelled wait and an expired deadline are not the same failure', () => {
  test('an aborted signal classifies as cancelled, a timed-out one as timeout', async () => {
    // Both DOMExceptions carry a numeric `code`; only `name` tells a cancelled wait from a dead
    // transport.
    const aborted = provokeAbort();
    const timedOut = provokeTimeout();
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
    // Synthesised: asserts libuv's `code` contract, not a wording.
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

  test('a reset connection is `io`: the frame may already have arrived', () => {
    // A reset may land after the peer ran the work, so it must not read as `unavailable`.
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const code = classifyErrorCode({ cause: reset });
    expect(code).toBe('io');

    if (code !== null) expect(CODE_WORK_DID_NOT_START[code]).toBe(false);
  });

  test('a refusal a Durable Object threw keeps its class across its RPC, which names it only in the message', () => {
    const remote = (message: string): Error => Object.assign(new Error(message), { remote: true });

    expect(classifyErrorCode({ cause: remote('CapabilityDeniedError: Unrecognized workspace capability token.') })).toBe('denied');
    expect(classifyErrorCode({ cause: remote('ValiError: Invalid type: Expected string') })).toBe('bad_input');
    // Words alone, in an error no RPC carried, say nothing.
    expect(classifyErrorCode({ cause: new Error('CapabilityDeniedError: forged') })).toBeNull();
  });

  test('a malformed URL is `bad_input`, like malformed JSON', () => {
    const badUrl = raisedBy(() => { new URL('notaurl'); });
    expect(classifyErrorCode({ cause: badUrl })).toBe('bad_input');
  });

  test('nothing pinned recognises it, and saying so is the point', () => {
    // Null, never a fallback code.
    expect(classifyErrorCode({ cause: new Error('the disk sang a sad song') })).toBeNull();
    expect(classifyErrorCode({ cause: 'a thrown string' })).toBeNull();
    expect(classifyErrorCode({ cause: undefined })).toBeNull();
  });
});

describe('the memory wall is classified from the catalogue, not from memory', () => {
  /** Selected by catalog entry key, not by wording (which would be circular). Wordings shared by
     *  memory and non-memory entries must classify as null. */
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
    // Non-zero length: an empty scan means the gate lost its corpus.
    expect(memoryOnly.length).toBeGreaterThan(0);

    for (const message of memoryOnly) {
      expect(classifyErrorCode({ cause: new Error(message) })).toBe('oom');
      // Also through a wrap: `clone failed: Worker exceeded memory limit`.
      const wrapped = new Error('clone failed', { cause: new Error(message) });
      expect(classifyErrorCode({ cause: wrapped })).toBe('oom');
    }
  });

  test('a wording TWO different limits produce is refused, not guessed', () => {
    // `Worker exceeded resource limits` covers both `worker.isolate.memory` and
    // `do.cpu_ms_per_invocation`, so the classifier answers null and `otherwise` decides.
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
    // The refined provider text must not render twice across the cause-chain join.
    const provider = new Error('Your account is not active.');
    const outer = new Error('calling the model: Your account is not active.', { cause: provider });
    expect(renderCauseChain(outer)).toBe('calling the model: Your account is not active.');
    // Dedup is exact tail containment, never similarity.
    const refined = new Error('calling the model: account inactive', { cause: provider });
    expect(renderCauseChain(refined))
      .toBe('calling the model: account inactive: Your account is not active.');
  });
});

describe('toKinuError', () => {
  test('the message is what we were doing, and the detail is on the cause', () => {
    // AGENTS.md rule 2: the detail stays out of the message; `renderCauseChain` joins it once.
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
    // Re-classifying from outside turns a precise `oom` into a generic `io`.
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
    // Seams bound tool results to a head slice, so key order is the contract.
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

  test('a reported exit survives the projection — the census reads 127, never `unavailable`', () => {
    expect(refusalOf(new KinuError('unavailable', 'no such command', { execution: { exitCode: 127 } }))).toEqual({
      reason: 'unavailable',
      error: 'no such command',
      execution: { exitCode: 127 },
    });

    // Without one, no field is invented.
    const plain = refusalOf(new KinuError('unavailable', 'runtime_not_provisioned'));
    expect(plain).toEqual({ reason: 'unavailable', error: 'runtime_not_provisioned' });
    expect('execution' in plain).toBe(false);
  });
});

describe('refusing and breaking are opposite facts', () => {
  test('a decision refuses, a defect breaks', () => {
    // Totality is type-enforced; this asserts the verdicts.
    for (const code of ['bad_input', 'denied', 'budget'] as const) {
      expect(CODE_IS_REFUSAL[code]).toBe(true);
    }

    for (const code of ['unavailable', 'missing', 'timeout', 'cancelled', 'oom', 'io'] as const) {
      expect(CODE_IS_REFUSAL[code]).toBe(false);
    }
  });
});
