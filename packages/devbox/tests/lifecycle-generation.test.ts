// Lifecycle ownership, readiness and the recovery ladder, driven through the real `Devbox`
// against `support/devbox-harness.ts`; the pure halves are pinned in `decisions.test.ts`.
import { beforeEach, describe, expect, test, vi } from 'bun:test';

import * as v from 'valibot';

import {
  DEFAULT_DEVBOX_POLICY, parseRecoveryRow, type DevboxPolicy, type RecoveryRow,
  type RecoveryStage, type StartClock,
} from '../src/lifecycle';
import type { StoredValue } from '../src/storage';
import { handClock } from '../../test-utils/src/hand-clock';
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

/** A start that throws having created nothing, as when a container refuses a command. */
const refused = (code: string): StartFault => ({ error: failure(code), created: false });

/** Only the port-probe windows are shortened so a silent listener fails fast;
 *  every other number is the shipped policy. */
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

/** The port cap far exceeds the attach budget: a test that waited the full cap would outlast
 *  the runner's timeout, which is what the clamp must prevent. */
const TIGHT_POLICY: DevboxPolicy = {
  ...DEFAULT_DEVBOX_POLICY,
  attachBudgetMs: 20,
  portWaitMs: 30_000,
  portProbeIntervalMs: 1,
};


class TightBox extends Devbox<unknown> {
  /** The budget's clock, advanced by the test: a 20 ms budget is a fact of
   *  arithmetic here, not a race against the machine. */
  readonly clock = handClock(1_000_000);

  protected override get policy(): DevboxPolicy {
    return TIGHT_POLICY;
  }

  protected override get startClock(): StartClock {
    return this.clock;
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



/** Parsed, not cast: a filed row missing a stage or reason is a defect to fail on. */
const FiledIncidentSchema = v.object({ stage: v.string(), reason: v.string() });

type FiledIncident = v.InferOutput<typeof FiledIncidentSchema>;

function incidents(rows: Map<string, StoredValue>): readonly FiledIncident[] {
  return [...rows]
    .filter(([key]) => key.startsWith(INCIDENT_PREFIX))
    .map(([, row]) => v.parse(FiledIncidentSchema, row));
}

/** Counts the live schedule table, not arm calls: the start hook arms a row on every admission
 *  probe, so what matters is whether one survives (`#recover` deletes it; a retry leaves one). */
const armed = (container: FakeSandbox): number =>
  container.scheduleRows.filter(row => row.callback === 'devboxStartup').length;

function ladder(rows: Map<string, StoredValue>): RecoveryRow | undefined {
  // Parse with the production parser, not a cast: a looser read could assert a stage
  // the box would have refused.
  const held = parseRecoveryRow(rows.get(RECOVERY_KEY));

  return held.kind === 'row' ? held.row : undefined;
}

/** Faults the attempt's first durable write: ephemeral `attach()` cannot fail, and container
 *  faults after attach yield an incomplete restoration, not an attach failure. */
function failAttempt(harnessed: { readonly storage: FakeStorage }, code: string): void {
  harnessed.storage.faultOn('devbox:last-attach', failure(code));
}

function proc(
  rows: Map<string, StoredValue>, processId: string, command = 'bun run server.ts',
): void {
  rows.set(`devbox:proc:${processId}`, { processId, command, cwd: '/workspace', createdAt: 1 });
}

function port(rows: Map<string, StoredValue>, value: number, token: string): void {
  rows.set(`devbox:port:${value}`, { port: value, name: 'web', token, createdAt: 1 });
}

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

    const state = await box.devboxState();
    expect({
      starts: container.containerStarts,
      // The start hook arms a row for an unrestored box; the settling attempt retires it, since
      // a row firing on an attached box costs an unrequested wake, port probe and boot-id read.
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
        reason: expect.stringContaining('[transient -> retry]'),
      }),
    ]);
    expect((await box.devboxState()).restoration).toBe('unstarted');
  });


  test('a dark box admits through the instance probe and restores', async () => {
    // Dark means no listener, no specs, nothing exposed: the instance probe asks the platform.
    // A fresh box that cannot admit and restore this way can never bootstrap.
    const { box, container } = harness(TestBox);
    await container.stop();

    await box.devboxStartup();

    expect(container.execs.some((command) => command.includes(STAMP_COMMAND))).toBe(true);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('an unhealthy answer AFTER the container ran is a transient refusal the next drive heals', async () => {
    // `startFaultAfterRunning` fires after the platform has an instance: the container is up,
    // but this attempt cannot know it because its admission probe threw.
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
        reason: expect.stringContaining('[transient -> retry]'),
      }),
    ]);
    expect(armed(container)).toBe(1);

    // Runs on the row the refusal armed; the fault is one-shot like a transient one,
    // so the same identity attaches.
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
    }).toEqual({ starts: 2, stamps: 2, ready: true });
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

describe('a startup attempt owns a generation, and a superseded one is inert', () => {
  const stamps = (container: FakeSandbox): number =>
    container.execs.filter(command => command.includes(STAMP_COMMAND)).length;

  test('a superseded attempt cannot publish readiness for a generation that is gone', async () => {
    // The boot-id stamp is the attempt's last await, so parking there and replacing the
    // container tests the latest point a superseded attempt could still publish readiness.
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
    // The fence is checked as soon as the claim returns: an attempt whose generation turned over
    // while claiming must not attach against a container that is gone.
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
    // Parked inside the conditional write: the row still names this attempt, so only the
    // generation token, not the durable owner, refuses the stale recovery write.
    const harnessed = harness(TestBox);
    const { box, container, rows, storage } = harnessed;
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    // Two gates on `RECOVERY_KEY`, in read order: the claim, then the recovery's conditional write.
    // Parking the claim arms the second gate before the attempt reaches it, without microtask guessing.
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
    await stale; // The hook recorded no stale failure; the successor owns admission.
    expect(incidents(rows)).toEqual([]);
    expect(armed(container)).toBe(armsBefore);
    expect(ladder(rows)).toBeUndefined();
    expect(container.destroys).toBe(0);
    expect((await box.devboxState()).unready).toBeUndefined();
  });

  test('a superseded attempt does not release its successor\'s single-flight entry', async () => {
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
    expect(stamps(container)).toBe(2);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a caller does not JOIN a superseded attempt, it starts the new generation\'s', async () => {
    // Joining an attempt whose result is already discarded would hand the caller
    // a restoration that never happened.
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
    // The fence is checked before exposing a port too: a port exposed by a superseded attempt
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
    expect(await box.getExposedPorts('preview.test')).toEqual([{ port: 3000, url: 'https://3000-devbox-under-test-tok3000.preview.test', name: 'web' }]);
  });

  test('quiesce drains a pending admission before leaving the container stopped', async () => {
    const { box, container } = harness(TestBox);
    await container.stop();
    const admitting = gate();
    container.containerStartGate = admitting;
    // A capacity refusal fails before running: the start hook never runs, so only the
    // refusal itself could arm a row here.
    container.startFaultBeforeRunning = failure('CONTAINER_UNAVAILABLE');
    const stale = box.devboxStartup();
    await admitting.reached;

    const stopping = box.quiesce();
    expect((await box.resolveReadiness()).kind).toBe('pending');
    admitting.release();
    await stale;
    expect((await stopping).kind).toBe('skipped');
    expect(container.scheduleRows.map(row => row.callback)).not.toContain('devboxStartup');
    expect(container.running.running).toBe(false);
  });
});

// Staging, 2026-09-27 and 09-28: a first-run workspace was torn down (`discardState`, then
// `destroy`) while its box's own startup still waited on the platform. The container the platform
// granted about 20 s later was restored and watched, and ran with no workspace for hours.
describe('a destroyed box starts nothing of its own until it is asked again', () => {
  const stamps = (container: FakeSandbox): number =>
    container.execs.filter(command => command.includes(STAMP_COMMAND)).length;

  test('a start in flight when the box is torn down leaves no container and nothing armed', async () => {
    const { box, container } = harness(TestBox);
    const granted = gate();
    container.containerStartGate = granted;
    const startup = box.devboxStartup();
    await granted.reached;

    // The product's teardown; the platform grants the container once the destroy is under way.
    await box.discardState();
    const destroying = box.destroy();
    granted.release();
    await Promise.all([startup, destroying]);

    expect({ running: container.running.running, rows: container.scheduleRows.map(row => row.callback), stamps: stamps(container) })
      .toEqual({ running: false, rows: [], stamps: 0 });
  });

  test('a beat past its running check when the box is torn down leaves nothing running', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    const reading = gate();
    container.stateReadGate = reading;
    // The beat saw the container running and issued its first command. The SDK is still reading
    // its own state when the teardown lands, and then finds the container gone.
    const beat = box.devboxHeartbeat();
    await reading.reached;
    await box.discardState();
    await box.destroy();
    reading.release();
    await beat;

    expect({ running: container.running.running, rows: container.scheduleRows.map(row => row.callback) })
      .toEqual({ running: false, rows: [] });
  });

  // Review, 2026-09-28: a start already past the refusal ran on after the destroy, which had not
  // waited for it, so the container it launched stayed up with nothing watching it.
  test('a start past the refusal when the box is torn down leaves nothing running once destroy returns', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    await container.stop();
    const granted = gate();
    container.containerStartGate = granted;
    const starting = box.start();
    await granted.reached;
    const destroying = box.destroy();
    granted.release();
    await destroying;
    await Promise.allSettled([starting]);

    expect({ running: container.running.running, rows: container.scheduleRows.map(row => row.callback) })
      .toEqual({ running: false, rows: [] });
  });


  // Review, 2026-09-28: a file write queued on its path before the teardown got the path after it,
  // and its readiness check reopened the box and started a container.
  test('a request that waited for its lane through the teardown is refused, and starts nothing', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    const writing = gate();
    container.writeGate = writing;
    const first = box.writeFile('/workspace/notes.md', 'before the teardown');
    await writing.reached;
    const queued = box.writeFile('/workspace/notes.md', 'queued behind it');
    await box.discardState();
    await box.destroy();
    writing.release();
    await Promise.allSettled([first]);

    await expect(queued).rejects.toThrow('destroyed after this request arrived');
    expect({ running: container.running.running, rows: container.scheduleRows.map(row => row.callback) })
      .toEqual({ running: false, rows: [] });
  });

  test('a startup row the platform delivers after the teardown starts nothing', async () => {
    const { box, container } = harness(TestBox);
    container.startFaultBeforeRunning = failure('CONTAINER_UNAVAILABLE');
    await box.devboxStartup();
    expect(armed(container)).toBe(1);

    await box.discardState();
    await box.destroy();
    const starts = container.containerStarts;
    // The SDK's alarm pass reads every due row before it runs the first, so a row it read before
    // the teardown deleted it is still delivered.
    await box.devboxStartup();

    // Only the refusal's incident delivery is left: it never reaches a container.
    expect({ starts: container.containerStarts, running: container.running.running, rows: container.scheduleRows.map(row => row.callback) })
      .toEqual({ starts, running: false, rows: ['devboxIncidents'] });
  });

  // Review 3f6, 2026-09-30: a reopen waiting on a quiesce took no arrival, so a teardown that landed
  // while it waited did not fence it, and once the quiesce settled it reopened the torn-down box.
  const reopens = [
    ['start', (box: TestBox) => box.start()],
    ['kickStartup', (box: TestBox) => box.kickStartup()],
    ['attachNow', (box: TestBox) => box.attachNow()],
  ] as const;

  for (const [door, ask] of reopens) {
    test(`a ${door} queued behind a quiesce is refused when the box is torn down while it waits, and starts nothing`, async () => {
      const { box, container } = harness(TestBox);
      await box.devboxStartup();
      const held = gate();
      container.execGate = held;
      const admitted = box.exec('printf draining');
      await held.reached;
      const stopping = box.quiesce();
      const queued = ask(box);
      await box.destroy();
      const starts = container.containerStarts;
      held.release();
      await Promise.allSettled([admitted, stopping]);

      const [outcome] = await Promise.allSettled([queued]);

      expect({ outcome, starts: container.containerStarts, running: container.running.running, armed: armed(container) }).toEqual({
        outcome: { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('destroyed after this request arrived') }) },
        starts, running: false, armed: 0,
      });
    });
  }

  test('the next caller opens it again, and a host that asks for a start gets one', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    await box.discardState();
    await box.destroy();

    expect(await box.resolveReadiness()).toEqual({ kind: 'restored' });
    await box.destroy();
    await box.kickStartup();
    await box.devboxStartup();

    expect({ running: container.running.running, ready: (await box.devboxState()).ready })
      .toEqual({ running: true, ready: true });
  });
});

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
    expect(await box.getExposedPorts('preview.test')).toEqual([{ port: 3000, url: 'https://3000-devbox-under-test-tok3000.preview.test', name: 'web' }]);
    const state = await box.devboxState();
    expect({ ready: state.ready, unready: state.unready })
      .toEqual({ ready: true, unready: undefined });
  });

  test('a silent listener is NOT exposed, and the box says why it is not ready', async () => {
    const harnessed = harness(TestBox);
    const { box, rows } = harnessed;
    port(rows, 3000, 'tok3000');
    await box.devboxStartup();
    expect(await box.getExposedPorts('preview.test')).toEqual([]);
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
    expect(await box.getExposedPorts('preview.test')).toEqual([]);
    const state = await box.devboxState();
    expect(state.ready).toBe(false);
    expect(state.unready).toBe('process p1 did not restart; no port was exposed');
  });

  test('every failed spec reaches the ledger, so one dead spec does not hide the others', async () => {
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
    // A landed attach means the work directory exists; refusing `exec` would block the agent
    // from repairing its own server, and `ready` already reports the outage.
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
    await expect(box.exec('ls')).rejects.toMatchObject(
      { message: expect.stringContaining('no attached work directory') });
    await expect(box.exec('ls')).rejects.toMatchObject(
      { message: expect.stringContaining('permanent -> refuse') });
  });

  test('a stop on a box whose attach was refused stops the container with nothing to commit', async () => {
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'MISSING_CREDENTIALS');
    await expect(box.devboxStartup()).rejects.toThrow('MISSING_CREDENTIALS');
    const stopsBefore = container.stops;

    const outcome = await box.quiesce();

    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toContain('nothing is attached to commit');
    expect(outcome.reason).toContain('permanent -> refuse');
    expect(container.stops).toBe(stopsBefore + 1);
    expect(container.running.running).toBe(false);
  });
});

describe('one container identity is retried, then replaced, then refused', () => {
  const seeded = (stage?: RecoveryStage): StoredValue =>
    (stage === undefined ? { owner: PREVIOUS } : { owner: PREVIOUS, stage });

  test('an attempt CLAIMS the row, taking ownership and preserving the stage', async () => {
    // The ladder owner and stage are durable: a start, eviction or replacement mints a new attempt,
    // and in-memory generation restarts at zero on a rebuilt object.
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
    // The bound is the ladder's length, not a tuned count: each stage is a different action.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
    expect(container.destroys).toBe(0);
    await box.devboxStartup();
    expect(container.destroys).toBe(1);
    // The stage is persisted before the destruction, so a failure while `replace` is current
    // is terminal, not the second turn of a destroy loop.
    expect(ladder(rows)?.stage).toBe('replace');
    // Proved absent rather than assumed: `destroy` acknowledges the signal
    // before `container.running` flips.
    expect(container.running.running).toBe(false);
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
      await expect(box.exec('ls')).rejects.toMatchObject(
        { message: expect.stringContaining('transient -> refuse') });
    });

  test('storage exhaustion refuses at once: it repeats no work and moves no ladder', async () => {
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    failAttempt(harnessed, 'NO_SPACE');
    await expect(box.devboxStartup()).rejects.toThrow('NO_SPACE');
    expect({ armed: armed(container), destroys: container.destroys })
      .toEqual({ armed: 0, destroys: 0 });
    expect(ladder(rows)?.stage).toBeUndefined();
    await expect(box.exec('ls')).rejects.toMatchObject(
      { message: expect.stringContaining('exhausted -> refuse') });
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
    // The identity a reset failed on is already gone, so it is no evidence against its replacement.
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
      // The refusal is finite: the row is left readable at its terminal stage, not unreadable.
      const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
      rows.set(RECOVERY_KEY, { owner: 'x', stage: 'destroy-everything' });
      await expect(box.devboxStartup()).rejects.toThrow('did not parse');
      expect({ armed: armed(container), destroys: container.destroys })
        .toEqual({ armed: 0, destroys: 0 });
      expect(ladder(rows)?.stage).toBe('replace');
      expect(container.execs.filter(command => command.includes(STAMP_COMMAND))).toEqual([]);
      expect(rows.has('devbox:last-attach')).toBe(false);
      await expect(box.exec('ls')).rejects.toMatchObject(
        { message: expect.stringContaining('unreadable -> refuse') });
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
    // The owner token, not the in-memory generation, closes this race: a rebuilt object counts
    // from zero, so a parked older attempt can hold the same number as the one that matters.
    const harnessed = harness(TestBox);
    const { box, container, rows, storage } = harnessed;
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    // Arm the second gate only while parked at the claim's read, so it can catch only the
    // conditional write's read; a microtask count would make the ordering a race.
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
    await stale; // The hook recorded no stale failure; the successor owns admission.

    expect(rows.has(RECOVERY_KEY)).toBe(false);
    expect(armed(container)).toBe(armsAfterSuccess);
    expect(container.destroys).toBe(0);
    expect(incidents(rows)).toEqual([]);
    expect((await box.devboxState()).ready).toBe(true);
  });

  test('a destruction that did not land keeps refusing, and attaches over nothing', async () => {
    // The abandoned work is still inside that container; looking ready for a fresh start
    // is the overlap the replacement exists to prevent.
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    container.destroyFault = new Error('the container did not answer the signal');
    await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
    expect(container.destroys).toBe(0);
    await expect(box.devboxStartup()).rejects.toThrow('did not answer the signal');
    expect(container.running.running).toBe(true);
    await expect(box.exec('ls')).rejects.toMatchObject(
      { message: expect.stringContaining('could not be destroyed') });
    expect(container.containerStarts).toBe(1);
  });

  test('a destroyed identity is replaced by the next operation, not left refusing', async () => {
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    rows.set(RECOVERY_KEY, seeded('retry'));
    failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
    await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
    await box.devboxStartup();
    expect(container.running.running).toBe(false);
    await box.resolveReadiness();
    expect(container.containerStarts).toBe(2);
    expect((await box.devboxState()).ready).toBe(true);
    expect(rows.has(RECOVERY_KEY)).toBe(false);
  });

  test('attachNow is the explicit repair for a terminal refusal, and destroys nothing',
    async () => {
      // A terminal refusal keeps its `replace` stage so no eviction can restart a destructive ladder;
      // only a caller asking for the attach by name brings the box back.
      const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
      rows.set(RECOVERY_KEY, seeded('replace'));
      failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
      await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
      await expect(box.exec('ls')).rejects.toMatchObject(
        { message: expect.stringContaining('no attached work directory') });

      failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
      await expect(box.attachNow()).rejects.toThrow('RPC_TRANSPORT_ERROR');
      expect(container.destroys).toBe(0);
      expect(ladder(rows)?.stage).toBe('replace');

      const outcome = await box.attachNow();
      expect(outcome.kind).toBe('empty');
      expect(container.destroys).toBe(0);
      expect(rows.has(RECOVERY_KEY)).toBe(false);
      expect((await box.devboxState()).ready).toBe(true);
      const result = await box.exec('ls');
      expect(result.exitCode).toBe(0);
    });
});

describe('a promised retry is delivered even when the row carrying it is gone', () => {
  /** A landed attach ends on this command, so a test can tell whether an attach was attempted
   *  at all, not only what state it left. */
  const stamps = (container: FakeSandbox): number =>
    container.execs.filter(command => command.includes(STAMP_COMMAND)).length;

  /** Models an isolate reset after the ladder decided `retry` but before its arming write landed.
   *  The fake's rows ARE the schedule, so dropping them is the world the reset leaves. */
  const loseTheArmedRow = (container: FakeSandbox): void => {
    container.scheduleRows.length = 0;
  };

  test('the next operation re-arms the only coordinator when its retry row was lost', async () => {
    const harnessed = harness(TestBox);
    const { box, container, rows } = harnessed;
    failAttempt(harnessed, 'OPERATION_INTERRUPTED');
    await expect(box.devboxStartup()).rejects.toThrow('OPERATION_INTERRUPTED');
    expect({ armed: armed(container), destroys: container.destroys, stamps: stamps(container) })
      .toEqual({ armed: 1, destroys: 0, stamps: 1 });

    loseTheArmedRow(container);

    await expect(box.exec('ls')).rejects.toThrow('not ready');
    expect(armed(container)).toBe(1);
    expect(stamps(container)).toBe(1);
    await box.devboxStartup();
    const result = await box.exec('ls');

    expect({ exitCode: result.exitCode, stamps: stamps(container) })
      .toEqual({ exitCode: 0, stamps: 2 });
    expect((await box.devboxState()).restoration).toBe('attached');
    expect(rows.has(RECOVERY_KEY)).toBe(false);
  });

  test('a retry that IS scheduled refuses the caller and attaches nothing', async () => {
    // The pending schedule row is the rate limit: every caller gets the same refusal
    // instead of each call filing an incident.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'OPERATION_INTERRUPTED');
    await expect(box.devboxStartup()).rejects.toThrow('OPERATION_INTERRUPTED');

    await expect(box.exec('ls')).rejects.toMatchObject(
      { message: expect.stringContaining('A startup is armed') });
    await expect(box.exec('ls')).rejects.toMatchObject(
      { message: expect.stringContaining('stale-owner -> retry') });
    expect({ armed: armed(container), stamps: stamps(container) }).toEqual({ armed: 1, stamps: 1 });
  });

  test('a terminal class is never re-driven, and its refusal names the repair', async () => {
    // Exhaustion arms no row, so nothing blocks a re-drive; the box must still refuse
    // rather than repeat work the ladder refused.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'NO_SPACE');
    await expect(box.devboxStartup()).rejects.toThrow('NO_SPACE');
    expect(armed(container)).toBe(0);

    await expect(box.exec('ls')).rejects.toMatchObject(
      { message: expect.stringContaining('exhausted -> refuse') });
    await expect(box.exec('ls')).rejects.toMatchObject(
      { message: expect.stringContaining('terminal: call attachNow()') });
    expect(stamps(container)).toBe(1);
  });

  test('an idle box with no caller gets its lost retry armed by the state poll', async () => {
    // `devboxState` is the only thing that touches an idle box; it kicks the startup row,
    // arming a pending retryable unattach and leaving a terminal one alone.
    const harnessed = harness(TestBox);
    const { box, container } = harnessed;
    failAttempt(harnessed, 'OPERATION_INTERRUPTED');
    await expect(box.devboxStartup()).rejects.toThrow('OPERATION_INTERRUPTED');
    loseTheArmedRow(container);

    await box.devboxState();

    expect(container.scheduleRows.filter(row => row.callback === 'devboxStartup')).toHaveLength(1);
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

  test('a poll after the armed row comes due leaves that row and its alarm alone', async () => {
    // The SDK's `schedule()` resets the object's one alarm on every call, so re-arming a due row
    // on each poll starves the alarm; only the row's own dispatch may look past it (D14).
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const harnessed = harness(TestBox);
      const { box, container } = harnessed;
      failAttempt(harnessed, 'OPERATION_INTERRUPTED');
      await expect(box.devboxStartup()).rejects.toThrow('OPERATION_INTERRUPTED');
      const armsBefore = container.schedules.filter(name => name === 'devboxStartup').length;
      expect({ armed: armed(container), arms: armsBefore }).toEqual({ armed: 1, arms: 1 });

      // The row is due and the alarm loop has not delivered it yet.
      const armedRow = container.scheduleRows.find(row => row.callback === 'devboxStartup');

      if (armedRow === undefined) throw new Error('no devboxStartup row survived to wake this box');

      now = Math.ceil(armedRow.time) * 1000 + 500;

      for (let poll = 0; poll < 4; poll += 1) await box.devboxState();
      await expect(box.exec('ls')).rejects.toThrow('A startup is armed');

      expect({ armed: armed(container), arms: container.schedules.filter(name => name === 'devboxStartup').length })
        .toEqual({ armed: 1, arms: armsBefore });
    } finally {
      clock.mockRestore();
    }
  });

  test('a callback dispatching its own due row still arms its successor', async () => {
    // The SDK deletes a fired row only after the callback returns, so the heartbeat sees its
    // own due row and must look past it or the chain dies.
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const { box, container } = harness(TestBox);
      await box.exec('true');
      const heartbeats = (): { time: number }[] => container.scheduleRows.filter(row => row.callback === 'devboxHeartbeat');
      expect(heartbeats()).toHaveLength(1);
      const due = heartbeats()[0].time;
      now = Math.ceil(due) * 1000 + 500;

      await box.devboxHeartbeat();

      expect(heartbeats().filter(row => row.time > now / 1000)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('one budget, two policies: the attach may replace, the phases after it may not', () => {
  test('silent ports share the remaining budget instead of one window each', async () => {
    // Silent ports share one remaining budget; a window per port would hold every caller
    // in the readiness gate for the sum of the windows.
    const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;

    for (const value of [3000, 8080, 9000]) port(rows, value, `tok${String(value)}`);
    await box.devboxStartup();
    // A slow app is no reason to destroy a working box: no port answered, so none is exposed.
    expect(await box.getExposedPorts('preview.test')).toEqual([]);
    expect(container.destroys).toBe(0);
    expect(container.running.running).toBe(true);
    const state = await box.devboxState();
    expect(state.ready).toBe(false);
    expect(state.unready).toContain('port 3000');
    expect(state.ports.map(spec => spec.port)).toEqual([3000, 8080, 9000]);
  });

  test('ONE SLOW SERVER costs readiness and nothing else, and the next explicit try succeeds',
    async () => {
      const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
      proc(rows, 'p1');
      port(rows, 3000, 'tok3000');
      const slow = gate();
      container.startGate = slow;
      const attempt = box.devboxStartup();
      await slow.reached;
      // The process start's allowance expires while it is still parked: the
      // earliest armed timer is that step's, not the whole hook's.
      box.clock.tick();
      await attempt;

      expect(container.destroys).toBe(0);
      expect(container.running.running).toBe(true);
      expect(await box.getExposedPorts('preview.test')).toEqual([]);
      const stalled = await box.devboxState();
      expect(stalled.ready).toBe(false);
      expect(stalled.unready).toContain('process p1');
      expect(rows.has(RECOVERY_KEY)).toBe(false);
      expect(armed(container)).toBe(0);
      // Operations still work, which is the point of leaving the box attached.
      expect((await box.exec('ls')).exitCode).toBe(0);

      slow.release();
      container.listening.add(3000);
      const outcome = await box.attachNow();
      expect(outcome.kind).toBe('empty');
      expect(container.destroys).toBe(0);
      const repaired = await box.devboxState();
      expect({ ready: repaired.ready, unready: repaired.unready })
        .toEqual({ ready: true, unready: undefined });
      expect(await box.getExposedPorts('preview.test')).toEqual([{ port: 3000, url: 'https://3000-devbox-under-test-tok3000.preview.test', name: 'web' }]);
    });

  test('a process the container already holds is not started twice by the retry', async () => {
    // The walk asks the container before starting anything, so one spec cannot become two
    // servers fighting over one port.
    const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
    proc(rows, 'p1');
    await box.devboxStartup();
    expect(container.starts).toHaveLength(1);
    await box.attachNow();
    expect(container.starts).toHaveLength(1);
    expect(container.processes.size).toBe(1);
  });


  test('an initial boot stamp that exceeds the hook budget leaves the box unattached',
    async () => {
      const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
      const slow = gate();
      container.stampGate = slow;
      const attempt = box.devboxStartup();
      await slow.reached;
      // Assert the rejection only after the clock moves: `expect(promise).rejects` blocks until
      // settlement, and nothing can advance the test-driven clock meanwhile.
      box.clock.advance(TIGHT_POLICY.attachBudgetMs);
      await expect(attempt).rejects.toThrow('[abandoned -> replace]');
      expect(container.destroys).toBe(0);
      const state = await box.devboxState();
      expect(state.ready).toBe(false);
      expect(state.restoration).toBe('unattached');
      expect(rows.has(RECOVERY_KEY)).toBe(true);
      await box.devboxStartup();
      expect(container.destroys).toBe(1);
      slow.release();
    });

  test('a STALLED ATTACH still replaces the identity, because that work is unfenceable',
    async () => {
      // An attach abandoned mid-mount leaves work a retry would collide with, so the identity goes.
      const harnessed = harness(TightBox);
    const { box, container, rows } = harnessed;
      rows.set(RECOVERY_KEY, { owner: PREVIOUS, stage: 'retry' });
      failAttempt(harnessed, 'RPC_TRANSPORT_ERROR');
      await expect(box.devboxStartup()).rejects.toThrow('RPC_TRANSPORT_ERROR');
      expect(container.destroys).toBe(0);
      await box.devboxStartup();
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

      // The heartbeat that observes the settled command starts a fresh quiet period.
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

  test('a faulted initial boot stamp leaves the box unattached and unready', async () => {
    fixture.container.stampFaults.push(new Error('the stamp refused'));
    await expect(fixture.box.devboxStartup()).rejects.toThrow('the stamp refused');
    const state = await fixture.box.devboxState();
    expect(state.restoration).toBe('unattached');
    expect(state.ready).toBe(false);
    expect(state.unready).toContain('the stamp refused');
    expect(fixture.container.destroys).toBe(0);
  });

  test('an initial boot stamp failure is retried through the explicit start coordinator', async () => {
    fixture.container.stampFaults.push(new Error('the stamp refused'));
    await expect(fixture.box.devboxStartup()).rejects.toThrow('the stamp refused');
    expect((await fixture.box.devboxState()).unready).toContain('the stamp refused');

    await fixture.box.attachNow();
    expect((await fixture.box.devboxState()).ready).toBe(true);
  });

  test('a listening port really answers the shipped probe', async () => {
    port(fixture.rows, 7000, 'tok7000');
    fixture.container.listening.add(7000);
    await fixture.box.devboxStartup();
    expect(await fixture.box.getExposedPorts('preview.test')).toHaveLength(1);
  });

  test('the durable owner check really refuses a write, so the fence is not vacuous', async () => {
    failAttempt(fixture, 'RPC_TRANSPORT_ERROR');
    const claiming = gate();
    fixture.storage.gateOn(RECOVERY_KEY, claiming);
    const attempt = fixture.box.devboxStartup();
    await claiming.reached;
    const settling = gate();
    fixture.storage.gateOn(RECOVERY_KEY, settling);
    claiming.release();
    await settling.reached;
    fixture.rows.set(RECOVERY_KEY, { owner: 'another-attempt' });
    // Baseline is whatever the container start already armed; a superseded attempt may not add.
    const armedBeforeSettling = armed(fixture.container);
    settling.release();
    await attempt;
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
