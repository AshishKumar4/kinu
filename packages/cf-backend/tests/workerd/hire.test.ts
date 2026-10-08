/**
 * The delegation path end to end in workerd, through the product's own seams. No per-test clock
 * (`testTimeout: 0`, `scripts/test-clocks.ts`): a path that never arrives hangs, and the hang is the report.
 * Re-entry after eviction is `abortAllDurableObjects()` plus a request (`do-eviction-recovery.test.ts`).
 */

import { abortAllDurableObjects, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DELEGATION_MAX_DEPTH, ORCHESTRATOR_AGENT_SLUG, hostedActorSocketPath } from '@kinu.run/core';
import { CHAIN_BOTTOM, CHILD_ANSWER, HIRE_MISSION, NEST_RELAY, type HireObservation, type LogRow } from './hire-shapes';
import * as v from 'valibot';
import { HireRosterSchema, hireSocket } from '../helpers/hire-socket';

/** Re-acquired per use: the id survives an eviction, a stub does not. */
const probe = (workspace: string) => env.HIRE_PROBE.get(env.HIRE_PROBE.idFromName(workspace));

/** Admissions in a child's log; the root's own rows must not inflate a bound. */
function childAdmissions(observed: HireObservation): readonly LogRow[] {
  return observed.log.filter(
    (row) => row.variant === 'subordinate_task' && row.actorId !== observed.rootActorId,
  );
}

describe('hire', () => {
  // Owner, 2026-09-27 (SUBAGENTS.md §4): every hire returns at once; its answer arrives as a message.
  it('a task hire returns at once, and the child\'s answer opens its caller\'s next turn', async () => {
    const workspace = 'hire-answer';

    await probe(workspace).setup(workspace, 'hire-root', 'answer');
    await probe(workspace).openHire(workspace, 'Hire one auditor and tell me what it said.');
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);

    expect(observed.toolResults.join(' ')).toContain('"status":"working"');
    expect(observed.toolResults.join(' ')).not.toContain(CHILD_ANSWER);
    expect(observed.reports.join(' ')).toContain(CHILD_ANSWER);

    // A task hire's lifetime is the task.
    const hired = observed.roster.filter((row) => row.lifetime === 'task');

    expect(hired).toHaveLength(1);
    expect(hired[0]?.status).toBe('dismissed');

    expect(observed.transcript.join(' ')).toContain(CHILD_ANSWER);
  });

  // Owner, 2026-08-18: a hired agent hires its own helpers, to depth 4.
  it('a helper\'s own task hire answers that helper, and the relayed answer reaches the root', async () => {
    const workspace = 'hire-nested';

    await probe(workspace).setup(workspace, 'hire-root', 'nest');
    await probe(workspace).openHire(workspace, 'Hire one auditor that hires one of its own.');
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const answers = observed.reports.join(' ');

    expect(answers).toContain(NEST_RELAY);
    expect(answers).toContain(CHILD_ANSWER);

    const hired = observed.roster.filter((row) => row.lifetime === 'task');

    expect(hired.filter((row) => row.actorId === observed.rootActorId)).toHaveLength(1);
    expect(hired.filter((row) => row.actorId !== observed.rootActorId)).toHaveLength(1);
    expect(hired.every((row) => row.status === 'dismissed')).toBe(true);
  });

  it('a helper\'s own task child that notes its progress still answers the helper, which answers only then', async () => {
    const workspace = 'hire-nested-progress';

    await probe(workspace).setup(workspace, 'hire-root', 'nest-progress');
    await probe(workspace).openHire(workspace, 'Hire one auditor that hires one of its own, which notes its progress.');
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const toRoot = observed.reports.filter((report) => report.includes(NEST_RELAY));

    // The helper's turn on the progress note is not its answer: its own hire still works.
    expect(toRoot.every((report) => report.includes(CHILD_ANSWER))).toBe(true);
    expect(toRoot.length).toBeGreaterThan(0);
  });

  it('a chain of helpers each hiring its own stops at the depth cap and still answers the root', async () => {
    const workspace = 'hire-chain';

    await probe(workspace).setup(workspace, 'hire-root', 'chain');
    await probe(workspace).openHire(workspace, 'Hire one auditor; each hires one of its own.');
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const hired = observed.actors.filter((row) => row.hired);

    expect(hired).toHaveLength(DELEGATION_MAX_DEPTH);
    // Relayed up every level: the deepest helper's own answer reaches the root.
    expect(observed.rootReports.join(' ')).toContain(CHAIN_BOTTOM);
  });

  it('dismissing a helper retires the task agent it hired, mid-turn', async () => {
    const workspace = 'hire-nested-dismiss';

    await probe(workspace).setup(workspace, 'hire-root', 'nest-park');
    await probe(workspace).openHire(workspace, 'Hire one durable auditor that hires one of its own; the owner dismisses it.');

    await probe(workspace).childSpoke();
    // Hangs while the retirement waits out the parked grandchild: nothing below releases it.
    await probe(workspace).dismissChild(workspace);

    const observed: HireObservation = await probe(workspace).observe(workspace);

    expect(observed.reports.join(' ')).not.toContain(CHILD_ANSWER);
    expect(observed.roster.every((row) => row.status === 'dismissed')).toBe(true);
  });

  it('a child whose turn throws delivers its failure to its caller', async () => {
    const workspace = 'hire-throw';

    await probe(workspace).setup(workspace, 'hire-root', 'throw');
    await probe(workspace).openHire(workspace, 'Hire one auditor; its model will throw.');
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const answer = observed.reports.join(' ');

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

    // The interrupted `agents` call was claimed before the abort, so recovery settles it as the lost-call
    // refusal (effect-claim.ts), which is a settled caller too.
    expect([...observed.toolResults, ...observed.reports].join(' ')).toMatch(
      /failed|blocked|unavailable|interrupt|recovered|taken effect|CHILD-ANSWER/i,
    );
  });

  // warm-forge-4d6acc02, 2026-09-25: a delegated turn run inside the alarm slept on an 8-day Retry-After until the
  // 15-minute alarm wall reset the object, every 15 minutes, closing every socket. The wake must hand the turn off.
  it('the wake that starts a delegated turn returns while that turn is still running', async () => {
    const workspace = 'hire-wake-returns';

    await probe(workspace).setup(workspace, 'hire-root', 'park');
    const hiring = probe(workspace).openHire(workspace, 'Hire one auditor; it will park.');

    await probe(workspace).childSpoke();
    // Hangs while the wake holds the parked turn: the release below is never reached.
    await probe(workspace).wakeReturned(workspace);
    await probe(workspace).releaseChild();
    await hiring;
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);

    expect(observed.reports.join(' ')).toContain(CHILD_ANSWER);
  });

  it('the owner\'s Stop ends a parked delegated turn, and a restart does not run it again', async () => {
    const workspace = 'hire-stop';

    await probe(workspace).setup(workspace, 'hire-root', 'park');
    const hiring = probe(workspace).openHire(workspace, 'Hire one auditor; the owner will stop it.');

    await probe(workspace).childSpoke();
    await probe(workspace).stopChild(workspace);
    await hiring;
    // Hangs while the parked turn outlives the Stop: nothing below releases it.
    await probe(workspace).settled(workspace);
    await abortAllDurableObjects();
    await probe(workspace).reenter(workspace);

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const childTurns = observed.turns.filter((row) => row.actorId !== observed.rootActorId);

    expect(observed.reports).toEqual([]);
    expect(childTurns).toHaveLength(1);
    expect(childTurns[0]?.runs).toBe(1);
  });

  it('the owner\'s Dismiss with history kept ends a parked delegated turn instead of waiting on it', async () => {
    const workspace = 'hire-dismiss';

    await probe(workspace).setup(workspace, 'hire-root-durable', 'park');
    await probe(workspace).openHire(workspace, 'Hire one durable auditor; the owner will dismiss it.');
    // The child's request reaching the model is the turn parked; Dismiss before it would retire an unstarted child.
    await probe(workspace).childSpoke();
    // Hangs while the retirement waits on the parked turn: nothing below releases it.
    const dismissed = await probe(workspace).dismissChild(workspace);

    await abortAllDurableObjects();
    await probe(workspace).reenter(workspace);

    const observed: HireObservation = await probe(workspace).observe(workspace);
    const childTurns = observed.turns.filter((row) => row.actorId !== observed.rootActorId);

    expect(observed.roster.find((row) => row.name === dismissed)?.status).toBe('dismissed');
    expect(observed.reports.join(' ')).not.toContain(CHILD_ANSWER);
    expect(childTurns).toHaveLength(1);
    expect(childTurns[0]?.runs).toBe(1);
  });

  it('an eviction while the child works still delivers its answer', async () => {
    const workspace = 'hire-evict';

    await probe(workspace).setup(workspace, 'hire-root', 'answer');
    await probe(workspace).openHire(workspace, 'Hire one auditor across an eviction.');

    await probe(workspace).childSpoke();
    await abortAllDurableObjects();
    await probe(workspace).reenter(workspace);
    await probe(workspace).callerObserved();

    const observed: HireObservation = await probe(workspace).observe(workspace);

    const durable = [
      observed.reports.join(' '),
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
    await probe(workspace).settled(workspace);

    const observed: HireObservation = await probe(workspace).observe(workspace);

    expect(observed.rootActorId).not.toBe('');
    expect(observed.roster.filter((row) => row.lifetime === 'task')).toHaveLength(1);

    // The child retires after the turn that answers, so counts read rows a retired actor left behind.
    const child = observed.actors.filter((row) => row.hired);

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
    const app = env.HIRE_APP;

    const created = await app.fetch('http://localhost/api/user/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hire-msg-client', displayName: 'Hire Message Client' }),
    });

    expect(created.ok).toBe(true);
    const { name: workspace } = v.parse(v.object({ name: v.string() }), await created.json());

    const configured = await app.fetch('http://localhost/api/user/credentials/openai-compat.default', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'openai-compat', baseURL: `http://hire-models.invalid/w/${encodeURIComponent(workspace)}/v1`, apiKey: 'hire-fixture-key' }),
    });

    expect(configured.ok).toBe(true);

    const client = await hireSocket(app, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(workspace)}`, CHILD_ANSWER);

    try {
      await client.rpc('setModel', ['openai-compat/hire-root-durable'], v.object({ spec: v.string() }));
      client.send('Hire a durable auditor, then send it one message.');
      await client.completed();
      const roster = await client.rpc('listSubordinates', [], HireRosterSchema);
      const observed = await probe(workspace).observe(workspace);

      expect(roster.filter((row) => row.lifetime === 'durable')).toHaveLength(1);
      expect(roster.every((row) => row.status !== 'working')).toBe(true);
      expect(childAdmissions(observed)).toHaveLength(2);
      const childTurns = observed.turns.filter((row) => row.actorId !== observed.rootActorId);

      expect(childTurns).toHaveLength(1);
      expect(childTurns[0]?.runs).toBe(2);
      expect(observed.rootReports.join(' ')).toContain(CHILD_ANSWER);
      const child = childTurns[0]?.actorId ?? '';
      const archived = await probe(workspace).archiveSections(workspace);

      expect(archived.listed).toContain(child);
      expect(archived.sections[child]).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  it('a hired agent\'s plan is reviewed in its own window, and the owner\'s feedback starts its next turn there', async () => {
    const app = env.HIRE_APP;

    const created = await app.fetch('http://localhost/api/user/workspaces', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'hire-plan-client', displayName: 'Hire Plan Client' }),
    });

    expect(created.ok).toBe(true);
    const { name: workspace } = v.parse(v.object({ name: v.string() }), await created.json());

    const configured = await app.fetch('http://localhost/api/user/credentials/openai-compat.default', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'openai-compat', baseURL: `http://hire-models.invalid/w/${encodeURIComponent(workspace)}/v1`, apiKey: 'hire-fixture-key' }),
    });

    expect(configured.ok).toBe(true);
    const workspacePath = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(workspace)}`;
    const root = await hireSocket(app, workspacePath, CHILD_ANSWER);
    const PlanSchema = v.nullable(v.looseObject({ id: v.string(), revision: v.number(), status: v.string(), content: v.string() }));

    try {
      await root.rpc('setModel', ['openai-compat/hire-root-durable'], v.object({ spec: v.string() }));
      root.send('Hire a durable auditor, then send it one message.');
      await root.completed();
      const [auditor] = (await root.rpc('listSubordinates', [], HireRosterSchema)).filter((row) => row.lifetime === 'durable');
      const name = auditor?.name ?? '';
      const submitted = await probe(workspace).submitChildPlan(workspace, name, [{ start: 1, content: '# Audit plan\n\n1. Read the ledger.' }]);

      expect(submitted.ok).toBe(true);
      const pane = await hireSocket(app, `${workspacePath}/${hostedActorSocketPath(name)}`, CHILD_ANSWER);

      try {
        const shown = await pane.rpc('getActivePlanReview', [], PlanSchema);

        expect(shown?.status).toBe('pending');
        expect(shown?.content).toContain('Read the ledger');
        // The plan is the agent's own: the root's window shows none, and the agent's snapshot shows this one.
        expect(await root.rpc('getActivePlanReview', [], PlanSchema)).toBeNull();
        expect((await pane.rpc('getActorSnapshot', [name], v.looseObject({ activePlan: PlanSchema }))).activePlan?.id).toBe(shown?.id);

        const decided = await pane.rpc('decidePlanReview', [shown?.id ?? '', shown?.revision ?? 0, 'request_changes', 'Name the ledger files.'],
          v.looseObject({ ok: v.boolean(), queued: v.optional(v.boolean()) }));

        expect(decided).toMatchObject({ ok: true, queued: true });
        expect((await pane.rpc('getActivePlanReview', [], PlanSchema))?.status).toBe('changes_requested');

        // The feedback is the agent's next turn, in its own chat: no clock, so a turn that never comes hangs here.
        let lines = await probe(workspace).childLines(workspace, name);

        while (!lines.some((line) => line.includes('Name the ledger files.')) || !lines.at(-1)?.includes(CHILD_ANSWER)) lines = await probe(workspace).childLines(workspace, name);
        expect(lines.find((line) => line.includes('Name the ledger files.'))).toContain('The owner requested changes to plan');
      } finally {
        pane.close();
      }
    } finally {
      root.close();
    }
  });
});
