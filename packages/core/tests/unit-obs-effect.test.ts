/**
 * The Effect boundary's contracts (`obs/effect.ts` and `KinuError`). The migration slices lean on
 * them: a typed failure crosses `settle` unchanged, so every reader that classifies by the cause
 * chain (`failedToolOutcome`, `classifyErrorCode`) sees what it sees today; an interruption is
 * `cancelled`; and `JSON.stringify` of a `KinuError` carries no message and no cause chain.
 */

import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { Cause, Effect, Exit } from 'effect';
import { attempt, flight, KinuError, settle, settleSync } from '../src/obs/index';
import { isVfsError, VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';

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

describe('a VFS failure on the channel', () => {
  /** A file plane read in Effect form: its failure is a VfsError, which callers switch on by `code`. */
  const readOnlyWrite = (path: string): Effect.Effect<never, VfsError> => Effect.fail(new VfsError('EROFS', 'read-only file system', path));

  const expectErofs = (failed: { readonly thrown: unknown }): void => {
    expect(isVfsError(failed.thrown)).toBe(true);
    expect(failed.thrown).toMatchObject({ code: 'EROFS', errno: -30, path: '/mnt/ro/a.txt' });
    expect(failed.thrown).not.toBeInstanceOf(KinuError);
  };

  test('settle rejects with the VfsError itself, code, errno and path intact', async () => {
    const write = (allowed: boolean) => settle(Effect.gen(function* () {
      if (!allowed) return yield* new KinuError('denied', 'not this caller');

      return yield* readOnlyWrite('/mnt/ro/a.txt');
    }));

    expect.assertions(3);

    try {
      await write(true);
    } catch (error) {
      expectErofs({ thrown: error });
    }
  });

  test('settleSync throws the same VfsError synchronously', () => {
    expect.assertions(3);

    try {
      settleSync(readOnlyWrite('/mnt/ro/a.txt'));
    } catch (error) {
      expectErofs({ thrown: error });
    }
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

describe('flight', () => {
  const gate = () => {
    let open = (): void => {};

    const opened = new Promise<void>((resolve) => { open = resolve; });

    return { open: () => { open(); }, opened };
  };

  test('callers join one run and each fails with its own KinuError; the failure frees the key', async () => {
    const refusal = new KinuError('denied', 'the hub refused');
    const held = gate();
    let runs = 0;

    const refresh = flight(() => Effect.andThen(Effect.promise(() => held.opened), Effect.suspend(() => {
      runs += 1;

      return Effect.fail(refusal);
    })));

    const caught = (effect: Effect.Effect<number, KinuError | VfsError>) => settle(Effect.catch(effect, (failure) => Effect.succeed(failure)));
    const joiners = [caught(refresh()), caught(refresh())];

    held.open();

    expect(await Promise.all(joiners)).toEqual([refusal, refusal]);
    expect((await Promise.all(joiners))[1]).toBe(refusal);
    expect(runs).toBe(1);
    expect(await caught(refresh())).toBe(refusal);
    expect(runs).toBe(2);
  });

  test('a settled run frees its key, `keep` holds a success, and each key runs apart', async () => {
    let runs = 0;
    const count = (key: string) => Effect.sync(() => `${key}${String(++runs)}`);
    const fresh = flight(count, { key: (key) => key });
    const kept = flight(count, { key: (key) => key, keep: 'success' });

    expect([await settle(fresh('a')), await settle(fresh('a')), await settle(fresh('b'))]).toEqual(['a1', 'a2', 'b3']);
    expect([await settle(kept('a')), await settle(kept('a')), await settle(kept('b'))]).toEqual(['a4', 'a4', 'b5']);
  });

  test('a joined VfsError fails as itself, and a defect stays one', async () => {
    const missing = new VfsError('ENOENT', 'no such file', '/a');
    const read = flight(() => Effect.fail(missing));
    const boom = new Error('boom');
    const broken = flight(() => Effect.die(boom));

    expect(await settle(Effect.catch(read(), (failure) => Effect.succeed(isVfsError(failure) ? failure : null)))).toBe(missing);
    const exit = await settle(Effect.exit(broken()));

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && !Cause.hasFails(exit.cause)).toBe(true);
    expect(settle(broken())).rejects.toBe(boom);
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
