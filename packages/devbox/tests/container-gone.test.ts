// A container that is gone: a heartbeat must not second-guess a restoration in flight, and
// a stop or discard on a gone container must not resurrect an instance to act on it.
import { describe, expect, test } from 'bun:test';

import { DEFAULT_DEVBOX_POLICY, type DevboxPolicy } from '../src/lifecycle';
import { chainBox, chainHead } from './support/chain-box';
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
    // A wake's durable row names the stopped instance; the fresh instance has no marker
    // until the attempt stamps it, which is the attempt's LAST step.
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
    // A beat that re-drove would stamp a second time and turn the parked attempt stale
    // under its own container commands.
    expect({
      stamps: container.execs.filter((command) => command.includes(STAMP_COMMAND)).length,
      replacedCount: state.replacedCount,
      tickSawReplacement: state.lastTick?.replaced === true,
      ready: state.ready,
    }).toEqual({ stamps: 1, replacedCount: 1, tickSawReplacement: false, ready: true });
  });

  test('a settled beat asks the container one question: the boot-id read is its ping', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    const before = container.sequence.length;

    await box.devboxHeartbeat();

    expect(container.sequence.slice(before)).toEqual(['exec:devbox-beat-v1']);
    expect((await box.devboxState()).lastTick?.ping).toBe('ok');
  });

  test('the beat refuses replacement and arms the hook coordinator without restoring', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();
    expect((await box.devboxState()).ready).toBe(true);
    container.bootId = undefined;

    await box.devboxHeartbeat();

    const observed = await box.devboxState();
    expect(observed.ready).toBe(false);
    expect(observed.lastTick?.replaced).toBe(true);
    expect(container.execs.filter(command => command.includes(STAMP_COMMAND))).toHaveLength(1);
    await box.devboxStartup();
    const state = await box.devboxState();
    expect({
      stamps: container.execs.filter((command) => command.includes(STAMP_COMMAND)).length,
      replacedCount: state.replacedCount,
      tickSawReplacement: state.lastTick?.replaced,
    }).toEqual({ stamps: 2, replacedCount: 1, tickSawReplacement: true });
  });
});

describe('a stop or a discard on a box whose container is gone resurrects nothing', () => {
  /** A box that published one generation, then lost its container as the platform loses one:
   *  the instance is gone and nothing told the box. */
  async function published() {
    const arm = chainBox();
    expect((await arm.box.attachNow()).kind).toBe('empty');
    await arm.box.writeFile('/workspace/ladder/c64.bin', 'sixty-four KiB of ladder bytes');
    expect((await arm.box.checkpointNow('quiesce')).kind).toBe('committed');
    const head = chainHead(arm.rows);

    if (head === null) throw new Error('the quiesce published no generation');
    arm.container.running.running = false;
    arm.container.processes.clear();

    return { ...arm, head };
  }

  test('a stop commits nothing, asks the container nothing, and the next wake restores the head', async () => {
    const { box, container, rows, head } = await published();
    const asked = container.execs.length;
    const started = container.starts.length;

    const outcome = await box.quiesce();

    // The work directory died with the instance; a checkpoint now would make the SDK start
    // a fresh instance and archive a bare directory against no mount.
    expect(outcome.kind).toBe('skipped');
    expect(outcome.reason).toContain('not running');
    expect({
      commands: container.execs.length - asked,
      processStarts: container.starts.length - started,
    }).toEqual({ commands: 0, processStarts: 0 });
    expect((await box.devboxState()).restoration).not.toBe('attached');

    container.running.running = true;
    await box.kickStartup();
    await box.devboxStartup();
    const state = await box.devboxState();
    expect(state.restoration).toBe('attached');
    expect(state.lastAttach?.detail).toContain(head);
    expect(chainHead(rows)).toBe(head);
  });

  test('a discard drops the durable state without a container command', async () => {
    const { box, container, rows } = await published();
    const asked = container.execs.length;
    const started = container.starts.length;

    await box.discardState();

    expect(chainHead(rows)).toBeNull();
    expect(rows.has('devbox:last-attach')).toBe(false);
    expect({
      commands: container.execs.length - asked,
      processStarts: container.starts.length - started,
      kills: container.kills.length,
    }).toEqual({ commands: 0, processStarts: 0, kills: 0 });
  });
});
