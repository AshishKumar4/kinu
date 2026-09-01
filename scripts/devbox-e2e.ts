#!/usr/bin/env bun
/**
 * The deployed devbox lifecycle suite: every storage strategy, the whole
 * lifecycle, on a real container, with a settle ceiling per operation as the
 * oracle.
 *
 * WHAT THIS IS FOR. The strategy benchmark answers "which is faster" and costs
 * hours; it can only answer that once every arm survives its own lifecycle, and
 * three separate deployed runs were spent discovering at the wake, an hour in,
 * that an arm could not. This suite asks the cheaper question first and asks it
 * of all five arms at once: create a box, write through the strategy's own work
 * directory, checkpoint, stop, wake, verify the restored bytes, grow the tree,
 * checkpoint again, attach from a fresh container, verify again, tear down. An
 * arm that hangs, loses bytes, resurrects a deleted file or refuses to attach
 * fails ITS test, in minutes, before a benchmark spends the afternoon.
 *
 * A CEILING HERE IS A TEST DEADLINE, NOT A PRODUCT BOUND. Nothing in the
 * product waits on these numbers and no work path is cancelled by them: they
 * are the oracle this suite judges by, chosen so that ordinary behaviour passes
 * and a hang is reported as a hang instead of as a run that never ended. Every
 * one of them is MEASURED — the cold attach ceiling is the admission contract's
 * own `COLD_ATTACH_CEILING_MS`, and each remaining ceiling is three times the
 * slowest arm's measured settle for THIS suite's workload sizes, from the
 * calibration pass named in its `source`. Three times, because a ceiling that
 * sits close to the median reports load as a defect, and the defects this
 * suite exists to catch — a checkpoint that never publishes, an attach that
 * abandons its budget — are not 3x slow, they are unbounded.
 *
 * WHAT IT DOES NOT PROVE, stated on the green path as well as here: it is not a
 * measurement. Arms run concurrently, each in its own container, and a duration
 * recorded here is a driver-side wall clock that includes this process's poll
 * cadence — fine for "did this settle at all", useless for "which arm is
 * faster", which is `bench-devbox-strategies.ts`'s question and is answered
 * with the fixture's own in-container timings. It proves one lifecycle per arm
 * per run, at two tree sizes, on one account, so it is a smoke test of
 * durability rather than a durability proof; a strategy that fails one run in
 * ten passes here nine times.
 *
 * Usage:
 *   bun scripts/devbox-e2e.ts                 the suite, ceilings enforced
 *   bun scripts/devbox-e2e.ts --calibrate     measure only, print 3x ceilings
 *   bun scripts/devbox-e2e.ts --plan          what it would do, deploying nothing
 *   bun scripts/devbox-e2e.ts --arms r2fs     one arm
 *   bun scripts/devbox-e2e.ts --wedge r2fs    prove the oracle red on a live arm
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import {
  BENCH_ACCOUNT_ID, COLD_ATTACH_CEILING_MS, STRATEGIES, checkpointOperation,
  createFixtureResources, deployFixture, drainBucketResidue, execInBox, r2ResiduePlane,
  retryTransient, startupOperation, stopOperation, teardownLiveArms, writeFileInBox,
  type ArmFixture, type Fixture, type Strategy,
} from './bench-devbox-strategies';
import {
  WRANGLER_FAILED, describeThrown, publishTeardown, runTeardownOnce, runWrangler,
} from './fixtures/r2-bench/deploy-substrate';

const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));
/** Where the in-container workload lives. OUTSIDE `/workspace`, so the harness
 *  is never part of the tree whose bytes are being verified — and therefore
 *  gone after every container replacement, which is why it is reinstalled
 *  before each phase that runs it. */
const HARNESS_DIR = '/var/tmp/devbox-e2e';
const HARNESS_PATH = `${HARNESS_DIR}/workload.ts`;
const WORKLOAD_SOURCE = join(REPO_ROOT, 'scripts/fixtures/devbox-e2e/workload.ts');
/** The subtree every arm writes through and every digest is taken over. */
const WORK_ROOT = '/workspace/e2e';
/** The mid-scale tree, in MiB of generated content. It is written npm-SHAPED
 *  but NOT into `node_modules`: the default exclude policy drops that tree on
 *  purpose, and a suite that wrote there would report the policy as data loss.
 *  See `npmPlan` in the workload fixture. */
const MID_SCALE_MIB = 30;
/** The files the small workload plants to have them deleted before the first
 *  checkpoint. A restore that brings one back fails `restore-verify` by name. */
const DELETED_PATHS = ['delete-me-0.txt', 'delete-me-1.txt', 'delete-me-2.txt'] as const;
/** The file a detached writer holds open across the checkpoint and the stop. */
const OPEN_WRITE_PATH = 'open-write.bin';

// ── the ceilings ────────────────────────────────────────────────────────────

export type LifecycleOp =
  | 'cold-attach' | 'small-workload' | 'checkpoint-small' | 'stop-small' | 'wake-attach'
  | 'restore-verify' | 'mid-workload' | 'checkpoint-mid' | 'stop-mid' | 'cold-reattach'
  | 'reattach-verify' | 'teardown';

export interface OperationCeiling {
  readonly op: LifecycleOp;
  /** The test deadline, in milliseconds. */
  readonly ms: number;
  /** Where the number came from. A ceiling nobody can trace back to a
   *  measurement is a number somebody liked the look of. */
  readonly source: string;
}

/** The measured basis for every ceiling below that is not the admission
 *  contract's own: one calibration pass of THIS suite, all five arms in flight,
 *  2026-09-01, artifact `bench-artifacts/devbox-e2e-e2ecal0901002202.json`. */
export const CALIBRATION_RUN = 'devbox-e2e-e2ecal0901002202';

/** Recorded bench artifacts this suite takes a number from where its own
 *  calibration pass never reached the step. Named, because a ceiling whose
 *  basis is a different workload has to say so. */
const SMOKE_RUN = 'the 20260831184750 smoke artifact';
const LADDER_RUN = 'bench-artifacts/devbox-ab7.json';

const G6 = 'the admission contract\'s COLD_ATTACH_CEILING_MS, unchanged';
const measured = (ms: number, arm: string): string =>
  `3x ${String(ms)} ms, the slowest arm (${arm}) that settled this step in ${CALIBRATION_RUN}`;

/**
 * The ceilings, and where each number comes from.
 *
 * FOUR ARE PROVISIONAL AND SAY SO. No arm has yet reached the mid-scale half of
 * this lifecycle on any run — the calibration pass lost every arm at or before
 * its wake — so there is nothing to take three times. A provisional ceiling is
 * a stated engineering bound with its reasoning, never a measurement wearing
 * one: it keeps one arm's step inside the gate's own deadline with five arms in
 * flight, and the first run that settles the step repins it at 3x measured.
 * Which kind a ceiling is, is readable in its `source`.
 */
const PROVISIONAL = 'PROVISIONAL: no arm has settled this step on any recorded run. Bounded so five '
  + 'arms in flight stay inside the gate deadline; repin at 3x measured on the first run that '
  + 'settles it';

export const CEILINGS: readonly OperationCeiling[] = [
  { op: 'cold-attach', ms: COLD_ATTACH_CEILING_MS, source: G6 },
  { op: 'small-workload', ms: 334_000, source: measured(111_276, 'r2fs') },
  { op: 'checkpoint-small', ms: 83_000, source: measured(27_664, 'merkle-pack') },
  { op: 'stop-small', ms: 25_000, source: measured(8_278, 'merkle-pack') },
  {
    op: 'wake-attach',
    ms: 90_000,
    source: `3x 29,721 ms, the slowest wake in a complete arm (${LADDER_RUN}, snapshot-chain, `
      + 'over a 64 MiB ladder tree — an upper bound for this suite\'s 1 MB one). No arm settled '
      + `a wake in ${CALIBRATION_RUN}: two hit the wall and one refused`,
  },
  {
    op: 'restore-verify',
    ms: 334_000,
    source: `3x 111,276 ms, the small-workload step in ${CALIBRATION_RUN} (r2fs), which writes AND `
      + 'digests the same tree this step digests and reads — strictly more work',
  },
  { op: 'mid-workload', ms: 900_000, source: PROVISIONAL },
  {
    op: 'checkpoint-mid',
    ms: 130_000,
    source: `3x 43,143 ms, the 64 MiB quiesce in ${SMOKE_RUN} (snapshot-chain) — twice this `
      + 'suite\'s 30 MiB tree, so an upper bound',
  },
  {
    op: 'stop-mid',
    ms: 155_000,
    source: '3x 50,891 ms, the slowest recorded stop in any complete arm '
      + '(bench-artifacts/devbox-strategies-20260825230839.json, overlay-cas)',
  },
  { op: 'cold-reattach', ms: COLD_ATTACH_CEILING_MS, source: G6 },
  { op: 'reattach-verify', ms: 400_000, source: PROVISIONAL },
  { op: 'teardown', ms: 300_000, source: PROVISIONAL },
];

export function ceilingFor(op: LifecycleOp, ceilings: readonly OperationCeiling[]): OperationCeiling {
  const found = ceilings.find((ceiling) => ceiling.op === op);
  if (found === undefined) throw new Error(`no ceiling is declared for ${op}`);
  return found;
}

/**
 * What a calibration pass bounds each operation at.
 *
 * Generous on purpose — it is not an oracle, it is the wall that stops a
 * calibration pass from running forever when the thing being calibrated is
 * broken. A calibration number that came out of a bounded wait is reported as
 * such and is not turned into a ceiling.
 */
export const CALIBRATION_CEILING_MS = 900_000;

/**
 * How much longer than its ceiling an operation is given to notice it lost.
 *
 * The ceiling is enforced by this driver, so the verdict is exact; the
 * operation underneath is ALSO handed the same deadline plus this grace, so its
 * own poll loop ends shortly afterwards instead of running to the benchmark's
 * 25-minute operation deadline behind a verdict that has already been recorded.
 */
const CEILING_GRACE_MS = 15_000;

// ── the verdict ─────────────────────────────────────────────────────────────

export interface StepRecord {
  readonly op: LifecycleOp;
  readonly ms: number;
  readonly ceilingMs: number;
  readonly ok: boolean;
  /** What the operation answered, in its own words. */
  readonly detail: string;
}

export interface StrategyVerdict {
  readonly strategy: Strategy;
  readonly box: string;
  readonly passed: boolean;
  readonly steps: StepRecord[];
  readonly failures: string[];
  readonly notes: string[];
}

/** The one sentence a failing step reports, in the one shape every reader of
 *  this suite learns once: which arm, which operation, what bound, what it
 *  actually did. */
export function ceilingRefusal(
  strategy: string, op: LifecycleOp, ceilingMs: number, elapsedMs: number, detail: string,
): string {
  return `${strategy}: ${op} did not settle inside its ${String(ceilingMs)} ms ceiling `
    + `(${String(elapsedMs)} ms elapsed): ${detail}`;
}

/** The same sentence for a step that ANSWERED inside its ceiling and answered
 *  wrongly. Kept distinct because "it hung" and "it came back with the wrong
 *  bytes" are different defects and a reader must not have to infer which. */
export function wrongAnswer(
  strategy: string, op: LifecycleOp, elapsedMs: number, detail: string,
): string {
  return `${strategy}: ${op} settled in ${String(elapsedMs)} ms and did not hold: ${detail}`;
}

// ── the deployed operations, behind one seam ────────────────────────────────

export interface StartupOutcome { readonly ms: number; readonly kind: string; readonly detail: string }
export interface SettleOutcome { readonly ms: number; readonly ok: boolean; readonly detail: string }
export interface ExecOutcome { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

/**
 * Every deployed thing one lifecycle does.
 *
 * A seam rather than direct calls, for one reason: the oracle has to be
 * provable RED without a deployment. `devbox-e2e.test.ts` runs this same
 * lifecycle against a seam whose checkpoint never settles and asserts the
 * failure names the operation and the arm inside the ceiling window. Against
 * the deployed fixture the implementation is `deployedSeam`, which is the bench
 * harness's own routes and nothing else.
 */
export interface LifecycleSeam {
  readonly startup: (
    kick: '/create' | '/wake', operation: string, allowed: readonly string[], deadlineMs: number,
  ) => Promise<StartupOutcome>;
  readonly checkpoint: (what: string, deadlineMs: number) => Promise<SettleOutcome>;
  readonly stop: (what: string, deadlineMs: number) => Promise<SettleOutcome>;
  readonly exec: (command: string) => Promise<ExecOutcome>;
  readonly write: (path: string, content: string) => Promise<void>;
  /** Bounded like every other step: a box wedged in its own attach loop can
   *  hold a `/teardown` request open indefinitely, and this suite's verdict is
   *  a ceiling. Measured on `r2fs` and `overlay-cas` in the calibration run,
   *  both of which spent 900,000 ms on one unbounded request. */
  readonly teardown: (deadlineMs: number) => Promise<void>;
}

export function deployedSeam(fixture: Fixture, box: string): LifecycleSeam {
  return {
    startup: async (kick, operation, allowed, deadlineMs): Promise<StartupOutcome> => {
      const completed = await startupOperation(fixture, box, kick, operation, allowed, { deadlineMs });
      return { ms: completed.ms, kind: completed.attach.kind, detail: completed.attach.detail };
    },
    checkpoint: async (what, deadlineMs): Promise<SettleOutcome> => {
      const settled = await checkpointOperation(fixture, box, 'quiesce', what, { deadlineMs });
      const kind = settled.outcome?.kind ?? 'unknown';
      return {
        ms: settled.ms ?? -1,
        ok: kind === 'committed',
        detail: settled.error ?? `${kind}${settled.outcome?.reason === undefined ? '' : ` (${settled.outcome.reason})`}`
          + ` moved=${String(settled.outcome?.movedBytes ?? 'n/a')} held=${String(settled.outcome?.bytes ?? 0)}B`,
      };
    },
    stop: async (what, deadlineMs): Promise<SettleOutcome> => {
      const settled = await stopOperation(fixture, box, what, { deadlineMs });
      return {
        ms: settled.ms ?? -1,
        ok: settled.ok === true,
        detail: settled.error ?? (settled.ok === true ? 'stopped' : 'the stop did not confirm'),
      };
    },
    exec: async (command): Promise<ExecOutcome> => {
      const reply = await retryTransient(`exec ${command.slice(0, 40)}`, async () =>
        await execInBox(fixture, box, command),
      );
      return {
        exitCode: reply.exitCode ?? -1,
        stdout: reply.stdout ?? '',
        stderr: reply.stderr ?? reply.error ?? '',
      };
    },
    write: async (path, content): Promise<void> => { await writeFileInBox(fixture, box, path, content); },
    teardown: async (deadlineMs): Promise<void> => {
      const errors = await teardownLiveArms(fixture, [box], undefined, deadlineMs);
      if (errors.length > 0) throw new Error(`live teardown failed: ${errors.join('; ')}`);
    },
  };
}

// ── the oracle ──────────────────────────────────────────────────────────────

/** A promise abandoned at its ceiling, kept so the process can account for it
 *  rather than trip over its rejection later. */
export interface StrandedWork {
  readonly what: string;
  readonly settled: Promise<void>;
}

/**
 * Run one operation under its ceiling.
 *
 * The ceiling is a RACE here rather than only a deadline handed downwards,
 * because the defect class this suite exists to catch is an operation that
 * never answers at all — including one hung below the layer that accepts a
 * deadline. The abandoned work is not orphaned: it keeps a handler and is
 * accounted for at the end of the run.
 */
export async function underCeiling<T>(
  what: string,
  ceilingMs: number,
  stranded: StrandedWork[],
  run: (deadlineMs: number) => Promise<T>,
): Promise<T> {
  const work = run(ceilingMs + CEILING_GRACE_MS);
  // The refusal is built here so the catch below can tell — by identity, not by
  // a flag two settling promises can race — whether the CEILING ended this or
  // the operation itself did. An operation that refused on its own has nothing
  // abandoned behind it, and recording one would put a note about a hang under
  // every wrong answer.
  const passedItsCeiling = new Error(`${what} passed its ${String(ceilingMs)} ms ceiling`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(passedItsCeiling); }, ceilingMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } catch (error) {
    if (error !== passedItsCeiling) throw error;
    // The abandoned operation still settles, and its late outcome is evidence:
    // "the checkpoint answered 40 s after we stopped waiting" and "it never
    // answered at all" are different findings. Attaching the handler HERE is
    // also what keeps a late rejection from reaching the process as an
    // unhandled one and failing a run that already has its verdict.
    const account = async (): Promise<void> => {
      try {
        await work;
        logLine(`${what}: the abandoned operation later succeeded`);
      } catch (late) {
        logLine(`${what}: the abandoned operation later refused: ${describeThrown({ cause: late })}`);
      }
    };
    stranded.push({ what, settled: account() });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ── the lifecycle ───────────────────────────────────────────────────────────

/** What `workload.ts digest` answers: the whole tree as one value, plus the two
 *  counts that tell a reader whether a mismatch is a loss or a resurrection. */
export interface TreeDigest {
  readonly ok: boolean;
  readonly files: number;
  readonly bytes: number;
  readonly digest: string;
}
const TreeDigestSchema: v.GenericSchema<TreeDigest> = v.looseObject({
  ok: v.boolean(),
  files: v.number(),
  bytes: v.number(),
  digest: v.string(),
});

/** What a workload command answers when only its success is read. */
interface WorkloadAck { readonly ok: boolean }
const WorkloadAckSchema: v.GenericSchema<WorkloadAck> = v.looseObject({ ok: v.boolean() });

/** What `workload.ts absent` answers: the deleted paths that came back. It is
 *  read on BOTH exit codes, because a non-zero exit here is the finding rather
 *  than a failure to look — decoding only the zero case is how the sentence
 *  naming a resurrected file became unreachable. */
interface AbsentReply {
  readonly ok: boolean;
  readonly resurrected: string[];
}
const AbsentReplySchema: v.GenericSchema<AbsentReply> = v.looseObject({
  ok: v.boolean(),
  resurrected: v.array(v.string()),
});

/** What `workload.ts read` answers about one file, from inside the container. */
interface FileReply {
  readonly ok: boolean;
  readonly exists: boolean;
  readonly bytes: number;
  readonly content: string;
}
const FileReplySchema: v.GenericSchema<FileReply> = v.looseObject({
  ok: v.boolean(),
  exists: v.boolean(),
  bytes: v.number(),
  content: v.string(),
});

/** The one JSON object a workload command answers, decoded at this boundary. A
 *  command whose output cannot be decoded is a failed step carrying what the
 *  container actually printed, never a default. */
function decodeReply<TSchema extends v.GenericSchema>(
  schema: TSchema, what: string, outcome: ExecOutcome,
): v.InferOutput<TSchema> {
  const start = outcome.stdout.indexOf('{');
  if (start === -1) {
    throw new Error(
      `${what} printed no JSON (exit ${String(outcome.exitCode)}): `
      + `${(outcome.stdout + outcome.stderr).slice(0, 300)}`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(outcome.stdout.slice(start));
  } catch (error) {
    throw new Error(`${what} printed unparseable JSON: ${outcome.stdout.slice(start, start + 300)}`, { cause: error });
  }
  const parsed = v.safeParse(schema, decoded);
  if (!parsed.success) {
    throw new Error(`${what} answered a reply this suite cannot read: ${outcome.stdout.slice(start, start + 300)}`);
  }
  return parsed.output;
}

export interface LifecycleOptions {
  readonly ceilings: readonly OperationCeiling[];
  readonly seed: string;
  readonly midScaleMib: number;
  /** The workload program, as bytes to install in the box. */
  readonly workloadSource: string;
  readonly log: (message: string) => void;
}

/**
 * One arm's whole lifecycle, and every step's verdict.
 *
 * NEVER THROWS. A step that fails ends the lifecycle and the teardown still
 * runs, because this function's failure mode is one arm's verdict rather than
 * the run's: five arms are in flight and one hanging checkpoint may not take
 * the other four's evidence with it.
 */
export async function runLifecycle(
  strategy: Strategy,
  box: string,
  seam: LifecycleSeam,
  options: LifecycleOptions,
): Promise<StrategyVerdict> {
  const steps: StepRecord[] = [];
  const failures: string[] = [];
  const notes: string[] = [];
  const stranded: StrandedWork[] = [];

  const step = async <T>(op: LifecycleOp, run: (deadlineMs: number) => Promise<T>): Promise<T> => {
    const ceiling = ceilingFor(op, options.ceilings);
    const started = Date.now();
    options.log(`${strategy}: ${op} (ceiling ${String(ceiling.ms)} ms)`);
    try {
      const value = await underCeiling(`${strategy} ${op}`, ceiling.ms, stranded, run);
      steps.push({ op, ms: Date.now() - started, ceilingMs: ceiling.ms, ok: true, detail: 'settled' });
      return value;
    } catch (error) {
      const elapsed = Date.now() - started;
      const detail = describeThrown({ cause: error });
      const text = elapsed >= ceiling.ms
        ? ceilingRefusal(strategy, op, ceiling.ms, elapsed, detail)
        : wrongAnswer(strategy, op, elapsed, detail);
      steps.push({ op, ms: elapsed, ceilingMs: ceiling.ms, ok: false, detail });
      failures.push(text);
      throw new Error(text, { cause: error });
    }
  };

  /** A step's own assertion. Inside the ceiling and wrong is still a failure,
   *  and it reads as one rather than as a timeout. */
  const require = (condition: boolean, what: string): void => {
    if (!condition) throw new Error(what);
  };

  /** One workload command whose non-zero exit is a failure to run. */
  const workload = async (command: string, what: string): Promise<ExecOutcome> => {
    const outcome = await seam.exec(`cd ${HARNESS_DIR} && bun ${HARNESS_PATH} ${command}`);
    if (outcome.exitCode !== 0) {
      throw new Error(`${what} exited ${String(outcome.exitCode)}: ${(outcome.stdout + outcome.stderr).slice(0, 300)}`);
    }
    return outcome;
  };

  /** The deletion check, whose non-zero exit carries the answer. */
  const resurrected = async (): Promise<string[]> => decodeReply(
    AbsentReplySchema,
    'deletion check',
    await seam.exec(
      `cd ${HARNESS_DIR} && bun ${HARNESS_PATH} absent --root ${WORK_ROOT} --paths ${DELETED_PATHS.join(',')}`,
    ),
  ).resurrected;

  /** The harness lives on the container's own disk, which nothing preserves.
   *  Reinstalled before every phase that runs it, which is also this suite's
   *  cheapest observation that the box is answering at all. */
  const installHarness = async (): Promise<void> => {
    await seam.exec(`mkdir -p ${HARNESS_DIR}`);
    await seam.write(HARNESS_PATH, options.workloadSource);
    const present = await seam.exec(`test -f ${HARNESS_PATH} && echo YES || echo NO`);
    require(present.stdout.includes('YES'), `the workload harness is not present at ${HARNESS_PATH}`);
  };

  const digest = async (what: string): Promise<TreeDigest> =>
    decodeReply(TreeDigestSchema, what, await workload(`digest --root ${WORK_ROOT}`, what));

  const marker = `devbox-e2e-${crypto.randomUUID()}`;
  const markerPath = `${WORK_ROOT}/marker.txt`;
  const openWriteContent = `open-write-${crypto.randomUUID()}`;
  let smallDigest = '';
  let midDigest = '';

  try {
    // ── the box exists and a fresh container attached it ──────────────────
    const cold = await step('cold-attach', async (deadlineMs) =>
      await seam.startup('/create', `${strategy} cold attach`, ['empty', 'attached'], deadlineMs),
    );
    notes.push(`cold attach: ${cold.kind} — ${cold.detail}`);

    // ── ~1 MB of mixed files, written THROUGH the strategy's work directory ──
    smallDigest = await step('small-workload', async () => {
      await installHarness();
      const written = decodeReply(
        WorkloadAckSchema, 'small workload',
        await workload(`small --root ${WORK_ROOT} --seed ${options.seed}`, 'small workload'),
      );
      require(written.ok, 'the small workload did not report success');
      // The one file whose bytes THIS PROCESS knows, so the restore is checked
      // against the driver's own ground truth and not only against a digest the
      // container computed twice.
      await seam.write(markerPath, marker);
      await workload(
        `delete --root ${WORK_ROOT} --paths ${DELETED_PATHS.join(',')}`, 'planned deletions',
      );
      // The open handle has to exist BEFORE the checkpoint it is measured
      // across, and it must outlive this exec — hence detached.
      await seam.exec(
        `cd ${HARNESS_DIR} && nohup bun ${HARNESS_PATH} hold-open --root ${WORK_ROOT} `
        + `--path ${OPEN_WRITE_PATH} --content ${openWriteContent} --hold-ms 1800000 `
        + '>/dev/null 2>&1 & echo spawned',
      );
      const held = decodeReply(
        FileReplySchema, 'open-write arming',
        await workload(`read --root ${WORK_ROOT} --path ${OPEN_WRITE_PATH}`, 'open-write arming'),
      );
      require(held.content === openWriteContent, `the open write was not flushed before the checkpoint: ${held.content}`);
      const taken = await digest('small tree digest');
      require(taken.files > 100, `the small tree holds ${String(taken.files)} files`);
      return taken.digest;
    });

    // ── commit, recycle, and restore ──────────────────────────────────────
    await step('checkpoint-small', async (deadlineMs) => {
      const settled = await seam.checkpoint(`${strategy} first checkpoint`, deadlineMs);
      require(settled.ok, `the first checkpoint did not commit: ${settled.detail}`);
      return settled;
    });
    await step('stop-small', async (deadlineMs) => {
      const settled = await seam.stop(`${strategy} stop`, deadlineMs);
      require(settled.ok, `the stop did not confirm: ${settled.detail}`);
      return settled;
    });
    // ── the wake ──────────────────────────────────────────────────────────
    //
    // THE LIVE PROOF OF THE GATE-TIME RESTORE IS NOT WIRED HERE, deliberately,
    // and the reason is worth stating rather than leaving as an omission. The
    // restore now runs inside the container-start hook, which the SDK awaits in
    // `blockConcurrencyWhile`, so while it is held the runtime delivers no event
    // to the box: an `/exec` posted the moment a wake starts is not queued
    // behind a promise this code holds, it is not delivered at all until the
    // restore has settled. Proving that needs a racing operation whose REPLY
    // carries container bytes, and the only channel this suite has for that is
    // the workload harness — which is installed after the wake, so a racing
    // call cannot use it. The property is held instead by
    // `packages/devbox/tests/restore-in-gate.test.ts`, which drives an operation
    // during EVERY restore phase and pins that it observes only the finished
    // world or a box that names what is missing.
    const woke = await step('wake-attach', async (deadlineMs) =>
      await seam.startup('/wake', `${strategy} wake`, ['attached'], deadlineMs),
    );
    notes.push(`wake: ${woke.kind} — ${woke.detail}`);

    await step('restore-verify', async () => {
      await installHarness();
      const restored = await digest('restored tree digest');
      require(
        restored.digest === smallDigest,
        `the restored tree is not the tree that was checkpointed `
        + `(${String(restored.files)} files / ${String(restored.bytes)} B restored)`,
      );
      const readMarker = decodeReply(
        FileReplySchema, 'marker read',
        await workload(`read --root ${WORK_ROOT} --path marker.txt`, 'marker read'),
      );
      require(readMarker.content === marker, `the marker file came back as ${readMarker.content.slice(0, 60)}`);
      const back = await resurrected();
      require(
        back.length === 0,
        `a file deleted before the checkpoint came back after the restore: ${back.join(', ')}`,
      );
      const openWrite = decodeReply(
        FileReplySchema, 'open-write read',
        await workload(`read --root ${WORK_ROOT} --path ${OPEN_WRITE_PATH}`, 'open-write read'),
      );
      require(
        openWrite.content === openWriteContent,
        'the bytes a writer flushed before the checkpoint did not survive the recycle '
        + `(${String(openWrite.bytes)} B back)`,
      );
      return restored.digest;
    });

    // ── the same lifecycle again, at a tree size that finds the scaling ────
    midDigest = await step('mid-workload', async () => {
      const written = decodeReply(
        WorkloadAckSchema, 'mid workload',
        await workload(
          `npm --root ${WORK_ROOT} --seed ${options.seed} --mib ${String(options.midScaleMib)}`,
          'mid workload',
        ),
      );
      require(written.ok, 'the mid-scale workload did not report success');
      const taken = await digest('mid tree digest');
      require(
        taken.bytes > options.midScaleMib * 1_000_000,
        `the mid tree holds ${String(taken.bytes)} B, short of the ${String(options.midScaleMib)} MiB asked for`,
      );
      return taken.digest;
    });
    await step('checkpoint-mid', async (deadlineMs) => {
      const settled = await seam.checkpoint(`${strategy} second checkpoint`, deadlineMs);
      require(settled.ok, `the second checkpoint did not commit: ${settled.detail}`);
      return settled;
    });
    await step('stop-mid', async (deadlineMs) => {
      const settled = await seam.stop(`${strategy} release`, deadlineMs);
      require(settled.ok, `the release did not confirm: ${settled.detail}`);
      return settled;
    });

    // ── a fresh container, holding nothing, attaching the whole tree ───────
    const reattached = await step('cold-reattach', async (deadlineMs) =>
      await seam.startup('/create', `${strategy} cold reattach`, ['attached'], deadlineMs),
    );
    notes.push(`cold reattach: ${reattached.kind} — ${reattached.detail}`);

    await step('reattach-verify', async () => {
      await installHarness();
      const restored = await digest('reattached tree digest');
      require(
        restored.digest === midDigest,
        'the tree a fresh container attached is not the tree that was checkpointed '
        + `(${String(restored.files)} files / ${String(restored.bytes)} B restored)`,
      );
      const back = await resurrected();
      require(
        back.length === 0,
        `a file deleted two checkpoints ago came back on the cold reattach: ${back.join(', ')}`,
      );
      return restored.digest;
    });
  } catch (error) {
    // Already recorded by `step`, which is the only thing that throws here. An
    // unrecorded throw is this suite's own defect and says so rather than
    // vanishing into a passing arm.
    if (failures.length === 0) failures.push(`${strategy}: the lifecycle threw before any step failed: ${describeThrown({ cause: error })}`);
  }

  // TEARDOWN ON BOTH PATHS. A failed arm is exactly the arm whose box is still
  // holding a container instance and whose store is still holding its bytes.
  try {
    await underCeiling(`${strategy} teardown`, ceilingFor('teardown', options.ceilings).ms, stranded,
      // HALVED, because `teardownLiveArms` makes two idempotent passes and the
      // ceiling is what the step is judged by: one pass may not spend the whole
      // window and leave the second with nothing to run in.
      async (deadlineMs) => { await seam.teardown(Math.floor(deadlineMs / 2)); });
    steps.push({
      op: 'teardown', ms: 0, ceilingMs: ceilingFor('teardown', options.ceilings).ms, ok: true, detail: 'purged',
    });
  } catch (error) {
    const detail = describeThrown({ cause: error });
    steps.push({
      op: 'teardown', ms: 0, ceilingMs: ceilingFor('teardown', options.ceilings).ms, ok: false, detail,
    });
    failures.push(`${strategy}: teardown did not complete: ${detail}`);
  }

  for (const abandoned of stranded) notes.push(`abandoned at its ceiling: ${abandoned.what}`);
  return { strategy, box, passed: failures.length === 0, steps, failures, notes };
}

// ── the run ─────────────────────────────────────────────────────────────────

const logLine = (message: string): void => {
  process.stderr.write(`[devbox-e2e] ${message}\n`);
};

export interface Options {
  readonly arms: readonly Strategy[];
  readonly runId: string;
  readonly seed: string;
  readonly calibrate: boolean;
  readonly plan: boolean;
  readonly keep: boolean;
  readonly midScaleMib: number;
  /** The arm whose checkpoint is deliberately wedged, to prove the oracle red
   *  against a real deployment. Never set by the gate. */
  readonly wedge: Strategy | null;
  readonly out: string;
}

const HELP = `Usage: bun scripts/devbox-e2e.ts [options]

  --arms a,b        arms to run (default: every strategy)
  --calibrate       measure with a generous bound and print 3x ceilings
  --plan            print what would run and exit
  --keep            leave the deployed fixtures in place
  --seed <text>     workload seed (default: devbox-e2e)
  --mib <n>         mid-scale tree size in MiB (default: ${String(MID_SCALE_MIB)})
  --wedge <arm>     wedge that arm's first checkpoint, to prove the oracle red
  --out <path>      artifact path
`;

export function parseOptions(argv: readonly string[]): Options {
  const value = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
  };
  const requested = value('arms', '').split(',').map((arm) => arm.trim()).filter((arm) => arm.length > 0);
  const unknown = requested.filter((arm) => !STRATEGIES.some((strategy) => strategy === arm));
  if (unknown.length > 0) throw new Error(`unknown arm(s): ${unknown.join(', ')}`);
  const arms = requested.length === 0
    ? STRATEGIES
    : STRATEGIES.filter((strategy) => requested.includes(strategy));
  const wedgeName = value('wedge', '');
  const wedge = STRATEGIES.find((arm) => arm === wedgeName) ?? null;
  if (wedgeName.length > 0 && wedge === null) throw new Error(`unknown arm to wedge: ${wedgeName}`);
  const runId = value('run-id', `e2e${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`);
  return {
    arms,
    runId,
    seed: value('seed', 'devbox-e2e'),
    calibrate: argv.includes('--calibrate'),
    plan: argv.includes('--plan'),
    keep: argv.includes('--keep'),
    midScaleMib: Number.parseInt(value('mib', String(MID_SCALE_MIB)), 10),
    wedge,
    out: value('out', join('bench-artifacts', `devbox-e2e-${runId}.json`)),
  };
}

/** The ceilings a run judges by: the declared table, or the calibration wall. */
export function ceilingsFor(calibrate: boolean): readonly OperationCeiling[] {
  if (!calibrate) return CEILINGS;
  return CEILINGS.map((ceiling) => ({
    op: ceiling.op,
    ms: CALIBRATION_CEILING_MS,
    source: 'calibration pass: a wall, not an oracle',
  }));
}

/**
 * What a calibration pass proposes, per operation: three times the slowest arm
 * that actually settled, rounded up to the next second. Printed rather than
 * written, because a ceiling is a decision somebody records in the table above
 * with the run it came from.
 */
export function proposedCeilings(
  verdicts: readonly StrategyVerdict[],
): { op: LifecycleOp; measuredMs: number; arm: string; proposedMs: number }[] {
  const proposals: { op: LifecycleOp; measuredMs: number; arm: string; proposedMs: number }[] = [];
  for (const ceiling of CEILINGS) {
    let slowest = { arm: '', ms: -1 };
    for (const verdict of verdicts) {
      for (const step of verdict.steps) {
        if (step.op === ceiling.op && step.ok && step.ms > slowest.ms) {
          slowest = { arm: verdict.strategy, ms: step.ms };
        }
      }
    }
    if (slowest.ms < 0) continue;
    proposals.push({
      op: ceiling.op,
      measuredMs: slowest.ms,
      arm: slowest.arm,
      proposedMs: Math.ceil((slowest.ms * 3) / 1_000) * 1_000,
    });
  }
  return proposals;
}

/** The wedge: one arm's first checkpoint replaced by an operation that never
 *  settles, so a live run proves the ceiling fires on a real deployment and
 *  names the arm and the operation. */
export function wedgedSeam(seam: LifecycleSeam): LifecycleSeam {
  let wedged = false;
  return {
    ...seam,
    checkpoint: async (what, deadlineMs): Promise<SettleOutcome> => {
      if (wedged) return await seam.checkpoint(what, deadlineMs);
      wedged = true;
      return await new Promise<SettleOutcome>(() => {
        logLine(`WEDGE: ${what} will never settle; the ceiling is the only thing that can end it`);
      });
    },
  };
}

export function render(verdicts: readonly StrategyVerdict[], options: Options): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`Devbox deployed lifecycle suite — run ${options.runId}`);
  lines.push(options.calibrate
    ? 'CALIBRATION PASS: ceilings are not enforced; the numbers below are the basis for them.'
    : 'Ceilings enforced. A ceiling is this suite\'s test deadline, never a product bound.');
  lines.push('');
  const ops = CEILINGS.map((ceiling) => ceiling.op);
  const header = ['operation'.padEnd(18), 'ceiling'.padStart(9), ...verdicts.map((verdict) => verdict.strategy.padStart(15))];
  lines.push(header.join(' '));
  for (const op of ops) {
    const ceiling = ceilingFor(op, ceilingsFor(options.calibrate));
    const cells = verdicts.map((verdict) => {
      const step = verdict.steps.find((row) => row.op === op);
      if (step === undefined) return 'not reached'.padStart(15);
      return `${step.ok ? '' : 'FAIL '}${String(step.ms)}`.padStart(15);
    });
    lines.push([op.padEnd(18), `${String(ceiling.ms)}`.padStart(9), ...cells].join(' '));
  }
  lines.push('');
  for (const verdict of verdicts) {
    lines.push(`${verdict.passed ? 'PASS' : 'FAIL'}  ${verdict.strategy}  (box ${verdict.box})`);
    for (const failure of verdict.failures) lines.push(`        ${failure}`);
  }
  lines.push('');
  if (options.calibrate) {
    lines.push('Proposed ceilings — 3x the slowest arm that settled:');
    for (const proposal of proposedCeilings(verdicts)) {
      lines.push(
        `  ${proposal.op.padEnd(18)} measured ${String(proposal.measuredMs).padStart(7)} ms `
        + `(${proposal.arm}) -> ${String(proposal.proposedMs)} ms`,
      );
    }
    lines.push('');
  }
  // THE BLIND SPOTS, ON THE GREEN PATH. A limitation visible only in red output
  // is invisible exactly when the tree is green.
  lines.push('What a green run here does NOT prove:');
  lines.push('  - nothing about SPEED. Durations are driver-side wall clocks with five arms in');
  lines.push('    flight; ranking is bench-devbox-strategies.ts\'s question, on the fixture\'s own timings.');
  lines.push('  - nothing about a defect that needs a bigger tree than this suite writes');
  lines.push(`    (${String(options.midScaleMib)} MiB), or more than one recycle per size.`);
  lines.push('  - nothing about concurrency INSIDE one box: one writer, one lifecycle, no contention.');
  lines.push('  - nothing about a flaky arm: one lifecycle per arm per run, so one pass in ten reads green.');
  return lines.join('\n');
}

/** One arm's deployment, and what the run has to give back. */
interface Lane {
  readonly fixture: ArmFixture;
  readonly box: string;
  live: Fixture | null;
  stop: (() => readonly string[]) | null;
  refusal: string | null;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const options = parseOptions(argv);
  const ceilings = ceilingsFor(options.calibrate);
  const planned = options.arms.map((arm) => `${arm}: box ab-${arm}-${options.runId}`);
  if (options.plan) {
    process.stdout.write(
      `Devbox deployed lifecycle suite\n\narms          ${options.arms.join(', ')}\n`
      + `${planned.map((line) => `  ${line}`).join('\n')}\n`
      + `ceilings      ${ceilings.map((ceiling) => `${ceiling.op}=${String(ceiling.ms)}ms`).join(', ')}\n`
      + `mid scale     ${String(options.midScaleMib)} MiB\nartifact      ${options.out}\n`
      + '\nNothing has run. Drop --plan to execute.\n',
    );
    return 0;
  }

  process.env.CLOUDFLARE_ACCOUNT_ID = BENCH_ACCOUNT_ID;
  if (runWrangler(REPO_ROOT, ['whoami'], { allowFailure: true }).startsWith(WRANGLER_FAILED)) {
    logLine('wrangler is not authenticated; nothing can be deployed and nothing can be proved');
    return 1;
  }

  const workloadSource = readFileSync(WORKLOAD_SOURCE, 'utf8');
  const startedAt = new Date().toISOString();
  const fixtures = await createFixtureResources(options.runId, options.arms);
  const lanes: Lane[] = fixtures.arms.map((fixture) => ({
    fixture,
    box: `ab-${fixture.strategy}-${options.runId}`,
    live: null,
    stop: null,
    refusal: null,
  }));
  const r2AccessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const r2SecretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
  const residue = r2AccessKeyId !== undefined && r2SecretAccessKey !== undefined
    ? r2ResiduePlane({ accountId: BENCH_ACCOUNT_ID, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey })
    : null;
  if (residue === null) {
    logLine('R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are absent: an interrupted run\'s bucket residue '
      + 'cannot be drained, and a bucket delete may refuse');
  }
  const token = `devbox-e2e-${crypto.randomUUID()}`;
  const verdicts: StrategyVerdict[] = [];
  const teardownErrors: string[] = [];

  // TEARDOWN IS PUBLISHED BEFORE THE FIRST DEPLOY, and runs on a signal as well
  // as on the ordinary exit: `finally` does not run when the process is killed,
  // and a fixture Worker left on workers.dev is a live exec endpoint.
  publishTeardown(async (): Promise<void> => {
    if (options.keep) {
      logLine('--keep left every Worker, container application, bucket and generated config in place');
      return;
    }
    for (const lane of lanes) {
      if (lane.live !== null) {
        const errors = await teardownLiveArms(lane.live, [lane.box]);
        teardownErrors.push(...errors);
      }
      const statuses = lane.stop?.() ?? [];
      for (const status of statuses.filter((status) => /failed/i.test(status))) {
        teardownErrors.push(`${lane.fixture.strategy}: ${status}`);
      }
      let deleted = runWrangler(REPO_ROOT, ['r2', 'bucket', 'delete', lane.fixture.bucket], { allowFailure: true });
      if (deleted.startsWith(WRANGLER_FAILED) && /not empty|10008/i.test(deleted) && residue !== null) {
        const drained = await drainBucketResidue(residue, lane.fixture.bucket);
        logLine(`${lane.fixture.bucket}: drained ${String(drained.objects)} object(s), `
          + `aborted ${String(drained.uploads)} upload(s)`);
        deleted = runWrangler(REPO_ROOT, ['r2', 'bucket', 'delete', lane.fixture.bucket], { allowFailure: true });
      }
      if (deleted.startsWith(WRANGLER_FAILED) && !/not found|does not exist/i.test(deleted)) {
        teardownErrors.push(`${lane.fixture.bucket}: ${deleted.slice(0, 200)}`);
      }
    }
    fixtures.disposeConfig();
    logLine(teardownErrors.length === 0
      ? 'teardown complete: every Worker, container application and bucket is gone'
      : `teardown left work behind: ${teardownErrors.join('; ')}`);
  });

  try {
    // DEPLOYS FIRST AND SERIALLY, outside the measured window: `runWrangler` is
    // `execFileSync`, which stops this process's event loop, so a deploy beside
    // a measuring sibling would be charged to that sibling's attach ceiling.
    for (const lane of lanes) {
      try {
        runWrangler(REPO_ROOT, ['r2', 'bucket', 'create', lane.fixture.bucket]);
        const started = await deployFixture(token, lane.fixture);
        lane.live = started.fixture;
        lane.stop = started.stop;
        logLine(`${lane.fixture.strategy}: deployed at ${started.fixture.origin}`);
      } catch (error) {
        lane.refusal = `deploy failed: ${describeThrown({ cause: error })}`;
        logLine(`${lane.fixture.strategy}: ${lane.refusal}`);
      }
    }

    // EVERY ARM AT ONCE. Each has its own Worker, bucket and container, so the
    // only thing they share is this driver's polling, which waits on the
    // network. A lane records its own failure and never throws, so one hanging
    // checkpoint cannot take a sibling's evidence with it.
    verdicts.push(...await Promise.all(lanes.map(async (lane): Promise<StrategyVerdict> => {
      const live = lane.live;
      if (live === null) {
        return {
          strategy: lane.fixture.strategy,
          box: lane.box,
          passed: false,
          steps: [],
          failures: [`${lane.fixture.strategy}: ${lane.refusal ?? 'this arm was never deployed'}`],
          notes: [],
        };
      }
      const base = deployedSeam(live, lane.box);
      return await runLifecycle(
        lane.fixture.strategy,
        lane.box,
        options.wedge === lane.fixture.strategy ? wedgedSeam(base) : base,
        {
          ceilings,
          seed: options.seed,
          midScaleMib: options.midScaleMib,
          workloadSource,
          log: logLine,
        },
      );
    })));
  } finally {
    await runTeardownOnce();
  }

  const artifact = {
    meta: {
      run: options.runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      arms: options.arms,
      calibration: options.calibrate,
      wedged: options.wedge,
      midScaleMib: options.midScaleMib,
      workers: lanes.map((lane) => lane.fixture.worker),
      buckets: lanes.map((lane) => lane.fixture.bucket),
    },
    ceilings,
    verdicts,
    teardownErrors,
    proposals: options.calibrate ? proposedCeilings(verdicts) : [],
  };
  mkdirSync(dirname(join(REPO_ROOT, options.out)), { recursive: true });
  writeFileSync(join(REPO_ROOT, options.out), `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${render(verdicts, options)}\n`);
  logLine(`artifact written to ${options.out}`);

  // A CALIBRATION PASS NEVER PASSES A GATE. It enforces no ceiling, so its exit
  // code answers only "did the run complete", and reading it as a suite result
  // is exactly the mistake this line prevents.
  if (options.calibrate) return verdicts.every((verdict) => verdict.steps.length > 0) ? 0 : 1;
  const failed = verdicts.filter((verdict) => !verdict.passed);
  if (teardownErrors.length > 0) {
    logLine(`teardown errors: ${teardownErrors.join('; ')}`);
    return 1;
  }
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
