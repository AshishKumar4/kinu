import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import { EvalVerifier, matchesReference, type SlateClient, type VerifierSession } from './verifier';

const CallSchema = v.object({ method: v.string(), args: v.array(JsonValueSchema) });

/** A slate RPC answering from a table of methods, as the deployment's `slate` op does. */
function session(methods: Record<string, (input: JsonValue) => JsonValue>): VerifierSession {
  return {
    slateOp: (operation) => {
      const call = v.parse(CallSchema, operation);
      const method = methods[call.method];

      if (method === undefined) return Promise.resolve({ ok: false, reason: 'bad_input', error: `no method ${call.method}` });

      return Promise.resolve({ ok: true, value: method(call.args[0] ?? null) });
    },
    readFile: () => Promise.resolve(''),
    writeFile: () => Promise.resolve(),
  };
}

/** A slate RPC whose every call is refused with `error`, as the deployment words it. */
function refusing(error: string): VerifierSession {
  return { ...session({}), slateOp: () => Promise.resolve({ ok: false, reason: 'io', error }) };
}

/** A turn of one check that makes one slate call over `connection`. */
function oneCall(connection: VerifierSession) {
  return new EvalVerifier(connection, []).collect(async (verifier) => {
    await verifier.check('builds', async () => ({ pass: (await verifier.call('app', 'total', [])) !== null }));
  });
}

type Method = 'add' | 'total';

/** A counter slate that adds `step` per call and answers an extra field the contract does not name. */
function counter(step: number): SlateClient<Method> {
  let total = 0;

  return (method) => {
    if (method === 'total') return Promise.resolve({ total });
    total += step;

    return Promise.resolve({ ok: true, extra: 'ignored' });
  };
}

const AnswerSchema = v.union([v.object({ ok: v.boolean() }), v.object({ total: v.number() })]);

// The contract names `ok` and `total`; anything else an answer carries is dropped before comparing.
const normalize = (_method: Method, answer: JsonValue): JsonValue => v.parse(AnswerSchema, answer);

const script = async (client: SlateClient<Method>) => {
  await client('add');
  await client('add');
  await client('total');
};

describe('EvalVerifier', () => {
  test('a check that throws fails alone, with its error as evidence, and the others still run', async () => {
    const checks = await new EvalVerifier(session({}), []).collect(async (verifier) => {
      await verifier.check('first', () => Promise.resolve({ pass: true }));
      await verifier.check('refused', async () => ({ pass: (await verifier.call('app', 'missing', [])) === null }));
      await verifier.check('last', () => Promise.resolve({ pass: true, evidence: { seen: [1, 2] } }));
    });

    expect(checks.map((check) => [check.id, check.pass])).toEqual([['first', true], ['refused', false], ['last', true]]);
    expect(JSON.stringify(checks[1]?.evidence)).toContain('no method missing');
  });

  test('the answer is the last bare reply: narration and a reply to the product\'s reminder do not replace it', () => {
    const answered = new EvalVerifier(session({}), [
      'Let me count the overdue loans in the library first.',
      '**3**',
      'Those open tasks are all finished now.',
    ]);

    expect(answered.bareAnswer(/^(\d+)$/)).toBe('3');
    expect(new EvalVerifier(session({}), ['I could not reach the library.']).bareAnswer(/^(\d+)$/)).toBeNull();
  });

  test('a call the deployment could not carry fails the trial as infrastructure, not the check', async () => {
    const dropped: VerifierSession = {
      ...session({}),
      slateOp: () => Promise.reject(new Error(`${INFRA_FAILURE_MARKER} — the workspace socket closed (code 1006)`)),
    };

    await expect(oneCall(dropped)).rejects.toThrow(INFRA_FAILURE_MARKER);
    await expect(oneCall(refusing('slate app.total: Network connection lost.'))).rejects.toThrow(INFRA_FAILURE_MARKER);
  });

  test('a refusal the slate itself gave fails its check with the product\'s words', async () => {
    const checks = await oneCall(refusing('slate app.total: UNKNOWN_SYMBOL'));

    expect(checks.map((check) => [check.id, check.pass])).toEqual([['builds', false]]);
    expect(JSON.stringify(checks[0]?.evidence)).toContain('UNKNOWN_SYMBOL');
  });
});

describe('matchesReference', () => {
  test('passes when every answer matches the reference once normalized, extra fields and all', async () => {
    expect(await matchesReference({ slate: counter(2), reference: counter(2), script, normalize })).toEqual({ pass: true, evidence: { calls: 3 } });
  });

  test('names the first call that differs, with both answers', async () => {
    expect(await matchesReference({ slate: counter(2), reference: counter(3), script, normalize })).toEqual({
      pass: false, evidence: { call: 3, of: 3, method: 'total', input: null, answered: { total: 4 }, expected: { total: 6 } },
    });
  });
});
