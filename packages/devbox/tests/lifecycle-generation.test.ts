// Lifecycle ownership, honest readiness, and the recovery ladder — driven
// through the real Devbox class against the platform stand-in in
// `support/devbox-harness.ts`, which holds the one SDK substitution and explains
// why it exists.
//
// Every defect here is about ORDER and OWNERSHIP across awaits: which of two
// overlapping startup attempts may write, whether a port may be exposed after
// its listener said nothing, and what a box does the second time one container
// identity fails. The pure halves — the taxonomy, the ladder, the plan — are
// pinned in `decisions.test.ts`; what is pinned here is the shipped methods
// acting on them.
//
// The four defects, in the shape they had:
//   * a startup attempt abandoned by a container replacement kept running, then
//     published readiness for a generation that no longer existed, filed that
//     generation's attach failure, and RELEASED ITS SUCCESSOR'S single-flight
//     entry — after which the next caller started a second concurrent
//     restoration against the same container;
//   * a restored process whose start threw, and a port whose listener stayed
//     silent, were recorded and stepped over — straight into exposing that very
//     port, and then reporting the box ready;
//   * one generic retry policy re-armed the same identity for every failure,
//     spending retries on configuration that cannot change and repeating copies
//     into a filesystem that is already full;
//   * and no number of failures ever escalated to replacing the identity.
import { beforeEach, describe, expect, test, vi } from 'bun:test';

import * as v from 'valibot';

import {
  DEFAULT_DEVBOX_POLICY, parseRecoveryRow, type DevboxPolicy, type RecoveryRow,
  type RecoveryStage,
} from '../src/lifecycle';
import type { StoredValue } from '../src/storage';
import {
  Devbox, FakeSandbox, gate, harness, SandboxFailure, STAMP_COMMAND,
  type FakeStorage, type Harness, type StartFault,
} from './support/devbox-harness';

const RECOVERY_KEY = 'devbox:attach-recovery';
/** The owner a seeded row carries: a previous attempt's token, which no live
 *  attempt holds. */
const PREVIOUS = 'previous-attempt';
const INCIDENT_PREFIX = 'devbox:incident:';

const failure = (code: string): SandboxFailure =>
  new SandboxFailure({ code, message: `the container reported ${code}` });

/** A start that throws having created nothing, which is what a container
 *  refusing a command does. The harness owns the shape. */
const refused = (code: string): StartFault => ({ error: failure(code), created: false });

/** The probe windows are milliseconds so a silent listener is a fast fact
 *  rather than a thirty-second one. Every other number is the shipped policy:
 *  this box is the production box with a test-length probe. */
const TEST_POLICY: DevboxPolicy = {
  ...DEFAULT_DEVBOX_POLICY,
  portWaitMs: 4,
  portProbeIntervalMs: 1,
};

const HEARTBEAT_POLICY: DevboxPolicy = {
  ...TEST_POLICY,
  idleMs: 1,
  quietConfirmMs: 1,
};

/**
 * The same box on a budget short enough for a test to exhaust, and with a port
 * cap far LONGER than that budget.
 *
 * Both numbers matter. The cap is thirty seconds, so any test that waited a
 * port's full cap would outlast the runner's timeout many times over — which is
 * exactly what the clamp is asked to prevent. The budget is milliseconds, so the
 * one end-to-end deadline is reachable without sleeping.
 */
const TIGHT_POLICY: DevboxPolicy = {
  ...DEFAULT_DEVBOX_POLICY,
  attachBudgetMs: 20,
  portWaitMs: 30_000,
  portProbeIntervalMs: 1,
};


class TightBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return TIGHT_POLICY;
  }

  protected override get previewHost(): string | undefined {
    return 'preview.example';
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return TEST_POLICY;
  }

  protected override get previewHost(): string | undefined {
    return 'preview.example';
  }

  /** Off, so the schedule rows a test counts are the ones its own actions
   *  wrote. The ambient tick is exercised elsewhere. */
  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

class HeartbeatBox extends TestBox {
  protected override get policy(): DevboxPolicy {
    return HEARTBEAT_POLICY;
  }
}



/** The incidents the box filed, by stage. Read from durable rows, because that
 *  is where the class writes them before anyone is told. */
/** The two fields every assertion here reads off a filed incident. Parsed
 *  rather than asserted: a row the box wrote that carries no stage or no reason
 *  is a defect worth failing on, not one to cast past. */
const FiledIncidentSchema = v.object({ stage: v.string(), reason: v.string() });

type FiledIncident = v.InferOutput<typeof FiledIncidentSchema>;

function incidents(rows: Map<string, StoredValue>): readonly FiledIncident[] {
  return [...rows]
    .filter(([key]) => key.startsWith(INCIDENT_PREFIX))
    .map(([, row]) => v.parse(FiledIncidentSchema, row));
}

/** Startup rows the box is actually holding.
 *
 *  THE LIVE TABLE, not the log of arm calls, and the difference is the property.
 *  The container-start hook arms a startup row for a box with nothing restored
 *  yet, and the SDK runs that hook on every admission probe — so "was an arm
 *  ever issued" stopped being the question. What matters is whether a row
 *  survives to wake this box: a terminal ladder deletes it (`#recover`), and a
 *  retry leaves exactly one. */
const armed = (container: FakeSandbox): number =>
  container.scheduleRows.filter(row => row.callback === 'devboxStartup').length;

/** The ladder row as stored, read raw so a test sees the owner as well as the
 *  stage. */
function ladder(rows: Map<string, StoredValue>): RecoveryRow | undefined {
  // The production parser, not a cast: it is the one authority on this row's
  // shape, and a test that read the row more loosely than the box does could
  // assert a stage the box would have refused.
  const held = parseRecoveryRow(rows.get(RECOVERY_KEY));
  return held.kind === 'row' ? held.row : undefined;
}

/**
 * Make the next attempt FAIL AS AN ATTEMPT, with the class the taxonomy should
 * read, by failing its first durable write.
 *
 * An ephemeral box's `attach()` cannot fail — it has nowhere to attach from —
 * and a container fault is no longer usable for this. After the fenceability
 * split, every step AFTER the attach reports its exhaustion instead of throwing,
 * so a faulted process start or boot stamp produces an INCOMPLETE restoration
 * rather than an attach failure. The attempt's first durable write is the
 * nearest honest stand-in: it propagates exactly as a real attach failure does,
 * into the recovery ladder.
 */
function failAttempt(harnessed: { readonly storage: FakeStorage }, code: string): void {
  harnessed.storage.faultOn('devbox:last-attach', failure(code));
}

/** A durable process spec, as `startSupervised` would have left one. */
function proc(
  rows: Map<string, StoredValue>, processId: string, command = 'bun run server.ts',
): void {
  rows.set(`devbox:proc:${processId}`, { processId, command, cwd: '/workspace', createdAt: 1 });
}

function port(rows: Map<string, StoredValue>, value: number, token: string): void {
  rows.set(`devbox:port:${value}`, { port: value, name: 'web', token, createdAt: 1 });
}

// ── asynchronous startup kick ───────────────────────────────────────────────

describe('the startup kick arms restoration without attaching inline', () => {
  test('a stopped box starts only enough to arm the existing startup callback', async () => {
    const { box, container } = harness(TestBox);
    await container.stop();

    await box.kickStartup();

    expect({
      starts: container.containerStarts,
      startupArms: armed(container),
      attachCommands: container.execs,
    }).toEqual({ starts: 0, startupArms: 1, attachCommands: [] });
    const pending = await box.devboxState();
    expect({
      restoration: pending.restoration,
      lastAttach: pending.lastAttach,
      ready: pending.ready,
    }).toEqual({ restoration: 'unstarted', lastAttach: undefined, ready: false });

    await container.start();
    await box.devboxStartup();
    const attached = await box.devboxState();
    expect({
      restoration: attached.restoration,
      attach: attached.lastAttach?.kind,
      ready: attached.ready,
    }).toEqual({ restoration: 'attached', attach: 'empty', ready: true });
  });

  test('the raw startup callback admits a stopped container, then attaches it', async () => {
    const { box, container } = harness(TestBox);
    await container.stop();

    await box.devboxStartup();

    expect(container.startWaitOptions).toHaveLength(1);
    expect(container.startWaitOptions[0]).toMatchObject({
      portToCheck: 3000,
      // THE PROBE LASTS ITS WHOLE WINDOW, expressed as the SDK's own retry
      // shape. `retries: 1` made the SDK give up after ONE poll — its
      // `totalTries` IS this number — so the abort signal below could never
      // fire and every instant refusal cost an incident row plus a re-arm.
      // Measured live at 21 incidents in 15 s on a contended account.
      retries: Math.ceil(TEST_POLICY.portWaitMs / 100),
      waitInterval: 100,
      signal: expect.any(AbortSignal),
    });
    const state = await box.devboxState();
    expect({
      starts: container.containerStarts,
      // NO ROW SURVIVES A SETTLED RESTORATION. The container-start hook arms one
      // for a box with nothing restored yet; the attempt that settles retires it,
      // because a row firing on an attached box is a wake, a port probe and a
      // boot-id read that nothing asked for.
      startupArms: armed(container),
      restoration: state.restoration,
      attach: state.lastAttach?.kind,
      ready: state.ready,
    }).toEqual({
      starts: 1,
      startupArms: 0,
      restoration: 'attached',
      attach: 'empty',
      ready: true,
    });
  });

  test('a capacity refusal — no container ever ran — records its class and arms one successor', async () => {
    // The container was never admitted, so no start hook ran and nothing
    // restored: the incident and the successor row are the whole answer.
    const { box, container, rows } = harness(TestBox);
    await container.stop();
    container.startFaultBeforeRunning = new SandboxFailure({
      code: 'CONTAINER_UNAVAILABLE',
      message: 'the container is at capacity',
    });

    await box.devboxStartup();

    expect(container.startWaitOptions).toHaveLength(1);
    expect(armed(container)).toBe(1);
    expect(incidents(rows)).toEqual([
      expect.objectContaining({
        stage: 'attach',
        reason: expect.stringContaining('[transient → retry]'),
      }),
    ]);
    expect((await box.devboxState()).restoration).toBe('unstarted');
  });

  test('an unhealthy answer AFTER the container ran is a transient refusal the next drive heals', async () => {
    // `startFaultAfterRunning` fires once the platform has an instance, so the
    // container really is up — but this attempt cannot know that, because the
    // admission probe it asked threw. The restore no longer happens inside the
    // container-start hook (see restore-out-of-gate.test.ts for the probe that
    // refuted that placement), so what this box owes is the honest sequence: the
    // refusal is recorded as transient, a successor is armed, and the next drive
    // — one second later on the schedule, or the next operation — attaches.
    const { box, container, rows } = harness(TestBox);
    await container.stop();
    container.startFaultAfterRunning = new SandboxFailure({
      code: 'CONTAINER_UNAVAILABLE',
      message: 'the container is not healthy',
    });

    await box.devboxStartup();

    expect((await box.devboxState()).restoration).toBe('unstarted');
    expect(incidents(rows)).toEqual([
      expect.objectContaining({
        stage: 'attach',
        reason: expect.stringContaining('[transient → retry]'),
      }),
    ]);
    expect(armed(container)).toBe(1);

    // THE HEAL, on the row that refusal armed. The fault was one-shot, as a
    // transient one is, so the same identity attaches.
    await box.devboxStartup();

    const state = await box.devboxState();
    expect({ restoration: state.restoration, ready: state.ready })
      .toEqual({ restoration: 'attached', ready: true });
  });

  test('a stopped replacement cannot reuse the prior container attachment after eviction', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    await container.stop();
    container.bootId = undefined;

    await box.devboxStartup();

    expect({
      starts: container.containerStarts,
      stamps: container.execs.filter(command => command.includes(STAMP_COMMAND)).length,
      ready: (await box.devboxState()).ready,
    }).toEqual({ starts: 1, stamps: 2, ready: true });
  });


  test('a state poll reactivates a stopped container but leaves attachment scheduled', async () => {
    const { box, container } = harness(TestBox);
    await container.stop();

    const state = await box.devboxState();
    expect({
      starts: container.containerStarts,
      startupArms: armed(container),
      restoration: state.restoration,
      attachCommands: container.execs,
    }).toEqual({ starts: 0, startupArms: 1, restoration: 'unstarted', attachCommands: [] });
  });
});

// ── one attempt, one generation ─────────────────────────────────────────────

describe('a startup attempt owns a generation, and a superseded one is inert', () => {
  const stamps = (container: FakeSandbox): number =>
    container.execs.filter(command => command.includes(STAMP_COMMAND)).length;

  test('a superseded attempt cannot publish readiness for a generation that is gone', async () => {
    // KINU-030. The attempt is parked at its LAST await — the boot-id stamp —
    // and the container is replaced underneath it. Before the fence it went on
    // to set readiness, and the box then reported itself restored while the
    // instance it had restored no longer existed.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    const parked = gate();
    container.stampGate = parked;
    const stale = box.devboxStartup();
    await parked.reached;
    await container.stop();
    container.bootId = undefined;
    const successor = box.devboxStartup();
    await successor;
    parked.release();
    await stale;
    const state = await box.devboxState();
    expect({ ready: state.ready, unready: state.unready }).toEqual({
      ready: true, unready: undefined,
    });
  });

  test('a superseded attempt admitted before the turnover attaches nothing', async () => {
    // The claim is the attempt's first act, and the fence is checked the moment
    // it returns: an attempt whose generation turned over while it was claiming
    // must not go on to attach against a container that is gone.
    const harnessed = harness(TestBox);
    const { box, container, rows, storage } = harnessed;
    const claiming = gate();
    storage.gateOn(RECOVERY_KEY, claiming);
    const stale = box.devboxStartup();
    await claiming.reached;
    await container.stop();
    const successor = box.devboxStartup();
    await successor;
    claiming.release();
    await stale;
    expect(container.execs.filter(command => command.includes(STAMP_COMMAND))).toHaveLength(1);
    expect(rows.has('devbox:last-attach')).toBe(true);
  });

  test('a superseded FAILING attempt files nothing, arms nothing and stores no stage', async () => {
    // The other half of the ownership defect: this attempt is already in its
    // RECOVERY path when the generation turns over. It used to record the attach
    // failure of a generation that had been replaced, publish that generation's
    // refusal, and re-arm a startup nobody had asked for.
    //
    // Parked INSIDE the conditional write, which is where both tokens are
    // compared. The row still names this attempt — nothing deleted it — so the
    // durable owner alone would let the write through; the generation is what
    // refuses it.
    const harnessed = harness(TestBox);
    const { box, container, rows, storage } = harnessed;
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    // Two gates on the same key, in the order the attempt reads it: the CLAIM
    // first, then the conditional write inside the recovery. Parking the claim is
    // how the second gate is armed at a point the attempt has not reached yet,
    // without guessing at microtasks.
    const claiming = gate();
    storage.gateOn(RECOVERY_KEY, claiming);
    const stale = box.devboxStartup();
    await claiming.reached;
    const settling = gate();
    storage.gateOn(RECOVERY_KEY, settling);
    claiming.release();
    await settling.reached;
    await container.stop();
    const successor = box.devboxStartup();
    await successor;
    const armsBefore = armed(container);
    settling.release();
    await expect(stale).rejects.toThrow('RPC_TRANSPORT_ERROR');
    expect(incidents(rows)).toEqual([]);
    expect(armed(container)).toBe(armsBefore);
    expect(ladder(rows)).toBeUndefined();
    expect(container.destroys).toBe(0);
    // And the refusal was not published either: the new generation is untouched.
    expect((await box.devboxState()).unready).toBeUndefined();
  });

  test('a superseded attempt does not release its successor\'s single-flight entry', async () => {
    // THE CONCURRENCY DEFECT. The stale attempt cleared the tracked startup in
    // its `finally`, so the next caller found no attempt in flight and started
    // a SECOND restoration against the same container.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    const stalled = gate();
    container.stampGate = stalled;
    const stale = box.devboxStartup();
    await stalled.reached;
    await container.stop();
    const successorGate = gate();
    container.stampGate = successorGate;
    const successor = box.devboxStartup();
    await successorGate.reached;
    // The stale attempt settles while the successor is still parked. Its
    // `finally` must not free the slot the successor holds.
    stalled.release();
    await stale;
    const joined = box.devboxStartup();
    successorGate.release();
    await Promise.all([successor, joined]);
    // Two attempts ran: the abandoned one and its successor. The third caller
    // joined the successor instead of opening a third restoration.
    expect(stamps(container)).toBe(2);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a caller does not JOIN a superseded attempt, it starts the new generation\'s', async () => {
    // The mirror of the rule above: joining an attempt whose result is already
    // discarded would hand the caller a restoration that never happened.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    const stalled = gate();
    container.stampGate = stalled;
    const stale = box.devboxStartup();
    await stalled.reached;
    await container.stop();
    const fresh = box.devboxStartup();
    stalled.release();
    await Promise.all([stale, fresh]);
    expect(stamps(container)).toBe(2);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a superseded restoration exposes no port', async () => {
    // The fence is checked before the outward-facing act as well as before the
    // state write: a port exposed by an attempt whose container is gone
    // publishes a URL into a dead instance.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    proc(rows, 'p1');
    port(rows, 3000, 'tok3000');
    container.listening.add(3000);
    const parked = gate();
    container.startGate = parked;
    const stale = box.devboxStartup();
    await parked.reached;
    await container.stop();
    const successor = box.devboxStartup();
    await successor;
    parked.release();
    await stale;
    expect(container.exposures).toEqual([{ port: 3000, token: 'tok3000', name: 'web' }]);
  });

  test('a superseded ADMISSION refusal arms nothing and files nothing', async () => {
    // The window before an attempt owns anything. `start()` is the admission
    // probe every attempt awaits, and it is the longest await on the path — a
    // whole `portWaitMs`. A quiesce can land inside it, because an attempt
    // parked there holds no resource lane, no checkpoint lane and no
    // single-flight entry, so the heartbeat's own busy check cannot see it.
    //
    // What the refusal then did was arm a startup one second out and file an
    // attach incident. Both outlive the deliberate stop: `quiesce` arms NOTHING
    // on purpose, so the armed row wakes a box that was put to sleep and starts
    // its container again, and the incident reaches the agent as a live blocker
    // about a container nobody asked to exist.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    await container.stop();
    const admitting = gate();
    container.containerStartGate = admitting;
    // Refused WITHOUT an instance, which is what a capacity refusal is: the
    // container never comes up, so the class's own start hook never runs and the
    // only thing that could arm a row here is the refusal itself.
    container.startFaultBeforeRunning = failure('CONTAINER_UNAVAILABLE');
    const stale = box.devboxStartup();
    await admitting.reached;

    // The box is deliberately quiesced while that probe is parked: the
    // generation turns over, the container stops, and nothing is armed.
    await box.quiesce();
    const armedByQuiesce = armed(container);

    admitting.release();
    await stale;

    expect(armed(container)).toBe(armedByQuiesce);
    expect(incidents(rows)).toEqual([]);
    // And the box is still asleep: nothing woke it to serve an attempt whose
    // generation is gone.
    expect(container.running.running).toBe(false);
  });
});

// ── readiness is attach plus complete restoration ───────────────────────────

describe('a failed restored service is never exposed and never reported ready', () => {
  test('an answering listener is exposed with its persisted token, and the box is ready', async () => {
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    proc(rows, 'p1');
    port(rows, 3000, 'tok3000');
    container.listening.add(3000);
    await box.devboxStartup();
    expect(container.starts)
      .toEqual([{ command: 'bun run server.ts', cwd: '/workspace', processId: 'p1' }]);
    expect(container.exposures).toEqual([{ port: 3000, token: 'tok3000', name: 'web' }]);
    const state = await box.devboxState();
    expect({ ready: state.ready, unready: state.unready })
      .toEqual({ ready: true, unready: undefined });
  });

  test('a silent listener is NOT exposed, and the box says why it is not ready', async () => {
    // KINU-029. The probe found nothing, the incident was filed, and the walk
    // continued into exposing that very port — so the box handed back a preview
    // URL that answers 502 and called itself ready.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    port(rows, 3000, 'tok3000');
    await box.devboxStartup();
    expect(container.exposures).toEqual([]);
    const state = await box.devboxState();
    expect(state.ready).toBe(false);
    expect(state.unready).toBe('port 3000 never answered');
    expect(incidents(rows).map(row => row.stage)).toEqual(['port']);
  });

  test('a process that did not restart stops EVERY exposure, not just its own port', async () => {
    // Nothing here maps a process to a port, so a box whose server did not come
    // back cannot know which URLs are dead. It publishes none of them.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    proc(rows, 'p1');
    port(rows, 3000, 'tok3000');
    port(rows, 8080, 'tok8080');
    container.listening.add(3000).add(8080);
    container.startFaults.push(refused('COMMAND_NOT_FOUND'));
    await box.devboxStartup();
    expect(container.exposures).toEqual([]);
    const state = await box.devboxState();
    expect(state.ready).toBe(false);
    expect(state.unready).toBe('process p1 did not restart; no port was exposed');
  });

  test('every failed spec reaches the ledger, so one dead spec does not hide the others', async () => {
    // The phase still runs to its end. Stopping at the first failure would file
    // one incident for a box with two broken servers, and the second would be
    // discovered only after the first was fixed.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    proc(rows, 'p1');
    proc(rows, 'p2', 'python3 app.py');
    container.startFaults.push(refused('COMMAND_NOT_FOUND'), refused('PROCESS_ERROR'));
    await box.devboxStartup();
    expect(incidents(rows).map(row => row.stage)).toEqual(['process', 'process']);
    expect((await box.devboxState()).unready)
      .toBe('process p1 did not restart; process p2 did not restart; no port was exposed');
  });

  test('operations stay permitted while a restored service is down, so it can be repaired', async () => {
    // The attach landed, so the work directory is there. Refusing `exec` would
    // deny the agent the one way it has to fix its own server — and `ready`
    // already tells the truth.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    proc(rows, 'p1');
    container.startFaults.push(refused('PROCESS_ERROR'));
    await box.devboxStartup();
    expect((await box.devboxState()).ready).toBe(false);
    const result = await box.exec('ls');
    expect(result.exitCode).toBe(0);
  });

  test('an attach that never landed refuses operations, with the reason', async () => {
    const harnessed = harness(TestBox);
    const { box } = harnessed;
    failAttempt(harnessed, 'MISSING_CREDENTIALS');
    await expect(box.devboxStartup()).rejects.toThrow('MISSING_CREDENTIALS');
    await expect(box.exec('ls')).rejects.toThrow('no attached work directory');
    await expect(box.exec('ls')).rejects.toThrow('permanent → refuse');
  });

  test('a stop on a box whose attach was refused stops the container with nothing to commit', async () => {
    // The deployed merkle-pack release of run 20260905075659: the attach was
    // abandoned at its budget and classified terminal, and the stop's final
    // checkpoint then waited on the container the abandoned restore was still
    // running in, past the driver's 120 s release deadline. A box that
    // admitted no caller holds no work to commit, so the stop skips straight
    // to the container.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'MISSING_CREDENTIALS');
    await expect(box.devboxStartup()).rejects.toThrow('MISSING_CREDENTIALS');
    const stopsBefore = container.stops;

    const outcome = await box.quiesce();

    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toContain('nothing is attached to commit');
    expect(outcome.reason).toContain('permanent → refuse');
    expect(container.stops).toBe(stopsBefore + 1);
    expect(container.running.running).toBe(false);
  });
});

// ── the recovery ladder ─────────────────────────────────────────────────────

describe('one container identity is retried, then replaced, then refused', () => {
  /** A ladder row left by an earlier attempt: a foreign owner, and how far the
   *  ladder had gone. Every attempt claims the row and preserves that stage. */
  const seeded = (stage?: RecoveryStage): StoredValue =>
    (stage === undefined ? { owner: PREVIOUS } : { owner: PREVIOUS, stage });

  test('an attempt CLAIMS the row, taking ownership and preserving the stage', async () => {
    // The reset case, and the reason the owner is durable: a container start, an
    // eviction and a replacement all mint a new attempt, and none of them may
    // forget how far the ladder has gone. The in-memory generation cannot carry
    // this — a rebuilt object starts counting at zero again.
    for (const stage of [undefined, 'retry', 'replace'] as const) {
      const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
      rows.set(RECOVERY_KEY, seeded(stage));
      const parked = gate();
      container.stampGate = parked;
      const attempt = box.devboxStartup();
      await parked.reached;
      const claimed = ladder(rows);
      expect(claimed?.stage).toBe(stage);
      expect(claimed?.owner).not.toBe(PREVIOUS);
      expect(claimed?.owner).toBeString();
      parked.release();
      await attempt;
      // The attempt landed, so the claim goes with it.
      expect(rows.has(RECOVERY_KEY)).toBe(false);
    }
  });

  test('a transport transient retries the same identity and records the stage', async () => {
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
    expect(ladder(rows)?.stage).toBe('retry');
    expect(armed(container)).toBe(1);
    expect(container.destroys).toBe(0);
  });

  test('the SECOND failure of that identity destroys it, and proves it gone', async () => {
    // KINU-032. Re-arming the same identity forever is how a persistently
    // unhealthy container kept a box trapped. The bound is the ladder's length,
    // not a tuned count: each stage is a DIFFERENT action.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
    expect(container.destroys).toBe(1);
    // The stage is persisted BEFORE the destruction, so a failure that strikes
    // while `replace` is current is terminal instead of the second turn of a
    // destroy loop.
    expect(ladder(rows)?.stage).toBe('replace');
    // Proved absent rather than assumed: `destroy` acknowledges the signal
    // before `container.running` flips.
    expect(container.running.running).toBe(false);
    // And nothing was armed against an identity that no longer exists.
    expect(armed(container)).toBe(0);
  });

  test('a failure while REPLACE is stored refuses, KEEPS the stage, and destroys nothing',
    async () => {
      // Keeping the stage is the half that survives an eviction: a ladder that
      // reset itself would destroy one identity after another.
      const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
      rows.set(RECOVERY_KEY, seeded('replace'));
      failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
      await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
      expect(container.destroys).toBe(0);
      expect(armed(container)).toBe(0);
      expect(ladder(rows)?.stage).toBe('replace');
      await expect(box.exec('ls')).rejects.toThrow('transient → refuse');
    });

  test('storage exhaustion refuses at once: it repeats no work and moves no ladder', async () => {
    // KINU-028. Under one generic policy this spent the retry budget copying a
    // base into a filesystem that was already full.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    failAttempt(harnessed, 'NO_SPACE');
    await expect(box.devboxStartup()).rejects.toThrow('NO_SPACE');
    expect({ armed: armed(container), destroys: container.destroys })
      .toEqual({ armed: 0, destroys: 0 });
    expect(ladder(rows)?.stage).toBeUndefined();
    await expect(box.exec('ls')).rejects.toThrow('exhausted → refuse');
  });

  test('permanent configuration refuses at once, without spending the ladder', async () => {
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    failAttempt(harnessed, 'INVALID_MOUNT_CONFIG');
    await expect(box.devboxStartup()).rejects.toThrow('INVALID_MOUNT_CONFIG');
    expect({ armed: armed(container), destroys: container.destroys })
      .toEqual({ armed: 0, destroys: 0 });
    expect(ladder(rows)?.stage).toBe('retry');
  });

  test('a reset does not advance the container-fault ladder', async () => {
    // The identity it failed on is already gone, so it is no evidence against
    // the one that replaced it. Under a single policy this counted towards
    // destroying a container that had done nothing wrong.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    failAttempt(harnessed, 'OPERATION_INTERRUPTED');
    await expect(box.devboxStartup()).rejects.toThrow('OPERATION_INTERRUPTED');
    expect(container.destroys).toBe(0);
    expect(ladder(rows)?.stage).toBe('retry');
    expect(armed(container)).toBe(1);
  });

  test('an unreadable row refuses the attempt BEFORE it attaches, and normalises itself',
    async () => {
      // Strict schema: there is no evidence to act on, so nothing attaches and
      // nothing is destroyed. The refusal is finite because the row is left
      // readable at its terminal stage instead of unreadable for ever.
      const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
      rows.set(RECOVERY_KEY, { owner: 'x', stage: 'destroy-everything' });
      await expect(box.devboxStartup()).rejects.toThrow('did not parse');
      expect({ armed: armed(container), destroys: container.destroys })
        .toEqual({ armed: 0, destroys: 0 });
      expect(ladder(rows)?.stage).toBe('replace');
      // Nothing was attached, and the attach was never even attempted.
      expect(container.execs.filter(command => command.includes(STAMP_COMMAND))).toEqual([]);
      expect(rows.has('devbox:last-attach')).toBe(false);
      await expect(box.exec('ls')).rejects.toThrow('unreadable → refuse');
    });

  test('an attach that lands deletes the row, so the next failure starts fresh', async () => {
    const harnessed = harness(TestBox);
    const { box, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    await box.devboxStartup();
    expect(rows.has(RECOVERY_KEY)).toBe(false);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a stage write that raced a newer success changes ZERO rows and stays inert', async () => {
    // THE RACE THE OWNER TOKEN EXISTS FOR, and the in-memory generation cannot
    // close it: an evicted and rebuilt object counts from zero again, so two
    // attempts can hold the same number while only one still matters.
    //
    // The older attempt is parked INSIDE its conditional write, between reading
    // the row and writing its stage. A newer attempt then attaches successfully
    // and deletes the row. When the older one resumes it must find the row gone,
    // write nothing, and act on nothing — otherwise it resurrects a ladder the
    // success had cleared and arms the replacement of a container that works.
    const harnessed = harness(TestBox);
    const { box, container, rows, storage } = harnessed;
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    // Park at the CLAIM's read first, then arm the second gate while the attempt
    // cannot advance, so it can only catch the conditional write's read.
    // Guessing that with a microtask count would be a race pretending to be a
    // test.
    const claiming = gate();
    storage.gateOn(RECOVERY_KEY, claiming);
    const stale = box.devboxStartup();
    await claiming.reached;
    const settling = gate();
    storage.gateOn(RECOVERY_KEY, settling);
    claiming.release();
    await settling.reached;

    await container.stop();
    await box.devboxStartup();
    expect((await box.devboxState()).ready).toBe(true);
    expect(rows.has(RECOVERY_KEY)).toBe(false);
    const armsAfterSuccess = armed(container);

    settling.release();
    await expect(stale).rejects.toThrow('RPC_TRANSPORT_ERROR');

    // Zero rows changed: no stage came back.
    expect(rows.has(RECOVERY_KEY)).toBe(false);
    // And nothing downstream of the write ran either.
    expect(armed(container)).toBe(armsAfterSuccess);
    expect(container.destroys).toBe(0);
    expect(incidents(rows)).toEqual([]);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a destruction that did not land keeps refusing, and attaches over nothing', async () => {
    // The abandoned work is still inside that container. Looking ready for a
    // fresh start here is exactly the overlap the replacement exists to prevent.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    container.destroyFault = new Error('the container did not answer the signal');
    await expect(box.devboxStartup()).rejects.toThrow('did not answer the signal');
    expect(container.running.running).toBe(true);
    await expect(box.exec('ls')).rejects.toThrow('could not be destroyed');
    expect(container.containerStarts).toBe(0);
  });

  test('a destroyed identity is replaced by the next operation, not left refusing', async () => {
    // The whole point of replacing an identity is that something attaches
    // again. The readiness gate starts the fresh container, whose own start
    // hook opens the next generation and clears the refusal.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
    expect(container.running.running).toBe(false);
    // A caller arrives. `ensureReady` starts a container, whose own start hook
    // turns the generation over, and this attach lands.
    await box.ensureReady();
    expect(container.containerStarts).toBe(1);
    expect((await box.devboxState()).ready).toBe(true);
    // The success is what clears the ladder.
    expect(rows.has(RECOVERY_KEY)).toBe(false);
  });

  test('attachNow is the explicit repair for a terminal refusal, and destroys nothing',
    async () => {
      // A terminal refusal keeps its `replace` stage on purpose, so no eviction
      // can restart a destructive ladder. That leaves one question: how does the
      // box ever come back? By a caller asking for the attach by name. It
      // re-attempts, it does not destroy, and a success clears the row.
      const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
      rows.set(RECOVERY_KEY, seeded('replace'));
      failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
      await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
      await expect(box.exec('ls')).rejects.toThrow('no attached work directory');

      // Repair attempt one still fails: refused again, and STILL no destruction.
      failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
      await expect(box.attachNow()).rejects.toThrow('RPC_TRANSPORT_ERROR');
      expect(container.destroys).toBe(0);
      expect(ladder(rows)?.stage).toBe('replace');

      // Repair attempt two lands, and the box is back.
      const outcome = await box.attachNow();
      expect(outcome.kind).toBe('empty');
      expect(container.destroys).toBe(0);
      expect(rows.has(RECOVERY_KEY)).toBe(false);
      expect((await box.devboxState()).ready).toBe(true);
      const result = await box.exec('ls');
      expect(result.exitCode).toBe(0);
    });
});

// ── the retry the ladder promised ───────────────────────────────────────────

describe('a promised retry is delivered even when the row carrying it is gone', () => {
  /** The one command a landed attach ends on, so a test can say whether an
   *  attach was attempted at all rather than only what state it left. */
  const stamps = (container: FakeSandbox): number =>
    container.execs.filter(command => command.includes(STAMP_COMMAND)).length;

  /** The isolate reset that made this defect permanent: the ladder decided
   *  `retry` and its arming write never landed, so the box holds a promise with
   *  nothing keeping it. The fake's rows ARE the schedule, so dropping them is
   *  the same world the reset leaves behind. */
  const loseTheArmedRow = (container: FakeSandbox): void => {
    container.scheduleRows.length = 0;
  };

  test('the next operation drives the attach when no row is left to deliver it', async () => {
    // The deployed shape: `overlay-cas` failed its attach with
    // OPERATION_INTERRUPTED, the taxonomy answered `stale-owner → retry`, and
    // the ONE schedule row that answer armed was the only thing that could
    // re-drive it — `ensureReady` refused every operation on `unattached` and
    // `kickStartup` no-opped on any phase but `unstarted`. Lose that write and
    // /create, /wake and every operation are inert for ever.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    failAttempt(harnessed, 'OPERATION_INTERRUPTED');
    await expect(box.devboxStartup()).rejects.toThrow('OPERATION_INTERRUPTED');
    expect({ armed: armed(container), destroys: container.destroys, stamps: stamps(container) })
      .toEqual({ armed: 1, destroys: 0, stamps: 0 });

    loseTheArmedRow(container);

    const result = await box.exec('ls');

    expect({ exitCode: result.exitCode, stamps: stamps(container) })
      .toEqual({ exitCode: 0, stamps: 1 });
    expect((await box.devboxState()).restoration).toBe('attached');
    // The attach that landed is what clears the ladder row.
    expect(rows.has(RECOVERY_KEY)).toBe(false);
  });

  test('a retry that IS scheduled refuses the caller and attaches nothing', async () => {
    // The rate limit is the schedule, not a counter: while a row is pending,
    // one broken box answers every caller from the same decision instead of
    // filing an incident per call.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'OPERATION_INTERRUPTED');
    await expect(box.devboxStartup()).rejects.toThrow('OPERATION_INTERRUPTED');

    await expect(box.exec('ls')).rejects.toThrow('A retry is already under way');
    await expect(box.exec('ls')).rejects.toThrow('stale-owner → retry');
    expect({ armed: armed(container), stamps: stamps(container) }).toEqual({ armed: 1, stamps: 0 });
  });

  test('a terminal class is never re-driven, and its refusal names the repair', async () => {
    // The complement, and the reason this is a promise rather than a retry
    // loop: exhaustion armed nothing, so there is no row in the way — and the
    // box must still refuse instead of repeating work the ladder refused.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'NO_SPACE');
    await expect(box.devboxStartup()).rejects.toThrow('NO_SPACE');
    expect(armed(container)).toBe(0);

    await expect(box.exec('ls')).rejects.toThrow('exhausted → refuse');
    await expect(box.exec('ls')).rejects.toThrow('terminal: call attachNow()');
    expect(stamps(container)).toBe(0);
  });

  test('an idle box with no caller gets its lost retry armed by the state poll', async () => {
    // `devboxState` is the only thing that touches an idle box, and it kicks
    // the startup row. A retryable unattach is pending work, so the kick arms
    // it; a terminal one is left alone.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'OPERATION_INTERRUPTED');
    await expect(box.devboxStartup()).rejects.toThrow('OPERATION_INTERRUPTED');
    loseTheArmedRow(container);

    await box.devboxState();

    expect(container.scheduleRows.filter(row => row.callback === 'devboxStartup')).toHaveLength(1);
    // And the arm is idempotent: a second poll finds the row it just wrote.
    await box.devboxState();
    expect(container.scheduleRows.filter(row => row.callback === 'devboxStartup')).toHaveLength(1);
  });

  test('a terminal unattach is not woken by the state poll', async () => {
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'MISSING_CREDENTIALS');
    await expect(box.devboxStartup()).rejects.toThrow('MISSING_CREDENTIALS');
    loseTheArmedRow(container);

    await box.devboxState();

    expect(container.scheduleRows.filter(row => row.callback === 'devboxStartup')).toEqual([]);
  });
});

// ── one budget for the whole restoration ────────────────────────────────────

describe('one budget, two policies: the attach may replace, the phases after it may not', () => {
  test('silent ports share the remaining budget instead of one window each', async () => {
    // KINU-N014. Each port used to get its own thirty-second window, so three
    // silent ports added about ninety seconds while every caller sat in the
    // readiness gate. WITHOUT THE ALLOWANCE THIS TEST CANNOT PASS: three
    // thirty-second windows outlast the runner's timeout many times over.
    const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
    for (const value of [3000, 8080, 9000]) port(rows, value, `tok${String(value)}`);
    await box.devboxStartup();
    // ATTACHED, AND HONEST ABOUT NOT BEING READY. No port answered, so none was
    // exposed; the container is untouched because a slow app is no reason to
    // destroy a working box.
    expect(container.exposures).toEqual([]);
    expect(container.destroys).toBe(0);
    expect(container.running.running).toBe(true);
    const state = await box.devboxState();
    expect(state.ready).toBe(false);
    expect(state.unready).toContain('port 3000');
    // The specs all survive, so the ports can be proved again later.
    expect(state.ports.map(spec => spec.port)).toEqual([3000, 8080, 9000]);
  });

  test('ONE SLOW SERVER costs readiness and nothing else, and the next explicit try succeeds',
    async () => {
      // The regression this split exists for. Under one throwing deadline a
      // process that outran the budget abandoned the restoration, which the
      // taxonomy read as unfenceable work and answered by destroying a container
      // that was working perfectly. A slow `npm run dev` must never cost the box
      // its identity.
      const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
      proc(rows, 'p1');
      port(rows, 3000, 'tok3000');
      const slow = gate();
      container.startGate = slow;
      const attempt = box.devboxStartup();
      await slow.reached;
      // The allowance expires while the start is still parked.
      await attempt;

      expect(container.destroys).toBe(0);
      expect(container.running.running).toBe(true);
      expect(container.exposures).toEqual([]);
      const stalled = await box.devboxState();
      expect(stalled.ready).toBe(false);
      expect(stalled.unready).toContain('process p1');
      // The ladder is untouched: this is not an attach failure.
      expect(rows.has(RECOVERY_KEY)).toBe(false);
      expect(armed(container)).toBe(0);
      // Operations still work, which is the point of leaving the box attached.
      expect((await box.exec('ls')).exitCode).toBe(0);

      // THE EXPLICIT RETRY. The server has come up in the meantime, so the
      // repair finds it and the box goes ready. Nothing was destroyed and no
      // timer did this: a caller asked.
      slow.release();
      container.listening.add(3000);
      const outcome = await box.attachNow();
      expect(outcome.kind).toBe('empty');
      expect(container.destroys).toBe(0);
      const repaired = await box.devboxState();
      expect({ ready: repaired.ready, unready: repaired.unready })
        .toEqual({ ready: true, unready: undefined });
      expect(container.exposures).toEqual([{ port: 3000, token: 'tok3000', name: 'web' }]);
    });

  test('a process the container already holds is not started twice by the retry', async () => {
    // What makes the explicit retry safe: the walk asks the container before it
    // starts anything, so one spec cannot become two servers fighting over one
    // port.
    const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
    proc(rows, 'p1');
    await box.devboxStartup();
    expect(container.starts).toHaveLength(1);
    await box.attachNow();
    expect(container.starts).toHaveLength(1);
    expect(container.processes.size).toBe(1);
  });

  test('an exposure that outruns its allowance is reported, not exposed and not replaced',
    async () => {
      const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
      port(rows, 3000, 'tok3000');
      container.listening.add(3000);
      const slow = gate();
      container.exposeGate = slow;
      const attempt = box.devboxStartup();
      await slow.reached;
      await attempt;
      expect(container.destroys).toBe(0);
      const state = await box.devboxState();
      expect(state.ready).toBe(false);
      expect(state.unready).toContain('port 3000');
      expect(incidents(rows).map(row => row.stage)).toEqual(['port']);
      slow.release();
    });

  test('a boot stamp that outruns its allowance leaves the box attached and unready',
    async () => {
      // The last phase, and the one that used to sit furthest outside any bound.
      // It is a step like the others now: reported, never replaced.
      const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
      const slow = gate();
      container.stampGate = slow;
      const attempt = box.devboxStartup();
      await slow.reached;
      await attempt;
      expect(container.destroys).toBe(0);
      const state = await box.devboxState();
      expect(state.ready).toBe(false);
      expect(state.unready).toBe('the boot id stamp is still pending');
      expect(rows.has(RECOVERY_KEY)).toBe(false);
      slow.release();
    });

  test('a STALLED ATTACH still replaces the identity, because that work is unfenceable',
    async () => {
      // The other half of the split, and it must not regress: an attach
      // abandoned mid-mount leaves work a retry would collide with, so the
      // identity goes. `r2fs.test.ts` drives the real strategy attach; this pins
      // the class-level consequence through the ladder.
      const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
      rows.set(RECOVERY_KEY, { owner: PREVIOUS, stage: 'retry' });
      failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
      await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
      expect(container.destroys).toBe(1);
      expect(container.running.running).toBe(false);
      expect(ladder(rows)?.stage).toBe('replace');
    });
});

describe('the heartbeat does not quiesce active caller work', () => {
  test('a long exec crossing both idle windows keeps running, then quiesces after it settles', async () => {
    let now = Date.parse('2026-08-28T00:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { box, container } = harness(HeartbeatBox);
      await box.exec('true');

      const running = gate();
      container.execGate = running;
      const command = box.exec('long-running-command');
      await running.reached;
      now += 3;
      await box.devboxHeartbeat();
      now += 3;
      await box.devboxHeartbeat();
      expect({ running: container.running.running, stops: container.stops }).toEqual({
        running: true,
        stops: 0,
      });

      running.release();
      await command;

      // The heartbeat that observes the settled command starts a fresh quiet
      now += 3;
      await box.devboxHeartbeat();
      expect(container.stops).toBe(0);
      now += 3;
      await box.devboxHeartbeat();
      expect({ running: container.running.running, stops: container.stops }).toEqual({
        running: false,
        stops: 1,
      });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('the fakes can fail, so the assertions above are not vacuous', () => {
  let fixture: Harness<TestBox>;
  beforeEach(() => { fixture = harness(TestBox); });

  test('a faulted durable write really rejects the attempt', async () => {
    failAttempt(fixture, 'UNKNOWN_ERROR');
    await expect(fixture.box.devboxStartup()).rejects.toThrow('UNKNOWN_ERROR');
  });

  test('a faulted container step really leaves the box attached and unready', async () => {
    // The other half of the split, proved on the fake: a container fault after
    // the attach must NOT reject the attempt.
    fixture.container.stampFaults.push(new Error('the stamp refused'));
    await fixture.box.devboxStartup();
    const state = await fixture.box.devboxState();
    expect({ ready: state.ready, unready: state.unready })
      .toEqual({ ready: false, unready: 'the boot id stamp failed' });
    expect(fixture.container.destroys).toBe(0);
  });

  test('a terminal boot stamp failure is retried by the explicit attached repair', async () => {
    fixture.container.stampFaults.push(new Error('the stamp refused'));
    await fixture.box.devboxStartup();
    expect((await fixture.box.devboxState()).unready).toBe('the boot id stamp failed');

    await fixture.box.attachNow();
    expect((await fixture.box.devboxState()).ready).toBe(true);
  });

  test('a listening port really answers the shipped probe', async () => {
    port(fixture.rows, 7000, 'tok7000');
    fixture.container.listening.add(7000);
    await fixture.box.devboxStartup();
    expect(fixture.container.exposures).toHaveLength(1);
  });

  test('the durable owner check really refuses a write, so the fence is not vacuous', async () => {
    // Proof that the conditional write is load-bearing rather than decorative:
    // the row is taken over by another owner while the attempt is parked, and
    // the attempt's stage write must then change nothing at all. Without the
    // comparison this write lands and the assertion below fails.
    failAttempt(fixture, 'RPC_TRANSPORT_ERROR');
    const claiming = gate();
    fixture.storage.gateOn(RECOVERY_KEY, claiming);
    const attempt = fixture.box.devboxStartup();
    await claiming.reached;
    const settling = gate();
    fixture.storage.gateOn(RECOVERY_KEY, settling);
    claiming.release();
    await settling.reached;
    // Another owner takes the row while this attempt is inside its conditional
    // write. Without the comparison the write lands and the assertion fails.
    fixture.rows.set(RECOVERY_KEY, { owner: 'another-attempt' });
    // What the superseded attempt is measured against: whatever the container
    // start had already armed. An inert attempt may not ADD to it.
    const armedBeforeSettling = armed(fixture.container);
    settling.release();
    await expect(attempt).rejects.toThrow('RPC_TRANSPORT_ERROR');
    expect(fixture.rows.get(RECOVERY_KEY)).toEqual({ owner: 'another-attempt' });
    expect(armed(fixture.container)).toBe(armedBeforeSettling);
    expect(incidents(fixture.rows)).toEqual([]);
  });

  test('a gated call really parks until it is released', async () => {
    const parked = gate();
    fixture.container.stampGate = parked;
    const attempt = fixture.box.devboxStartup();
    let settled = false;
    const settledAttempt = attempt.then(() => { settled = true; });
    await parked.reached;
    expect(settled).toBe(false);
    parked.release();
    await settledAttempt;
    expect(settled).toBe(true);
  });
});
