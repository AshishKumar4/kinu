import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { JsonValueSchema, type JsonValue } from '@kinu.run/core';
import { INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import { EvalVerifier, finishedWork, matchesReference, type SlateClient, type VerifierSession } from './verifier';

const CallSchema = v.object({ method: v.string(), args: v.array(JsonValueSchema) });

/** No check here acts on a page, so nothing is ever left to settle. */
const settledAtOnce = (): Promise<void> => Promise.resolve();

/** A slate RPC answering from a table of methods, as the deployment's `slate` op does. */
function session(methods: Record<string, (input: JsonValue) => JsonValue>): VerifierSession {
  return {
    web: { origin: 'http://127.0.0.1:8787', identity: { kind: 'loopback' }, workspace: 'eval-verifier' },
    slateOp: (operation) => {
      const call = v.parse(CallSchema, operation);
      const method = methods[call.method];

      if (method === undefined) return Promise.resolve({ ok: false, reason: 'bad_input', error: `no method ${call.method}` });

      return Promise.resolve({ ok: true, value: method(call.args[0] ?? null) });
    },
    listSlates: () => Promise.resolve({ slates: [], problems: [] }),
    readFile: () => Promise.resolve(''),
    readBytes: () => Promise.resolve(new Uint8Array()),
    writeFile: () => Promise.resolve(),
    listFiles: () => Promise.resolve([]),
    craftedTools: () => Promise.resolve([]),
    runEvents: () => Promise.resolve([]),
    memoryContent: () => Promise.resolve(''),
    memoryFacts: () => Promise.resolve([]),
    workspaceWork: () => Promise.reject(new Error('no work board here')),
    inspect: () => Promise.reject(new Error('no inspector here')),
    swarmRuns: () => Promise.resolve([]),
    execute: () => Promise.reject(new Error('no shell here')),
    exposedPorts: () => Promise.resolve([]),
  };
}

/** A slate RPC whose every call is refused with `error`, as the deployment words it. */
function refusing(error: string, reason = 'io'): VerifierSession {
  return { ...session({}), slateOp: () => Promise.resolve({ ok: false, reason, error }) };
}

/** A turn of one check that makes one slate call over `connection`. */
function oneCall(connection: VerifierSession) {
  return new EvalVerifier(connection, [], 0, settledAtOnce).collect(async (verifier) => {
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
    const checks = await new EvalVerifier(session({}), [], 0, settledAtOnce).collect(async (verifier) => {
      await verifier.check('first', () => Promise.resolve({ pass: true }));
      await verifier.check('refused', async () => ({ pass: (await verifier.call('app', 'missing', [])) === null }));
      await verifier.check('last', () => Promise.resolve({ pass: true, evidence: { seen: [1, 2] } }));
    });

    expect(checks.map((check) => [check.id, check.pass])).toEqual([['first', true], ['refused', false], ['last', true]]);
    expect(JSON.stringify(checks[1]?.evidence)).toContain('no method missing');
  });

  test('a check\'s own evidence is stored scrubbed: what the agent built and said can carry a capability', async () => {
    const leaky = 'served at https://library-0000000000-fixture.kinu.run/ with x-kinu-dev-identity-secret: abc123';

    const [check] = await new EvalVerifier(session({}), [leaky], 0, settledAtOnce).collect(async (verifier) => {
      await verifier.check('answers', () => Promise.resolve({ pass: false, evidence: { replies: verifier.recentReplies() } }));
    });

    expect(check?.evidence).toEqual({ replies: ['served at https://<preview>.kinu.run/ with x-kinu-dev-identity-secret: <secret>'] });
  });

  test('the answer is the last bare reply: narration and a reply to the product\'s reminder do not replace it', () => {
    const answered = new EvalVerifier(session({}), [
      'Let me count the overdue loans in the library first.',
      '**3**',
      'Those open tasks are all finished now.',
    ], 0, settledAtOnce);

    expect(answered.bareAnswer(/^(\d+)$/)).toBe('3');
    expect(new EvalVerifier(session({}), ['I could not reach the library.'], 0, settledAtOnce).bareAnswer(/^(\d+)$/)).toBeNull();
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

  test('the slate\'s own words that mention a platform failure are still the slate\'s: only the platform\'s io shape is lost', async () => {
    const mentioned = await oneCall(refusing('slate app.total: SYNC_FAILED: Network connection lost while syncing'));
    const chosen = await oneCall(refusing('Network connection lost.', 'unavailable'));

    expect([...mentioned, ...chosen].map((check) => [check.id, check.pass])).toEqual([['builds', false], ['builds', false]]);
    expect(JSON.stringify(mentioned[0]?.evidence)).toContain('SYNC_FAILED');
  });
});

/** A brief longer than the 500 characters a run summary keeps (core turn-lifecycle.ts), its file named past them. */
const LONG_BRIEF = `Tally the waitlist signups per country. ${'The file is a CSV with a header row. '.repeat(14)}Write the totals to signups-by-country.json`;

/**
 * An inspector over one live helper and one released, as core subordinates/inspection-path.ts answers: a path reaches
 * live children only, so by name the released helper is missing, and every retained helper is reached by its actor from
 * the root. Run summaries and events are previews; the canonical history retains the full run-linked assignment.
 */
function inspecting(): VerifierSession {
  const missing = { view: 'missing' as const, reason: 'missing', error: 'The requested subordinate or retained history is unavailable.' };

  const actors = new Map([
    ['actor-live', [{ status: 'error', brief: LONG_BRIEF }, { status: 'completed', brief: 'Retry the same tally' }]],
    ['actor-done', [{ status: 'completed', brief: 'Write the totals' }]],
  ]);

  return {
    ...session({}),
    inspect: (request) => {
      if (request.view === 'children') {
        return Promise.resolve({ view: 'children', page: { status: 'end', items: [
          { name: 'ask-task-live', status: 'working', lifetime: 'task', actorReference: { actorId: 'actor-live' } },
          { name: 'ask-task-done', status: 'dismissed', lifetime: 'task', actorReference: { actorId: 'actor-done' } },
        ] } });
      }

      const runs = request.path.length === 0 && 'actor' in request && request.actor !== undefined ? actors.get(request.actor) : undefined;

      if (runs === undefined) return Promise.resolve(missing);

      if (request.view === 'runs') {
        return Promise.resolve({ view: 'runs', page: { status: 'end', items: runs.map((run, index) => ({
          runId: `run-${String(index)}`, startedAt: 10 + index, status: run.status, userMessage: run.brief.slice(0, 500),
        })) } });
      }

      if (request.view !== 'history') return Promise.resolve(missing);

      return Promise.resolve({ view: 'history', page: { status: 'end', items: runs.map((run, index) => ({
        id: `message-${String(index)}`, position: index, role: 'user', turnId: `turn-${String(index)}`,
        runId: `run-${String(index)}`, content: run.brief, createdAt: 10 + index,
      })) } });
    },
  };
}

describe("a helper's runs", () => {
  // Staging f75f06932, 2026-10-01: both task helpers of a capture were dismissed once they answered, and their runs
  // read by name answered missing (kinu-logs/evals-fast/FINDINGS.md F3B), as every task helper's do.
  test('every helper is read by its actor, live or released, and each run by the brief that started it, whole', async () => {
    const work = await new EvalVerifier(inspecting(), [], 0, settledAtOnce).helperWork();

    expect(work).toEqual([
      { name: 'ask-task-live', status: 'working', runs: [
        { startedAt: 10, status: 'error', userMessage: LONG_BRIEF }, { startedAt: 11, status: 'completed', userMessage: 'Retry the same tally' },
      ] },
      { name: 'ask-task-done', status: 'dismissed', runs: [{ startedAt: 10, status: 'completed', userMessage: 'Write the totals' }] },
    ]);
  });

  // delegation trial 3 (run 37880718948): the first brief named the report past the summary's cut, the retry named none.
  test('a retry finishes the assignment whose brief names its file only past the summary\'s first 500 characters', async () => {
    const work = await new EvalVerifier(inspecting(), [], 0, settledAtOnce).helperWork();

    expect(finishedWork(work, 'signups-by-country.json')).toEqual(['ask-task-live']);
  });

  test('an absent run link cannot borrow a full assignment from a similar run or its preview', async () => {
    const base = inspecting();

    const connection: VerifierSession = {
      ...base,
      inspect: async (request) => {
        const answer = await base.inspect(request);

        if (answer.view !== 'history') return answer;

        return { view: 'history', page: { status: 'end', items: answer.page.items.map((entry) => ({
          ...entry, runId: `${entry.runId ?? ''}-different-run`,
        })) } };
      },
    };

    const work = await new EvalVerifier(connection, [], 0, settledAtOnce).helperWork();

    expect(work.flatMap((helper) => helper.runs.map((run) => run.userMessage))).toEqual([null, null, null]);
    expect(finishedWork(work, 'signups-by-country.json')).toEqual([]);
  });

  test('history paging finds the opening assignment, not a later steer from its run', async () => {
    const base = inspecting();

    const connection: VerifierSession = {
      ...base,
      inspect: async (request) => {
        const answer = await base.inspect(request);

        if (answer.view !== 'history' || request.view !== 'history') return answer;

        if (request.page.cursor === undefined) return { view: 'history', page: { status: 'more', next: { before: 5 }, items: [{
          id: 'steer', position: 5, role: 'user', turnId: 'turn', runId: 'run-0', content: 'Use integer counts', createdAt: 100,
        }] } };

        return answer;
      },
    };

    const work = await new EvalVerifier(connection, [], 0, settledAtOnce).helperWork();

    expect(work[0]?.runs[0]?.userMessage).toBe(LONG_BRIEF);
  });

  test('a reused helper must finish the assigned run, not just an earlier unrelated run', () => {
    const work = [
      { name: 'earlier-completion', status: 'dismissed', runs: [
        { startedAt: 10, status: 'completed', userMessage: 'Build src/maybe.ts' },
        { startedAt: 20, status: 'error', userMessage: 'Build test-results' },
      ] },
      { name: 'finished-dashboard', status: 'dismissed', runs: [{ startedAt: 20, status: 'completed', userMessage: 'Build test-results' }] },
    ];

    expect(finishedWork(work, 'test-results')).toEqual(['finished-dashboard']);
  });

  test('a later retry can finish the assignment without repeating its subject', () => {
    const work = [{ name: 'resumed', status: 'idle', runs: [
      { startedAt: 120, status: 'completed', userMessage: 'Continue the interrupted work' },
      { startedAt: 110, status: 'error', userMessage: 'Build src/maybe.ts' },
    ] }];

    expect(finishedWork(work, 'maybe.ts')).toEqual(['resumed']);
  });

  test('old helper runs cannot satisfy this turn', async () => {
    const connection = {
      ...inspecting(),
      inspect: (request: Parameters<VerifierSession['inspect']>[0]) => request.view === 'runs'
        ? Promise.resolve({ view: 'runs' as const, page: { status: 'end' as const, items: [
          { runId: 'old-inspection-run', startedAt: 90, status: 'completed', userMessage: 'Build src/maybe.ts' },
        ] } })
        : inspecting().inspect(request),
    };

    const verifier = new EvalVerifier(connection, [], 100, settledAtOnce);

    expect((await verifier.helperWork()).flatMap((helper) => helper.runs)).toEqual([]);
  });

  test('old swarms cannot satisfy this turn', async () => {
    const connection = {
      ...session({}),
      swarmRuns: () => Promise.resolve([{ run: { id: 'old', startedAt: 90, status: 'completed', winnerScore: null }, params: null, head: null }]),
    };

    expect(await new EvalVerifier(connection, [], 100, settledAtOnce).swarms()).toEqual([]);
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
