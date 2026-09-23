/**
 * D8's control under each SDK shape: the probe's reentry run (`probeReentry`) on three builds of
 * the same probe, told apart only by the patches applied to the pristine SDK packages.
 *
 *   outside  the base revision's pair: `onStart` after the start block (D8, shipped 2026-09-13)
 *   inside   upstream's block with the base revision's sandbox patch: the hook in the block,
 *            its calls on whatever control connection is open
 *   rotated  this tree's pair: the hook in the block on a connection opened inside it, with the
 *            SDK's own timers set outside the block cleared at its entry
 *
 * Each run leaves one timer set outside the start block pending (`--pending`): the control
 * connection's timers after an exec, the alarm loop's wait between two schedule rows, or a stray
 * timer nothing clears. `--local` runs each build under `wrangler dev` with Docker; otherwise each
 * build deploys as its own Worker, waits for its container application, runs, and deletes both.
 * Every run uses a fresh box; `--reset-window` adds one run whose window outlives the 30 s cap.
 *
 *   bun scripts/bench-devbox-onstart-shapes.ts [--local] [--arms outside,inside,rotated]
 *     [--pending connection,alarm,stray] [--runs 3] [--window-ms 5000] [--hold-ms 2000]
 *     [--reset-window] [--touch-ms 250] [--gate-cells] [--base <rev>]
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import {
  awaitApplicationRollout, containerAppIds, containerApplicationName, delay, deleteContainerApps, describeThrown,
  runWrangler,
} from './fixtures/r2-bench/deploy-substrate';
import { parseJsonc } from './jsonc';
import { REENTRY_PENDING, type ReentryPending, type ReentryStamp } from '../packages/devbox/bench/reentry';

const REPO = new URL('..', import.meta.url).pathname;

const PROBE_DIR = join(REPO, 'packages/devbox/bench');

const ARMS = ['outside', 'inside', 'rotated'] as const;

type Arm = (typeof ARMS)[number];

const CONTAINERS_PATCH = 'patches/@cloudflare%2Fcontainers@0.3.7.patch';

const SANDBOX_PATCH = 'patches/@cloudflare%2Fsandbox@0.12.8.patch';

/** Past the platform's 30 s `blockConcurrencyWhile` cap, so a hook that never hears its reply
 *  is reset by the platform, as D8's control was, rather than cut short by the probe. */
const RESET_WINDOW_MS = 45_000;

const ProbeConfigSchema = v.looseObject({
  name: v.string(),
  containers: v.array(v.looseObject({ class_name: v.string(), image: v.string() })),
});

const DevboxManifestSchema = v.object({
  dependencies: v.object({ '@cloudflare/containers': v.string(), '@cloudflare/sandbox': v.string() }),
});

const StampSchema = v.object({
  windowMs: v.number(),
  holdMs: v.number(),
  pending: v.picklist(REENTRY_PENDING),
  started: v.number(),
  armed: v.boolean(),
  firstStartMs: v.nullable(v.number()),
  openerExecMs: v.nullable(v.number()),
  hookEntered: v.nullable(v.number()),
  hookExecMs: v.nullable(v.number()),
  hookExecError: v.nullable(v.string()),
  lateReplyAt: v.nullable(v.number()),
  hookExited: v.nullable(v.number()),
  reentryReturned: v.nullable(v.number()),
  error: v.nullable(v.string()),
}) satisfies v.GenericSchema<unknown, ReentryStamp>;


const StampReplySchema = v.looseObject({ ok: v.boolean(), error: v.optional(v.string()), stamp: v.optional(v.nullable(StampSchema)) });

const TouchReplySchema = v.looseObject({ ok: v.boolean(), at: v.optional(v.number()) });

interface RunObservation {
  readonly box: string;
  readonly windowMs: number;
  readonly holdMs: number;
  readonly pending: ReentryPending;
  readonly postMs: number;
  readonly postStatus: number | null;
  readonly postError: string | null;
  readonly stamp: ReentryStamp | null;
  /** Delivery times of the touches, each as ms since the reentry POST was sent. */
  readonly touches: readonly number[];
  /** Touches the Durable Object ran between `hookEntered` and `hookExited`; 0 means the hook held the gate. */
  readonly touchesInsideHook: number | null;
  readonly verdict: string;
  readonly cleanup: string;
}

interface ArmObservation {
  readonly arm: Arm;
  /** Where each patch came from, and a digest of each patched file as bundled. */
  readonly patches: {
    readonly containers: string; readonly sandbox: string; readonly containerJs: string; readonly sandboxJs: string;
  };
  worker: string;
  origin: string | null;
  rolloutMs: number | null;
  runs: RunObservation[];
  gates: GateObservation[];
  cleanup: string[];
  errors: string[];
}

const log = (message: string): void => { process.stderr.write(`[onstart-shapes] ${message}\n`); };

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

/** A patch's text at a revision; `worktree` reads this tree's file as it stands. */
function patchText(path: string, revision: string): string {
  return revision === 'worktree' ? readFileSync(join(REPO, path), 'utf8') : git(['show', `${revision}:${path}`]);
}

/** Pristine packages from the registry at the versions `packages/devbox` pins, one copy per arm. */
function pristinePackage(name: string, version: string, into: string, runDir: string): void {
  const packDir = join(runDir, 'packs');
  mkdirSync(packDir, { recursive: true });
  const tarball = execFileSync('npm', ['pack', `${name}@${version}`, '--pack-destination', packDir], { encoding: 'utf8' }).trim().split('\n').at(-1);

  if (tarball === undefined || tarball.length === 0) throw new Error(`npm pack ${name}@${version} named no tarball`);
  mkdirSync(into, { recursive: true });
  execFileSync('tar', ['xzf', join(packDir, tarball), '-C', into, '--strip-components=1']);
}

/** GNU `patch`, not `git apply`: under a repository `git apply` resolves paths from the repository
 *  root and silently skips a package directory inside `bench-artifacts/`, leaving it pristine. */
function applyPatch(text: string, packageDir: string, runDir: string, label: string): void {
  const file = join(runDir, `${label}.patch`);
  writeFileSync(file, text);
  execFileSync('patch', ['-p1', '--forward', '--batch', '--no-backup-if-mismatch', '-d', packageDir, '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The arm's module tree: both SDK packages patched as the arm says, and their two runtime
 *  dependencies linked from this checkout so every arm bundles the same versions of them. */
function materialize(arm: Arm, base: string, runDir: string) {
  const manifest = v.parse(DevboxManifestSchema, JSON.parse(readFileSync(join(REPO, 'packages/devbox/package.json'), 'utf8')));
  const modules = join(runDir, arm, 'node_modules');
  const containersDir = join(modules, '@cloudflare/containers');
  const sandboxDir = join(modules, '@cloudflare/sandbox');
  pristinePackage('@cloudflare/containers', manifest.dependencies['@cloudflare/containers'], containersDir, runDir);
  pristinePackage('@cloudflare/sandbox', manifest.dependencies['@cloudflare/sandbox'], sandboxDir, runDir);
  const containersFrom = { outside: base, inside: 'none', rotated: 'worktree' }[arm];
  const sandboxFrom = arm === 'rotated' ? 'worktree' : base;

  if (containersFrom !== 'none') applyPatch(patchText(CONTAINERS_PATCH, containersFrom), containersDir, runDir, `${arm}-containers`);
  applyPatch(patchText(SANDBOX_PATCH, sandboxFrom), sandboxDir, runDir, `${arm}-sandbox`);
  const require = createRequire(join(REPO, 'node_modules/@cloudflare/sandbox/package.json'));

  for (const dependency of ['capnweb', 'aws4fetch']) {
    symlinkSync(dirname(require.resolve(`${dependency}/package.json`)), join(modules, dependency));
  }

  const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  const sandboxChunk = readdirSync(join(sandboxDir, 'dist')).find((name) => /^sandbox-.*\.js$/.test(name));

  if (sandboxChunk === undefined) throw new Error(`no sandbox chunk under ${sandboxDir}/dist`);

  return {
    modules,
    patches: {
      containers: containersFrom, sandbox: sandboxFrom,
      containerJs: digest(join(containersDir, 'dist/lib/container.js')), sandboxJs: digest(join(sandboxDir, 'dist', sandboxChunk)),
    },
  };
}

function writeConfig(arm: Arm, worker: string, modules: string, runDir: string): string {
  const parsed = parseJsonc(readFileSync(join(PROBE_DIR, 'wrangler.probe.jsonc'), 'utf8'), ProbeConfigSchema, 'probe config');
  const path = join(runDir, arm, 'wrangler.json');
  writeFileSync(path, `${JSON.stringify({
    ...parsed,
    $schema: join(REPO, 'node_modules/wrangler/config-schema.json'),
    name: worker,
    main: join(PROBE_DIR, 'probe-worker.ts'),
    alias: {
      '@cloudflare/containers': join(modules, '@cloudflare/containers/dist/index.js'),
      '@cloudflare/sandbox': join(modules, '@cloudflare/sandbox/dist/index.js'),
    },
  }, null, 2)}\n`);

  return path;
}

async function post(origin: string, token: string, path: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const reply = await fetch(`${origin}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await reply.text();

  try {
    return { status: reply.status, body: JSON.parse(text) };
  } catch (cause) {
    throw new Error(`${path} answered ${String(reply.status)} with a non-JSON body: ${text.slice(0, 200)}`, { cause });
  }
}

async function readStamp(origin: string, token: string, box: string): Promise<ReentryStamp | null> {
  const reply = await fetch(`${origin}/probe/reentry?box=${box}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });

  return v.parse(StampReplySchema, await reply.json()).stamp ?? null;
}

function judge(stamp: ReentryStamp | null, touchesInside: number | null, postError: string | null): string {
  if (stamp === null) return `no stamp${postError === null ? '' : `: ${postError}`}`;

  if (stamp.hookEntered === null) return `the hook never ran${stamp.error === null ? '' : `: ${stamp.error}`}`;
  let replied = `no reply inside ${String(stamp.windowMs)} ms`;

  if (stamp.hookExecError !== null) replied = `failed: ${stamp.hookExecError}`;
  else if (stamp.hookExecMs !== null) replied = `replied in ${String(stamp.hookExecMs)} ms`;

  let held = 'gate unmeasured';

  if (touchesInside === 0) held = 'gate held';
  else if (touchesInside !== null) held = `${String(touchesInside)} requests ran inside the hook`;

  const detail = postError === null ? '' : ` (${postError})`;
  const ended = stamp.hookExited === null ? `hook never exited${detail}` : 'hook exited';

  return `${replied}; ${held}; ${ended}`;
}

/** One probe target and one reentry cell; `touchMs` 0 sends no requests during the run. */
interface Cell {
  readonly origin: string;
  readonly token: string;
  readonly box: string;
  readonly windowMs: number;
  readonly holdMs: number;
  readonly touchMs: number;
  readonly pending: ReentryPending;
}

async function runOnce({ origin, token, box, windowMs, holdMs, touchMs, pending }: Cell): Promise<RunObservation> {
  const sent = Date.now();
  const touches: number[] = [];
  let done = touchMs === 0;

  const touching = (async (): Promise<void> => {
    while (!done) {
      try {
        const reply = v.parse(TouchReplySchema, (await post(origin, token, `/probe/reentry/touch?box=${box}`, 60_000)).body);

        if (reply.at !== undefined) touches.push(reply.at - sent);
      } catch (cause) {
        log(`${box}: touch failed: ${describeThrown({ cause })}`);
      }

      await delay(touchMs);
    }
  })();

  let postStatus: number | null = null;
  let postError: string | null = null;

  try {
    const reply = await post(origin, token, `/probe/reentry?box=${box}&windowMs=${String(windowMs)}&holdMs=${String(holdMs)}&pending=${pending}`, 180_000);
    postStatus = reply.status;

    if (reply.status !== 200) postError = JSON.stringify(reply.body).slice(0, 300);
  } catch (cause) {
    postError = describeThrown({ cause });
  }

  const postMs = Date.now() - sent;
  done = true;
  await touching;
  await delay(1_000);
  const stamp = await readStamp(origin, token, box);
  const entered = stamp?.hookEntered ?? null;
  const exited = stamp?.hookExited ?? null;
  const touchesInsideHook = entered === null || exited === null ? null : touches.filter((at) => at + sent > entered && at + sent < exited).length;
  let cleanup: string;

  try {
    cleanup = `destroy ${String((await post(origin, token, `/probe/onstart/destroy?box=${box}`, 60_000)).status)}`;
  } catch (cause) {
    cleanup = `destroy failed: ${describeThrown({ cause })}`;
  }

  return { box, windowMs, holdMs, pending, postMs, postStatus, postError, stamp, touches, touchesInsideHook, verdict: judge(stamp, touchesInsideHook, postError), cleanup };
}

const GateReplySchema = v.looseObject({
  ok: v.boolean(),
  stamp: v.optional(v.nullable(v.looseObject({ entered: v.number(), completed: v.nullable(v.number()) }))),
});

interface GateObservation {
  readonly op: string;
  readonly queued: boolean;
  readonly postStatus: number | null;
  /** From `entered` to the 50 ms timer's completion inside the block; null when it never fired. */
  readonly timerMs: number | null;
  readonly reads: number;
}

/** P2 again: the plain DO's 50 ms timer inside a block, alone and with reads queued at its gate. */
async function runGateCell(origin: string, token: string, op: string, queued: boolean): Promise<GateObservation> {
  const headers = { authorization: `Bearer ${token}` };
  let done = !queued;
  let reads = 0;

  const reading = (async (): Promise<void> => {
    while (!done) {
      try {
        await fetch(`${origin}/probe/gate?op=${op}`, { headers, signal: AbortSignal.timeout(60_000) });
        reads += 1;
      } catch (cause) {
        log(`${op}: read failed: ${describeThrown({ cause })}`);
      }

      await delay(100);
    }
  })();

  let postStatus: number | null = null;

  try {
    postStatus = (await post(origin, token, `/probe/gate?arm=timer-inside&op=${op}`, 120_000)).status;
  } catch (cause) {
    log(`${op}: gate probe failed: ${describeThrown({ cause })}`);
  }

  done = true;
  await reading;
  const reply = await fetch(`${origin}/probe/gate?op=${op}`, { headers, signal: AbortSignal.timeout(60_000) });
  const stamp = v.parse(GateReplySchema, await reply.json()).stamp ?? null;
  const completed = stamp?.completed ?? null;

  return { op, queued, postStatus, timerMs: stamp === null || completed === null ? null : completed - stamp.entered, reads };
}

interface Plan {
  readonly local: boolean;
  readonly arms: readonly Arm[];
  readonly pending: readonly ReentryPending[];
  readonly runs: number;
  readonly windowMs: number;
  readonly holdMs: number;
  readonly resetWindow: boolean;
  readonly base: string;
  readonly touchMs: number;
  readonly gateCells: boolean;
}

/** `exited` stops the wait when a local `wrangler dev` dies first, so a server that some other
 *  process holds on the same address is never mistaken for the probe. */
async function awaitHealth(origin: string, deadlineMs: number, exited: () => boolean): Promise<void> {
  const since = Date.now();

  for (;;) {
    if (exited()) throw new Error(`the probe Worker exited before it answered /health at ${origin}`);

    try {
      if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) })).status === 200) return;
    } catch (cause) {
      if (Date.now() - since > deadlineMs) throw new Error(`the probe Worker never answered /health at ${origin}`, { cause });
    }

    if (Date.now() - since > deadlineMs) throw new Error(`the probe Worker never answered /health at ${origin}`);
    await delay(1_000);
  }
}

const ListeningSchema = v.object({ port: v.number() });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });

  return v.parse(ListeningSchema, address).port;
}

/** What every arm of one run shares. */
interface RunContext {
  readonly plan: Plan;
  readonly runId: string;
  readonly runDir: string;
  readonly token: string;
  readonly save: (row: ArmObservation) => void;
}

/** Starts `wrangler dev` for one arm; the returned stop kills it and reports how it exited. */
async function startLocal(arm: Arm, config: string, row: ArmObservation, context: RunContext): Promise<() => Promise<string>> {
  const port = await freePort();

  const child = spawn('bunx', ['wrangler', 'dev', '--config', config, '--port', String(port), '--ip', '0.0.0.0', '--var', `PROBE_TOKEN:${context.token}`], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
  });

  const devLog = join(context.runDir, arm, 'wrangler-dev.log');
  child.stdout.on('data', (chunk: Buffer) => { writeFileSync(devLog, chunk, { flag: 'a' }); });
  child.stderr.on('data', (chunk: Buffer) => { writeFileSync(devLog, chunk, { flag: 'a' }); });
  row.origin = `http://127.0.0.1:${String(port)}`;

  const stop = async (): Promise<string> => {
    child.kill('SIGINT');
    await delay(5_000);

    return `wrangler dev exited: ${String(child.exitCode ?? child.signalCode)}`;
  };

  try {
    await awaitHealth(row.origin, 300_000, () => child.exitCode !== null || child.signalCode !== null);
  } catch (cause) {
    row.cleanup.push(await stop());
    throw cause;
  }

  return stop;
}

async function runArm(arm: Arm, context: RunContext): Promise<ArmObservation> {
  const { plan, runId, runDir, token, save } = context;
  const worker = `kinu-devbox-shapes-${runId}-${arm}`;
  const { modules, patches } = materialize(arm, plan.base, runDir);
  const row: ArmObservation = { arm, patches, worker, origin: null, rolloutMs: null, runs: [], gates: [], cleanup: [], errors: [] };
  save(row);
  const config = writeConfig(arm, worker, modules, runDir);
  const application = containerApplicationName(worker, 'OnStartExecProbe');
  let stopLocal: (() => Promise<string>) | null = null;

  try {
    if (plan.local) {
      stopLocal = await startLocal(arm, config, row, context);
    } else {
      const output = runWrangler(REPO, ['deploy', '--config', config, '--var', `PROBE_TOKEN:${token}`]);
      const deployedAt = Date.now();
      row.origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0] ?? null;

      if (row.origin === null) throw new Error(`deploy printed no workers.dev origin:\n${output.slice(-1500)}`);
      await awaitHealth(row.origin, 180_000, () => false);
      row.rolloutMs = (await awaitApplicationRollout({ repoRoot: REPO, application, log, since: deployedAt, deadlineMs: 240_000 })).readyAfterMs;
    }

    save(row);
    const origin = row.origin;

    if (origin === null) throw new Error(`${arm} has no origin to drive`);

    const cells = plan.pending.flatMap((pending) => [
      ...Array.from({ length: plan.runs }, () => ({ pending, windowMs: plan.windowMs })),
      ...(plan.resetWindow ? [{ pending, windowMs: RESET_WINDOW_MS }] : []),
    ]);

    for (const [index, { pending, windowMs }] of cells.entries()) {
      const observed = await runOnce({ origin, token, box: `${arm}-${runId}-${String(index)}`, windowMs, holdMs: plan.holdMs, touchMs: plan.touchMs, pending });
      row.runs.push(observed);
      log(`${arm} run ${String(index)} (${pending}, window ${String(windowMs)} ms): ${observed.verdict}; POST ${String(observed.postStatus)} after ${String(observed.postMs)} ms`);
      save(row);
    }

    for (const queued of plan.gateCells ? [false, true] : []) {
      const gate = await runGateCell(origin, token, `${arm}-${runId}-gate-${queued ? 'queued' : 'alone'}`, queued);
      row.gates.push(gate);
      log(`${arm} gate cell ${queued ? 'with reads queued' : 'alone'}: timer ${gate.timerMs === null ? 'never fired' : `fired after ${String(gate.timerMs)} ms`}, ${String(gate.reads)} reads`);
      save(row);
    }
  } catch (cause) {
    row.errors.push(describeThrown({ cause }));
  } finally {
    if (stopLocal !== null) {
      row.cleanup.push(await stopLocal());
    } else if (!plan.local) {
      row.cleanup.push(`worker: ${runWrangler(REPO, ['delete', '--name', worker, '--force'], { allowFailure: true }).slice(0, 80).replace(/\s+/g, ' ')}`);
      row.cleanup.push(...deleteContainerApps(REPO, [application], log));
      row.cleanup.push(`application listed after delete: ${String(containerAppIds(REPO, [application], log).length)}`);
    }

    save(row);
  }

  return row;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);

  return index === -1 ? undefined : process.argv[index + 1];
}

function parsePlan(): Plan {
  const arms = (option('--arms') ?? ARMS.join(',')).split(',').map((arm) => v.parse(v.picklist(ARMS), arm));
  const pending = (option('--pending') ?? 'connection').split(',').map((kind) => v.parse(v.picklist(REENTRY_PENDING), kind));

  return {
    local: process.argv.includes('--local'),
    arms,
    pending,
    runs: Number(option('--runs') ?? '3'),
    windowMs: Number(option('--window-ms') ?? '5000'),
    holdMs: Number(option('--hold-ms') ?? '2000'),
    resetWindow: process.argv.includes('--reset-window'),
    base: option('--base') ?? git(['merge-base', 'HEAD', 'main']).trim(),
    touchMs: Number(option('--touch-ms') ?? '250'),
    gateCells: process.argv.includes('--gate-cells'),
  };
}

async function run(): Promise<number> {
  const plan = parsePlan();
  const runId = `s${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const artifacts = join(REPO, 'bench-artifacts', 'onstart-shapes', runId);
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  const token = crypto.randomUUID();
  const arms: ArmObservation[] = [];
  const revision = git(['rev-parse', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain']).trim().length > 0;

  const save = (): void => {
    writeFileSync(join(artifacts, 'observations.json'), `${JSON.stringify({ runId, date: new Date().toISOString(), revision, dirty, plan, arms }, null, 2)}\n`);
  };

  for (const arm of plan.arms) {
    const row = await runArm(arm, {
      plan, runId, runDir: artifacts, token,
      save: (current) => { if (!arms.includes(current)) arms.push(current); save(); },
    });

    log(`${arm}: ${JSON.stringify(row.runs.map((one) => one.verdict))} errors ${JSON.stringify(row.errors)}`);
  }

  save();
  process.stdout.write(`${JSON.stringify({ artifact: join(artifacts, 'observations.json'), revision, dirty, arms: arms.map((arm) => ({ arm: arm.arm, rolloutMs: arm.rolloutMs, verdicts: arm.runs.map((one) => one.verdict), errors: arm.errors, cleanup: arm.cleanup })) })}\n`);

  return arms.every((arm) => arm.errors.length === 0) ? 0 : 1;
}

if (import.meta.main) process.exitCode = await run();
