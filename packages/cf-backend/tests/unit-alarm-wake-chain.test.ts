/**
 * The durable wake chain, as ROWS.
 *
 * A workspace has exactly one Kinu wake — the `_kinuTimerTick` schedule row —
 * and everything asynchronous rides it: timer triggers, peer-outbox retries,
 * outbound-email reconciliation. Losing that row does not fail anything. It
 * stops the workspace, silently, until some unrelated scheduling write happens
 * to re-arm it. Both defects fixed here had exactly that shape.
 *
 * Behavioural, not source-shaped: the schedule registry the production code
 * reads is real SQL over the object's own storage, so the harness Agent keeps
 * that table (tests/helpers/agents-sdk.ts) and these tests assert which rows
 * survive. The ALARM itself is workerd's and is fired for real in
 * tests/workerd/do-alarm.test.ts — including the redelivery-on-throw contract
 * the re-arm now depends on.
 */
import { describe, expect, test } from 'bun:test';
import { orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const KINU_TIMER_CALLBACK = '_kinuTimerTick';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A schedule write that fails — the storage failure that used to end the
 *  chain, injected where it happens. */
function breakScheduleWrites(agent: HarnessOrchestratorAgent): void {
  Object.defineProperty(agent, 'schedule', {
    configurable: true,
    value: async (): Promise<never> => { throw new Error('storage write failed'); },
  });
}

describe('the workspace keeps exactly one wake row', () => {
  test('the stale sweep spares the Kinu wake and still drops a dead continuation', async () => {
    // KINU-N027: the sweep deleted every overdue `delayed`/`scheduled` row, and
    // it runs BEFORE the SDK reads the due rows — so an activation whose Kinu
    // wake was more than a day overdue deleted the very row it was about to
    // run, and nothing re-armed it. Cron triggers, peer retries and email
    // reconciliation all stopped together for that workspace.
    const { agent, db } = orchestratorHarness();
    await agent.listSchedules();
    const overdueSec = Math.floor((Date.now() - 2 * DAY_MS) / 1000);
    const insert = db.prepare(
      `INSERT INTO cf_agents_schedules (id, callback, payload, type, time) VALUES (?, ?, NULL, ?, ?)`,
    );
    insert.run('kinu-wake', KINU_TIMER_CALLBACK, 'scheduled', overdueSec);
    insert.run('dead-continuation', '_chatRecovery', 'delayed', overdueSec);

    // The ACTOR's activation, not `agent.onStart()`: the vendor chat base
    // shadows that name, so calling it activates nothing and this assertion
    // would pass or fail on a sweep that never ran.
    agent.activateActor();

    expect((await agent.listSchedules()).map((row) => row.id)).toEqual(['kinu-wake']);
  });

  test('a failed re-arm leaves the previous wake row in place', async () => {
    // KINU-N003 (first half): `armTimer` cancelled the armed rows and then
    // wrote the replacement. A failure in that window left ZERO wake rows, and
    // nothing re-arms a workspace whose only wake was the one just cancelled.
    // The write comes first now, so the worst case is one extra wake.
    const { agent } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const before = await agent.listSchedules();
    expect(before.map((row) => row.callback)).toEqual([KINU_TIMER_CALLBACK]);

    breakScheduleWrites(agent);
    // A sooner trigger wants a sooner row, so this really does re-arm.
    await expect(agent.createTimerTrigger({ atMs: Date.now() + 60_000, label: 'soon' }))
      .rejects.toThrow('storage write failed');

    expect((await agent.listSchedules()).map((row) => row.id)).toEqual(
      before.map((row) => row.id),
    );
  });

  test('a tick that cannot re-arm fails, so the runtime redelivers it', async () => {
    // KINU-N003 (second half): the tick caught its re-arm failure, recorded a
    // diagnostic and returned. The alarm therefore looked successful, platform
    // redelivery never engaged, and the chain was over. The other three phases
    // are still tolerated — their work is state-driven and the next wake retries
    // it — but this failure IS the loss of the next wake.
    const { agent } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const [armed] = await agent.listSchedules();
    if (!armed) throw new Error('the trigger did not arm a wake row');
    // With the row gone (the state KINU-N027 produced) the tick has a real
    // re-arm to do rather than a no-op dedup.
    await agent.cancelSchedule(armed.id);
    breakScheduleWrites(agent);

    // try/catch rather than a rejection callback: the thrown value is a CAUGHT
    // BINDING, so it is narrowed where it is used instead of entering through an
    // unparsed parameter. A tick that resolved leaves this null, and the
    // `toBeInstanceOf` below is what makes that case fail by name rather than
    // reading as `undefined` inside a `toContain`.
    let failure: Error | null = null;
    try {
      await agent._kinuTimerTick();
    } catch (thrown) {
      if (thrown instanceof Error) failure = thrown;
    }

    // It REJECTS — that rejection is the whole contract, because it is what makes
    // the platform redeliver the alarm instead of counting the tick as done.
    expect(failure).toBeInstanceOf(Error);
    // Classified at the boundary rather than rethrown raw, so the message names
    // the operation and the storage failure stays on the cause chain. Both halves
    // are asserted: a classification that dropped the cause would leave a red
    // with nothing to debug, and a raw rethrow would lose the operation.
    expect(failure?.message).toContain('re-arming the wake that keeps the timer chain alive');
    expect(String(failure?.cause)).toContain('storage write failed');
  });

  test('an activation restores a wake row that went missing', async () => {
    // The recovery half: platform redelivery is bounded, and a row that was
    // never written is not a delivery to retry. An activation is then the one
    // moment a stranded workspace can notice — and the row is derived state, so
    // reconstructing it needs no record of the loss.
    const { agent } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const [armed] = await agent.listSchedules();
    if (!armed) throw new Error('the trigger did not arm a wake row');
    await agent.cancelSchedule(armed.id);
    expect(await agent.listSchedules()).toEqual([]);

    await agent.reconcileWakeRow();

    expect((await agent.listSchedules()).map((row) => row.callback))
      .toEqual([KINU_TIMER_CALLBACK]);
  });

  test('the reconcile cannot invent a wake nothing is waiting for', async () => {
    // It is derived from durable work, so a workspace with no triggers, no peer
    // retries and no pending email stays asleep.
    const { agent } = orchestratorHarness();

    await agent.reconcileWakeRow();

    expect(await agent.listSchedules()).toEqual([]);
  });

  test('an armed wake is left alone, however overdue', async () => {
    // The reconcile answers "is there a wake row at all", never "is it soon
    // enough" — that is `armTimer`'s question. A due row is a wake the platform
    // still owes, so re-arming over it would add a second one on every touch.
    const { agent, db } = orchestratorHarness();
    await agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' });
    const [armed] = await agent.listSchedules();
    if (!armed) throw new Error('the trigger did not arm a wake row');
    db.prepare(`UPDATE cf_agents_schedules SET time = ? WHERE id = ?`)
      .run(Math.floor((Date.now() - 2 * DAY_MS) / 1000), armed.id);

    await agent.reconcileWakeRow();

    expect((await agent.listSchedules()).map((row) => row.id)).toEqual([armed.id]);
  });

  test('two concurrent arms converge on ONE wake row, the earliest', async () => {
    // The race the harness used to hide. `onStart` DETACHES the wake reconcile
    // (`void this.reconcileTimerRow()`), so an activation reconcile and a
    // registration arm interleave: every `await` in `armTimer` is a suspension
    // point, both callers pre-read an EMPTY registry, both write, and a collapse
    // over each caller's own pre-read set cancels nothing. That left two wake
    // rows permanently — the one state this whole suite is named against.
    //
    // Two registrations are the same shape and need no internals: each arms, and
    // the pair must agree on one survivor. It has to be the SOONER wake, because
    // keeping the later one silently delays every trigger, peer retry and email
    // reconciliation riding the row.
    const { agent } = orchestratorHarness();
    const soonerMs = Date.now() + 2 * DAY_MS;

    await Promise.all([
      agent.createTimerTrigger({ atMs: Date.now() + 4 * DAY_MS, label: 'far' }),
      agent.createTimerTrigger({ atMs: soonerMs, label: 'sooner' }),
    ]);

    const wakes = (await agent.listSchedules())
      .filter((row) => row.callback === KINU_TIMER_CALLBACK);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.time).toBe(Math.ceil(soonerMs / 1000));
  });
});
