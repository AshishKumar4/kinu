#!/usr/bin/env bun
/**
 * WHICH reference refuses the r2fs detach — measured on a real container.
 *
 * Live run probe09011530 reported `the work directory could not be detached
 * while these processes were still holding it: 258 (bun)` with a chained
 * `fusermount: failed to unmount /workspace: Device or resource busy`, and the
 * obvious reading — "a bun process survived TERM and KILL" — cannot be true:
 * SIGKILL is not deliverable-and-ignorable. So one of three things is:
 *
 *   H1  the survivor is respawning,
 *   H2  it is kernel-stuck in uninterruptible IO on the FUSE mount,
 *   H3  the name in the refusal is not the thing holding the mount.
 *
 * This probe decides between them by reading, in the container, immediately
 * before and after the stop: the session shell's own pid and cwd, its whole
 * ancestor chain with each link's `/proc/<pid>/stat` state field, comm, ppid
 * and cwd, and every process holding the work directory BY FD and BY CWD
 * separately — a distinction the product's own scan does not draw.
 *
 * Then it runs the decisive experiment: with every fd holder already signalled
 * by the stop that just refused, move the SESSION's cwd out of the mount and
 * ask for the same unmount again. If that one succeeds, the blocker was never a
 * process the scan could kill.
 *
 * Usage:  bun scripts/devbox-holder-probe.ts
 *         bun scripts/devbox-holder-probe.ts --keep     leave the fixture up
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import {
  BENCH_ACCOUNT_ID, createFixtureResources, drainBucketResidue, r2ResiduePlane,
  deployFixture, startupOperation, stopOperation, teardownLiveArms, type Fixture,
} from './bench-devbox-strategies';
import {
  WRANGLER_FAILED, describeThrown, publishTeardown, runTeardownOnce, runWrangler,
} from './fixtures/r2-bench/deploy-substrate';

const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const WORKLOAD_SOURCE = join(REPO_ROOT, 'scripts/fixtures/devbox-e2e/workload.ts');
const HARNESS_DIR = '/var/tmp/devbox-e2e';
const HARNESS_PATH = `${HARNESS_DIR}/workload.ts`;
const WORK_ROOT = '/workspace/e2e';
const RUNTIME_DIR = '/var/tmp/devbox';
const WORKDIR = '/workspace';

const log = (line: string): void => {
  process.stdout.write(`[holder-probe] ${line}\n`);
};

/**
 * ONE bounded read-only /proc report. Signals nothing and kills nothing: this
 * is the instrument, not the repair.
 *
 * `${` never appears — the whole command is assembled from single-quoted
 * fragments so no shell expansion is eaten by the template, and it is one line
 * with `;` separators for the same reason the product's scan is: the SDK feeds
 * it to one persistent session shell, and an `exit` or a parse error there ends
 * the channel every later command needs.
 */
const DIAGNOSTIC = [
  'echo "SESSION pid=$$ cwd=$(readlink /proc/$$/cwd)"',
  'a=$$',
  'while [ -n "$a" ] && [ "$a" != 0 ] && [ "$a" != 1 ]; do '
  + 'st=$(sed \'s/.*) //\' /proc/$a/stat 2>/dev/null); '
  + 'echo "ANC pid=$a comm=$(cat /proc/$a/comm 2>/dev/null)'
  + ' state=$(echo "$st" | cut -d\' \' -f1) ppid=$(echo "$st" | cut -d\' \' -f2)'
  + ' cwd=$(readlink /proc/$a/cwd 2>/dev/null)"; '
  + 'a=$(echo "$st" | cut -d\' \' -f2); done',
  'for pid in $(ls /proc | grep -E \'^[0-9]+$\'); do '
  + 'fd=$(ls -l /proc/$pid/fd 2>/dev/null | grep -c -F ' + `'${WORKDIR}'` + '); '
  + 'cw=$(readlink /proc/$pid/cwd 2>/dev/null); '
  + 'case "$cw" in ' + `'${WORKDIR}'` + '*) ch=1;; *) ch=0;; esac; '
  + 'if [ "$fd" != 0 ] || [ "$ch" = 1 ]; then '
  + 'st=$(sed \'s/.*) //\' /proc/$pid/stat 2>/dev/null); '
  + 'echo "HOLD pid=$pid comm=$(cat /proc/$pid/comm 2>/dev/null)'
  + ' state=$(echo "$st" | cut -d\' \' -f1) ppid=$(echo "$st" | cut -d\' \' -f2)'
  + ' fdmatches=$fd cwdholds=$ch cwd=$cw"; fi; done',
  'echo "MOUNTED=$(grep -c -F ' + `' ${WORKDIR} '` + ' /proc/mounts)"',
  'echo SCAN-END',
].join('; ');

/** What `POST /exec` answers. PARSED, not asserted: the reply crosses the
 *  network from a fixture Worker, so its shape is an assumption until something
 *  checks it, and a probe whose evidence is `undefined` because a field was
 *  renamed would report a clean stop it never observed. */
const ExecReplySchema = v.looseObject({
  ok: v.optional(v.boolean()),
  exitCode: v.optional(v.number()),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  error: v.optional(v.string()),
});
type ExecReply = v.InferOutput<typeof ExecReplySchema>;

/** What `POST /write` answers; only its refusal is read. */
const AckReplySchema = v.looseObject({
  ok: v.optional(v.boolean()),
  error: v.optional(v.string()),
});

/** The union of every field this probe's two routes accept. One named contract
 *  rather than a bag of unknowns: the fixture refuses a body it cannot read, and
 *  a typo in a field name is a compile error here instead of a 400 mid-probe. */
interface ProbeRequest {
  readonly command?: string;
  readonly cwd?: string;
  readonly path?: string;
  readonly content?: string;
}

/** Every box-addressed route binds the request to its arm, and the fixture
 *  refuses one that does not: the driver's own helper infers the strategy from
 *  an `ab-<strategy>-…` box name, and these hand-built calls carry it
 *  explicitly for the same reason. */
async function post<TSchema extends v.GenericSchema>(
  fixture: Fixture,
  path: string,
  schema: TSchema,
  body: ProbeRequest,
  timeoutMs = 120_000,
): Promise<v.InferOutput<TSchema>> {
  const response = await fetch(`${fixture.origin}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...body, strategy: 'r2fs' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return v.parse(schema, await response.json());
}

/** An exec whose cwd this probe CHOOSES. The product's own default is
 *  `/workspace`, which is the fact under test, so a probe that could not pass a
 *  cwd could not run the decisive experiment. */
async function exec(
  fixture: Fixture, box: string, command: string, cwd?: string,
): Promise<ExecReply> {
  return await post(
    fixture,
    `/exec?box=${box}`,
    ExecReplySchema,
    cwd === undefined ? { command } : { command, cwd },
  );
}

async function scan(fixture: Fixture, box: string, when: string): Promise<string> {
  const reply = await exec(fixture, box, DIAGNOSTIC, RUNTIME_DIR);
  const out = (reply.stdout ?? '').trim();
  log(`── /proc report ${when} ──`);
  for (const line of out.split('\n')) log(`  ${line}`);
  if ((reply.stderr ?? '').trim().length > 0) log(`  stderr: ${(reply.stderr ?? '').trim()}`);
  if (reply.error !== undefined) log(`  error: ${reply.error}`);
  return out;
}

async function main(): Promise<number> {
  const keep = process.argv.includes('--keep');
  const runId = `hp${new Date().toISOString().replace(/\D/g, '').slice(4, 14)}`;
  process.env.CLOUDFLARE_ACCOUNT_ID = BENCH_ACCOUNT_ID;
  if (runWrangler(REPO_ROOT, ['whoami'], { allowFailure: true }).startsWith(WRANGLER_FAILED)) {
    log('wrangler is not authenticated; nothing can be deployed and nothing can be proved');
    return 1;
  }

  const workloadSource = readFileSync(WORKLOAD_SOURCE, 'utf8');
  const fixtures = await createFixtureResources(runId, ['r2fs']);
  const arm = fixtures.arms[0];
  if (arm === undefined) throw new Error('no r2fs arm was generated');
  // `ab-<strategy>-…`, because `addressArmRequest` infers the arm from exactly
  // that shape and every driver helper below goes through it.
  const box = `ab-r2fs-${runId}`;
  let live: Fixture | null = null;
  let stopWorker: (() => readonly string[]) | null = null;

  const accessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
  const residue = accessKeyId !== undefined && secretAccessKey !== undefined
    ? r2ResiduePlane({ accountId: BENCH_ACCOUNT_ID, accessKeyId, secretAccessKey })
    : null;

  publishTeardown(async (): Promise<void> => {
    if (keep) {
      log(`--keep left ${arm.worker} / ${arm.bucket} in place`);
      return;
    }
    if (live !== null) {
      for (const error of await teardownLiveArms(live, [box])) log(`teardown: ${error}`);
    }
    for (const status of (stopWorker?.() ?? []).filter((s) => /failed/i.test(s))) {
      log(`teardown: ${status}`);
    }
    let deleted = runWrangler(REPO_ROOT, ['r2', 'bucket', 'delete', arm.bucket], { allowFailure: true });
    if (deleted.startsWith(WRANGLER_FAILED) && /not empty|10008/i.test(deleted) && residue !== null) {
      const drained = await drainBucketResidue(residue, arm.bucket);
      log(`${arm.bucket}: drained ${String(drained.objects)} object(s), aborted ${String(drained.uploads)} upload(s)`);
      deleted = runWrangler(REPO_ROOT, ['r2', 'bucket', 'delete', arm.bucket], { allowFailure: true });
    }
    if (deleted.startsWith(WRANGLER_FAILED) && !/not found|does not exist/i.test(deleted)) {
      log(`teardown: ${arm.bucket}: ${deleted.slice(0, 200)}`);
    }
    fixtures.disposeConfig();
    log('teardown complete');
  });

  try {
    runWrangler(REPO_ROOT, ['r2', 'bucket', 'create', arm.bucket]);
    const started = await deployFixture(`holder-probe-${crypto.randomUUID()}`, arm);
    live = started.fixture;
    stopWorker = started.stop;
    log(`deployed at ${live.origin}`);

    const cold = await startupOperation(live, box, '/create', 'probe cold attach', ['empty', 'attached']);
    log(`cold attach: ${cold.attach.kind} — ${cold.attach.detail}`);

    // ── the E2E's own open-write arming, verbatim in shape ─────────────────
    await exec(live, box, `mkdir -p ${HARNESS_DIR}`);
    await post(live, `/write?box=${box}`, AckReplySchema, {
      path: HARNESS_PATH, content: workloadSource,
    });
    await exec(live, box, `mkdir -p ${WORK_ROOT}`);
    const spawned = await exec(
      live, box,
      `cd ${HARNESS_DIR} && nohup bun ${HARNESS_PATH} hold-open --root ${WORK_ROOT} `
      + '--path open-write.bin --content probe-open-write --hold-ms 1800000 '
      + '>/dev/null 2>&1 & echo spawned',
    );
    log(`writer spawn: rc=${String(spawned.exitCode)} ${(spawned.stdout ?? '').trim()}`);

    // An ordinary product exec, at the product's DEFAULT cwd. This is the shape
    // every E2E workload call has, and the question is what it leaves behind.
    const defaulted = await exec(live, box, 'echo default-cwd=$(pwd)');
    log(`product default exec: ${(defaulted.stdout ?? '').trim()}`);

    await scan(live, box, 'before the stop');

    // ── the stop probe09011530 saw refuse ─────────────────────────────────
    const settled = await stopOperation(live, box, 'probe stop');
    log(`stop: ok=${String(settled.ok)} error=${settled.error ?? '(none)'}`);

    const after = await scan(live, box, 'after the stop');
    const stillMounted = /MOUNTED=[1-9]/.test(after);

    // ── THE CONTROLLED EXPERIMENT, run only when the stop LEFT the mount up ─
    // Every fd holder has been TERMed and KILLed by the stop, so both arms run
    // with zero fd holders under the work directory, adjacent in time, against
    // the same live mount. The ONLY difference between them is the cwd the
    // session shell is standing in when `fusermount -u` runs — the product's own
    // default for every internal exec, `/workspace`, versus anywhere else.
    if (stillMounted) {
      const unmount = `(fusermount -u '${WORKDIR}' 2>&1 || fusermount3 -u '${WORKDIR}' 2>&1); `
        + `echo "rc=$?"; echo "MOUNTED=$(grep -c -F ' ${WORKDIR} ' /proc/mounts)"`;
      for (const arm of [
        { label: `A: session cwd INSIDE the mount (${WORKDIR}, the product default)`, cwd: WORKDIR },
        { label: `B: session cwd OUTSIDE the mount (${RUNTIME_DIR})`, cwd: RUNTIME_DIR },
      ]) {
        const attempt = await exec(live, box, unmount, arm.cwd);
        log(`── ${arm.label} ──`);
        for (const line of (attempt.stdout ?? '').trim().split('\n')) log(`  ${line}`);
        const err = (attempt.stderr ?? '').trim();
        if (err.length > 0) log(`  stderr: ${err}`);
      }
    }

    // ── THE VERDICT ───────────────────────────────────────────────────────
    // What this probe exists to answer: does a box whose caller left a writer
    // holding a file open across the checkpoint stop CLEANLY — mount released,
    // container stopped, no refusal? Both halves are required: a stop that
    // reports success over a mount that is still up has released nothing.
    const clean = settled.ok === true && !stillMounted;
    log(clean
      ? 'VERDICT PASS — the open-write scenario stopped clean: the stop confirmed and '
        + `${WORKDIR} is no longer mounted`
      : `VERDICT FAIL — stop ok=${String(settled.ok)}, ${WORKDIR} still mounted=${String(stillMounted)}`);
    return clean ? 0 : 1;
  } catch (error) {
    log(`probe failed: ${describeThrown({ cause: error })}`);
    return 1;
  } finally {
    await runTeardownOnce();
  }
}

process.exit(await main());
