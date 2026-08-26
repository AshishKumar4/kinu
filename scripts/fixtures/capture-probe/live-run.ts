/**
 * The ephemeral deployed CaptureSound probe: provision, measure, destroy,
 * prove nothing is left.
 *
 * Every resource this module creates is UNIQUE to one run and torn down in the
 * same process that created it. A leaked fixture Worker or container
 * application holds a live instance on the account and blocks the next deploy,
 * so cleanup is not a courtesy step — it is part of the result. The teardown
 * ledger runs every step once, then RE-RUNS every step and requires the second
 * pass to succeed too: a delete that only works when the thing exists has not
 * proven idempotence until it also works when it does not. Any failure in
 * either pass fails the run with a nonzero exit even if the measurement itself
 * succeeded.
 *
 * The wrangler config is GENERATED per run and lives in a temp directory: a
 * per-run secret written into a committed file would outlive a crash, and a
 * fixed Worker name would collide across concurrent runs. The bearer token is
 * passed through `wrangler deploy --var` and never touches disk.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { CaptureCapabilityReportSchema } from '../../../packages/devbox/src/capture/capabilities';
import type { CaptureCapabilityReport } from '../../../packages/devbox/src/capture/capabilities';


import {
  accountId,
  awaitTokenAccepted,
  containerApplicationName,
  containerAppIds,
  delay,
  deleteContainerApps,
  deleteFixtureWorker,
  describeThrown,
  publishTeardown,
} from '../r2-bench/deploy-substrate';

/** The container image, pinned to the @cloudflare/sandbox version this repo's
 *  product deploy uses (packages/devbox/bench/wrangler.jsonc). The SDK checks
 *  SANDBOX_VERSION at container start; a drift here is a startup failure, not a
 *  silent downgrade. */
export const PROBE_SANDBOX_IMAGE = 'docker.io/cloudflare/sandbox:0.12.8';

const RUN_ID_LENGTH = 8;

export interface LiveRunPlan {
  readonly runId: string;
  readonly workerName: string;
  /** The exact expected image tag; verified inside the running container. */
  readonly image: string;
  /** Evidence identity: unique run plus the image version it accepted. */
  readonly imageRunIdentity: string;
  /** The container application derived from Worker + DO class. */
  readonly containerAppName: string;
  readonly token: string;
  /** Written by `materializeConfig`, removed by teardown. */
  readonly configPath: string;
}

function shortRunId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, RUN_ID_LENGTH);
}

/**
 * Unique names for one ephemeral run, plus its own temp home for the generated
 * config. Two calls never collide.
 */
export function planLiveRun(): LiveRunPlan {
  const runId = shortRunId();
  const dir = mkdtempSync(join(tmpdir(), 'capture-probe-live-'));
  const workerName = `kinu-capture-probe-${runId}`;
  return {
    runId,
    workerName,
    image: PROBE_SANDBOX_IMAGE,
    imageRunIdentity: `${runId}:${PROBE_SANDBOX_IMAGE}`,
    containerAppName: containerApplicationName(workerName, 'CaptureProbeBox'),
    token: `capture-probe-${crypto.randomUUID()}`,
    configPath: join(dir, 'wrangler.json'),
  };
}

/**
 * Render the wrangler config for one run. The bearer token is deliberately NOT
 * here — it travels through `--var` — so the rendered file is safe to leave in
 * a temp dir even if a later cleanup step fails.
 */
export function renderWranglerConfig(plan: LiveRunPlan, repoRoot: string, workerEntry: string): string {
  const config = {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: plan.workerName,
    account_id: accountId(repoRoot),
    main: workerEntry,
    compatibility_date: '2025-12-01',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: true,
    observability: { enabled: true },
    durable_objects: {
      bindings: [{ class_name: 'CaptureProbeBox', name: 'CaptureProbeBox' }],
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['CaptureProbeBox'] }],
    containers: [
      {
        class_name: 'CaptureProbeBox',
        image: plan.image,
        max_instances: 1,
        instance_type: { vcpu: 2, memory_mib: 6144, disk_mb: 8000 },
      },
    ],
  };
  return JSON.stringify(config, null, 2);
}
/** Write the generated config into the plan's private temp home. */
export function materializeConfig(plan: LiveRunPlan, repoRoot: string, workerEntry: string): void {
  writeFileSync(plan.configPath, renderWranglerConfig(plan, repoRoot, workerEntry));
}

/** Remove the generated file AND its private empty temp home. Idempotent. */
export function removeGeneratedConfig(plan: LiveRunPlan): void {
  rmSync(dirname(plan.configPath), { recursive: true, force: true });
}

// ── the teardown ledger ──────────────────────────────────────────────────────

export interface TeardownStep {
  readonly name: string;
  /** Performs the removal. Must SUCCEED when the target is already gone. */
  run(): Promise<string>;
}

export interface TeardownReport {
  /** One row per step per pass; second-pass names are prefixed `again/`. */
  readonly passes: ReadonlyArray<{ readonly name: string; readonly outcome: string }>;
  readonly failures: readonly string[];
}

export class TeardownLedger {
  private readonly steps: TeardownStep[] = [];
  private executed = false;

  register(step: TeardownStep): void { this.steps.push(step); }

  get isEmpty(): boolean { return this.steps.length === 0; }

  private async singlePass(log: (message: string) => void): Promise<{
    outcomes: Array<{ name: string; outcome: string }>;
    failures: string[];
  }> {
    const outcomes: Array<{ name: string; outcome: string }> = [];
    const failures: string[] = [];
    // Reverse order: children of a deployment die before their parent.
    for (const step of [...this.steps].reverse()) {
      let outcome: string;
      try {
        outcome = await step.run();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        outcome = `FAILED: ${detail}`;
        failures.push(`${step.name}: ${detail}`);
      }
      log(`teardown ${step.name}: ${outcome}`);
      outcomes.push({ name: step.name, outcome });
    }
    return { outcomes, failures };
  }

  /**
   * Run every step once, guarded against double execution, then prove
   * idempotence by running them AGAIN. Failures from either pass are reported;
   * a nonempty list means the account is not provably clean.
   */
  async executeAndVerify(log: (message: string) => void): Promise<TeardownReport> {
    if (this.executed) return { passes: [], failures: [] };
    this.executed = true;
    const first = await this.singlePass(log);
    log('teardown second pass (idempotence proof)');
    const second = await this.singlePass(log);
    return {
      passes: [
        ...first.outcomes,
        ...second.outcomes.map((row) => ({ ...row, name: `again/${row.name}` })),
      ],
      failures: [...first.failures, ...second.failures.map((f) => `idempotence/${f}`)],
    };
  }

}

// ── concrete steps ───────────────────────────────────────────────────────────

export interface DeployedRun {
  readonly plan: LiveRunPlan;
  readonly repoRoot: string;
  readonly origin: string;
  readonly configPath: string;
}

/**
 * Stop the box before its Worker disappears. A 404 means it was already gone;
 * every other status and every transport error becomes a named cleanup failure.
 */
export async function shutdownBox(run: DeployedRun, log: (message: string) => void): Promise<string | null> {
  try {
    const response = await fetch(`${run.origin}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${run.plan.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    log(`box shutdown status ${response.status}`);
    if (response.status === 200 || response.status === 404) return null;
    return `box shutdown returned ${response.status}`;
  } catch (error) {
    const detail = describeThrown({ cause: error });
    log(`box shutdown failed: ${detail}`);
    return `box shutdown failed: ${detail}`;
  }
}
export async function verifyIdempotentDestroy(
  destroy: () => Promise<string | null>,
): Promise<readonly string[]> {
  const failures: string[] = [];
  for (let pass = 0; pass < 2; pass += 1) {
    const failure = await destroy();
    if (failure !== null) failures.push(pass === 0 ? failure : `idempotence/${failure}`);
  }
  return failures;
}


async function deleteAndAwaitContainerApplication(run: DeployedRun, log: (message: string) => void): Promise<string> {
  const removed = deleteContainerApps(run.repoRoot, [run.plan.containerAppName], log);
  if (removed.some((outcome) => outcome.includes('FAILED'))) {
    throw new Error(`container application delete failed: ${removed.join(', ')}`);
  }
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (containerAppIds(run.repoRoot, [run.plan.containerAppName], log).length === 0) {
      return removed.join(', ');
    }
    if (Date.now() >= deadline) {
      throw new Error(`container application ${run.plan.containerAppName} remained after delete`);
    }
    await delay(1_000);
  }
}

/** Standard deployed-resource steps. The generated config is registered before deploy. */
export function registerTeardownSteps(ledger: TeardownLedger, run: DeployedRun, log: (message: string) => void): void {
  // TeardownLedger reverses registration. Register Worker first so execution
  // is: container application (and absence proof), Worker, local config.
  ledger.register({
    name: 'fixture-worker',
    run: async () => {
      if (!deleteFixtureWorker(run.repoRoot, run.configPath, run.plan.workerName, log)) {
        throw new Error('fixture Worker delete was refused');
      }
      return 'deleted';
    },
  });
  ledger.register({
    name: 'container-application',
    run: () => deleteAndAwaitContainerApplication(run, log),
  });
}

// ── the full live run ────────────────────────────────────────────────────────

export type ProbeVerdict =
  | { readonly verdict: 'capable' | 'no-go' }
  | { readonly verdict: 'invalid'; readonly detail: string };

export interface LiveRunResult {
  readonly origin: string;
  readonly verdict: ProbeVerdict;
  readonly report: CaptureCapabilityReport;
  readonly cleanupFailures: readonly string[];
}

/** A failed live run whose message carries the cleanup outcome with it. */
export class LiveProbeError extends Error {
  constructor(
    message: string,
    readonly cleanupFailures: readonly string[],
    options: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LiveProbeError';
  }
}

const ProbeReplySchema = v.strictObject({
  exitCode: v.number(),
  stdout: v.string(),
  stderr: v.string(),
  imageVersion: v.string(),
});
type ProbeReply = v.InferOutput<typeof ProbeReplySchema>;

export function parseProbeReply(raw: string): ProbeReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`probe reply is not JSON: ${raw.slice(0, 200)}`, { cause: error });
  }
  try {
    return v.parse(ProbeReplySchema, parsed);
  } catch (error) {
    throw new Error(`probe reply does not match its contract: ${raw.slice(0, 200)}`, { cause: error });
  }
}

export function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error('the probe printed no stdout');
  return last;
}

export interface LiveRunDeps {
  readonly repoRoot: string;
  /** Absolute path of scripts/fixtures/capture-probe/worker.ts. */
  readonly workerEntry: string;
  /** Absolute path of scripts/fixtures/capture-probe/probe.ts. */
  readonly probeSourcePath: string;
  readonly readProbeSource: () => string;
  readonly decide: (report: CaptureCapabilityReport) => ProbeVerdict;
  /** Runs `wrangler deploy` for this plan and returns its output. */
  readonly deploy: (plan: LiveRunPlan) => string;
  readonly log: (message: string) => void;
}

async function measure(deps: LiveRunDeps, plan: LiveRunPlan, origin: string): Promise<CaptureCapabilityReport> {
  await awaitTokenAccepted(origin, plan.token, '/health', deps.log);
  const response = await fetch(`${origin}/probe`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plan.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source: deps.readProbeSource() }),
    signal: AbortSignal.timeout(240_000),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`probe request failed with status ${response.status}: ${responseText.slice(0, 500)}`);
  }
  const reply = parseProbeReply(responseText);
  if (reply.exitCode !== 0) {
    throw new Error(`in-container probe exited ${reply.exitCode}: ${reply.stderr.slice(-400)}`);
  }
  const expectedVersion = plan.image.slice(plan.image.lastIndexOf(':') + 1);
  if (reply.imageVersion !== expectedVersion) {
    throw new Error(`STALE_IMAGE: expected ${expectedVersion}, container reported ${reply.imageVersion}`);
  }
  return v.parse(CaptureCapabilityReportSchema, JSON.parse(lastNonEmptyLine(reply.stdout)));
}

/**
 * Raise the ephemeral fixture, run the probe inside its real container, decide,
 * tear everything down, and prove the teardown idempotent.
 *
 * Success returns the decision plus an EMPTY cleanupFailures list. Any
 * deployment or measurement failure throws LiveProbeError AFTER cleanup ran,
 * carrying the cleanup outcome; cleanup failures always demand a nonzero exit.
 */
export async function runLiveCaptureProbe(deps: LiveRunDeps): Promise<LiveRunResult> {
  const plan = planLiveRun();
  materializeConfig(plan, deps.repoRoot, deps.workerEntry);

  const ledger = new TeardownLedger();
  ledger.register({
    name: 'generated-config',
    run: async () => {
      removeGeneratedConfig(plan);
      return 'removed';
    },
  });
  let deployed: DeployedRun | null = null;
  publishTeardown(() => ledger.executeAndVerify(deps.log).then(() => undefined));

  const finish = async (): Promise<readonly string[]> => {
    const live = deployed;
    const destroyFailures = live === null
      ? []
      : await verifyIdempotentDestroy(async () => await shutdownBox(live, deps.log));
    const teardown = await ledger.executeAndVerify(deps.log);
    return [...teardown.failures, ...destroyFailures];
  };

  try {
    const output = deps.deploy(plan);
    const origin = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(output)?.[0];
    if (origin === undefined) {
      throw new Error(`wrangler deploy printed no workers.dev origin:\n${output.slice(-3000)}`);
    }
    deps.log(`deployed ${origin}`);
    deployed = { plan, repoRoot: deps.repoRoot, origin, configPath: plan.configPath };
    registerTeardownSteps(ledger, deployed, deps.log);

    const report = await measure(deps, plan, origin);
    const failures = await finish();
    return { origin, verdict: deps.decide(report), report, cleanupFailures: failures };
  } catch (error) {
    const failures = await finish();
    throw new LiveProbeError(
      error instanceof Error ? error.message : String(error),
      failures,
      { cause: error },
    );
  }
}
