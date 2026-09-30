import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { Effect } from 'effect';
import { authoredRefusal, classifyErrorCode, KinuError, settle } from '@kinu.run/core/obs';
import { createWorkersTracer } from '../../src/obs/cf-tracer';
import { DevboxError, devboxFailure } from '../../../devbox/src/errors';

// Compat 2026-09-28: native RPC carries own fields, not subclasses; rejection checks run after the microtask checkpoint.
test('RPC preserves classification and cause without preserving the subclass', async () => {
  const probe = env.EFFECT_ATOMICITY_PROBE.get(env.EFFECT_ATOMICITY_PROBE.idFromName('native-error'));
  expect.assertions(4);

  try {
    await probe.refusal();
  } catch (cause) {
    expect(cause).not.toBeInstanceOf(KinuError);
    expect(cause).toMatchObject({ name: 'KinuError[unavailable]', _tag: 'KinuError', code: 'unavailable', cause: { name: 'TypeError', message: 'socket closed' } });
    expect(classifyErrorCode({ cause })).toBe('unavailable');
    expect(authoredRefusal({ doing: 'calling the peer', cause })).toMatchObject({ code: 'unavailable', message: 'upstream refused' });
  }
});

test('the standalone library code and file errno survive RPC without its prototype', async () => {
  const probe = env.EFFECT_ATOMICITY_PROBE.get(env.EFFECT_ATOMICITY_PROBE.idFromName('devbox-error'));
  expect.assertions(3);

  try { await probe.devboxRefusal(); }
  catch (cause) {
    expect(cause).not.toBeInstanceOf(DevboxError);
    expect(devboxFailure({ cause })?.code).toBe('file');
    expect(cause).toMatchObject({ code: 'file', cause: { kind: 'devbox.file', code: 'ENOENT', path: '/workspace/missing' } });
  }
});

test('a late-adopted rejection reaches its caller without another unhandled failure', async () => {
  const failure = new KinuError('unavailable', 'binding unavailable');
  const reject = (): Promise<never> => Promise.reject(failure);

  await expect(settle(Effect.promise(async () => reject()))).rejects.toBe(failure);
});

test('native span exception recording preserves the original rejection', async () => {
  const tracer = createWorkersTracer();
  const failure = new KinuError('denied', 'private failure text');

  await expect(tracer.span('compat.refusal', { isolateGen: 1, selfPath: 'root' }, async (span) => {
    span.setAttribute('kinu.test', true);
    throw failure;
  })).rejects.toBe(failure);
});
