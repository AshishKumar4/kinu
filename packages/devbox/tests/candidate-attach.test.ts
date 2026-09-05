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

import { deriveBoxId, Devbox, harness } from './support/devbox-harness';
import { candidateBox, candidateHead, memoryBucket, reactivateCandidateBox } from './support/candidate-box';
import type { Harness, TestEnv } from './support/devbox-harness';
import type { CandidateContainerFormat } from '../src/candidates/container';
import {
  CANDIDATE_JOURNAL_BINARY,
  CANDIDATE_JOURNAL_SOCKET,
  CANDIDATE_STORE_MOUNT,
} from '../src/candidates/container';
import { JOURNAL_READY_WAIT_SECONDS } from '../src/capture/journal/command';
import { DEFAULT_DEVBOX_POLICY, describeThrown, type DevboxPolicy } from '../src/lifecycle';
import { chainStoreRoot } from '../src/snapshot-chain';
import { DEVBOX_WORKDIR, type DevboxStrategyName, type DevboxStore, type StoredValue } from '../src/storage';

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

describe('a wake on the same instance rewrites the attach row the driver reads', () => {
  /**
   * THE DEPLOYED FAILURE THIS HOLDS. Run 20260902154130, artifact
   * `bench-artifacts/20260902154130/merkle-pack.json`: the merkle-pack arm
   * cold-attached `empty` (`attachColdKind`), published three generations
   * through its quiesces with the tick after each one skipped as "fenced the
   * published manifest" (`checkpoints`), stopped in 6,625 ms, and its wake was
   * refused by the driver with `wake restored empty, expected attached`
   * (`verifyChecks[2]`, `notes[2]`).
   *
   * `empty` cannot have come from an attach: the candidate storage answers it
   * only when the control row has no head (`container.ts` `attach`, and the
   * runner's `rootId: null` only for `head === null`), and the row held a head
   * the ticks had just fenced. It came from the DURABLE row the driver reads —
   * `devbox:last-attach`, which `startupPollVerdict` returns the moment
   * `restoration === 'attached'` — and that row was written by the cold attach
   * alone. A wake on the instance the stop left behind still carries
   * `/tmp/devbox-boot-id`, so `#hasAttachedContainer` is true, the drive takes
   * the same-container repair instead of an attach, reaches `attached`, and
   * leaves the cold `empty` row for the driver to read.
   *
   * THE ASSERTION IS ON THE DURABLE ROW, because that is what the driver
   * reads, so a fix that only changes the in-memory phase cannot pass it.
   */
  test('stop then wake on the SAME instance rewrites lastAttach with kind attached and the next tick reaches the fence', async () => {
    const { box, container, rows, runner } = candidateBox('merkle-pack');

    // A fresh box: the cold attach answers `empty` and writes that down.
    expect((await box.attachNow()).kind).toBe('empty');
    expect(rows.get('devbox:last-attach')).toMatchObject({ kind: 'empty' });

    // A write, then the ladder's quiesce: the runner hands the box a staged
    // draft, the box publishes it, and the control row holds a head.
    await box.writeFile('/workspace/ladder/c64.bin', 'sixty-four KiB of ladder bytes');
    const published = await box.checkpointNow('quiesce');
    expect(published.kind).toBe('committed');
    const head = candidateHead(rows, 'merkle-pack');
    if (head === null) throw new Error('the quiesce published no head');
    expect(published.reason).toContain(head);

    // The stop. Nothing was written since the publish, so the final quiesce
    // fences the published manifest — the tick rows of the deployed ladder —
    // and the container stops with its boot marker intact, which is what the
    // platform leaves when it brings the same instance back.
    expect((await box.quiesce()).kind).toBe('skipped');
    expect(container.running.running).toBe(false);
    expect(rows.get('devbox:boot-id')).toBe(container.bootId);

    // The wake, as the driver's `/wake` drives it: the startup row is armed
    // and the platform runs its callback.
    const asked = container.execs.length;
    const started = container.starts.length;
    const answered = runner.invocations.length;
    await box.kickStartup();
    await box.devboxStartup();
    const wakeAsks = container.execs.length - asked;

    const state = await box.devboxState();
    expect(state.restoration).toBe('attached');
    // THE ROW THE DRIVER READS, rewritten by THIS wake: it names the head
    // this generation serves, not what the cold attach found.
    expect(state.lastAttach?.kind).toBe('attached');
    expect(state.lastAttach?.detail).toContain(head);
    // THE WAKE IS THE REPAIR, AND IT IS A COUNTABLE NUMBER OF ASKS. The tree
    // never left the instance disk, so no restore runner ran: the container
    // was asked to start the daemon the stop took down and to re-seed it with
    // the head, and nothing else. Every exec, so a round trip added to this
    // path has to be added here and justified: two boot-marker reads (the
    // door's and the repair's own); three health probes of three execs each
    // (before the repair, after the store remount, after the seed); the store
    // remount's mkdir and its before/after mount reads; the daemon replacement's
    // mount read, its mkdir and its one readiness ask; the boot-marker
    // re-check after the repair; and ONE `mkdir -p` of the runtime directory
    // itself, issued once per container by the exec seam before any command
    // stands in that directory (the chdir the deployed r2fs arm died on —
    // `#rawExec`'s own note carries the measurement).
    expect(runner.invocations.slice(answered).map((call) => call.action)).toEqual(['seed']);
    expect(
      container.starts.slice(started).filter((start) => start.command.includes(CANDIDATE_JOURNAL_BINARY)),
    ).toHaveLength(1);
    expect(wakeAsks).toBeLessThanOrEqual(19);
    // And the daemon answers after the wake, so the next tick reaches the
    // runner and its fence answers — the deployed release died instead of
    // `no mutation journal answers`.
    expect(container.journalRunning()).toBe(true);
    const tick = await box.checkpointNow('tick');
    expect(tick).toMatchObject({
      kind: 'skipped',
      reason: 'candidate merkle-pack tick fenced the published manifest',
    });
    expect(runner.invocations.at(-1)?.action).toBe('checkpoint');
  });
});

// ── the stop tolerates a daemon row it cannot kill ─────────────────────────
//
// THE DEFECT, and it is the ORDER that produces it. `#releaseWorkdirHolders`
// kills every LIVE supervised process seconds earlier on the same stop — the
// journal daemon included — under its own written rule that a stop must not be
// held hostage by one id the container cannot kill. `stopJournal` then re-kills
// the daemon row it still finds listed, and the SDK's kill contract ERRORS on
// an id the container no longer holds. So the sibling's own tolerant kill is
// what makes the row stale for the fatal one, and either way — a table one
// beat behind, or a process that died between the list and the kill — the
// caller is at fault, not the table.
//
// Tolerated BY CODE, never by prose: `PROCESS_NOT_FOUND` is the SDK's own
// classification and `ProcessAbsentSchema` already reads it elsewhere in this
// class. Any other failure still travels.

describe('a stop that finds a daemon row it cannot kill', () => {
  const staged = async (): Promise<ReturnType<typeof candidateBox>> => {
    const harnessed = candidateBox('merkle-pack');
    expect((await harnessed.box.attachNow()).kind).toBe('empty');
    await harnessed.box.writeFile('/workspace/ladder/c64.bin', 'sixty-four KiB of ladder bytes');
    expect((await harnessed.box.checkpointNow('quiesce')).kind).toBe('committed');
    return harnessed;
  };

  const daemonRow = (id: string, status: string) => ({
    id, pid: 4242, status, command: `${CANDIDATE_JOURNAL_BINARY} --mount /workspace`,
  });

  test('a daemon that died between the list and the kill does not fail the stop', async () => {
    // THE RACY DEATH, and the path the release pass creates: it kills this row
    // tolerantly moments earlier, so the re-kill here answers absence.
    const { box, container } = await staged();
    container.processes.set('journal-racy', daemonRow('journal-racy', 'running'));
    container.killFaultsById.set(
      'journal-racy',
      Object.assign(new Error('no such process'), { code: 'PROCESS_NOT_FOUND' }),
    );

    const stopped = await box.quiesce();

    expect(['committed', 'skipped']).toContain(stopped.kind);
    expect(container.running.running).toBe(false);
    // The release pass tolerated it too, so BOTH kills were attempted and
    // neither ended the stop.
    expect(container.kills.filter((id) => id === 'journal-racy').length).toBeGreaterThanOrEqual(2);
  });

  test('a row the table still lists but the container has finished is not killed at all', async () => {
    // THE STALE TABLE. A row that is not live needs no kill, which is the
    // sibling's own filter; attempting one is how a stop turns a table one
    // beat behind into a refusal.
    const { box, container } = await staged();
    container.processes.set('journal-stale', daemonRow('journal-stale', 'exited'));

    const stopped = await box.quiesce();

    expect(['committed', 'skipped']).toContain(stopped.kind);
    expect(container.kills).not.toContain('journal-stale');
  });

  test('a live daemon the container cannot kill still refuses the stop', async () => {
    // The tolerance is for ABSENCE alone. A live daemon that will not die owns
    // the mount below, and a stop that swallowed that would hand the next wake
    // a second daemon over a mount the first still holds.
    const { box, container } = await staged();
    container.processes.set('journal-stuck', daemonRow('journal-stuck', 'running'));
    container.killFaultsById.set(
      'journal-stuck',
      Object.assign(new Error('container is wedged'), { code: 'CONTAINER_ERROR' }),
    );

    await expect(box.quiesce()).rejects.toThrow(/wedged/);
  });
});

// ── 6.19: stop then wake on the same instance keeps three generations ───────
//
// WHY THREE ARMS AND THREE GENERATIONS. The decisive bench compares
// snapshot-chain, bounded-layers and merkle-pack, and every arm's wake is
// judged by the head three quiesces published and the bytes those generations
// hold. One generation cannot see an incremental format misread its parent:
// the Nth generation is the first thing ever to read the (N-1)th, so a
// closure the second generation declares wrongly stays invisible until the
// third. Each arm below therefore commits three quiesces before the stop.
//
// WHY TWO SHAPES. A wake after a stop arrives in one of two objects: the box
// that stopped, still warm, or a new isolate over the same durable rows after
// the platform evicted the first. Both must serve the same head and the same
// bytes. The first shape guards the in-memory path, the second the rows.
//
// WHY THE STOP IS PROVED. A wake over a stop that never stopped reads exactly
// like a healthy recycle, which is how two empty candidate wakes measured as
// recycles. The stop below is proved completed — resolved, container stopped,
// exactly one stop transition, boot row intact — before any wake runs.
const chainBucket = memoryBucket();

class ChainBox extends Devbox<Record<string, never>> {
  protected override get strategy(): DevboxStrategyName {
    return 'snapshot-chain';
  }

  protected override get store(): DevboxStore {
    return { binding: 'BACKUP_BUCKET', bucket: chainBucket.handle };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }

  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }
}

interface ChainArm extends Harness<ChainBox> {
  readonly id: string;
}

function openChainBox(name: string): ChainArm {
  const id = deriveBoxId('snapshot-chain', name);
  const harnessed = harness(ChainBox, id);
  harnessed.container.chainStore = { objects: chainBucket.objects, root: chainStoreRoot(`boxes/${id}`) };
  return { id, ...harnessed };
}

function reactivateChainBox(first: ChainArm): ChainArm {
  // A new isolate over the same durable state: fresh memory, the same rows,
  // the same bucket bytes and the stopped container disk transplanted. The
  // schedule table is deliberately not carried: alarms belong to the isolate
  // that armed them, and the wake re-arms what it needs.
  const second = harness(ChainBox, first.id);
  second.rows.clear();
  for (const [key, value] of first.rows) second.rows.set(key, value);
  const from = first.container;
  const to = second.container;
  to.running.running = from.running.running;
  to.bootId = from.bootId;
  to.files.clear();
  for (const [key, value] of from.files) to.files.set(key, value);
  to.directories.clear();
  for (const directory of from.directories) to.directories.add(directory);
  to.s3fsMounts.clear();
  for (const mount of from.s3fsMounts) to.s3fsMounts.add(mount);
  to.overlayMounts.clear();
  for (const mount of from.overlayMounts) to.overlayMounts.add(mount);
  to.layerMounts.clear();
  for (const mount of from.layerMounts) to.layerMounts.add(mount);
  to.stagedArchives.clear();
  for (const [key, value] of from.stagedArchives) to.stagedArchives.set(key, value);
  to.processes.clear();
  for (const [key, value] of from.processes) to.processes.set(key, value);
  to.sessionCwd = from.sessionCwd;
  to.changeVersion = from.changeVersion;
  to.chainStore = from.chainStore;
  return { id: first.id, ...second };
}

/** Either box this cell drives, typed the way the harness types its boxes. */
type CellBox = InstanceType<typeof Devbox<TestEnv>>;

async function commitThreeGenerations(box: CellBox): Promise<void> {
  expect((await box.attachNow()).kind).toBe('empty');
  await box.writeFile('/workspace/notes.txt', 'generation one');
  expect((await box.checkpointNow('quiesce')).kind).toBe('committed');
  await box.writeFile('/workspace/extra.txt', 'added by the second commit');
  expect((await box.checkpointNow('quiesce')).kind).toBe('committed');
  await box.writeFile('/workspace/third.txt', 'written by the third generation');
  expect((await box.checkpointNow('quiesce')).kind).toBe('committed');
}

async function expectGenerationsReadable(box: CellBox): Promise<void> {
  expect((await box.readFile('/workspace/notes.txt')).content).toBe('generation one');
  expect((await box.readFile('/workspace/extra.txt')).content).toBe('added by the second commit');
  expect((await box.readFile('/workspace/third.txt')).content).toBe('written by the third generation');
}

async function chainHeadOf(box: CellBox): Promise<string> {
  const head = (await box.devboxState()).chain?.base.id ?? null;
  if (head === null) throw new Error('the chain names no head after three commits');
  return head;
}

function candidateHeadOrThrow(rows: Map<string, StoredValue>, format: CandidateContainerFormat): string {
  const head = candidateHead(rows, format);
  if (head === null) throw new Error(`the ${format} quiesce published no head`);
  return head;
}

async function stopAndProveCompleted(
  box: CellBox,
  container: { readonly stops: number; readonly running: { readonly running: boolean }; readonly bootId: string | undefined },
  rows: Map<string, StoredValue>,
): Promise<void> {
  const stops = container.stops;
  const outcome = await box.quiesce();
  // A stop that lost its final commit refuses to stop rather than lose work,
  // so a failed commit here would be the defect wearing success.
  expect(outcome.kind).not.toBe('failed');
  // PROVED, not assumed: the container reports itself stopped, the stop
  // transition ran exactly once for this call, and the boot row still names
  // the instance the stop left behind.
  expect(container.running.running).toBe(false);
  expect(container.stops).toBe(stops + 1);
  expect(rows.get('devbox:boot-id')).toBe(container.bootId);
}

async function wakeAndExpectGenerations(
  box: CellBox,
  readHead: () => Promise<string>,
  head: string,
  tickFragment: string,
): Promise<void> {
  // The wake, as the driver's `/wake` drives it: the startup row is armed and
  // the platform runs its callback.
  await box.kickStartup();
  await box.devboxStartup();
  const state = await box.devboxState();
  expect(state.restoration).toBe('attached');
  // THE ROW THE DRIVER READS, rewritten by THIS wake: it names the head this
  // generation serves, not what the cold attach found.
  expect(state.lastAttach?.kind).toBe('attached');
  expect(state.lastAttach?.detail).toContain(head);
  expect(await readHead()).toBe(head);
  await expectGenerationsReadable(box);
  // The wake left the arm quiescent: the next tick meets the published head
  // instead of publishing a fourth generation or refusing on a dead journal.
  const tick = await box.checkpointNow('tick');
  expect(tick.kind).toBe('skipped');
  expect(tick.reason ?? '').toContain(tickFragment);
}

for (const format of ['bounded-layers', 'merkle-pack'] as const) {
  test(`6.19 ${format} stops and wakes on the same instance with three generations intact`, async () => {
    const arm = candidateBox(format);
    await commitThreeGenerations(arm.box);
    const head = candidateHeadOrThrow(arm.rows, format);
    await stopAndProveCompleted(arm.box, arm.container, arm.rows);
    await wakeAndExpectGenerations(
      arm.box,
      () => Promise.resolve(candidateHeadOrThrow(arm.rows, format)),
      head,
      `candidate ${format} tick fenced the published manifest`,
    );
  });

  test(`6.19 ${format} wakes on a new isolate over the same rows with three generations intact`, async () => {
    const first = candidateBox(format);
    await commitThreeGenerations(first.box);
    const head = candidateHeadOrThrow(first.rows, format);
    await stopAndProveCompleted(first.box, first.container, first.rows);
    const second = reactivateCandidateBox(format, first);
    await wakeAndExpectGenerations(
      second.box,
      () => Promise.resolve(candidateHeadOrThrow(second.rows, format)),
      head,
      `candidate ${format} tick fenced the published manifest`,
    );
  });
}

test('6.19 snapshot-chain stops and wakes on the same instance with three generations intact', async () => {
  const arm = openChainBox('stop-wake-same');
  await commitThreeGenerations(arm.box);
  const head = await chainHeadOf(arm.box);
  await stopAndProveCompleted(arm.box, arm.container, arm.rows);
  // The wake seats the layers under an empty upper, and an empty upper is the
  // chain's own proof of quiescence: the tick skips on it before any gate.
  await wakeAndExpectGenerations(arm.box, () => chainHeadOf(arm.box), head, 'nothing has been written since the attach');
});

test('6.19 snapshot-chain wakes on a new isolate over the same rows with three generations intact', async () => {
  const first = openChainBox('stop-wake-isolate');
  await commitThreeGenerations(first.box);
  const head = await chainHeadOf(first.box);
  await stopAndProveCompleted(first.box, first.container, first.rows);
  const second = reactivateChainBox(first);
  await wakeAndExpectGenerations(second.box, () => chainHeadOf(second.box), head, 'nothing has been written since the attach');
});

test('a wake that finds the journal socket absent restarts the daemon instead of serving a deaf journal', async () => {
  // THE DEFECT. `attachmentHealth` read the socket probe's EXIT CODE, but the
  // probe ends in `|| echo no`, so the exit is 0 either way and the socket
  // read healthy for ever. A repair that found a live daemon, a live mount
  // and a dead socket took the silent path and served a journal nothing
  // could talk to; the next tick died with no mutation journal answering.
  // The probe's answer is its WORDS, the way the mount read already takes
  // its own, so an absent socket restarts the daemon and re-seeds it.
  const first = candidateBox('merkle-pack');
  expect((await first.box.attachNow()).kind).toBe('empty');
  await first.box.writeFile('/workspace/notes.txt', 'generation one');
  expect((await first.box.checkpointNow('quiesce')).kind).toBe('committed');
  const head = candidateHeadOrThrow(first.rows, 'merkle-pack');
  // The isolate is reset while the container runs: the daemon row, the mount
  // and the boot marker survive, but the control socket does not.
  const second = reactivateCandidateBox('merkle-pack', first);
  second.container.journalSocketUp = false;
  const daemonStarts = second.container.starts
    .filter((start) => start.command.includes(CANDIDATE_JOURNAL_BINARY)).length;
  await second.box.kickStartup();
  await second.box.devboxStartup();
  const state = await second.box.devboxState();
  expect(state.restoration).toBe('attached');
  expect(state.lastAttach?.kind).toBe('attached');
  expect(state.lastAttach?.detail).toContain(head);
  // THE RESTART, counted rather than inferred: the deaf daemon is replaced,
  // so the journal answers again. No fresh `seed` start is expected on top:
  // runner slots are idempotent by (action, head), and the seed for this
  // head already completed, so the repair reuses its reply and only the
  // daemon itself is new.
  expect(
    second.container.starts.filter((start) => start.command.includes(CANDIDATE_JOURNAL_BINARY)),
  ).toHaveLength(daemonStarts + 1);
  expect(second.container.journalRunning()).toBe(true);
  const tick = await second.box.checkpointNow('tick');
  expect(tick).toMatchObject({
    kind: 'skipped',
    reason: 'candidate merkle-pack tick fenced the published manifest',
  });
});
