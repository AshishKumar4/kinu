#!/usr/bin/env bun
/**
 * Ephemeral deployed comparison of four payload transports, measured where the
 * bytes move: INSIDE a real @cloudflare/sandbox container.
 *
 *   bun scripts/bench-payload-transports.ts --plan   # print the plan, run nothing
 *   bun scripts/bench-payload-transports.ts --run    # the real thing
 *
 * THE DRIVER NEVER CARRIES PAYLOAD BYTES: it sends JSON commands and reads JSON
 * results. Deterministic payloads are generated inside the container (one
 * batched supervised seed operation, outside all timed windows); every timed
 * transfer executes in-container or across the owning DO's own SDK surface;
 * digests are verified in-container AND independently by a server-side object
 * read.
 *
 * Long operations NEVER hold a Worker/DO request open: the driver POSTs
 * /op/start (receiving a deterministic operationId) and polls /op/poll. The
 * operationId IS the container process id, so a DO reset mid-transfer re-reads
 * the same process instead of duplicating work — deterministic redrive.
 *
 * Credential material never appears in a command line or process list; the
 * owner DO forwards it through ProcessOptions.env only.
 *
 * Image freshness gates the run: setup verifies the RUNNING SANDBOX_VERSION
 * against the pinned tag before any cell is accepted; a stale image is an infra
 * failure that CENSORS the run — never data.
 *
 * Teardown order: purge bucket state through the live fixture, DESTROY the
 * container and clear its DO state, delete the container application, wait for
 * absence, then delete Worker, bucket, and local material — with a replay pass.
 * Any residue exits nonzero.
 */
import { execFileSync } from 'node:child_process';
import * as v from 'valibot';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JsonObjectSchema } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import {
  accountId, armSignalTeardown, awaitTokenAccepted, containerAppIds,
  delay, deleteContainerApps, publishTeardown, runTeardownOnce, runWrangler, WRANGLER_FAILED,
} from './fixtures/r2-bench/deploy-substrate';
import { PAYLOAD_ARMS, PAYLOAD_SIZES_MIB, type PayloadArmId } from './fixtures/payload-transport/arms';
import { CLEANUP_GATES, evaluateCleanup, exitFor, provesAbsence, type CleanupEvidence } from './fixtures/payload-transport/cleanup';
import { decideAll, judgeImage } from './fixtures/payload-transport/decision';
import { isValidResourceName, runIdentity, type RunIdentity } from './fixtures/payload-transport/payload';
import { renderMarkdown } from './fixtures/payload-transport/report';
import { validateArtifact, type Artifact, type Availability, type Cell } from './fixtures/payload-transport/schema';
import {
  HarnessResultSchema,
  InventoryReplySchema,
  ObjectVerificationReplySchema,
  OkReplySchema,
  OperationPollReplySchema,
  OperationStartReplySchema,
  PresignReplySchema,
  PurgeReplySchema,
  SetupReplySchema,
  TemporaryCredentialsReplySchema,
} from './fixtures/payload-transport/wire';
import type { HarnessResult, SetupReply } from './fixtures/payload-transport/wire';
import { summarize } from './fixtures/r2-bench/stats';

const ROOT = dirname(dirname(new URL(import.meta.url).pathname));
const FIXTURE_DIR = join(ROOT, 'scripts/fixtures/payload-transport');
const ARTIFACT_ROOT = join(ROOT, 'bench-artifacts/payload-transport');
const CONTAINER_APP_SUFFIX = '-sandbox';

const log = (message: string): void => {
  process.stderr.write(`[payload-transport] ${message}\n`);
};
armSignalTeardown(log);

const wrangler = (args: readonly string[], allowFailure = false): string =>
  runWrangler(ROOT, args, { allowFailure });

/**
 * Put a secret on the deployed Worker with the VALUE ON STDIN only.
 *
 * SECURITY: `wrangler deploy --var NAME:value` exposes the value in the
 * process list and any captured command log. `wrangler secret put` reads the
 * value from stdin, so no credential material ever appears in argv, in the
 * generated config, or in this driver's logs.
 */
function putSecret(name: string, value: string, configPath: string): void {
  execFileSync('bunx', ['wrangler', 'secret', 'put', name, '--config', configPath], {
    cwd: ROOT,
    encoding: 'utf8',
    input: `${value}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId(ROOT) },
  });
}

const FixtureConfigSchema = v.looseObject({
  containers: v.optional(v.array(v.looseObject({ image: v.string() }))),
});

/** The image tag this instrument pins, read from its own wrangler config. */
function fixtureConfig(): v.InferOutput<typeof FixtureConfigSchema> {
  const stripped = readFileSync(join(FIXTURE_DIR, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return v.parse(FixtureConfigSchema, JSON.parse(stripped));
}

function pinnedImage(): string {
  return fixtureConfig().containers?.[0]?.image ?? 'unknown';
}

interface Options {
  readonly plan: boolean;
  readonly reps: number;
  readonly concurrency: number;
  readonly seed: number;
  readonly out?: string;
}

function options(argv: readonly string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const number = (name: string, fallback: number): number => {
    const parsed = Number(value(name) ?? fallback);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
    return parsed;
  };
  return {
    plan: !argv.includes('--run'),
    reps: number('--reps', 3),
    concurrency: number('--concurrency', 4),
    seed: number('--seed', 20260826),
    out: value('--out'),
  };
}

/** Durable run state: ONLY the crash-recovery information teardown needs. */
interface Ledger {
  readonly runId: string;
  readonly workerName: string;
  readonly bucketName: string;
  readonly createdAt: string;
}

function writeLedger(path: string, value: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/** A wire value the driver may place in a fixture request body. */
type WireValue = string | number | boolean;

/** Every request body is a flat owner record of wire values. */
type FixtureRequest = Readonly<Record<string, WireValue>>;


async function call<TSchema extends v.GenericSchema>(
  origin: string,
  token: string,
  route: string,
  schema: TSchema,
  body: FixtureRequest = {},
): Promise<v.InferOutput<TSchema>> {
  const response = await fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_600_000),
  });
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`${route} (${response.status}) returned non-JSON: ${text.slice(0, 300)}`, {
      cause: error,
    });
  }
  const object = v.parse(JsonObjectSchema, decoded);
  if (object['error'] !== undefined) {
    throw new Error(`${route}: ${v.parse(v.string(), object['error'])}`);
  }
  return v.parse(schema, object);
}
async function setupFixture(origin: string, token: string): Promise<SetupReply> {
  let lastFailure = 'setup was not attempted';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await call(origin, token, '/setup', SetupReplySchema);
    } catch (error) {
      lastFailure = renderThrownChain({ cause: error });
      if (attempt < 4) {
        log(`setup attempt ${attempt} failed: ${lastFailure}`);
        await delay(attempt * 15_000);
      }
    }
  }
  throw new Error(`setup failed after four attempts: ${lastFailure}`);
}


/** Start a supervised operation and POLL it to completion. No request is held open server-side. */
async function runOperation(
  origin: string,
  token: string,
  operationId: string,
  kind: 'seed' | 'transfer',
  spec: FixtureRequest,
): Promise<readonly HarnessResult[]> {
  await call(
    origin,
    token,
    '/op/start',
    OperationStartReplySchema,
    { operationId, kind, ...spec },
  );
  for (;;) {
    const poll = await call(
      origin,
      token,
      '/op/poll',
      OperationPollReplySchema,
      { operationId },
    );
    if (poll.exitCode === null) {
      const settle = Promise.withResolvers<void>();
      setTimeout(settle.resolve, 500);
      await settle.promise;
      continue;
    }
    if (poll.exitCode !== 0) {
      throw new Error(`operation ${operationId} exited ${poll.exitCode}`);
    }
    if (poll.results === undefined) {
      throw new Error(`operation ${operationId} completed without result evidence`);
    }
    return poll.results;
  }
}

interface SeededFile {
  readonly path: string;
  readonly sizeMiB: 1 | 10 | 100;
  readonly sizeBytes: number;
  readonly sha256: string;
}
function requiredSeed(
  seeded: ReadonlyMap<1 | 10 | 100, SeededFile>,
  sizeMiB: 1 | 10 | 100,
): SeededFile {
  const found = seeded.get(sizeMiB);
  if (found === undefined) throw new Error(`seed evidence omitted ${sizeMiB} MiB`);
  return found;
}

function singleResult(results: readonly HarnessResult[], operationId: string): HarnessResult {
  if (results.length !== 1 || results[0] === undefined) {
    throw new Error(`${operationId} returned ${results.length} results, expected one`);
  }
  return results[0];
}

interface SeedEvidence {
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface MeasuredEvidence {
  readonly wallMs: number;
  readonly sha256: string;
}

function seedEvidence(result: HarnessResult, sizeMiB: 1 | 10 | 100): SeedEvidence {
  if (result.bytes === undefined || result.sha256 === undefined) {
    throw new Error(`seed ${sizeMiB} MiB returned incomplete evidence`);
  }
  return { sizeBytes: result.bytes, sha256: result.sha256 };
}

function measuredEvidence(result: HarnessResult, operationId: string): MeasuredEvidence {
  if (result.ms === undefined || result.sha256 === undefined) {
    throw new Error(`${operationId} returned incomplete measurement evidence`);
  }
  return { wallMs: result.ms, sha256: result.sha256 };
}


function availability(keysPresent: boolean): Availability[] {
  const absent = 'R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY were not supplied; this direct credential arm is unavailable and never falls back.';
  if (!keysPresent) {
    return [
      { arm: 'do-base64', available: true },
      { arm: 'loopback-entrypoint', available: true },
      { arm: 'presigned-r2', available: false, reason: absent },
      { arm: 'temp-s3-creds', available: false, reason: absent },
    ];
  }
  return PAYLOAD_ARMS.map((arm) => ({ arm, available: true }));
}
function availabilityFor(rows: readonly Availability[], arm: PayloadArmId): Availability {
  const found = rows.find((row) => row.arm === arm);
  if (found === undefined) throw new Error(`availability omitted ${arm}`);
  return found;
}


function planText(identity: RunIdentity, opts: Options): string {
  return [
    `Payload transport plan ${identity.runId}`,
    `Worker: ${identity.workerName}  Bucket: ${identity.bucketName}`,
    `Image: ${pinnedImage()} (verified running before evidence is accepted)`,
    `Matrix: ${PAYLOAD_ARMS.join(', ')} × PUT/GET × ${PAYLOAD_SIZES_MIB.join('/')} MiB × ${opts.reps} reps`,
    'All timed transfers execute inside the benchmark container (or across its owning-DO SDK surface).',
    'The driver carries commands and results only — no payload body originates on it.',
    `Cleanup gates: ${CLEANUP_GATES.map((gate) => gate.id).join(', ')} — residue exits nonzero.`,
    'No live work runs without --run.',
  ].join('\n');
}

function configFor(identity: RunIdentity): string {
  return JSON.stringify({
    ...fixtureConfig(),
    main: join(FIXTURE_DIR, 'worker.ts'),
    name: identity.workerName,
    r2_buckets: [{ binding: 'BACKUP_BUCKET', bucket_name: identity.bucketName }],
  }, null, 2);
}

async function main(): Promise<number> {
  const opts = options(process.argv.slice(2));
  const identity = runIdentity();
  const r2AccessKeyId = process.env['R2_ACCESS_KEY_ID'];
  const r2SecretAccessKey = process.env['R2_SECRET_ACCESS_KEY'];
  const r2KeysPresent = r2AccessKeyId !== undefined && r2SecretAccessKey !== undefined;
  const availabilityRows = availability(r2KeysPresent);
  if (!isValidResourceName(identity.workerName) || !isValidResourceName(identity.bucketName)) {
    throw new Error('generated resource names are illegal');
  }
  if (opts.plan) {
    process.stdout.write(`${planText(identity, opts)}\n`);
    return 0;
  }

  const runDir = join(ARTIFACT_ROOT, identity.runId);
  const ledgerPath = join(runDir, 'ledger.json');
  const configPath = join(runDir, 'wrangler.json');
  const token = `payload-${crypto.randomUUID()}`;
  const artifactPath = opts.out ?? join(ARTIFACT_ROOT, `${identity.runId}.json`);
  const containerApp = `${identity.workerName}${CONTAINER_APP_SUFFIX}`;
  writeLedger(ledgerPath, { ...identity, createdAt: new Date().toISOString() });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(configPath, configFor(identity));

  const cleanup: CleanupEvidence[] = [];
  let origin: string | null = null;
  let failure: string | null = null;
  let imageObserved: string | null = null;
  const cells: Cell[] = [];
  const controlRpc: Artifact['controlRpc'] = [];
  const concurrencyRows: Artifact['concurrency'] = [];

  /**
   * Teardown in the platform-correct order, with TWO complete release passes:
   *
   *   destroy, destroy            (while the Worker still exists — either
   *                                failure is preserved as residue)
   *   app → worker → bucket → config
   *   app → worker → bucket → config
   *
   * App absence is proven by POLLING THE ACCOUNT LISTING after each delete,
   * never by trusting a command's returned text. A wrangler failure proves
   * nothing: only explicit not-found/already-deleted output counts as absence;
   * auth/network/API faults are cleanup failures.
   */
  const teardown = async (): Promise<void> => {
    let inventoryProof: { readonly objects: number; readonly bytes: number } | undefined;
    let inventoryFailure: string | undefined;
    if (origin !== null) {
      try {
        await call(origin, token, '/purge', PurgeReplySchema);
        inventoryProof = await call(origin, token, '/inventory', InventoryReplySchema);
      } catch (error) {
        inventoryFailure = renderThrownChain({ cause: error });
      }
    }

    // A fixture that became reachable must destroy the runtime twice while its
    // Worker still exists. Before a successful deploy there is no runtime/DO
    // to destroy; account-side application absence is the cleanup oracle.
    const destroyFailures: string[] = [];
    if (origin !== null) {
      for (const attempt of [1, 2] as const) {
        try {
          await call(origin, token, '/destroy', OkReplySchema);
        } catch (error) {
          destroyFailures.push(
            `destroy attempt ${attempt}: ${renderThrownChain({ cause: error })}`,
          );
        }
      }
    }

    const bucketProofs: boolean[] = [];
    const releasePasses: boolean[] = [];
    for (let pass = 1; pass <= 2; pass += 1) {
      let appOk = false;
      let appDetail = '';
      try {
        deleteContainerApps(ROOT, [containerApp], log);
        for (let poll = 0; poll < 6; poll += 1) {
          if (containerAppIds(ROOT, [containerApp], log).length === 0) {
            appOk = true;
            break;
          }
          await delay(10_000);
        }
        appDetail = appOk
          ? `listing confirms absent (pass ${pass})`
          : `still listed after 6 polls (pass ${pass})`;
      } catch (error) {
        appDetail = `container listing failed (pass ${pass}): ${renderThrownChain({ cause: error })}`;
      }
      const runtimeOk = destroyFailures.length === 0;
      cleanup.push({
        gate: 'container-application-absent',
        ok: appOk && runtimeOk,
        detail: runtimeOk ? appDetail : `${destroyFailures.join('; ')}; ${appDetail}`,
      });

      const workerDelete = wrangler(['delete', '--name', identity.workerName, '--force'], true);
      const workerOk = provesAbsence(workerDelete);
      cleanup.push({
        gate: 'fixture-worker-absent',
        ok: workerOk,
        detail: workerDelete.slice(0, 240),
      });

      const bucketDelete = wrangler(['r2', 'bucket', 'delete', identity.bucketName], true);
      const bucketOk = provesAbsence(bucketDelete);
      bucketProofs.push(bucketOk);
      cleanup.push({
        gate: 'bucket-deleted',
        ok: bucketOk,
        detail: bucketDelete.slice(0, 240),
      });

      let localOk = true;
      let localDetail = `release pass ${pass} cleared generated config and durable ledger`;
      try {
        rmSync(configPath, { force: true });
        rmSync(ledgerPath, { force: true });
      } catch (error) {
        localOk = false;
        localDetail = `release pass ${pass}: ${renderThrownChain({ cause: error })}`;
      }
      cleanup.push({ gate: 'local-material-cleared', ok: localOk, detail: localDetail });
      releasePasses.push(appOk && runtimeOk && workerOk && bucketOk && localOk);
    }

    const inventoryEmpty = inventoryProof !== undefined
      && inventoryProof.objects === 0
      && inventoryProof.bytes === 0;
    const deletionProvedEmpty = bucketProofs.length === 2 && bucketProofs.every(Boolean);
    cleanup.push({
      gate: 'bucket-state-empty',
      ok: inventoryEmpty || deletionProvedEmpty,
      detail: inventoryProof === undefined
        ? `no live inventory; bucket deletion proof ${deletionProvedEmpty ? 'passed' : 'failed'}${inventoryFailure === undefined ? '' : ` (${inventoryFailure})`}`
        : `inventory after purge: ${inventoryProof.objects} object(s), ${inventoryProof.bytes} byte(s)`,
    });
    cleanup.push({
      gate: 'multipart-ledger-drained',
      ok: deletionProvedEmpty,
      detail: deletionProvedEmpty
        ? 'single-PUT instrument created no multipart id and the run bucket was deleted twice'
        : 'bucket deletion did not prove multipart state absent',
    });
    cleanup.push({
      gate: 'cleanup-replay-idempotent',
      ok: releasePasses.length === 2 && releasePasses.every(Boolean),
      detail: 'second release pass re-ran every route and re-polled the account listing',
    });
  };
  publishTeardown(teardown);

  try {
    if (wrangler(['whoami'], true).startsWith(WRANGLER_FAILED)) throw new Error('wrangler is not authenticated');
    wrangler(['r2', 'bucket', 'create', identity.bucketName]);

    // Deploy NON-SECRET vars only. Bearer token and parent R2 credentials are
    // injected afterwards through stdin-only `wrangler secret put` — never as
    // command arguments, never into the generated config.
    const deployed = wrangler(['deploy', '--config', configPath, '--var', `ACCOUNT_ID:${accountId(ROOT)}`, '--var', `BUCKET_NAME:${identity.bucketName}`]);
    putSecret('BENCH_TOKEN', token, configPath);
    if (r2AccessKeyId !== undefined && r2SecretAccessKey !== undefined) {
      putSecret('R2_ACCESS_KEY_ID', r2AccessKeyId, configPath);
      putSecret('R2_SECRET_ACCESS_KEY', r2SecretAccessKey, configPath);
    }
    origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployed)?.[0] ?? null;
    if (origin === null) throw new Error('wrangler deploy returned no workers.dev origin');
    await awaitTokenAccepted(origin, token, '/shape', log);

    const setup = await setupFixture(origin, token);

    // IMAGE FRESHNESS — decided BEFORE any cell is accepted. Stale/unknown
    // censors the whole run as an infrastructure failure; it is never data.
    imageObserved = setup.imageVersion;
    const verdict = judgeImage(pinnedImage(), imageObserved);
    if (verdict.kind === 'unknown') throw new Error(`could not verify the running container image (pinned ${pinnedImage()}); censoring the run`);
    if (verdict.kind === 'stale') throw new Error(`stale container image: running ${verdict.observed}, pinned ${verdict.pinned}; censoring the run`);
    log(`image verified: ${verdict.observed}`);
    const liveOrigin = origin;

    // SEED — one batched supervised operation, outside all timed windows.
    const seedFiles = PAYLOAD_SIZES_MIB.map((sizeMiB) => ({
      path: `/tmp/payload-bench/payload-${sizeMiB}.bin`,
      sizeMiB,
    }));
    const seededResults = await runOperation(origin, token, `seed-${identity.runId}`, 'seed', {
      files: JSON.stringify(seedFiles),
      seed: opts.seed,
    });
    if (seededResults.length !== PAYLOAD_SIZES_MIB.length) {
      throw new Error(`seed operation returned ${seededResults.length} results`);
    }
    const seeded = new Map<1 | 10 | 100, SeededFile>();
    for (const [index, sizeMiB] of PAYLOAD_SIZES_MIB.entries()) {
      const result = seededResults[index];
      if (result === undefined) throw new Error(`seed result ${index} is absent`);
      const evidence = seedEvidence(result, sizeMiB);
      const file = {
        path: `/tmp/payload-bench/payload-${sizeMiB}.bin`,
        sizeMiB,
        ...evidence,
      };
      seeded.set(sizeMiB, file);
      log(`seeded ${sizeMiB} MiB → ${evidence.sha256.slice(0, 12)}…`);
    }

    const idleLatencies: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = Date.now();
      await fetch(`${origin}/control`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
      idleLatencies.push(Date.now() - started);
    }
    controlRpc.push({ phase: 'idle', arm: null, latency: summarize(idleLatencies) });

    const independentChecks: { cell: Cell; key: string; file: SeededFile }[] = [];

    const runCell = async (
      arm: PayloadArmId,
      op: 'put' | 'get',
      file: SeededFile,
      rep: number,
      keySuffix: string,
    ): Promise<Cell> => {
      const base = { arm, op, sizeMiB: file.sizeMiB, rep };
      const available = availabilityFor(availabilityRows, arm);
      if (!available.available) {
        return {
          ...base,
          phase: 'failed',
          status: 'unavailable',
          reason: available.reason ?? `${arm} is unavailable`,
          wallMs: null,
        };
      }
      const key = `payload/${keySuffix}`;
      const operationId = `${identity.runId}-${arm}-${op}-${rep}-${keySuffix.length}`;
      try {
        if (arm === 'do-base64') {
          const result = await call(
            liveOrigin,
            token,
            '/arm/do-base64',
            HarnessResultSchema,
            { file: file.path, key, op },
          );
          const measured = measuredEvidence(result, operationId);
          return judge(base, file, key, measured, 'owner-do');
        }
        if (arm === 'loopback-entrypoint') {
          const url = `http://r2.internal/${identity.bucketName}/${key}`;
          const result = singleResult(
            await runOperation(liveOrigin, token, operationId, 'transfer', {
              mode: 'loopback', file: file.path, url, op,
            }),
            operationId,
          );
          return judge(base, file, key, measuredEvidence(result, operationId), 'container');
        }
        if (arm === 'presigned-r2') {
          const grant = await call(
            liveOrigin,
            token,
            '/grant/presign',
            PresignReplySchema,
            { key, op },
          );
          if (!grant.available) {
            return {
              ...base,
              phase: 'failed',
              status: 'unavailable',
              reason: grant.reason,
              wallMs: null,
            };
          }
          const result = singleResult(
            await runOperation(liveOrigin, token, operationId, 'transfer', {
              mode: 'direct', file: file.path, url: grant.opaque, op,
            }),
            operationId,
          );
          return judge(
            base,
            file,
            key,
            measuredEvidence(result, operationId),
            'container',
            grant.fingerprint,
          );
        }
        const credentials = await call(
          liveOrigin,
          token,
          '/temp-credentials',
          TemporaryCredentialsReplySchema,
          { prefix: 'payload/' },
        );
        if (!credentials.available) {
          return {
            ...base,
            phase: 'failed',
            status: 'unavailable',
            reason: credentials.reason,
            wallMs: null,
          };
        }
        const result = singleResult(
          await runOperation(liveOrigin, token, operationId, 'transfer', {
            mode: 'sigv4',
            file: file.path,
            key,
            op,
            endpoint: credentials.endpoint,
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
          }),
          operationId,
        );
        return judge(
          base,
          file,
          key,
          measuredEvidence(result, operationId),
          'container',
          credentials.fingerprint,
        );
      } catch (error) {
        return {
          ...base,
          phase: 'failed',
          status: 'failed',
          reason: renderThrownChain({ cause: error }),
          wallMs: null,
        };
      }

      function judge(
        cellBase: { arm: PayloadArmId; op: 'put' | 'get'; sizeMiB: 1 | 10 | 100; rep: number },
        seededFile: SeededFile,
        objectKey: string,
        measured: MeasuredEvidence,
        timedBy: 'container' | 'owner-do',
        grantFingerprint?: string,
      ): Cell {
        const cell: Cell = measured.sha256 === seededFile.sha256
          ? { ...cellBase, phase: 'published', status: 'ok', wallMs: measured.wallMs, timedBy }
          : {
              ...cellBase,
              phase: 'failed',
              status: 'corrupt',
              wallMs: measured.wallMs,
              timedBy,
              reason: 'in-container verification disagreed with the seeded digest',
            };
        if (grantFingerprint !== undefined) cell.grantFingerprint = grantFingerprint;
        if (cell.status === 'ok' && cellBase.op === 'put') {
          independentChecks.push({ cell, key: objectKey, file: seededFile });
        }
        return cell;
      }
    };

    for (const arm of PAYLOAD_ARMS) {
      if (!availabilityFor(availabilityRows, arm).available) continue;
      for (const sizeMiB of PAYLOAD_SIZES_MIB) {
        const file = requiredSeed(seeded, sizeMiB);
        for (let rep = 0; rep < opts.reps; rep += 1) {
          cells.push(await runCell(arm, 'put', file, rep, `put/${arm}/${sizeMiB}/${rep}`));
          cells.push(await runCell(arm, 'get', file, rep, `put/${arm}/${sizeMiB}/${rep}`));
          log(`arm ${arm} ${sizeMiB} MiB rep ${rep + 1}/${opts.reps} done`);
        }
      }
    }

    // INDEPENDENT verification of every stored object, server-side.
    for (const check of independentChecks) {
      try {
        const verified = await call(
          liveOrigin,
          token,
          '/verify-object',
          ObjectVerificationReplySchema,
          { key: check.key },
        );
        if (verified.sha256 !== check.file.sha256 || verified.size !== check.file.sizeBytes) {
          check.cell.status = 'corrupt';
          check.cell.phase = 'failed';
          check.cell.reason = 'independent R2-side read disagreed with the seeded digest';
        }
      } catch (error) {
        check.cell.status = 'failed';
        check.cell.phase = 'failed';
        check.cell.reason = `independent verification could not run: ${renderThrownChain({ cause: error })}`;
      }
    }

    // CONCURRENCY + LOADED CONTROL RPC, per available arm.
    for (const arm of PAYLOAD_ARMS) {
      if (!availabilityFor(availabilityRows, arm).available) continue;
      const stop = { value: false };
      const loaded: number[] = [];
      let samplerFailure: string | undefined;
      const sampler = (async (): Promise<void> => {
        while (!stop.value) {
          const started = Date.now();
          try {
            const response = await fetch(`${liveOrigin}/control`, {
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
              body: '{}',
            });
            if (!response.ok) throw new Error(`control sample returned ${response.status}`);
            loaded.push(Date.now() - started);
          } catch (error) {
            samplerFailure = renderThrownChain({ cause: error });
            stop.value = true;
            break;
          }
          const settle = Promise.withResolvers<void>();
          setTimeout(settle.resolve, 150);
          await settle.promise;
        }
      })();
      const startedAt = Date.now();
      const tenMiB = requiredSeed(seeded, 10);
      const results = await Promise.all(
        Array.from({ length: opts.concurrency }, (_, slot) =>
          runCell(arm, 'put', tenMiB, 1000 + slot, `concurrent/${arm}/${slot}`)),
      );
      const wallMs = Date.now() - startedAt;
      stop.value = true;
      await sampler;
      const allOk = samplerFailure === undefined && results.every((cell) => cell.status === 'ok');
      if (allOk) {
        concurrencyRows.push({
          arm,
          wallMs,
          throughputMiBs: (10 * opts.concurrency) / (wallMs / 1000),
          status: 'ok',
        });
      } else {
        concurrencyRows.push({
          arm,
          wallMs,
          throughputMiBs: null,
          status: 'failed',
          reason: samplerFailure
            ?? results.find((cell) => cell.reason !== undefined)?.reason
            ?? 'a concurrent transfer failed without a reason',
        });
      }
      controlRpc.push({ phase: 'loaded', arm, latency: summarize(loaded) });
    }
  } catch (error) {
    failure = renderThrownChain({ cause: error });
  } finally {
    await runTeardownOnce();
  }

  const verdict = evaluateCleanup(cleanup);
  const planBase: Artifact['plan'] = {
    runId: identity.runId,
    workerName: identity.workerName,
    bucketName: identity.bucketName,
    seed: opts.seed,
    sizesMiB: [...PAYLOAD_SIZES_MIB],
    reps: opts.reps,
    concurrency: opts.concurrency,
    startedAt: new Date().toISOString(),
    imagePinned: pinnedImage(),
  };
  const plan: Artifact['plan'] = imageObserved === null
    ? planBase
    : { ...planBase, imageObserved };
  const artifact = validateArtifact({
    instrument: 'payload-transports',
    version: 1,
    plan,
    availability: [...availabilityRows],
    cells,
    controlRpc,
    concurrency: concurrencyRows,
    verdicts: [...decideAll(cells)],
    cleanup: { steps: [...verdict.steps], residue: verdict.residue },
  });
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(artifactPath.replace(/\.json$/, '.md'), `${renderMarkdown(artifact)}\n`);
  log(`artifact written: ${artifactPath}`);
  if (failure !== null) log(`run failure: ${failure}`);
  return exitFor(failure, verdict);
}

if (import.meta.main) process.exit(await main());
