/**
 * The delegation path, end to end, on the runtime that ships it.
 *
 * Every case drives the product's own seams: the workspace's
 * `subordinateSeams()`, the real `scheduleDrain`, the real event log, and a
 * hire the model actually authors through the `agents` tool. Nothing here
 * stubs a drain, hand-calls a report, or reads source text.
 *
 * NO PER-TEST CLOCK. The workerd tier runs with `testTimeout: 0` and
 * `scripts/test-clocks.ts` locks the clock corpus shrink-only, so these cases
 * carry no deadline of their own: each waits on a gate the product's own
 * traffic resolves. A path that never arrives HANGS, and the hang is the
 * report — it is not weakened into a passing assertion.
 *
 * RE-ENTRY AFTER AN EVICTION is `abortAllDurableObjects()` followed by a
 * request, the shape `do-eviction-recovery.test.ts` establishes: a stub held
 * across a reset is itself broken, the id survives, and a read is a request
 * that runs `onStart` — which is how a real caller comes back.
 */

import { abortAllDurableObjects, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CHILD_ANSWER, HIRE_MISSION, type HireObservation, type LogRow } from './hire-shapes';

/** Re-acquired per use: the id survives an eviction, a stub does not. */
const probe = (workspace: string) => env.HIRE_PROBE.get(env.HIRE_PROBE.idFromName(workspace));

/** The admissions written into a CHILD's log — the root's own rows are not
 *  delegation admissions and must not inflate a bound. */
function childAdmissions(observed: HireObservation): readonly LogRow[] {
  return observed.log.filter(
    (row) => row.variant === 'subordinate_task' && row.actorId !== observed.rootActorId,
  );
}

describe('hire', () => {
  it('a task hire returns the child\'s answer to its caller', async () => {
    const workspace = 'hire-answer';

    await probe(workspace).setup(workspace, 'hire-root', 'answer');
    await probe(workspace).openHire(workspace, 'Hire one auditor and tell me what it said.');
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);

    // The resolved tool result — what the caller's own `agents` call returned.
    expect(observed.toolResults.join(' ')).toContain(CHILD_ANSWER);

    // The roster row for a task hire ends dismissed: the lifetime IS the task.
    const hired = observed.roster.filter((row) => row.lifetime === 'task');

    expect(hired).toHaveLength(1);
    expect(hired[0]?.status).toBe('dismissed');

    // The child's own transcript holds the answer it gave.
    expect(observed.transcript.join(' ')).toContain(CHILD_ANSWER);
  });

  it('a child whose turn throws still settles its caller', async () => {
    const workspace = 'hire-throw';

    await probe(workspace).setup(workspace, 'hire-root', 'throw');
    await probe(workspace).openHire(workspace, 'Hire one auditor; its model will throw.');
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const answer = observed.toolResults.join(' ');

    // A failed child settles its caller with an outcome that carries why.
    expect(answer).toMatch(/failed|blocked|unavailable/i);
    expect(answer).not.toContain(CHILD_ANSWER);

    const hired = observed.roster.filter((row) => row.lifetime === 'task');

    expect(hired).toHaveLength(1);
    expect(hired[0]?.status).toBe('dismissed');
  });

  it('a child interrupted mid-turn still settles its caller', async () => {
    const workspace = 'hire-interrupt';

    await probe(workspace).setup(workspace, 'hire-root', 'park');
    // HELD rather than awaited, and this case cannot be written any other way:
    // `openHire` is `runTaskFromMcp`, whose `inbox.send` resolves when the
    // QUEUED TURN ENDS, and the caller's turn ends when the hire settles. This
    // case stages an interruption BEFORE that settlement, so awaiting the
    // caller here is waiting for the very thing the interruption has not
    // happened yet to cause — the run stops with the child still parked in its
    // model call and `childSpoke` never reached. Case 6 holds its hire for the
    // same reason.
    const hiring = probe(workspace).openHire(workspace, 'Hire one auditor; it will be interrupted.');

    // The interruption lands while the child is inside its model call: its
    // claim is left unsettled, which is what a mid-turn interruption IS.
    await probe(workspace).childSpoke();
    await abortAllDurableObjects();

    // The caller's RPC frame died with the activation — that IS the eviction —
    // so this promise carries the platform's abort and nothing this case
    // asserts. Settled, not caught: the settlement under test is the DURABLE
    // one read below.
    await Promise.allSettled([hiring]);

    // A request is how a caller comes back; `onStart` runs the recovery scan.
    await probe(workspace).reenter(workspace);
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);

    // Settled either way — an answer or a stated failure — never still parked.
    expect(observed.toolResults.join(' ')).toMatch(
      /failed|blocked|unavailable|interrupt|recovered|CHILD-ANSWER/i,
    );
  });

  it('an eviction between the child\'s answer and the caller\'s wait still settles the caller', async () => {
    const workspace = 'hire-evict';

    await probe(workspace).setup(workspace, 'hire-root', 'answer');
    await probe(workspace).openHire(workspace, 'Hire one auditor across an eviction.');

    // End the activation after the child has spoken and before the caller has
    // observed it: the in-memory waiter dies here, so whatever settles the
    // caller now has to be durable.
    await probe(workspace).childSpoke();
    await abortAllDurableObjects();
    await probe(workspace).reenter(workspace);

    const observed: HireObservation = await probe(workspace).observe(workspace);

    const durable = [
      observed.toolResults.join(' '),
      observed.transcript.join(' '),
      observed.log
        .filter((row) => row.variant === 'subordinate_report')
        .map((row) => `${row.kind}:${row.bodyLength}`)
        .join(' '),
    ].join(' ');

    // The answer reached the caller through whatever durable path exists: the
    // resolved call, the transcript, or a report on the caller's own rail.
    expect(durable).toMatch(new RegExp(`${CHILD_ANSWER}|subordinate_report|completed`));

    const hired = observed.roster.filter((row) => row.lifetime === 'task');

    expect(hired).toHaveLength(1);
    expect(hired[0]?.status).toBe('dismissed');
  });

  it('one brief produces exactly one child turn', async () => {
    const workspace = 'hire-once';

    await probe(workspace).setup(workspace, 'hire-root', 'answer');
    await probe(workspace).openHire(workspace, `Hire one auditor with ${HIRE_MISSION}.`);
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);

    expect(observed.rootActorId).not.toBe('');
    expect(observed.roster.filter((row) => row.lifetime === 'task')).toHaveLength(1);

    // A task hire's lifetime IS the task on the IDENTITY plane too, and the
    // read below depends on that: the child retires itself inside the turn that
    // answers, before its caller is told anything, so every count of its work
    // is a read of rows a retired actor left behind.
    const child = observed.actors.filter((row) => row.kind === 'subordinate');

    expect(child).toHaveLength(1);
    expect(child[0]?.retiringAt).not.toBeNull();
    // One brief, one admission: the child's log carries the birth task and
    // nothing else. An exact number, so a re-admission loop cannot hide in a
    // "small enough" bound. The message carries the row count and the newest
    // body's head, so a loop shows its nesting rather than only its size.
    const admissions = childAdmissions(observed);

    expect(admissions, [
      `subordinate_task rows: ${String(admissions.length)}`,
      `body lengths: ${admissions.map((row) => String(row.bodyLength)).join(',')}`,
      `newest body head: ${admissions.at(-1)?.body.slice(0, 160) ?? ''}`,
    ].join(' | ')).toHaveLength(1);

    // And exactly one turn ran for it.
    const childTurns = observed.turns.filter((row) => row.actorId !== observed.rootActorId);

    expect(childTurns).toHaveLength(1);
    expect(childTurns[0]?.runs).toBe(1);
  });
  it('a message to a hired durable subordinate produces one turn and no unbounded admissions', async () => {
    const workspace = 'hire-msg';

    await probe(workspace).setup(workspace, 'hire-root-durable', 'answer');
    // Held rather than awaited: under the bug the caller's `agents` turn never
    // finishes, and settling on it first would end this case in a hang with no
    // counted admissions. The settle assertion below is unchanged — it still
    // requires the same arrival — the count just reaches the record first.
    const hiring = probe(workspace).openHire(workspace, 'Hire a durable auditor, then send it one message.');

    await probe(workspace).msgSent();

    const early: HireObservation = await probe(workspace).observe(workspace);
    const earlyAdmissions = childAdmissions(early);

    // The birth assignment plus the one message: two admissions, not a stream.
    expect(earlyAdmissions, [
      `subordinate_task rows: ${String(earlyAdmissions.length)}`,
      `newest body head: ${earlyAdmissions.at(-1)?.body.slice(0, 160) ?? ''}`,
    ].join(' | ')).toHaveLength(2);

    await hiring;
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);

    expect(observed.roster.filter((row) => row.lifetime === 'durable')).toHaveLength(1);
    expect(childAdmissions(observed)).toHaveLength(2);

    const childTurns = observed.turns.filter((row) => row.actorId !== observed.rootActorId);

    expect(childTurns).toHaveLength(1);
    expect(childTurns[0]?.runs).toBe(2);
  });
});
