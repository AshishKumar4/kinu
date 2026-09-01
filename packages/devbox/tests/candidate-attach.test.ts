// The candidate arms' own container ports, driven through the real class.
//
// WHY THIS FILE EXISTS, AND WHY THE CONFORMANCE BATTERY DOES NOT COVER IT.
// `tests/support/strategy-machine.ts` drives the shipped adapters through
// SUBSTITUTED ports: it proves `candidateContainerStorage` sequences an attach
// correctly given ports that behave. The ports themselves — `Devbox`'s own
// `#candidatePorts`, which is where every container round trip a candidate arm
// makes is composed — have no such suite, and that is exactly where the
// deployed defect lived.
//
// MEASURED DEFECT THIS FILE HOLDS. bounded-layers never attached. On the
// deployed arm (probe `blp1`, one Worker, one container, `wrangler tail` open
// across the whole attempt) the box sat at `running=true restoration=unstarted`
// for 300,771 ms with its attach pinned and not one further incident; run
// `e2ecal0901002202` recorded 900,001 ms on the same step and run
// `e2e20260901140445` lost it to the 25,000 ms product ceiling. The empty cold
// attach a fresh box takes — `restoreState`, `mountStore`, `stopJournal`,
// `startJournal` — starts no runner at all, so the whole of that time was spent
// in container round trips, and `startJournal` alone was FORTY of them: a
// readiness loop bounded by attempt count rather than by time, on a path whose
// own documentation records that one exec can retry inside the SDK for two
// minutes when the container is being reclaimed.
//
// So the property under test is a COST, and it is asserted as one: how many
// times the container is asked, not merely whether the answer was right.
import { describe, expect, test } from 'bun:test';

import { Devbox, harness } from './support/devbox-harness';
import {
  CANDIDATE_JOURNAL_BINARY,
  CANDIDATE_JOURNAL_SOCKET,
  CANDIDATE_STORE_MOUNT,
} from '../src/candidates/container';
import { JOURNAL_READY_WAIT_SECONDS } from '../src/capture/journal/command';
import { DEFAULT_DEVBOX_POLICY, describeThrown, type DevboxPolicy } from '../src/lifecycle';
import { DEVBOX_WORKDIR, type DevboxStrategyName, type DevboxStore } from '../src/storage';

/**
 * One bounded-layers box on the platform stand-in.
 *
 * THE BUCKET IS A REFUSAL, deliberately. A cold attach on a box that has
 * published nothing reads its control row, finds no head, and must never reach
 * the store: the owner's bar is that payload bytes do not transit the Durable
 * Object isolate, and a bucket that throws on every call turns that from a
 * claim into a postcondition of every test below.
 */
class BoundedLayersBox extends Devbox<Record<string, never>> {
  protected override get strategy(): DevboxStrategyName {
    return 'bounded-layers';
  }

  protected override get candidateRunnerPath(): string {
    return '/opt/kinu/candidate-runner.bundle.mjs';
  }

  protected override get store(): DevboxStore {
    // SAFETY: constructed against the R2Bucket contract. A cold attach with no
    // published head reaches no member of it, which is the property the empty
    // path exists for; any call lands on the prototype's own refusal below and
    // fails the test that provoked it.
    const bucket: R2Bucket = Object.create({
      get: () => { throw new Error('a cold attach must not read the store'); },
      head: () => { throw new Error('a cold attach must not read the store'); },
      put: () => { throw new Error('a cold attach must not write the store'); },
    });
    return { binding: 'BACKUP_BUCKET', bucket };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }
}

/** Every exec that asked whether the journal daemon is serving. Matched on the
 *  socket the question is about rather than on a command's first word, so a
 *  loop that asks forty times in any wording is still counted forty times. */
function readinessAsks(execs: readonly string[]): readonly string[] {
  return execs.filter((command) => command.includes(CANDIDATE_JOURNAL_SOCKET));
}

/** The sentence an attach refused with. A refusal that RESOLVED is the defect
 *  these tests exist for — a strategy reporting success it did not perform —
 *  so it is named here rather than allowed to read as an empty message. */
async function describeRefusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (cause) {
    return describeThrown({ cause });
  }
  throw new Error('the attach settled where a refusal was required');
}

describe('a candidate cold attach asks the container once per question', () => {
  test('the journal readiness question costs ONE round trip, not forty', async () => {
    const { box, container } = harness(BoundedLayersBox);

    const outcome = await box.attachNow();

    // The empty box attached: no head, so nothing to restore and no runner to
    // start — the state a first cold attach is really in.
    expect(outcome.kind).toBe('empty');
    // THE REGRESSION GUARD. The loop this replaced asked `JOURNAL_READY_ATTEMPTS`
    // times — forty — and a container that answered slowly turned each of those
    // into an unbounded SDK retry.
    expect(readinessAsks(container.execs)).toHaveLength(1);
    // And the daemon really is serving, from the container's own report rather
    // than from the call having returned.
    expect(container.journalRunning()).toBe(true);
    expect(container.s3fsMounts.has(CANDIDATE_STORE_MOUNT)).toBe(true);
  });

  test('a daemon that never serves fails in one round trip, naming which half is missing', async () => {
    const { box, container } = harness(BoundedLayersBox);
    // The daemon starts and its mount never lands: the only reason a readiness
    // question exists at all.
    container.journalMounts = false;
    container.processLogs.set('candidate-journal', {
      stdout: '', stderr: 'fuse: device not found',
    });

    // ONE refusal, read as one value: the sentence is the finding, and every
    // clause of it is asserted below rather than matched loosely.
    const refused = await describeRefusal(box.attachNow());

    expect(refused).toContain(`did not serve ${DEVBOX_WORKDIR}`);
    expect(refused).toContain(`within ${String(JOURNAL_READY_WAIT_SECONDS)}s`);
    // THE HALF THAT WAS MISSING, said by the probe rather than inferred from
    // the daemon's logs. The message this replaced could only say "did not
    // mount" and hand over whatever the daemon printed.
    expect(refused).toContain('control socket absent, mount absent');
    // The daemon's own words still travel: they are the cause, and the probe
    // reading is the symptom.
    expect(refused).toContain('fuse: device not found');
    // A FAILING readiness question costs one round trip too. The old loop spent
    // forty before it could say anything at all, which is the whole reason a
    // failing attach was indistinguishable from a hanging one.
    expect(readinessAsks(container.execs)).toHaveLength(1);
    // The daemon that will not serve is not left running beside the next one:
    // two daemons must never recover or append one journal.
    expect(container.kills).toContain('candidate-journal');
  });

  test('the whole empty cold attach is a countable number of container asks', async () => {
    const { box, container } = harness(BoundedLayersBox);

    await box.attachNow();

    // EVERY exec the attach made, so a future round trip added to this path has
    // to be added here too and justified. The forty-hop loop made this number
    // meaningless: it was forty plus whatever else happened.
    //
    // mkdir the store mount; read /proc/mounts before; read it after; kill the
    // old daemon's mount; mkdir the journal root and state; one readiness ask;
    // then the boot-id stamp's read and write.
    expect(container.execs.length).toBeLessThanOrEqual(8);
    // THREE mount reads in the integrated world, each a different question:
    // the attach's before/after pair, plus the release seam's own read —
    // #releaseMount checks what is really mounted before it kills the old
    // daemon's mount (fix/r2fs-holder), a question the attach pair cannot
    // answer for it.
    expect(container.execs.filter((command) => command === 'cat /proc/mounts')).toHaveLength(3);
    expect(
      container.starts.filter((start) => start.command.includes(CANDIDATE_JOURNAL_BINARY)),
    ).toHaveLength(1);
  });
});
