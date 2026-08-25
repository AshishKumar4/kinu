#!/usr/bin/env bun
/**
 * Devbox storage strategies, measured against each other: `snapshot-chain` vs
 * `r2fs`.
 *
 * This is the decision the whole storage question turns on. The raw-layout
 * benchmark beside it (`scripts/bench-r2-workspace.ts`) answers "what does an R2
 * mount cost"; this answers "which strategy should a Devbox default to", by
 * driving the real product lifecycle — attach, checkpoint, stop, wake — through
 * `packages/devbox/bench`.
 *
 *   bun scripts/bench-devbox-strategies.ts --plan
 *
 * Five rules it inherits from the layout benchmark, each one bought with a
 * failed run:
 *
 *   /verify FIRST, per arm. A strategy whose verify fails measured the
 *   container's own blank disk, and its numbers are refused rather than ranked.
 *   Two sibling agents each shipped a probe that silently passed on a blank
 *   /workspace; this is the guard against being the third.
 *
 *   ONE BOX PER ARM. `mountBucket` refuses a second mount of one binding at a
 *   different prefix or readOnly value, so arms cannot share an instance.
 *
 *   /ops/flush AT EVERY PHASE BOUNDARY. The tally batches in the proxy isolate;
 *   a settle-and-hope read undercounted PUTs by at least 590 on the layout
 *   benchmark's process path, while its teardown deleted the objects that proved
 *   it. A flush is a fact, a settle is a wish.
 *
 *   WAKE IS DEPLOYED-ONLY. After a stop, local workerd loses the container's
 *   networking sidecar and every later call hangs 30 s. A local wake number is
 *   not a slow measurement, it is not a measurement.
 *
 *   MINUTE-SCALE WORK RUNS AS A PROCESS. A blocking exec is bounded by a fixed
 *   platform ceiling no timeout option raises. The heavy groups are backgrounded
 *   and polled for a sentinel.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  WRANGLER_FAILED, armSignalTeardown, delay, deleteContainerApps, describeThrown,
  publishTeardown, runTeardownOnce, runWrangler,
} from './fixtures/r2-bench/deploy-substrate';
import * as v from 'valibot';
import { summarize, type Summary } from './fixtures/r2-bench/stats';
import { parseProbeRun, type ProbeRun } from './fixtures/r2-bench/report';
import {
  R2_CLASS_A_USD_PER_MILLION, R2_CLASS_B_USD_PER_MILLION, decide, opsAreBlind, sqliteFinding,
  totalsFor, type DecisionVerdict, type TickRecord,
} from './fixtures/r2-bench/decision';

/**
 * What `decisive.ts` prints. Parsed rather than cast, for the reason the whole
 * instrument now follows: a payload that disagreed with its contract used to
 * become a silent `undefined` and take a later segment down with it.
 */
/**
 * The chain's generation, as the fixture reports it.
 *
 * `base.id` is a fresh uuid after a rebase and `delta` goes absent, so comparing
 * this before and after the checkpoint ladder says DEFINITIVELY whether a rebase
 * fired there — rather than leaving it as a possibility a reader has to weigh.
 * `rev` is monotonic across both, which is what distinguishes a rebase from a
 * quiesce that wrote nothing.
 *
 * Absent for any arm that is not a chain, which is itself the point: overlay-cas
 * never rebases, so a chain that does is a structural difference between the two
 * that reproduces on every run with this ladder, not a coin flip between runs.
 */
interface ChainGeneration {
  readonly baseId: string | null;
  readonly hasDelta: boolean;
  readonly rev: number | null;
}

const StateReplySchema = v.looseObject({
  state: v.optional(v.looseObject({
    chain: v.optional(v.nullable(v.looseObject({
      base: v.optional(v.looseObject({ id: v.optional(v.string()) })),
      delta: v.optional(v.unknown()),
      rev: v.optional(v.number()),
    }))),
  })),
});

async function chainGeneration(fixture: Fixture, box: string): Promise<ChainGeneration> {
  const reply = await call(fixture, 'GET', `/state?box=${box}`, StateReplySchema);
  const chain = reply.state?.chain ?? null;
  return {
    baseId: chain?.base?.id ?? null,
    hasDelta: chain?.delta !== undefined && chain?.delta !== null,
    rev: chain?.rev ?? null,
  };
}

interface DecisiveRun {
  readonly workload?: string;
  readonly segments?: readonly { readonly name: string; readonly bytesWritten: number; readonly pathsTouched: number; readonly wallMs: number }[];
  readonly treeBytes?: number;
  readonly error?: string;
}

const DecisiveRunSchema: v.GenericSchema<DecisiveRun> = v.looseObject({
  workload: v.optional(v.string()),
  segments: v.optional(v.array(v.looseObject({
    name: v.string(),
    bytesWritten: v.number(),
    pathsTouched: v.number(),
    wallMs: v.number(),
  }))),
  treeBytes: v.optional(v.number()),
  error: v.optional(v.string()),
});

function parseDecisiveRun(text: string, source: string): DecisiveRun {
  const parsed = v.safeParse(DecisiveRunSchema, JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      `${source} printed a payload that is not a decisive run: `
      + `${parsed.issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ')}`
      + ` — body: ${text.slice(0, 300)}`,
    );
  }
  return parsed.output;
}

const REPO_ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const BENCH_DIR = join(REPO_ROOT, 'packages/devbox/bench');
const FIXTURE_WORKER = 'kinu-devbox-bench';
/**
 * Container applications the platform derives from this fixture's Durable Object
 * classes, one per strategy arm, as `<worker>-<class lowercased>`. Teardown
 * deletes every one of them, because `wrangler delete` removes the Worker and
 * leaves these holding live instances that block the next deploy on the name.
 *
 * `max_instances` is 1 PER CLASS and three classes now compete, so the per-arm
 * container release at the end of `measureArm` is load-bearing rather than tidy:
 * without it the second arm failed every phase with `Maximum number of running
 * container instances exceeded`, and a third arm makes that likelier, not less.
 */
const FIXTURE_CONTAINER_APPS = [
  'kinu-devbox-bench-snapshotchainbox',
  'kinu-devbox-bench-r2fsbox',
  'kinu-devbox-bench-overlaycasbox',
];
const BUCKET = 'kinu-devbox-bench';
const HARNESS = '/workspace/.devbox-bench';
const PROBE_FILES = ['stats.ts', 'probe.ts', 'decisive.ts'] as const;
/**
 * The decisive experiment's arms, from the adopted research spec.
 *
 * `npm` runs TWICE — with and without the excludes policy — because excludes are
 * the one lever that changes the changed-set without changing the work, so the
 * pair isolates what the policy is worth. `git` is the arm the 10x bar is set
 * on; `sqlite` decides a separate question and never the default.
 */
const DECISIVE_WORKLOADS = [
  { id: 'npm', workload: 'npm', excludes: false, args: '--target-mib 400 --segments 4' },
  { id: 'npm-excluded', workload: 'npm', excludes: true, args: '--target-mib 400 --segments 4' },
  { id: 'git', workload: 'git', excludes: false, args: '--files 2000 --commits 200 --touch-percent 5 --segments 4' },
  { id: 'sqlite', workload: 'sqlite', excludes: false, args: '--size-mib 64 --segments 4' },
] as const;

/** Segments per decisive workload. Index 0 seeds; 1..N are the incremental ones
 *  the experiment actually measures. */
const SEGMENTS_PER_WORKLOAD = 4;

/**
 * How long to wait before a tick so the strategy's minimum-interval guard does
 * not suppress it. Measured, not chosen: without this every tick after the first
 * answered `skipped (within the minimum checkpoint interval)`. Read from the
 * bench fixture's OWN policy override rather than from the shipped default: the
 * fixture sets `checkpointIntervalMs: 2_000`, so the guard needs three seconds,
 * and reading the shipped 5-minute value would idle this driver a hundredfold
 * longer than the guard requires.
 */
const MIN_CHECKPOINT_INTERVAL_MS = 3_000;

/** Groups a blocking exec cannot reach; backgrounded and polled instead. */
const PROCESS_PHASES = new Set<string>([
  'npmlike', 'gitlike', 'small1k', 'small10k', 'seq100',
]);
const PHASES = ['posix', 'seq1', 'seq10', 'rand', 'archive', 'small1k', 'npmlike'] as const;
/** Change sizes for the checkpoint ladder, in KiB of freshly written bytes. */
const CHANGE_SIZES_KIB = [64, 4_096, 65_536] as const;
const POLL_MS = 10_000;
const PROCESS_DEADLINE_MS = 1_500_000;

/**
 * The arms. `overlay-cas` is the promoted form of the overlay/sync concept that
 * the layout benchmark measured as the shape worth keeping: writes land on the
 * container disk and R2 receives content-addressed state, rather than every
 * write traversing FUSE.
 *
 * Every arm is measured by the same driver against the same workloads and the
 * same routes. Nothing below this line knows which arm it is running, which is
 * what makes a three-way comparison the same experiment as a two-way one.
 */
type Strategy = 'snapshot-chain' | 'r2fs' | 'overlay-cas';
const STRATEGIES: readonly Strategy[] = ['snapshot-chain', 'r2fs', 'overlay-cas'];

interface Options {
  seed: number;
  budgetMs: number;
  /** Run the decisive experiment's three workloads and apply its decision rule.
   *  Off by default because it writes hundreds of megabytes per arm. */
  decisive: boolean;
  plan: boolean;
  keep: boolean;
  /** Arms to run, from `--arms a,b`. Defaults to all three; an unknown name
   *  refuses rather than measuring an empty run. */
  arms: readonly Strategy[];
  /** Unique Durable Object suffix. A Worker redeploy does not delete DO
   * storage, so fixed box names contaminate a later run with prior state. */
  runId: string;
  out: string;
}

const log = (message: string): void => {
  process.stderr.write(`[devbox-bench] ${message}\n`);
};


/** Valibot's own field-level words for a payload that missed its contract. What
 *  the fixture sent is the only authority on what is wrong with it. */
const issueText = (issues: readonly v.BaseIssue<unknown>[]): string =>
  issues.map((issue) => `${v.getDotPath(issue) ?? '<root>'}: ${issue.message}`).join('; ');

armSignalTeardown(log);

const wrangler = (args: readonly string[], options: { allowFailure?: boolean } = {}): string =>
  runWrangler(REPO_ROOT, args, options);

interface Fixture { origin: string; token: string }

/** Every field the driver ever sends. The fixture parses the same closed set at
 *  its edge, so a key nobody declares here cannot reach a route. */
interface DriverRequest {
  readonly strategy?: Strategy;
  readonly command?: string;
  readonly path?: string;
  readonly content?: string;
  readonly kind?: 'tick' | 'quiesce';
  readonly purge?: boolean;
  readonly prefix?: string;
  readonly whole?: boolean;
}

export interface AddressedArmRequest {
  readonly path: string;
  readonly body?: DriverRequest;
}

/** Bind every box-addressed request to its arm. GET carries it in the query;
 * POST carries it in JSON. A GET body is invalid in fetch and caused run 9 to
 * fail before the first arm. */
export function addressArmRequest(
  method: 'GET' | 'POST',
  path: string,
  body?: DriverRequest,
): AddressedArmRequest {
  const url = new URL(path, 'https://bench.invalid');
  const box = url.searchParams.get('box');
  const inferred = STRATEGIES.find((strategy) => {
    const base = `ab-${strategy}`;
    return box === base || box?.startsWith(`${base}-`) === true;
  });
  const strategy = body?.strategy ?? inferred;
  if (method === 'GET') {
    if (strategy !== undefined) url.searchParams.set('strategy', strategy);
    return { path: `${url.pathname}${url.search}` };
  }
  if (strategy === undefined) {
    return body === undefined ? { path } : { path, body };
  }
  return { path, body: { ...body, strategy } };
}

/**
 * One driver call, decoded through the schema its route answers with.
 *
 * The schema is a parameter rather than a caller-chosen type argument, because a
 * type argument asserts a shape over bytes nobody checked and every reply here
 * arrives over a network this run cannot see. A reply that disagrees with its
 * contract fails carrying the wire's own words — the JSON syntax error or
 * valibot's field-level message, plus a prefix of the text — because a benchmark
 * that defaults a missing number goes on to publish it.
 */
async function call<TSchema extends v.GenericSchema>(
  fixture: Fixture, method: 'GET' | 'POST', path: string, schema: TSchema, body?: DriverRequest,
): Promise<v.InferOutput<TSchema>> {
  const addressed = addressArmRequest(method, path, body);
  const headers = new Headers({ authorization: `Bearer ${fixture.token}` });
  if (addressed.body !== undefined) headers.set('content-type', 'application/json');
  const init: RequestInit = { method, signal: AbortSignal.timeout(3_600_000), headers };
  if (addressed.body !== undefined) init.body = JSON.stringify(addressed.body);
  const response = await fetch(`${fixture.origin}${addressed.path}`, init);
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${method} ${path} returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
      { cause: error },
    );
  }
  const parsed = v.safeParse(schema, decoded);
  if (!parsed.success) {
    throw new Error(
      `${method} ${path} (${response.status}) does not match its reply contract: `
      + `${issueText(parsed.issues)}\n${text.slice(0, 300)}`,
    );
  }
  return parsed.output;
}

/**
 * Every reply below is a LOOSE object: the declared fields are validated, and a
 * field nobody declared is preserved rather than deleted.
 *
 * Stripping is silent data loss at a boundary whose payload is archived, and it
 * has already cost this benchmark family a field: the probe emitted a top-level
 * `loopBudgetMs` that no interface declared, and a stripping schema would have
 * dropped it out of the run artifact instead of carrying it. `/ops` and
 * `/teardown` are written into that artifact whole, which is what a human reads
 * months later, so a new field has to survive a driver that has not heard of it.
 */

/** A call the driver only needs to have happened: `/write` at harness install,
 *  and the two `/ops` maintenance routes. Nothing reads the rest of the reply. */
interface AckReply { ok?: boolean; error?: string }

const AckReplySchema: v.GenericSchema<AckReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  error: v.optional(v.string()),
});

interface ExecReply { ok?: boolean; exitCode?: number; stdout?: string; stderr?: string; ms?: number; error?: string }

const ExecReplySchema: v.GenericSchema<ExecReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  exitCode: v.optional(v.number()),
  stdout: v.optional(v.string()),
  stderr: v.optional(v.string()),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

async function sh(fixture: Fixture, box: string, command: string): Promise<ExecReply> {
  return await call(fixture, 'POST', `/exec?box=${box}`, ExecReplySchema, { command });
}


// ── lifecycle ───────────────────────────────────────────────────────────────

async function deployFixture(token: string): Promise<{ fixture: Fixture; stop: () => void }> {
  // A crashed earlier run can leave the container applications behind and the
  // deploy then fails on the name.
  const stale = deleteContainerApps(REPO_ROOT, FIXTURE_CONTAINER_APPS, log);
  if (!stale.includes('absent')) log(`cleared stale container applications: ${stale.join(', ')}`);

  const output = wrangler(['deploy', '--config', join(BENCH_DIR, 'wrangler.jsonc'), '--var', `BENCH_TOKEN:${token}`]);
  const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
  if (origin === undefined) throw new Error(`deploy printed no workers.dev origin:\n${output.slice(-2500)}`);
  log(`deployed ${origin}`);

  // TWO checks, and the second one exists because the first one is not enough.
  //
  // An unauthenticated 401 proves that SOMETHING is answering at this origin. It
  // does not prove it is THIS deployment: the workers.dev hostname is stable, so
  // a previous deployment answers 401 exactly the same way, and a run that
  // started on that evidence got 401 back on its own token for every arm and
  // reported two failed creates that were nothing of the kind. So the security
  // assertion stays, and readiness now waits for an AUTHORIZED request to
  // succeed — which is the only thing that proves the token this run minted is
  // the token the live code is checking.
  const unauth = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.status)
    .catch((error) => {
      log(`the unauthenticated probe did not answer: ${describeThrown({ cause: error })}`);
      return 0;
    });
  if (unauth === 200) throw new Error('the bench app answered an unauthenticated request; refusing to run');

  const deadline = Date.now() + 180_000;
  for (;;) {
    const authed = await fetch(`${origin}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.status).catch((error) => {
      log(`the readiness probe did not answer: ${describeThrown({ cause: error })}`);
      return 0;
    });
    if (authed === 200) break;
    if (Date.now() > deadline) {
      throw new Error(
        `the deployment never accepted this run's token at ${origin} (last status ${authed}). `
        + 'A stable workers.dev hostname means an older deployment can answer here.',
      );
    }
    await delay(3_000);
  }

  return {
    fixture: { origin, token },
    stop: () => {
      let deleted = wrangler(['delete', '--config', join(BENCH_DIR, 'wrangler.jsonc'), '--force'], { allowFailure: true });
      if (deleted.startsWith(WRANGLER_FAILED)) {
        deleted = wrangler(['delete', '--name', FIXTURE_WORKER, '--force'], { allowFailure: true });
      }
      log(deleted.startsWith(WRANGLER_FAILED) ? `WARNING: Worker NOT deleted: ${deleted.slice(0, 200)}` : 'Worker deleted');
      log(`container applications: ${deleteContainerApps(REPO_ROOT, FIXTURE_CONTAINER_APPS, log).join(', ')}`);
    },
  };
}

// ── measurement ─────────────────────────────────────────────────────────────

/** The R2 operation tally as `/ops` answers it, and what the report's cost
 *  columns read. Written into the artifact whole; the reply-contract note above
 *  says why an undeclared key survives. */
interface OpTally { calls?: Record<string, number>; classA?: number; classB?: number; classFree?: number; total?: number }

const OpTallySchema: v.GenericSchema<OpTally> = v.looseObject({
  calls: v.optional(v.record(v.string(), v.number())),
  classA: v.optional(v.number()),
  classB: v.optional(v.number()),
  classFree: v.optional(v.number()),
  total: v.optional(v.number()),
});

/** One `/verify` assertion. `detail` is read: a failing check is quoted in the
 *  arm's notes and again in the report. */
interface VerifyCheck { name: string; pass: boolean; detail: string }

interface VerifyReply { ok?: boolean; checks?: VerifyCheck[]; passed?: boolean }

const VerifyReplySchema: v.GenericSchema<VerifyReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  checks: v.optional(v.array(v.looseObject({
    name: v.string(),
    pass: v.boolean(),
    detail: v.string(),
  }))),
  passed: v.optional(v.boolean()),
});

/** What an attach did. `kind` stays a free string rather than the fixture's
 *  three-value union, because an unrecognised kind is the finding: a wake this
 *  driver refuses to parse is a wake it cannot report. */
interface AttachOutcome { kind: string; detail: string }

/** `/create` and `/wake` answer the same way: an attach outcome and a duration. */
interface AttachReply { ok?: boolean; attach?: AttachOutcome; ms?: number; error?: string }

const AttachReplySchema: v.GenericSchema<AttachReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  attach: v.optional(v.looseObject({ kind: v.string(), detail: v.string() })),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

interface CheckpointReply {
  ok?: boolean;
  outcome?: { kind: string; reason?: string; bytes?: number; movedBytes?: number };
  ms?: number;
  error?: string;
}

const CheckpointReplySchema: v.GenericSchema<CheckpointReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  outcome: v.optional(v.looseObject({
    kind: v.string(),
    // Bytes THIS tick moved, reported by the strategy rather than derived.
    //
    // The alternative was differencing consecutive `bytes` readings, and that is
    // invalid by construction: `bytes` is durable bytes HELD, so a fold or rebase
    // supersedes a generation and held bytes legitimately FALL while the tick
    // moved a large archive. Two ticks in the verdict run went negative for
    // exactly that reason, and a retracted amplification claim came from reading
    // the cumulative field as a per-tick one.
    //
    // `undefined` is a truthful "not measurable here" and NOT zero: r2fs uploads
    // when the last handle closes, so no bytes attribute to a sync. Zero would
    // read as "moved nothing", which is a different claim.
    movedBytes: v.optional(v.number()),
    reason: v.optional(v.string()),
    bytes: v.optional(v.number()),
  })),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

interface StopReply { ok?: boolean; ms?: number; error?: string }

const StopReplySchema: v.GenericSchema<StopReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

/** What `/teardown` discarded and purged. The report prints this row whole and
 *  the artifact keeps it, so nothing here is read by name. */
interface TeardownReply {
  ok?: boolean;
  discarded?: boolean;
  purged?: number;
  emptyBucketGuaranteed?: boolean;
  ms?: number;
  error?: string;
}

const TeardownReplySchema: v.GenericSchema<TeardownReply> = v.looseObject({
  ok: v.optional(v.boolean()),
  discarded: v.optional(v.boolean()),
  purged: v.optional(v.number()),
  emptyBucketGuaranteed: v.optional(v.boolean()),
  ms: v.optional(v.number()),
  error: v.optional(v.string()),
});

interface CheckpointRow {
  changeKiB: number;
  kind: 'tick' | 'quiesce';
  ms: number;
  bytes: number;
  outcome: string;
}

interface ArmResult {
  strategy: Strategy;
  box: string;
  verifyPassed: boolean;
  verifyChecks: VerifyCheck[];
  attachColdMs: number | null;
  attachColdKind: string;
  attachWarmMs: number | null;
  attachWarmKind: string;
  checkpoints: CheckpointRow[];
  stopMs: number | null;
  wakeMs: number | null;
  wakeKind: string;
  phases: ProbeRun[];
  /** Per-checkpoint rows from the decisive experiment, priced against R2. */
  decisiveTicks: TickRecord[];
  /**
   * Quiesces this arm took, split by whether they fell before or inside the
   * decisive window.
   *
   * WHY IT IS RECORDED. The chain rebases only at a QUIESCE, and a rebase moves
   * a full-tree archive, so a rebase landing inside a measurement window inflates
   * that arm's tick sum for a reason that has nothing to do with the strategy —
   * two runs of identical workloads with different stop counts would disagree.
   * This driver issues only ticks inside the decisive window, so the confound is
   * structurally absent rather than merely small, and these counters are how a
   * reader checks that claim instead of taking it.
   */
  quiescesBeforeDecisive: number;
  decisiveQuiesces: number;
  /** The chain generation before and after the ladder, so a ladder rebase is
   *  observed rather than disclosed as a possibility. */
  generationBeforeLadder: ChainGeneration | null;
  generationAfterLadder: ChainGeneration | null;
  /** Measured tree size per decisive workload, for the sqlite re-ship ratio. */
  treeBytes: Record<string, number>;
  ops: OpTally | null;
  teardown: TeardownReply | null;
  notes: string[];
}

async function installHarness(fixture: Fixture, box: string): Promise<void> {
  await sh(fixture, box, `mkdir -p ${HARNESS}`);
  for (const file of PROBE_FILES) {
    await call(fixture, 'POST', `/write?box=${box}`, AckReplySchema, {
      path: `${HARNESS}/${file}`,
      content: readFileSync(join(REPO_ROOT, 'scripts/fixtures/r2-bench', file), 'utf8'),
    });
  }
}

/**
 * One metric group. Blocking exec for the cheap ones; backgrounded with a polled
 * sentinel for anything minute-scale, because the blocking path is bounded by a
 * ceiling that no timeout option raises.
 */
async function runPhase(
  fixture: Fixture, box: string, root: string, phase: string, seed: number, budgetMs: number,
): Promise<ProbeRun> {
  const base = `bun ${HARNESS}/probe.ts --root ${root} --phase ${phase} --seed ${seed} --budget-ms ${budgetMs}`;
  if (!PROCESS_PHASES.has(phase)) {
    // Reinstall once on a missing harness. NOTHING in the container survives a
    // recycle — `/` and `/workspace` are the same ext4 on `/dev/vdc` — and the
    // platform can recycle between two RPCs, so `cd: no such file or directory`
    // is a container event rather than a measurement. The layout benchmark
    // already recovers from exactly this; run 6 lost five phases to it here
    // because this driver did not.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reply = await sh(fixture, box, `cd ${HARNESS} && ${base}`);
      const start = (reply.stdout ?? '').indexOf('{');
      if (start !== -1) {
        return parseProbeRun((reply.stdout ?? '').slice(start), `${phase}: blocking exec stdout, attempt ${attempt}`);
      }
      const detail = (reply.error ?? reply.stderr ?? '').slice(0, 200);
      const lost = /No such file or directory/.test(detail);
      if (!lost || attempt === 2) {
        throw new Error(`${phase}: no JSON (exit ${reply.exitCode}) ${detail}`);
      }
      log(`${phase}: the harness was gone; reinstalling and retrying once`);
      await installHarness(fixture, box);
    }
  }

  const out = `${HARNESS}/out-${phase}-${seed}.json`;
  // Same recycle hazard, checked before spawning rather than discovered by a
  // sentinel that never appears: a detached process cannot report that its own
  // interpreter was missing.
  const present = await sh(fixture, box, `test -f ${HARNESS}/probe.ts && echo YES || echo NO`);
  if ((present.stdout ?? '').includes('NO')) {
    log(`${phase}: the harness was gone; reinstalling before spawning`);
    await installHarness(fixture, box);
  }
  await sh(fixture, box, `rm -f ${out} ${out}.done`);
  await sh(fixture, box, `cd ${HARNESS} && nohup ${base} --out ${out} >/dev/null 2>&1 & echo spawned`);
  const deadline = Date.now() + PROCESS_DEADLINE_MS;
  for (;;) {
    await delay(POLL_MS);
    const poll = await sh(fixture, box, `test -f ${out}.done && echo DONE || echo WAIT`);
    if ((poll.stdout ?? '').includes('DONE')) break;
    if (Date.now() > deadline) throw new Error(`${phase} did not finish within the process deadline`);
  }
  const read = await sh(fixture, box, `cat ${out}`);
  const start = (read.stdout ?? '').indexOf('{');
  if (start === -1) throw new Error(`${phase}: result file unreadable`);
  return parseProbeRun((read.stdout ?? '').slice(start), `${phase}: ${out} read back after the process run`);
}

/**
 * Run one decisive workload and price every checkpoint it triggers.
 *
 * The measurement that matters is the TICK, not the workload: the workload only
 * exists to put a known amount of pending change in front of a checkpoint. So
 * each segment runs, then a tick is taken, and the tick is charged with an op
 * diff taken across it — flush first so the window is closed, flush again after
 * so nothing the tick issued is still batched in an isolate.
 *
 * `unitsMoved` is whatever the strategy itself claims it moved. A chain reports
 * delta bytes; a content-addressed arm reports journal entries. Reported as null
 * with its label rather than 0 when the checkpoint said neither, because a
 * strategy that does not account for its own work is a finding.
 */
async function runDecisive(
  fixture: Fixture,
  box: string,
  arm: string,
  spec: (typeof DECISIVE_WORKLOADS)[number],
  seed: number,
): Promise<{ ticks: TickRecord[]; treeBytes: number; notes: string[] }> {
  const notes: string[] = [];
  const ticks: TickRecord[] = [];
  const root = `/workspace/decisive-${spec.id}`;

  // The excludes arm differs ONLY by the policy file, so the pair isolates the
  // policy rather than the workload.
  if (spec.excludes) {
    await call(fixture, 'POST', `/write?box=${box}`, AckReplySchema, {
      path: `${root}/.devboxignore`,
      content: 'node_modules/**/dist/**\n**/*.map\n.git/objects/**\n',
    });
  }

  // INTERLEAVED, one invocation per segment.
  //
  // MEASURED: running the whole workload and then taking N checkpoints produced
  // ONE tick carrying a 510 MiB cold archive and four reporting
  // `skipped (work directory is unchanged)` — because by then nothing had
  // changed since the first. Σticks was a single full-tree archive, which is the
  // exact quantity the O(p)-versus-O(c) question is NOT about. The workload is
  // now resumable by segment index so a checkpoint falls BETWEEN segments, which
  // is what makes the second and later ticks the incremental cost.
  let treeBytes = -1;
  for (let segment = 0; segment <= SEGMENTS_PER_WORKLOAD; segment++) {
    const command = `bun ${HARNESS}/decisive.ts --root ${root} --workload ${spec.workload} `
      + `--seed ${seed} --segment ${segment} ${spec.args}`;
    const reply = await sh(fixture, box, command);
    const start = (reply.stdout ?? '').indexOf('{');
    if (start === -1) {
      notes.push(`${spec.id} segment ${segment}: no JSON: ${(reply.error ?? reply.stderr ?? '').slice(0, 200)}`);
      continue;
    }
    const run = parseDecisiveRun((reply.stdout ?? '').slice(start), `${arm}/${spec.id}#${segment}`);
    if (run.error !== undefined) {
      notes.push(`${spec.id} segment ${segment}: ${run.error}`);
      continue;
    }
    if (run.treeBytes !== undefined && run.treeBytes > treeBytes) treeBytes = run.treeBytes;
    const segmentName = run.segments?.[0]?.name;
    if (segmentName === undefined) continue;

    // RESPECT THE MINIMUM CHECKPOINT INTERVAL, rather than measuring it.
    //
    // MEASURED: ticking immediately produced five consecutive
    // `skipped (within the minimum checkpoint interval)` outcomes on one arm, so
    // the whole workload recorded no work at all. The guard is correct product
    // behaviour; a driver that trips it is measuring the rate limiter.
    await delay(MIN_CHECKPOINT_INTERVAL_MS);

    await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
    const before = await call(fixture, 'GET', `/ops?box=${box}`, OpTallySchema);
    const cp = await call(fixture, 'POST', `/checkpoint?box=${box}`, CheckpointReplySchema, { kind: 'tick' });
    await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
    const after = await call(fixture, 'GET', `/ops?box=${box}`, OpTallySchema);

    // HELD versus MOVED are different quantities and the report keeps them apart.
    // `bytes` is the cumulative durable total; `movedBytes` is what this tick
    // actually uploaded. Absent `movedBytes` stays absent rather than becoming 0.
    const bytes = cp.outcome?.bytes;
    const moved = cp.outcome?.movedBytes;
    ticks.push({
      arm,
      workload: spec.id,
      segment: segmentName,
      wallMs: cp.ms ?? -1,
      classA: (after.classA ?? 0) - (before.classA ?? 0),
      classB: (after.classB ?? 0) - (before.classB ?? 0),
      classFree: (after.classFree ?? 0) - (before.classFree ?? 0),
      // NOT `?? 0`: a failed tick may have landed blobs before throwing, and
      // r2fs cannot attribute bytes to a commit boundary at all. Both answer
      // `null`, which is a different fact from a skip's honest zero.
      bytesPut: moved ?? null,
      heldBytes: bytes ?? null,
      movedReported: moved !== undefined,
      // Kept for the report's own arithmetic check.
      unitsMoved: moved ?? null,
      unitLabel: arm === 'overlay-cas' ? 'journal entries / CAS bytes' : 'delta bytes',
      outcome: cp.error !== undefined
        ? `error: ${cp.error}`
        : `${cp.outcome?.kind ?? 'unknown'}${cp.outcome?.reason !== undefined ? ` (${cp.outcome.reason})` : ''}`,
    });
  }
  return { ticks, treeBytes, notes };
}

export function isTransientContainerCreateError(error: string | undefined): boolean {
  return /no container instance|container service is unreachable|try again later|ContainerUnavailable|OperationInterrupted/i
    .test(error ?? '');
}

async function measureArm(
  fixture: Fixture, strategy: Strategy, options: Options,
): Promise<ArmResult> {
  // ONE BOX PER ARM: mountBucket refuses a second mount of one binding at a
  // different prefix or readOnly value, so the arms cannot share an instance.
  const box = `ab-${strategy}-${options.runId}`;
  const notes: string[] = [];
  const result: ArmResult = {
    strategy, box, verifyPassed: false, verifyChecks: [],
    attachColdMs: null, attachColdKind: '', attachWarmMs: null, attachWarmKind: '',
    checkpoints: [], stopMs: null, wakeMs: null, wakeKind: '',
    phases: [], decisiveTicks: [], quiescesBeforeDecisive: 0, decisiveQuiesces: 0,
    generationBeforeLadder: null, generationAfterLadder: null,
    treeBytes: {}, ops: null, teardown: null, notes,
  };

  log(`${strategy}: create (cold attach)`);
  let created: AttachReply = {};
  // Container capacity is a platform event, not a measurement: "there is no
  // container instance that can be provided to this durable object" killed the
  // first A/B outright, and the layout benchmark already retries the same
  // signature. Nothing has been measured when this fires, so retrying it is
  // recovery rather than re-rolling a result. The attempt count is recorded so a
  // cold-attach number that needed four tries cannot read like one that needed
  // one.
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    created = await call(fixture, 'POST', `/create?box=${box}`, AttachReplySchema, { strategy });
    if (created.error === undefined && created.ok === true) {
      if (attempt > 1) notes.push(`cold attach needed ${attempt} attempts (container capacity)`);
      break;
    }
    const transient = isTransientContainerCreateError(created.error);
    if (!transient || attempt === attempts) break;
    log(`${strategy}: create attempt ${attempt}/${attempts} hit a transient container error; retrying`);
    await delay(attempt * 15_000);
  }
  if (created.error !== undefined || created.ok !== true) {
    notes.push(`create failed: ${created.error ?? 'no ok'}`);
    return result;
  }
  result.attachColdMs = created.ms ?? null;
  result.attachColdKind = created.attach?.kind ?? '';

  // VERIFY FIRST. A strategy whose verify fails measured the container's own
  // blank disk; its numbers are recorded but refused for ranking.
  //
  // Retried through the cold window, same shape as the create retries above:
  // the driver deletes the container applications at start, so the first
  // verify can ride a container boot plus an image pull, and Bun's fetch
  // carries its own socket timeout near 300s that no AbortSignal raises (run
  // 20260825163259 died exactly there, arms empty). Verify is read-only, so a
  // retry is recovery, not a re-roll; the attempt count is recorded.
  log(`${strategy}: verify`);
  let verified: v.InferOutput<typeof VerifyReplySchema> | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      verified = await call(fixture, 'POST', `/verify?box=${box}`, VerifyReplySchema, { strategy });
      if (attempt > 1) notes.push(`verify needed ${attempt} attempts (cold container window)`);
      break;
    } catch (error) {
      const timeout = error instanceof Error && /timed out|TimeoutError/i.test(`${error.name} ${error.message}`);
      if (!timeout || attempt === attempts) throw error;
      log(`${strategy}: verify attempt ${attempt}/${attempts} timed out on the cold container; retrying`);
    }
  }
  if (verified === undefined) throw new Error(`${strategy}: verify returned nothing after ${attempts} attempts`);
  result.verifyChecks = verified.checks ?? [];
  result.verifyPassed = verified.passed === true;
  if (!result.verifyPassed) {
    notes.push('VERIFY FAILED: this arm measured a blank disk and is not ranked');
    const failed = result.verifyChecks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
    notes.push(...failed.slice(0, 6));
  }

  await installHarness(fixture, box);
  await call(fixture, 'POST', `/ops/reset?box=${box}`, AckReplySchema);

  // The checkpoint ladder: write a known number of bytes, then checkpoint, and
  // read back what it actually committed. A checkpoint that reports success with
  // no byte count is the failure two siblings already hit.
  result.generationBeforeLadder = await chainGeneration(fixture, box);
  for (const kib of CHANGE_SIZES_KIB) {
    await sh(fixture, box, `mkdir -p /workspace/ladder && dd if=/dev/urandom of=/workspace/ladder/c${kib}.bin bs=1024 count=${kib} 2>/dev/null && sync`);
    for (const kind of ['tick', 'quiesce'] as const) {
      if (kind === 'quiesce') result.quiescesBeforeDecisive++;
      const cp = await call(fixture, 'POST', `/checkpoint?box=${box}`, CheckpointReplySchema, { kind });
      result.checkpoints.push({
        changeKiB: kib,
        kind,
        ms: cp.ms ?? -1,
        bytes: cp.outcome?.bytes ?? -1,
        outcome: cp.error !== undefined ? `error: ${cp.error}` : `${cp.outcome?.kind ?? 'unknown'}${cp.outcome?.reason !== undefined ? ` (${cp.outcome.reason})` : ''}`,
      });
    }
  }

  for (const phase of PHASES) {
    try {
      result.phases.push(await runPhase(fixture, box, `/workspace/ab-${strategy}`, phase, options.seed, options.budgetMs));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`${strategy}: phase ${phase} failed: ${reason.slice(0, 160)}`);
      notes.push(`phase ${phase} did not complete: ${reason.slice(0, 240)}`);
    }
    // FLUSH AT THE PHASE BOUNDARY, not a settle-and-hope.
    await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
  }

  result.generationAfterLadder = await chainGeneration(fixture, box);

  // THE DECISIVE EXPERIMENT. Placed after the workload phases and BEFORE
  // stop/wake, deliberately: these workloads leave hundreds of megabytes behind,
  // and a wake measured across that tree would be measuring the tree rather than
  // the wake. Each workload is isolated so one that cannot run costs its own
  // rows and nothing else.
  if (options.decisive) {
    for (const spec of DECISIVE_WORKLOADS) {
      log(`${strategy}: decisive ${spec.id}`);
      try {
        // A timed-out container operation can stop the spot container and lose
        // the harness with it. Reinstall through the box before each workload;
        // this is also the attach/replay probe for the replacement generation.
        await installHarness(fixture, box);
        const run = await runDecisive(fixture, box, strategy, spec, options.seed);
        result.decisiveTicks.push(...run.ticks);
        result.treeBytes[spec.id] = run.treeBytes;
        notes.push(...run.notes);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log(`${strategy}: decisive ${spec.id} failed: ${reason.slice(0, 160)}`);
        notes.push(`decisive ${spec.id} did not complete: ${reason.slice(0, 240)}`);
      }
    }
  }

  // stop -> wake. Only meaningful on a deployed Worker.
  log(`${strategy}: stop then wake`);
  const stopped = await call(fixture, 'POST', `/stop?box=${box}`, StopReplySchema, {});
  result.stopMs = stopped.ms ?? null;
  const woke = await call(fixture, 'POST', `/wake?box=${box}`, AttachReplySchema, {});
  result.wakeMs = woke.ms ?? null;
  result.wakeKind = woke.attach?.kind ?? (woke.error ?? '');
  if (result.wakeKind !== 'attached') {
    notes.push(
      `WAKE NOT VERIFIED: attach.kind was '${result.wakeKind}', so the container may never have gone `
      + 'down and no durability conclusion may be drawn from this cycle',
    );
  }

  // Warm attach: a second create against a live box.
  const warm = await call(fixture, 'POST', `/create?box=${box}`, AttachReplySchema, { strategy });
  result.attachWarmMs = warm.ms ?? null;
  result.attachWarmKind = warm.attach?.kind ?? '';

  await call(fixture, 'POST', `/ops/flush?box=${box}`, AckReplySchema);
  result.ops = await call(fixture, 'GET', `/ops?box=${box}`, OpTallySchema);
  result.teardown = await call(
    fixture, 'POST', `/teardown?box=${box}`, TeardownReplySchema, { purge: true, prefix: '', whole: true },
  );

  // RELEASE THE CONTAINER before the next arm starts.
  //
  // MEASURED: run 7's second arm failed EVERY phase with `Maximum number of
  // running container instances exceeded`. `max_instances` is 1 per class, and
  // the first arm's box was still up — its own stop→wake measurement had
  // deliberately woken it and the warm-attach check kept it there — so the
  // second arm could never get an instance. One box per arm is required for
  // correctness, because mountBucket refuses a second mount of one binding at a
  // different prefix or readOnly value; the consequence is that each arm must
  // hand its instance BACK rather than merely stop using it.
  const released = await call(fixture, 'POST', `/stop?box=${box}`, StopReplySchema, {});
  if (released.ok !== true) {
    notes.push(`the box was not released after the arm: ${released.error ?? 'stop did not confirm'}`);
  }
  return result;
}

// ── report ──────────────────────────────────────────────────────────────────

function metricSummary(arm: ArmResult, name: string): Summary | null {
  const medians: number[] = [];

  for (const run of arm.phases) {
    for (const phase of run.phases) {
      for (const metric of phase.metrics) if (metric.name === name) medians.push(metric.summary.p50);
    }
  }
  return medians.length === 0 ? null : summarize(medians);
}
export function rankableTicks(
  arms: readonly { readonly strategy: string; readonly verifyPassed: boolean }[],
  ticks: readonly TickRecord[],
): TickRecord[] {
  const ranked = new Set(arms.filter((arm) => arm.verifyPassed).map((arm) => arm.strategy));
  return ticks.filter((tick) => ranked.has(tick.arm));
}

const num = (value: number | null, digits = 2): string => {
  if (value === null || !Number.isFinite(value) || value < 0) return '—';
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString('en-US');
  return value.toFixed(digits);
};

const HEADLINE = [
  'write-10MiB', 'read-10MiB', 'reread-10MiB', 'random-read-4KiB',
  'small-create-1k', 'small-stat-1k', 'small-read-1k', 'small-delete-1k',
  'archive-extract-300-files', 'npmlike-install-write', 'npmlike-resolve-probe',
  'rename-file', 'rename-file-4MiB',
] as const;

/** The artifact's header, printed as-is above the tables. `INCOMPLETE` is how a
 *  run that stopped early says so rather than looking whole. */
interface RunMeta {
  date: string;
  worker: string;
  bucket: string;
  image: string;
  seed: string;
  'loop budget ms': string;
  INCOMPLETE?: string;
}

function render(arms: readonly ArmResult[], meta: RunMeta): string {
  const out: string[] = [];
  out.push(`### Devbox storage strategies: ${STRATEGIES.map((id) => `\`${id}\``).join(' vs ')}`);
  out.push('');
  for (const [key, value] of Object.entries(meta)) out.push(`- ${key}: \`${value}\``);
  out.push('');

  out.push('#### Verify, first, per arm');
  out.push('');
  out.push('| arm | verify | failing checks |');
  out.push('| --- | --- | --- |');
  for (const arm of arms) {
    const failing = arm.verifyChecks.filter((c) => !c.pass).map((c) => `\`${c.name}\``).join(', ');
    out.push(`| \`${arm.strategy}\` | ${arm.verifyPassed ? 'PASSED' : '**FAILED**'} | ${failing === '' ? '—' : failing} |`);
  }
  out.push('');
  out.push(
    'An arm whose verify fails measured the container\'s own blank disk. Its rows below are '
    + 'recorded for diagnosis and are NOT ranked.',
  );
  out.push('');

  const ticks = arms.flatMap((arm) => arm.decisiveTicks);
  if (ticks.length > 0) {
    out.push('#### The decisive experiment');
    out.push('');
    out.push(
      'Three workloads, chosen because each makes PENDING CHANGE and CHANGED SET diverge, '
      + 'with a checkpoint between every segment. The measurement is the TICK; the workload only '
      + 'exists to put a known amount of pending change in front of one. Priced at R2 published '
      + `rates: $${R2_CLASS_A_USD_PER_MILLION.toFixed(2)}/M class A, `
      + `$${R2_CLASS_B_USD_PER_MILLION.toFixed(2)}/M class B.`,
    );
    out.push('');
    out.push(
      'NO NETWORK on these containers, so neither `npm install` nor `git clone` can run. Both are '
      + 'reproduced by their filesystem SHAPE — a generated dependency tree and a locally seeded '
      + 'repository with 200 real commits — which is what the storage layer sees either way. The '
      + 'git arm uses real `git`, so its index rewrites and object churn are genuine.',
    );
    out.push('');
    out.push(
      'One confound is structurally absent rather than argued away. The chain rebases only at a '
      + 'QUIESCE, and a rebase moves a full-tree archive, so a rebase inside a measurement window '
      + 'would inflate that arm\'s tick sum for a reason unrelated to the strategy — two runs of '
      + 'identical workloads with different stop counts would disagree. This driver issues ONLY '
      + 'ticks inside the decisive window, and the quiesce counts below are how a reader checks '
      + 'that rather than taking it.',
    );
    out.push('');
    out.push('| arm | quiesces before the window | quiesces inside it | rebased in the ladder |');
    out.push('| --- | --- | --- | --- |');
    for (const arm of arms) {
      const before = arm.generationBeforeLadder;
      const after = arm.generationAfterLadder;
      // OBSERVED, not weighed. A rebase writes a fresh base uuid and drops the
      // delta, so the pair answers it outright. `n/a` is a non-chain arm, which
      // is the interesting half: overlay-cas never rebases, so a chain that does
      // is a structural difference reproducing on every run with this ladder.
      const rebased = before === null || after === null
        ? 'not read'
        : before.baseId === null && after.baseId === null
          ? 'n/a (not a chain)'
          : before.baseId !== after.baseId
            ? `YES (${String(before.baseId).slice(0, 8)} -> ${String(after.baseId).slice(0, 8)})`
            : 'no';
      out.push(
        `| \`${arm.strategy}\` | ${arm.quiescesBeforeDecisive} | ${arm.decisiveQuiesces} `
        + `| ${rebased} |`,
      );
    }
    out.push('');
    out.push(
      'The ladder\'s quiesces DO precede the window, so a rebase there changes the base the '
      + 'decisive ticks are measured against. That is a state difference rather than a tick-cost '
      + 'confound, and the column above says whether it happened instead of leaving it as a '
      + 'possibility: a rebase writes a fresh base id and drops the delta, so the generation '
      + 'before and after the ladder answers it outright. The ladder\'s FIRST quiesce cannot '
      + 'rebase, because it creates the base and there is no delta to outgrow it.',
    );
    out.push('');
    out.push('| arm | workload | ticks | Σ tick ms | p50 | p95 | class A | class B | MiB moved | USD |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const arm of arms) {
      for (const spec of DECISIVE_WORKLOADS) {
        const totals = totalsFor(arm.decisiveTicks, spec.id);
        if (totals.ticks === 0) continue;
        const blind = opsAreBlind(arm.decisiveTicks, spec.id);
        const opsCell = blind ? 'unmeasured' : String(totals.classA);
        const bCell = blind ? 'unmeasured' : String(totals.classB);
        const usdCell = blind ? 'unmeasured' : `$${totals.usd.toFixed(6)}`;
        const movedCell = !totals.movedReported
          ? 'not measurable'
          : totals.unanswerable > 0
            ? `${(totals.bytesPut / 1024 / 1024).toFixed(1)} (${totals.unanswerable} tick(s) could not answer)`
            : (totals.bytesPut / 1024 / 1024).toFixed(1);
        out.push(
          `| \`${arm.strategy}\` | ${spec.id} | ${totals.ticks} | ${Math.round(totals.sumWallMs)} `
          + `| ${Math.round(totals.p50WallMs)} | ${Math.round(totals.p95WallMs)} | ${opsCell} `
          + `| ${bCell} | ${movedCell} | ${usdCell} |`,
        );
      }
    }
    out.push('');

    // The rule, applied to the rows above and to nothing else. Stated with its
    // thresholds so a reader can check the arithmetic rather than trust it.
    const candidate = STRATEGIES.find((id) => id === 'overlay-cas');
    if (candidate !== undefined) {
      // ONLY VERIFY-PASSING ARMS REACH THE RULE.
      //
      // MEASURED HOLE IN THIS INSTRUMENT: `decide` takes ticks and knows nothing
      // about verify, so a run where overlay-cas failed /verify still produced
      // twenty priced ticks and a computed ratio. That is the blank-disk ranking
      // the verify gate exists to prevent, arriving through a different door —
      // and it would have published a confident `chain stays default` from an
      // arm that never attached. The gate is enforced here, at the rule, rather
      // than trusted to have been enforced earlier.
      const rankable = rankableTicks(arms, ticks);
      const refused = arms.filter((arm) => !arm.verifyPassed).map((arm) => arm.strategy);
      if (refused.length > 0) {
        out.push(
          `REFUSED FROM RANKING: ${refused.map((id) => `\`${id}\``).join(', ')} failed /verify, so `
          + 'their ticks measured a container\'s own blank disk and are excluded from the ratio '
          + 'below. Their rows remain in the table above for diagnosis.',
        );
        out.push('');
      }
      const verdict: DecisionVerdict = decide(rankable, 'snapshot-chain', candidate);
      out.push('#### Decision rule');
      out.push('');
      out.push(
        'ratio(w) = Σ ticks(`snapshot-chain`, w) / Σ ticks(`overlay-cas`, w). '
        + 'ratio(git) ≥ 10 AND ratio(npm) ≥ 3 ⇒ the O(p) shape wins outright. '
        + 'Both < 3 ⇒ O(c) tick cost is not the bottleneck and the chain stays. '
        + 'Between them the rule is deliberately undecided, and says so.',
      );
      out.push('');
      out.push(verdict.kind === 'inconclusive'
        ? `**INCONCLUSIVE.** ${verdict.reason}`
        : `**${verdict.kind === 'o-p-wins' ? 'THE O(p) SHAPE WINS' : 'THE CHAIN STAYS DEFAULT'}.** ${verdict.detail}`);
      out.push('');
      out.push(
        'The 10x and 3x bars are CHOSEN thresholds from the research that set them, not measured '
        + 'constants. This experiment measures the ratio; it does not confirm the bar.',
      );
      out.push('');
    }

    // The sqlite arm answers a different question and must not be read as a
    // vote on the default.
    out.push('#### The sqlite arm, which decides a separate question');
    out.push('');
    out.push(
      'A 64 MiB database rewritten in place through real SQLite. This decides whether '
      + 'extent-level in-place tracking is ever worth building, NOT which strategy is default. '
      + 'File-granularity re-shipping the whole database per tick is recorded here as a cost, '
      + 'never treated as disqualifying.',
    );
    out.push('');
    for (const arm of arms) {
      const dbBytes = arm.treeBytes['sqlite'] ?? -1;
      out.push(`- \`${arm.strategy}\`: ${sqliteFinding(arm.decisiveTicks, dbBytes)}`);
    }
    out.push('');
  }

  out.push('#### Lifecycle');
  out.push('');
  out.push('| arm | attach cold (ms) | attach warm (ms) | stop (ms) | wake (ms) | wake attach.kind |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const arm of arms) {
    out.push(
      `| \`${arm.strategy}\` | ${num(arm.attachColdMs, 0)} | ${num(arm.attachWarmMs, 0)} `
      + `| ${num(arm.stopMs, 0)} | ${num(arm.wakeMs, 0)} `
      + `| ${arm.wakeKind === 'attached' ? 'attached' : `**${arm.wakeKind || 'unknown'}**`} |`,
    );
  }
  out.push('');
  out.push(
    'A wake whose `attach.kind` is not `attached` did not restore anything: the container never '
    + 'went down, so no durability conclusion may be drawn from that cycle.',
  );
  out.push('');

  out.push('#### Checkpoint ladder');
  out.push('');
  out.push('| arm | change | kind | ms | bytes committed | outcome |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const arm of arms) {
    for (const row of arm.checkpoints) {
      out.push(
        `| \`${arm.strategy}\` | ${row.changeKiB >= 1024 ? `${row.changeKiB / 1024} MiB` : `${row.changeKiB} KiB`} `
        + `| ${row.kind} | ${num(row.ms, 0)} | ${num(row.bytes, 0)} | ${row.outcome} |`,
      );
    }
  }
  out.push('');

  out.push('#### Workload, per-operation p50 (ms)');
  out.push('');
  const header = ['metric', ...arms.map((a) => `\`${a.strategy}\``)];
  out.push(`| ${header.join(' | ')} |`);
  out.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const metric of HEADLINE) {
    const cells = arms.map((arm) => {
      const found = metricSummary(arm, metric);
      return found === null ? '—' : num(found.p50);
    });
    if (cells.every((c) => c === '—')) continue;
    out.push(`| \`${metric}\` | ${cells.join(' | ')} |`);
  }
  out.push('');

  out.push('#### R2 operations and teardown');
  out.push('');
  out.push('| arm | class A | class B | free | total | teardown |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const arm of arms) {
    out.push(
      `| \`${arm.strategy}\` | ${num(arm.ops?.classA ?? null, 0)} | ${num(arm.ops?.classB ?? null, 0)} `
      + `| ${num(arm.ops?.classFree ?? null, 0)} | ${num(arm.ops?.total ?? null, 0)} `
      + `| ${JSON.stringify(arm.teardown ?? {})} |`,
    );
  }
  out.push('');

  const notes = arms.flatMap((arm) => arm.notes.map((note) => `\`${arm.strategy}\`: ${note}`));
  if (notes.length > 0) {
    out.push('#### What did not hold');
    out.push('');
    for (const note of notes) out.push(`- ${note}`);
    out.push('');
  }

  out.push('#### Recommendation');
  out.push('');
  out.push(recommend(arms));
  out.push('');
  return out.join('\n');
}

/**
 * One recommendation, derived from the rows rather than written beside them.
 *
 * The deciding quantity is small-file and metadata latency, because that is what
 * a workspace does; the checkpoint ladder decides the cost of keeping it durable;
 * and a failed verify or an unverified wake disqualifies an arm outright, because
 * a fast number from a blank disk is worse than no number.
 */
export function recommend(arms: readonly ArmResult[]): string {
  const ranked = arms.filter((arm) => arm.verifyPassed);
  if (ranked.length === 0) {
    return 'NO DEFAULT IS DERIVABLE FROM THIS RUN. No arm passed /verify, which means every arm '
      + 'measured the container\'s own blank disk rather than its strategy. The lifecycle rows above '
      + 'say which checks failed; fix those before reading any latency from this table.';
  }
  if (ranked.length === 1) {
    const only = ranked[0]!;
    return `ONLY \`${only.strategy}\` PASSED /verify, so it is the default by default rather than by `
      + `measurement. That is a weaker statement than this benchmark exists to make: the other arm's `
      + `verify failure is the thing to fix, and the comparison should be re-run before the choice is `
      + `treated as settled.`;
  }

  const key = 'small-stat-1k';
  const scored = ranked
    .map((arm) => ({ arm, stat: metricSummary(arm, key)?.p50 ?? null }))
    .filter((row): row is { arm: ArmResult; stat: number } => row.stat !== null);
  if (scored.length < 2) {
    return 'Both arms passed /verify but the deciding metric did not complete on both, so the arms '
      + 'are not separable on this run. The workload table says which cells are missing.';
  }
  scored.sort((a, b) => a.stat - b.stat);
  const best = scored[0]!;
  const worst = scored[scored.length - 1]!;
  const ratio = worst.stat / best.stat;
  const wakeNote = best.arm.wakeKind === 'attached'
    ? ''
    : ` Its wake was NOT verified (attach.kind '${best.arm.wakeKind}'), so the restore half of this `
      + 'recommendation rests on the checkpoint ladder rather than on an observed cold start.';

  return `DEFAULT TO \`${best.arm.strategy}\`. On the metric that decides a workspace — metadata `
    + `latency over many small files — it is ${ratio.toFixed(1)}x faster than \`${worst.arm.strategy}\` `
    + `(${best.stat.toFixed(2)} ms against ${worst.stat.toFixed(2)} ms per \`stat\`), and both arms `
    + `passed /verify so both numbers describe a real attached workspace rather than a blank disk.`
    + wakeNote;
}

// ── main ────────────────────────────────────────────────────────────────────

function parseOptions(argv: readonly string[]): Options {
  const value = (name: string, fallback: string): string => {
    const index = argv.indexOf(`--${name}`);
    return index !== -1 && index + 1 < argv.length ? argv[index + 1]! : fallback;
  };
  const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return {
    runId,
    seed: Number.parseInt(value('seed', '20260824'), 10),
    budgetMs: Number.parseInt(value('budget-ms', '8000'), 10),
    decisive: argv.includes('--decisive'),
    plan: argv.includes('--plan'),
    keep: argv.includes('--keep'),
    arms: value('arms', STRATEGIES.join(',')).split(',').map((raw): Strategy => {
      const arm = STRATEGIES.find((s) => s === raw.trim());
      if (arm === undefined) {
        throw new Error(`--arms names "${raw.trim()}"; known arms: ${STRATEGIES.join(', ')}`);
      }
      return arm;
    }),
    out: value('out', join('bench-artifacts', `devbox-strategies-${runId}.json`)),
  };
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options.plan) {
    process.stdout.write(
      `Devbox strategy A/B plan\n\narms          ${STRATEGIES.join(', ')}\n`
      + `phases        ${PHASES.join(',')}\n`
      + `process-driven ${[...PROCESS_PHASES].join(',')}\n`
      + `change sizes  ${CHANGE_SIZES_KIB.map((k) => (k >= 1024 ? `${k / 1024}MiB` : `${k}KiB`)).join(', ')}\n`
      + `bucket        ${BUCKET}\nworker        ${FIXTURE_WORKER}\n`
      + `artifact      ${options.out}\n\nNothing has run. Drop --plan to execute.\n`,
    );
    return 0;
  }
  if (!existsSync(join(BENCH_DIR, 'worker.ts'))) {
    throw new Error(`the devbox bench app is not present at ${BENCH_DIR}`);
  }
  if (wrangler(['whoami'], { allowFailure: true }).startsWith('WRANGLER_FAILED')) {
    log('wrangler is not authenticated; nothing can be deployed');
    return 1;
  }

  const token = `devbox-${crypto.randomUUID()}`;
  const arms: ArmResult[] = [];
  let stop: (() => void) | null = null;
  let failure: string | null = null;

  try {
    const started = await deployFixture(token);
    stop = started.stop;
    publishTeardown(async (): Promise<void> => {
      if (stop !== null) stop();
      if (!options.keep) {
        const deleted = wrangler(['r2', 'bucket', 'delete', BUCKET], { allowFailure: true });
        log(deleted.startsWith(WRANGLER_FAILED)
          ? 'bucket not deleted (objects or pending multipart uploads remain; a lifecycle rule aborting incomplete uploads is the remedy)'
          : 'bucket deleted');
      }
    });
    for (const strategy of options.arms) {
      arms.push(await measureArm(started.fixture, strategy, options));
    }
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log(`run failed: ${failure}`);
  } finally {
    await runTeardownOnce();
  }

  const meta: RunMeta = {
    date: new Date().toISOString().slice(0, 10),
    worker: FIXTURE_WORKER,
    bucket: BUCKET,
    image: 'docker.io/cloudflare/sandbox:0.12.8',
    seed: String(options.seed),
    'loop budget ms': String(options.budgetMs),
  };
  // A run that stopped early says so in its own header rather than looking whole.
  if (failure !== null) meta['INCOMPLETE'] = failure;
  mkdirSync(dirname(join(REPO_ROOT, options.out)), { recursive: true });
  writeFileSync(join(REPO_ROOT, options.out), `${JSON.stringify({ meta, arms }, null, 2)}\n`);
  process.stdout.write(`${render(arms, meta)}\n`);
  log(`artifact written to ${options.out}`);
  return failure === null ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
