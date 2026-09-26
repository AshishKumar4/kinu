/**
 * The delegation path end to end in workerd, through the product's own seams. No per-test clock
 * (`testTimeout: 0`, `scripts/test-clocks.ts`): a path that never arrives hangs, and the hang is the report.
 * Re-entry after eviction is `abortAllDurableObjects()` plus a request (`do-eviction-recovery.test.ts`).
 */

import { abortAllDurableObjects, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CHILD_ANSWER, HIRE_MISSION, type HireObservation, type LogRow } from './hire-shapes';

/** Re-acquired per use: the id survives an eviction, a stub does not. */
const probe = (workspace: string) => env.HIRE_PROBE.get(env.HIRE_PROBE.idFromName(workspace));

/** Admissions in a child's log; the root's own rows must not inflate a bound. */
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

    expect(observed.toolResults.join(' ')).toContain(CHILD_ANSWER);

    // A task hire's lifetime is the task.
    const hired = observed.roster.filter((row) => row.lifetime === 'task');

    expect(hired).toHaveLength(1);
    expect(hired[0]?.status).toBe('dismissed');

    expect(observed.transcript.join(' ')).toContain(CHILD_ANSWER);
  });

  it('a child whose turn throws still settles its caller', async () => {
    const workspace = 'hire-throw';

    await probe(workspace).setup(workspace, 'hire-root', 'throw');
    await probe(workspace).openHire(workspace, 'Hire one auditor; its model will throw.');
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const answer = observed.toolResults.join(' ');

    expect(answer).toMatch(/failed|blocked|unavailable/i);
    expect(answer).not.toContain(CHILD_ANSWER);

    const hired = observed.roster.filter((row) => row.lifetime === 'task');

    expect(hired).toHaveLength(1);
    expect(hired[0]?.status).toBe('dismissed');
  });

  it('a child interrupted mid-turn still settles its caller', async () => {
    const workspace = 'hire-interrupt';

    await probe(workspace).setup(workspace, 'hire-root', 'park');
    // Held, not awaited: `runTaskFromMcp`'s `inbox.send` resolves when the queued turn ends, which needs the
    // interruption staged below. Case 6 holds its hire for the same reason.
    const hiring = probe(workspace).openHire(workspace, 'Hire one auditor; it will be interrupted.');

    await probe(workspace).childSpoke();
    await abortAllDurableObjects();

    // The caller's RPC frame died with the activation; the durable settlement is read below.
    await Promise.allSettled([hiring]);

    // A request is how a caller comes back; `onStart` runs the recovery scan.
    await probe(workspace).reenter(workspace);
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);

    expect(observed.toolResults.join(' ')).toMatch(
      /failed|blocked|unavailable|interrupt|recovered|CHILD-ANSWER/i,
    );
  });

  it('the owner\'s Stop ends a parked delegated turn, and a restart does not run it again', async () => {
    const workspace = 'hire-stop';

    await probe(workspace).setup(workspace, 'hire-root', 'park');
    const hiring = probe(workspace).openHire(workspace, 'Hire one auditor; the owner will stop it.');

    await probe(workspace).childSpoke();
    await probe(workspace).stopChild(workspace);
    // Hangs while the parked turn outlives the Stop: nothing below releases it.
    await hiring;
    await abortAllDurableObjects();
    await probe(workspace).reenter(workspace);

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const childTurns = observed.turns.filter((row) => row.actorId !== observed.rootActorId);

    expect(observed.toolResults.join(' ')).not.toContain(CHILD_ANSWER);
    expect(childTurns).toHaveLength(1);
    expect(childTurns[0]?.runs).toBe(1);
  });

  it('the owner\'s Dismiss with history kept ends a parked delegated turn instead of waiting on it', async () => {
    const workspace = 'hire-dismiss';

    await probe(workspace).setup(workspace, 'hire-root-durable', 'park');
    // Held, not awaited: the root's turn waits on the child's answers, which the dismissal ends.
    const hiring = probe(workspace).openHire(workspace, 'Hire one durable auditor; the owner will dismiss it.');

    await probe(workspace).childSpoke();
    // Hangs while the retirement waits on the parked turn: nothing below releases it.
    const dismissed = await probe(workspace).dismissChild(workspace);

    await abortAllDurableObjects();
    await Promise.allSettled([hiring]);
    await probe(workspace).reenter(workspace);

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const childTurns = observed.turns.filter((row) => row.actorId !== observed.rootActorId);

    expect(observed.roster.find((row) => row.name === dismissed)?.status).toBe('dismissed');
    expect(observed.toolResults.join(' ')).not.toContain(CHILD_ANSWER);
    expect(childTurns[0]?.runs).toBe(1);
  });

  it('an eviction between the child\'s answer and the caller\'s wait still settles the caller', async () => {
    const workspace = 'hire-evict';

    await probe(workspace).setup(workspace, 'hire-root', 'answer');
    await probe(workspace).openHire(workspace, 'Hire one auditor across an eviction.');

    // The in-memory waiter dies here, so whatever settles the caller must be durable.
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

    // The child retires inside the turn that answers, so counts read rows a retired actor left behind.
    const child = observed.actors.filter((row) => row.kind === 'subordinate');

    expect(child).toHaveLength(1);
    expect(child[0]?.retiringAt).not.toBeNull();
    // Exact, so a re-admission loop cannot hide in a "small enough" bound.
    const admissions = childAdmissions(observed);

    expect(admissions, [
      `subordinate_task rows: ${String(admissions.length)}`,
      `body lengths: ${admissions.map((row) => String(row.bodyLength)).join(',')}`,
      `newest body head: ${admissions.at(-1)?.body.slice(0, 160) ?? ''}`,
    ].join(' | ')).toHaveLength(1);

    const childTurns = observed.turns.filter((row) => row.actorId !== observed.rootActorId);

    expect(childTurns).toHaveLength(1);
    expect(childTurns[0]?.runs).toBe(1);
  });
  it('a message to a hired durable subordinate produces one turn and no unbounded admissions', async () => {
    const workspace = 'hire-msg';

    await probe(workspace).setup(workspace, 'hire-root-durable', 'answer');
    // Held: under the bug the caller's turn never finishes, so the count reaches the record first.
    const hiring = probe(workspace).openHire(workspace, 'Hire a durable auditor, then send it one message.');

    await probe(workspace).msgSent();

    const early: HireObservation = await probe(workspace).observe(workspace);
    const earlyAdmissions = childAdmissions(early);

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
