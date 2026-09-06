// A container that is gone, and the two flows that used to act as if it were
// there: the heartbeat's replacement detector and the stop.
//
// MEASURED, run kinu-devbox-bench-20260906072721 (2026-09-06, merkle-pack,
// Worker tail with SANDBOX_LOG_LEVEL=debug):
//
//   * 07:30:14-16Z, the post-ladder wake. The wake's attempt was mounting the
//     store when the heartbeat fired, read the durable boot id against a
//     fresh instance that carried none yet, logged `the container instance was
//     replaced; re-driving the restoration now`, turned the generation over
//     and started a SECOND restoration. Two attempts then drove `mountStore`,
//     `stopJournal` and the restore on one container (two `mkdir -p
//     /var/tmp/devbox`, two `cat /tmp/devbox-boot-id`, two `cat /proc/mounts`
//     inside one second), which is the one hazard the daemon's own comments
//     forbid: two daemons over one journal.
//   * 07:31:12-32Z, after the fault cut killed the container. The arm's
//     release ran a quiesce whose final checkpoint started a runner against a
//     container that was gone, so the SDK started a FRESH instance to run it
//     (`Default session initialized` five seconds after `Sandbox stopped`);
//     the heartbeat saw that instance as a replacement and re-drove a full
//     restoration; the teardown's `discardState` then ran `rm -rf` of the
//     runner results under that restore (`ENOENT ... control.json`), and its
//     stop landed on the restore's mount command: `Sandbox operation
//     commands.execute was interrupted while the runtime connection was
//     closing`. The same sentence failed the merkle-pack post-ladder stop of
//     run 20260905232937 (2026-09-05).
//
// So: a restoration in flight owns the container's identity, and a heartbeat
// must not second-guess it; a stop or a discard on a box whose container is
// gone has nothing to commit and nothing to clean, and must not resurrect an
// instance to do either.
import { describe, expect, test } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { candidateBox, candidateHead } from './support/candidate-box';
import { Devbox, gate, harness, STAMP_COMMAND } from './support/devbox-harness';

const BOOT_ID_KEY = 'devbox:boot-id';

/** The shipped policy with a test-length probe: nothing here is about budgets. */
class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get previewHost(): string | undefined {
    return 'preview.example';
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

describe('a heartbeat landing inside a restoration leaves that restoration alone', () => {
  test('the beat does not re-drive a wake whose stamp has not landed yet', async () => {
    const { box, container, rows } = harness(TestBox);
    // The shape of every wake: the durable row names the instance the stop
    // took down, and the fresh instance carries no marker until the attempt
    // stamps it, which is the LAST thing the attempt does.
    rows.set(BOOT_ID_KEY, 'the-instance-the-stop-took-down');
    container.bootId = undefined;
    const parked = gate();
    container.stampGate = parked;
    const wake = box.devboxStartup();
    await parked.reached;

    await box.devboxHeartbeat();

    parked.release();
    await wake;
    const state = await box.devboxState();
    // ONE restoration, ONE stamp, ONE counted replacement: the wake's own. A
    // beat that re-drove would have stamped a second time and turned the
    // parked attempt stale under its own container commands.
    expect({
      stamps: container.execs.filter((command) => command.includes(STAMP_COMMAND)).length,
      replacedCount: state.replacedCount,
      tickSawReplacement: state.lastTick?.replaced === true,
      ready: state.ready,
    }).toEqual({ stamps: 1, replacedCount: 1, tickSawReplacement: false, ready: true });
  });

  test('the beat still re-drives an ATTACHED box whose instance was replaced', async () => {
    // The other direction: the detector is not disabled, it is scoped. A box
    // that settled on one instance and finds another underneath it is the
    // case the heartbeat exists for.
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    expect((await box.devboxState()).ready).toBe(true);
    container.bootId = undefined;

    await box.devboxHeartbeat();

    const state = await box.devboxState();
    expect({
      stamps: container.execs.filter((command) => command.includes(STAMP_COMMAND)).length,
      replacedCount: state.replacedCount,
      tickSawReplacement: state.lastTick?.replaced,
    }).toEqual({ stamps: 2, replacedCount: 1, tickSawReplacement: true });
  });
});

describe('a stop or a discard on a box whose container is gone resurrects nothing', () => {
  /** A merkle-pack box that has published one head and then lost its
   *  container the way the platform loses one: the instance is gone and
   *  nothing told the box. */
  async function published() {
    const arm = candidateBox('merkle-pack');
    expect((await arm.box.attachNow()).kind).toBe('empty');
    await arm.box.writeFile('/workspace/ladder/c64.bin', 'sixty-four KiB of ladder bytes');
    expect((await arm.box.checkpointNow('quiesce')).kind).toBe('committed');
    const head = candidateHead(arm.rows, 'merkle-pack');
    if (head === null) throw new Error('the quiesce published no head');
    arm.container.running.running = false;
    arm.container.processes.clear();
    return { ...arm, head };
  }

  test('a stop commits nothing, asks the container nothing, and the next wake restores the head', async () => {
    const { box, container, runner, rows, head } = await published();
    const asked = container.execs.length;
    const started = container.starts.length;
    const answered = runner.invocations.length;

    const outcome = await box.quiesce();

    // NOTHING TO COMMIT AND NOTHING TO ASK. The work directory died with the
    // instance; a checkpoint runner started now would run on a fresh instance
    // the SDK starts to run it, against no mount and no daemon.
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toContain('not running');
    expect({
      commands: container.execs.length - asked,
      processStarts: container.starts.length - started,
      runnerInvocations: runner.invocations.length - answered,
    }).toEqual({ commands: 0, processStarts: 0, runnerInvocations: 0 });
    // And the box no longer claims a work directory it does not have.
    expect((await box.devboxState()).restoration).not.toBe('attached');

    // The next wake is an ordinary restoration of the published head.
    await box.kickStartup();
    await box.devboxStartup();
    const state = await box.devboxState();
    expect(state.restoration).toBe('attached');
    expect(state.lastAttach?.detail).toContain(head);
    expect(candidateHead(rows, 'merkle-pack')).toBe(head);
  });

  test('a discard drops the durable state without a container command', async () => {
    const { box, container, runner, rows } = await published();
    const asked = container.execs.length;
    const started = container.starts.length;
    const answered = runner.invocations.length;

    await box.discardState();

    expect(candidateHead(rows, 'merkle-pack')).toBeNull();
    expect(rows.has('devbox:last-attach')).toBe(false);
    expect({
      commands: container.execs.length - asked,
      processStarts: container.starts.length - started,
      runnerInvocations: runner.invocations.length - answered,
      kills: container.kills.length,
    }).toEqual({ commands: 0, processStarts: 0, runnerInvocations: 0, kills: 0 });
  });

  test('a discard on a RUNNING container still releases its journal and its mount', async () => {
    // The container-side half is skipped only when there is no container:
    // a live one keeps a daemon over the work directory and a store mount,
    // and a discard that left them would hand the next attach a second
    // daemon over a mount the first still owns.
    const arm = candidateBox('merkle-pack');
    expect((await arm.box.attachNow()).kind).toBe('empty');
    expect(arm.container.journalRunning()).toBe(true);

    await arm.box.discardState();

    expect(arm.container.journalRunning()).toBe(false);
    expect(arm.container.mountCalls.at(-1)).toBe('unmount:/var/tmp/devbox/candidate-r2');
    expect(candidateHead(arm.rows, 'merkle-pack')).toBeNull();
  });
});
