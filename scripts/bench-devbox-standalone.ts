/**
 * DBX-9's acceptance run: `packages/devbox/example`, a Worker that uses Devbox with no Kinu code,
 * deployed on its own Worker, bucket and container application, and driven through the life a
 * machine that stays must survive:
 *
 *   start     a box attaches a fresh workspace
 *   write     a file through the SDK, a second through a shell, then a supervised process
 *   delete    the second file goes, after a commit that held it
 *   stop      the final checkpoint through the container's own sync (D30), then the container stops
 *   wake      a fresh container attaches the committed workspace
 *   verify    the file is back, the deleted one stays deleted, the process runs under its id again
 *   discard   the box drops its bytes and its object
 *
 * The run first sweeps what earlier benches left, and its own resources go through the benches'
 * teardown manifest, so an interrupted run is swept by the next. The supplied credentials outlive
 * it: nothing here writes, rotates or deletes them.
 *
 *   set -a; . ./.dev.vars; set +a; bun scripts/bench-devbox-standalone.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  BENCH_ACCOUNT_ID, cleanupObservationProbes, orphanTeardownExecutor, r2CleanupKeyRefusal, r2ResiduePlane,
  sourceRevision,
} from './bench-devbox-strategies';
import {
  WRANGLER_FAILED, awaitApplicationRollout, containerAppIds, delay, describeThrown, publishTeardown,
  runTeardownOnce, runWrangler,
} from './fixtures/r2-bench/deploy-substrate';
import { R2_OP_VOCABULARY } from './fixtures/storage-matrix/admission';
import {
  checkCleanup, createManifest, recoverAbandonedRuns, replayTeardown, writeManifest, type CleanupReport,
} from './fixtures/storage-matrix/cleanup';

const REPO = join(import.meta.dir, '..');

const EXAMPLE_DIR = join(REPO, 'packages/devbox/example');

/** A cold attach on a fresh application includes its rollout; ten minutes without one is a stalled box. */
const ATTACH_WAIT_MS = 600_000;

const log = (line: string): void => { process.stderr.write(`[standalone] ${line}\n`); };

/** The manifest declares no resource of this kind, so the check has nothing to ask; a probe that
 *  answered anyway would pass a resource nobody looked at. */
const undeclared = (kind: string) => async (): Promise<boolean> => {
  throw new Error(`the standalone run declares no ${kind}, so none can be probed`);
};

/** What the teardown observed, filled when it runs and read after. */
interface Closing {
  report: CleanupReport | null;
}

interface Step {
  readonly step: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

const ExecSchema = v.looseObject({ exitCode: v.number(), stdout: v.string(), stderr: v.string() });

const StateSchema = v.looseObject({
  restoration: v.string(),
  running: v.boolean(),
  chain: v.nullable(v.looseObject({ rev: v.number() })),
});

const SupervisedSchema = v.array(v.looseObject({ processId: v.string(), status: v.string() }));

/** The fields the example's routes read from a JSON body. */
interface RouteBody {
  readonly command?: string;
  readonly path?: string;
  readonly content?: string;
}

/** The example Worker's routes, one box, parsed at the reply. */
interface Call {
  readonly get: <T extends v.GenericSchema>(path: string, schema: T) => Promise<v.InferOutput<T>>;
  readonly post: <T extends v.GenericSchema>(path: string, schema: T, body?: RouteBody) => Promise<v.InferOutput<T>>;
}

function client(origin: string, token: string, box: string): Call {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const parsed = async <T extends v.GenericSchema>(path: string, reply: Response, schema: T): Promise<v.InferOutput<T>> => {
    const text = await reply.text();

    if (!reply.ok) throw new Error(`${path} answered ${String(reply.status)}: ${text.slice(0, 400)}`);

    return v.parse(schema, JSON.parse(text));
  };

  return {
    get: async (path, schema) => await parsed(path, await fetch(`${origin}${path}?box=${box}`, {
      headers, signal: AbortSignal.timeout(300_000),
    }), schema),
    post: async (path, schema, body = {}) => await parsed(path, await fetch(`${origin}${path}?box=${box}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
    }), schema),
  };
}

async function attached(call: Call): Promise<string> {
  const since = Date.now();
  await call.post('/start', v.unknown());

  for (;;) {
    const state = await call.get('/state', StateSchema);

    if (state.restoration === 'attached') return `attached after ${String(Date.now() - since)} ms, record rev ${String(state.chain?.rev ?? 'none')}`;

    if (state.restoration === 'unattached' || Date.now() - since > ATTACH_WAIT_MS) {
      throw new Error(`the box did not attach: ${JSON.stringify(state).slice(0, 400)}`);
    }

    await delay(1_000);
  }
}

async function shell(call: Call, command: string): Promise<string> {
  const result = await call.post('/exec', ExecSchema, { command });

  if (result.exitCode !== 0) throw new Error(`\`${command}\` exited ${String(result.exitCode)}: ${result.stderr}`);

  return result.stdout.trim();
}

/** Until the record moves past `rev`: the container's sync committed what was written before. */
async function committedAfter(call: Call, rev: number): Promise<string> {
  const since = Date.now();

  for (;;) {
    const state = await call.get('/state', StateSchema);
    const now = state.chain?.rev ?? -1;

    if (now > rev) return `record rev ${String(rev)} -> ${String(now)} after ${String(Date.now() - since)} ms`;

    if (Date.now() - since > ATTACH_WAIT_MS) throw new Error(`no commit moved the record past rev ${String(rev)}`);
    await delay(1_000);
  }
}

async function acceptance(call: Call): Promise<Step[]> {
  const steps: Step[] = [];
  const kept = `kept ${crypto.randomUUID()}`;
  let processId = '';

  const step = async (name: string, body: () => Promise<string>): Promise<void> => {
    const since = Date.now();
    const detail = await body();
    steps.push({ step: name, ok: true, ms: Date.now() - since, detail });
    log(`${name}: ${detail}`);
  };

  await step('start', async () => await attached(call));
  await step('write', async () => {
    await call.post('/write', v.unknown(), { path: '/workspace/kept.txt', content: kept });
    await shell(call, 'printf deleted-later > /workspace/deleted.txt');
    processId = (await call.post('/supervise', v.object({ processId: v.string() }), {
      command: 'while true; do date +%s > /tmp/beat; sleep 1; done',
    })).processId;

    return `kept.txt, deleted.txt and supervised process ${processId}`;
  });

  await step('delete', async () => {
    const rev = (await call.get('/state', StateSchema)).chain?.rev ?? -1;
    const committed = await committedAfter(call, rev);
    await shell(call, 'rm /workspace/deleted.txt');

    return `deleted.txt removed after the sync committed it (${committed})`;
  });

  await step('stop', async () => {
    const outcome = await call.post('/stop', v.looseObject({ kind: v.string() }));

    if (outcome.kind === 'failed') throw new Error(`the final checkpoint failed: ${JSON.stringify(outcome)}`);

    for (let polls = 0; (await call.get('/state', StateSchema)).running; polls += 1) {
      if (polls > 120) throw new Error('the container is still running two minutes after the stop');
      await delay(1_000);
    }

    return `final checkpoint ${outcome.kind}; the container stopped`;
  });

  await step('wake', async () => await attached(call));
  await step('verify', async () => {
    const read = await call.post('/read', v.looseObject({ content: v.string() }), { path: '/workspace/kept.txt' });

    if (read.content !== kept) throw new Error(`kept.txt came back as ${JSON.stringify(read.content)}`);
    await shell(call, 'test ! -e /workspace/deleted.txt');
    const supervised = await call.get('/supervised', SupervisedSchema);
    const revived = supervised.find((row) => row.processId === processId);

    if (revived?.status !== 'running') throw new Error(`process ${processId} is ${revived?.status ?? 'gone'} after the wake`);
    const beat = Number(await shell(call, 'sleep 2; cat /tmp/beat'));
    const age = Math.floor(Date.now() / 1000) - beat;

    if (age > 5) throw new Error(`the revived process last beat ${String(age)} s ago`);

    return `kept.txt intact, deleted.txt absent, process ${processId} running and beating ${String(age)} s ago`;
  });

  await step('discard', async () => {
    await call.post('/delete', v.unknown());

    return 'the box dropped its bytes and its object';
  });

  return steps;
}

async function main(): Promise<number> {
  const accessKeyId = process.env['R2_ACCESS_KEY_ID'] ?? '';
  const secretAccessKey = process.env['R2_SECRET_ACCESS_KEY'] ?? '';
  const refusal = r2CleanupKeyRefusal({ verifiesCleanup: true, accessKeyIdPresent: accessKeyId !== '', secretAccessKeyPresent: secretAccessKey !== '' });

  if (refusal !== null) {
    log(refusal);

    return 1;
  }

  process.env.CLOUDFLARE_ACCOUNT_ID = BENCH_ACCOUNT_ID;
  // Read before deploying: a later read could name edits made after the deploy.
  const revision = sourceRevision();
  const runId = `s${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const worker = `kinu-devbox-example-${runId}`;
  const application = `${worker}-examplebox`;
  const configDir = join(tmpdir(), `kinu-devbox-bench-${runId}`);
  const residue = r2ResiduePlane({ accountId: BENCH_ACCOUNT_ID, accessKeyId, secretAccessKey });
  await recoverAbandonedRuns(REPO, runId, orphanTeardownExecutor(residue), log);

  const manifest = createManifest(runId, [
    { kind: 'worker', name: worker, detail: 'standalone example Worker' },
    { kind: 'container-app', name: application, detail: 'standalone example container application' },
    { kind: 'r2-bucket', name: worker, detail: 'standalone example bucket' },
    { kind: 'local-path', name: configDir, detail: 'generated Wrangler config directory' },
  ]);

  writeManifest(REPO, manifest);
  const token = crypto.randomUUID();
  // A holder, not a `let`: the teardown assigns it from a callback, which narrowing cannot see.
  const closing: Closing = { report: null };
  const cleanupErrors: string[] = [];

  publishTeardown(async () => {
    const replay = await replayTeardown(REPO, manifest, orphanTeardownExecutor(residue));
    cleanupErrors.push(...replay.failures);

    try {
      closing.report = await checkCleanup(REPO, manifest, {
        ...cleanupObservationProbes({ wrangler: (args, options) => runWrangler(REPO, args, options), residue }),
        containerAppAbsent: async (name) => containerAppIds(REPO, [name], log).length === 0,
        boxStateEmpty: undeclared('box state'),
        alarmAbsent: undeclared('alarm'),
        mountAbsent: undeclared('mount'),
        localPathAbsent: async (path) => !existsSync(path),
        processAbsent: undeclared('process'),
        counters: async () => ({ ...manifest.counters }),
      }, R2_OP_VOCABULARY);
    } catch (cause) {
      cleanupErrors.push(`cleanup verification failed: ${describeThrown({ cause })}`);
    }
  });

  let steps: Step[] = [];
  let failure: string | null = null;
  let workerVersion: string | null = null;

  try {
    mkdirSync(configDir, { recursive: true });
    const config = join(configDir, 'wrangler.jsonc');

    const template = readFileSync(join(EXAMPLE_DIR, 'wrangler.jsonc'), 'utf8')
      .replace('"name": "kinu-devbox-example"', `"name": "${worker}"`)
      .replace('"bucket_name": "kinu-devbox-example"', `"bucket_name": "${worker}"`)
      .replace('"main": "worker.ts"', `"main": "${join(EXAMPLE_DIR, 'worker.ts')}"`)
      .replace('"$schema": "../../../node_modules/wrangler/config-schema.json"', `"$schema": "${join(REPO, 'node_modules/wrangler/config-schema.json')}"`);

    writeFileSync(config, template);
    runWrangler(REPO, ['r2', 'bucket', 'create', worker]);
    const deployedAt = Date.now();
    const output = runWrangler(REPO, ['deploy', '--config', config, '--var', `EXAMPLE_TOKEN:${token}`]);
    const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
    workerVersion = /Current Version ID:\s*([0-9a-f-]{8,})/i.exec(output)?.[1] ?? null;

    if (origin === undefined || output.startsWith(WRANGLER_FAILED)) throw new Error(`the deploy printed no origin: ${output.slice(-1500)}`);
    await awaitApplicationRollout({ repoRoot: REPO, application, log, since: deployedAt });

    for (let polls = 0; (await fetch(`${origin}/health`, { headers: { authorization: `Bearer ${token}` } })).status !== 200; polls += 1) {
      if (polls > 60) throw new Error(`${origin} never accepted this run's token`);
      await delay(3_000);
    }

    steps = await acceptance(client(origin, token, `standalone-${runId}`));
  } catch (cause) {
    failure = describeThrown({ cause });
    log(`run failed: ${failure}`);
  } finally {
    await runTeardownOnce();
  }

  const { report } = closing;
  const artifacts = join(REPO, 'bench-artifacts', 'standalone', runId);
  mkdirSync(artifacts, { recursive: true });

  const observed = {
    runId,
    date: new Date().toISOString(),
    revision,
    workerVersion,
    steps,
    failure,
    cleanup: { passed: report?.passed ?? false, checks: report?.checks ?? [], errors: cleanupErrors },
  };

  writeFileSync(join(artifacts, 'observations.json'), `${JSON.stringify(observed, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ artifact: join(artifacts, 'observations.json'), ...observed })}\n`);

  return failure === null && report?.passed === true ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
