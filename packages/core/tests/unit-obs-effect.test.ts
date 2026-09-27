/**
 * The Effect boundary's contracts (`obs/effect.ts` and `KinuError`). The migration slices lean on
 * them: a typed failure crosses `settle` unchanged, so every reader that classifies by the cause
 * chain (`failedToolOutcome`, `classifyErrorCode`) sees what it sees today; an interruption is
 * `cancelled`; and `JSON.stringify` of a `KinuError` carries no message and no cause chain.
 */

import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { Effect } from 'effect';
import { attempt, KinuError, settle, settleSync } from '../src/obs/index';

describe('settle', () => {
  test('resolves the success value', async () => {
    expect(await settle(Effect.succeed(3))).toBe(3);
  });

  test('rejects with the failed KinuError itself', async () => {
    const failure = new KinuError('denied', 'the gate refused');

    await expect(settle(Effect.fail(failure))).rejects.toBe(failure);
  });

  test('rejects with a defect unchanged', async () => {
    const bug = new TypeError('reading an absent field');

    await expect(settle(Effect.sync(() => {
      throw bug;
    }))).rejects.toBe(bug);
  });

  test('an abort interrupts the run and rejects with cancelled, keeping the reason', async () => {
    const controller = new AbortController();
    const reason = new Error('the user pressed stop');
    const pending = settle(Effect.never, { signal: controller.signal, interrupted: 'stopped before the answer' });

    controller.abort(reason);
    await expect(pending).rejects.toBeInstanceOf(KinuError);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled', message: 'stopped before the answer', cause: reason });
  });
});

describe('settleSync', () => {
  test('returns the success value, in the same tick', () => {
    expect(settleSync(Effect.succeed(3))).toBe(3);
  });

  test('throws the failed KinuError itself, and a defect unchanged', () => {
    const failure = new KinuError('denied', 'the gate refused');
    const bug = new TypeError('reading an absent field');

    expect(() => settleSync(Effect.fail(failure))).toThrow(failure);
    expect(() => settleSync(Effect.sync(() => {
      throw bug;
    }))).toThrow(bug);
  });

  test('an interruption is cancelled, as under settle', () => {
    expect(() => settleSync(Effect.interrupt, { interrupted: 'stopped' })).toThrow(expect.objectContaining({ code: 'cancelled', message: 'stopped' }));
  });

  test('an async step inside is a defect, and the steps after it never run', async () => {
    let thrown: unknown;
    let written = false;
    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observed = gate.then(() => { /* the step the fiber awaited has settled; its next step would have run */ });

    try {
      settleSync(Effect.gen(function* () {
        yield* Effect.promise(() => gate);
        written = true;
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeInstanceOf(KinuError);
    expect(thrown).toMatchObject({ name: 'AsyncFiberError' });
    release();
    await observed;
    await Promise.resolve();
    expect(written).toBe(false);
  });
});

describe('attempt', () => {
  test('a rejection is classified from its cause; the fallback covers only the unrecognised', async () => {
    const absent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    const opaque = new Error('socket hang up');

    await expect(settle(attempt({ doing: 'reading /x', otherwise: 'io' }, () => Promise.reject(absent))))
      .rejects.toMatchObject({ code: 'missing', message: 'reading /x', cause: absent });
    await expect(settle(attempt({ doing: 'calling the parent', otherwise: 'unavailable' }, () => Promise.reject(opaque))))
      .rejects.toMatchObject({ code: 'unavailable', cause: opaque });
  });
});

describe('KinuError', () => {
  test('yielding one fails the effect with it', async () => {
    const failure = new KinuError('missing', 'no such row');

    await expect(settle(Effect.gen(function* () {
      return yield* failure;
    }))).rejects.toBe(failure);
  });

  test('JSON carries the class, the exit and subclass fields, never the message or the cause chain', () => {
    class WithVerdict extends KinuError {
      constructor(readonly verdict: string) {
        super('bad_input', 'the edit matched twice');
      }
    }

    const withSecret = new KinuError('io', 'reading /x', { cause: new Error('token sk-live-123'), execution: { exitCode: 2 } });

    expect(JSON.stringify(withSecret)).toBe('{"code":"io","name":"KinuError[io]","execution":{"exitCode":2}}');
    expect(JSON.stringify(new KinuError('denied', 'refused', { cause: null }))).toBe('{"code":"denied","name":"KinuError[denied]"}');
    expect(JSON.stringify(new WithVerdict('ambiguous'))).toBe('{"code":"bad_input","name":"KinuError[bad_input]","verdict":"ambiguous"}');
  });

  test('printed as an Error, with its message and stack', () => {
    const printed = inspect(new KinuError('io', 'reading /x'));

    expect(printed.split('\n')[0]).toBe('KinuError[io]: reading /x');
    expect(printed).toContain('\n    at ');
  });
});
