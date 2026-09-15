/**
 * Container application rollout probe: how long a FRESH application takes to
 * report a healthy instance after `wrangler deploy`, and whether the bench
 * fixture's admission windows (`portWaitMs` 6,000, re-driven back to back)
 * change that.
 *
 * Two cells, each its own Worker and container application, serial:
 *
 *   passive — nothing touches the Durable Object until the platform's health
 *             row reports a provisioned instance; then one default-shaped
 *             `startAndWaitForPorts` is timed.
 *   churn   — from the moment the Worker answers, `probeStart('bench')` is
 *             re-driven the instant each 6 s window refuses, while the same
 *             health row is polled beside it.
 *
 * Every cell deletes its Worker and container application and proves both
 * absent. Observations land in `bench-artifacts/rollout-probe/<runId>/`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { containerAppIds, deleteContainerApps, describeThrown, delay, provisionedInstances, runWrangler } from './fixtures/r2-bench/deploy-substrate';
import { parseJsonc } from './jsonc';
import blockImage from '../packages/devbox/block-lower/upstream.json';

const REPO = new URL('..', import.meta.url).pathname;

const PROBE_DIR = join(REPO, 'packages/devbox/bench');

const ACCOUNT = 'f44999d1ddda7012e9a87729eba250f1';

const HEALTH_POLL_MS = 2_000;

const ROLLOUT_CEILING_MS = 240_000;

const ProbeConfigSchema = v.looseObject({
  name: v.string(),
  containers: v.array(v.looseObject({ class_name: v.string(), image: v.string() })),
});

const HealthSchema = v.looseObject({
  success: v.boolean(),
  result: v.optional(v.looseObject({
    version: v.optional(v.number()),
    instances: v.optional(v.number()),
    health: v.optional(v.looseObject({
      instances: v.optional(v.record(v.string(), v.number())),
    })),
  })),
});

const StampReplySchema = v.looseObject({
  ok: v.boolean(),
  error: v.optional(v.string()),
  stamp: v.optional(v.nullable(v.looseObject({
    mode: v.string(),
    startEntered: v.number(),
    startReturned: v.nullable(v.number()),
    onstartEntered: v.nullable(v.number()),
    execFinished: v.nullable(v.number()),
    startError: v.optional(v.string()),
  }))),
});

interface HealthReading {
  readonly at: number;
  readonly sinceDeployMs: number;
  readonly instances: number | null;
  readonly health: Record<string, number> | null;
  readonly error: string | null;
}

interface DriveReading {
  readonly at: number;
  readonly sinceDeployMs: number;
  readonly ms: number;
  readonly admitted: boolean;
  readonly detail: string;
}

interface CellObservation {
  readonly cell: 'passive' | 'churn';
  worker: string;
  application: string;
  applicationId: string | null;
  deployStartedAt: number;
  deployedAt: number | null;
  workerAnsweredAt: number | null;
  healthyAt: number | null;
  healthyAfterDeployMs: number | null;
  firstAdmissionAt: number | null;
  firstAdmissionAfterDeployMs: number | null;
  health: HealthReading[];
  drives: DriveReading[];
  cleanup: string[];
  errors: string[];
}

const log = (message: string): void => { process.stderr.write(`[rollout-probe] ${message}\n`); };

interface ProbeConfig {
  readonly path: string;
  readonly dispose: () => void;
}

/** The probe config under a unique Worker name and the bench's own image. */
function writeConfig(name: string): ProbeConfig {
  const parsed = parseJsonc(readFileSync(join(PROBE_DIR, 'wrangler.probe.jsonc'), 'utf8'), ProbeConfigSchema, 'probe config');
  const dir = join(tmpdir(), `rollout-probe-${name}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'wrangler.jsonc');
  writeFileSync(path, `${JSON.stringify({
    ...parsed,
    $schema: join(REPO, 'node_modules/wrangler/config-schema.json'),
    name,
    main: join(PROBE_DIR, 'probe-worker.ts'),
    containers: parsed.containers.map((container) => ({ ...container, image: blockImage.image })),
  }, null, 2)}\n`);

  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function readHealth(applicationId: string, deployedAt: number): Promise<HealthReading> {
  const at = Date.now();

  try {
    const reply = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/containers/applications/${applicationId}`, {
      headers: { authorization: `Bearer ${process.env['CLOUDFLARE_API_TOKEN'] ?? ''}` },
      signal: AbortSignal.timeout(10_000),
    });

    const parsed = v.parse(HealthSchema, await reply.json());

    return {
      at, sinceDeployMs: at - deployedAt,
      instances: parsed.result?.instances ?? null,
      health: parsed.result?.health?.instances ?? null,
      error: parsed.success ? null : `status ${String(reply.status)}`,
    };
  } catch (cause) {
    return { at, sinceDeployMs: at - deployedAt, instances: null, health: null, error: describeThrown({ cause }) };
  }
}

async function drive(origin: string, token: string, box: string, mode: string, deployedAt: number): Promise<DriveReading> {
  const at = Date.now();

  try {
    const reply = await fetch(`${origin}/probe/onstart?mode=${mode}&box=${box}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000),
    });

    const parsed = v.parse(StampReplySchema, await reply.json());
    const stamp = parsed.stamp ?? null;
    const admitted = parsed.ok && stamp !== null && stamp.startError === undefined && stamp.onstartEntered !== null;

    return {
      at, sinceDeployMs: at - deployedAt, ms: Date.now() - at, admitted,
      detail: stamp?.startError ?? parsed.error ?? (admitted ? `onStart entered ${String((stamp?.onstartEntered ?? 0) - stamp!.startEntered)} ms after start` : 'no stamp'),
    };
  } catch (cause) {
    return { at, sinceDeployMs: at - deployedAt, ms: Date.now() - at, admitted: false, detail: describeThrown({ cause }) };
  }
}

/** The Worker's own liveness, with a transport failure reported as status 0. */
async function workerHealth(origin: string): Promise<number> {
  try {
    return (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) })).status;
  } catch (cause) {
    log(`the Worker health probe did not answer: ${describeThrown({ cause })}`);

    return 0;
  }
}

async function destroyProbeBox(origin: string, token: string, box: string): Promise<string> {
  try {
    const reply = await fetch(`${origin}/probe/onstart/destroy?box=${box}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000),
    });

    return `destroy: ${String(reply.status)} ${(await reply.text()).slice(0, 120)}`;
  } catch (cause) {
    return `destroy failed: ${describeThrown({ cause })}`;
  }
}

async function runCell(cell: 'passive' | 'churn', runId: string, token: string, save: (row: CellObservation) => void): Promise<CellObservation> {
  const worker = `kinu-devbox-rollout-probe-${runId}-${cell}`;

  const row: CellObservation = {
    cell, worker, application: `${worker}-onstartexecprobe`, applicationId: null,
    deployStartedAt: Date.now(), deployedAt: null, workerAnsweredAt: null, healthyAt: null, healthyAfterDeployMs: null,
    firstAdmissionAt: null, firstAdmissionAfterDeployMs: null, health: [], drives: [], cleanup: [], errors: [],
  };

  save(row);

  const config = writeConfig(worker);
  const box = `${cell}-${runId}`;
  let origin: string | null = null;

  try {
    const output = runWrangler(REPO, ['deploy', '--config', config.path, '--var', `PROBE_TOKEN:${token}`]);
    row.deployedAt = Date.now();
    origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0] ?? null;

    if (origin === null) throw new Error(`deploy printed no workers.dev origin:\n${output.slice(-1500)}`);
    log(`${cell}: deployed ${origin} in ${String(row.deployedAt - row.deployStartedAt)} ms`);
    const deployedAt = row.deployedAt;

    for (;;) {
      const status = await workerHealth(origin);

      if (status === 200) break;

      if (Date.now() - deployedAt > 180_000) throw new Error('the probe Worker never answered /health');
      await delay(2_000);
    }

    row.workerAnsweredAt = Date.now();
    const found = containerAppIds(REPO, [row.application], log);
    row.applicationId = found[0]?.id ?? null;

    if (row.applicationId === null) throw new Error(`container application ${row.application} is not listed after deploy`);
    const applicationId = row.applicationId;
    save(row);

    const first = await readHealth(applicationId, deployedAt);
    row.health.push(first);
    log(`${cell}: first health reading ${JSON.stringify(first.health)} instances=${String(first.instances)}`);

    const healthy = (reading: HealthReading): boolean => provisionedInstances(reading.health ?? {}) >= 1;
    let stopPolling = false;

    const polling = (async (): Promise<void> => {
      while (!stopPolling) {
        await delay(HEALTH_POLL_MS);
        const reading = await readHealth(applicationId, deployedAt);
        row.health.push(reading);

        if (row.healthyAt === null && healthy(reading)) {
          row.healthyAt = reading.at;
          row.healthyAfterDeployMs = reading.at - deployedAt;
          log(`${cell}: healthy >= 1 at ${String(row.healthyAfterDeployMs)} ms after deploy: ${JSON.stringify(reading.health)}`);
        }

        save(row);

        if (Date.now() - deployedAt > ROLLOUT_CEILING_MS && row.healthyAt === null) {
          row.errors.push(`no healthy instance within ${String(ROLLOUT_CEILING_MS)} ms of deploy`);

          return;
        }
      }
    })();

    if (healthy(first)) { row.healthyAt = first.at; row.healthyAfterDeployMs = first.at - deployedAt; }

    if (cell === 'passive') {
      while (row.healthyAt === null && Date.now() - deployedAt <= ROLLOUT_CEILING_MS) await delay(500);

      if (row.healthyAt !== null) {
        const reading = await drive(origin, token, box, 'ports', deployedAt);
        row.drives.push(reading);

        if (reading.admitted) { row.firstAdmissionAt = reading.at + reading.ms; row.firstAdmissionAfterDeployMs = row.firstAdmissionAt - deployedAt; }
        else row.errors.push(`the post-healthy start was refused: ${reading.detail}`);
        log(`${cell}: post-healthy start ${reading.admitted ? 'admitted' : 'refused'} in ${String(reading.ms)} ms (${reading.detail})`);
      }
    } else {
      while (Date.now() - deployedAt <= ROLLOUT_CEILING_MS) {
        const reading = await drive(origin, token, box, 'bench', deployedAt);
        row.drives.push(reading);
        log(`${cell}: drive ${String(row.drives.length)} ${reading.admitted ? 'admitted' : 'refused'} in ${String(reading.ms)} ms (${reading.detail})`);
        save(row);

        if (reading.admitted) { row.firstAdmissionAt = reading.at + reading.ms; row.firstAdmissionAfterDeployMs = row.firstAdmissionAt - deployedAt; break; }
      }

      if (row.firstAdmissionAt === null) row.errors.push(`no admission within ${String(ROLLOUT_CEILING_MS)} ms of deploy`);

      // Keep reading the health row until it reports healthy too, so the two
      // clocks can be compared inside one cell.
      while (row.healthyAt === null && Date.now() - deployedAt <= ROLLOUT_CEILING_MS) await delay(500);
    }

    stopPolling = true;
    await polling;
  } catch (cause) {
    row.errors.push(describeThrown({ cause }));
  } finally {
    if (origin !== null) {
      row.cleanup.push(await destroyProbeBox(origin, token, box));
    }

    row.cleanup.push(`worker: ${runWrangler(REPO, ['delete', '--name', worker, '--force'], { allowFailure: true }).slice(0, 80).replace(/\s+/g, ' ')}`);
    row.cleanup.push(...deleteContainerApps(REPO, [row.application], log));
    row.cleanup.push(`application listed after delete: ${String(containerAppIds(REPO, [row.application], log).length)}`);
    config.dispose();
    save(row);
  }

  return row;
}

async function run(): Promise<number> {
  const runId = `r${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const artifacts = join(REPO, 'bench-artifacts', 'rollout-probe', runId);
  mkdirSync(artifacts, { recursive: true });
  const token = crypto.randomUUID();
  const cells: CellObservation[] = [];
  const save = (): void => writeFileSync(join(artifacts, 'observations.json'), `${JSON.stringify({ runId, date: new Date().toISOString(), image: blockImage.image, cells }, null, 2)}\n`);
  const selected = process.argv.slice(2).filter((arg): arg is 'passive' | 'churn' => arg === 'passive' || arg === 'churn');

  for (const cell of selected.length === 0 ? (['passive', 'churn'] as const) : selected) {
    const row = await runCell(cell, runId, token, (current) => { if (!cells.includes(current)) cells.push(current); save(); });
    log(`${cell}: healthy after ${String(row.healthyAfterDeployMs)} ms, first admission after ${String(row.firstAdmissionAfterDeployMs)} ms, errors ${JSON.stringify(row.errors)}`);
  }

  save();
  process.stdout.write(`${JSON.stringify({ artifact: join(artifacts, 'observations.json'), cells: cells.map((cell) => ({ cell: cell.cell, healthyAfterDeployMs: cell.healthyAfterDeployMs, firstAdmissionAfterDeployMs: cell.firstAdmissionAfterDeployMs, drives: cell.drives.length, errors: cell.errors, cleanup: cell.cleanup })) })}\n`);

  return cells.every((cell) => cell.errors.length === 0) ? 0 : 1;
}

if (import.meta.main) process.exitCode = await run();
